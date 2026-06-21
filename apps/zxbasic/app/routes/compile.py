import tempfile
import base64
import os
import sys
import signal
import threading
import subprocess
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta
from pathlib import Path
from fastapi import APIRouter, Header, HTTPException, status
from typing import Optional
from pydantic import BaseModel, Field, field_validator
from uuid import UUID
from app.process_monitor import process_monitor

# Try to import the main function for fallback
try:
    from src.zxbc import main as zxbc_main
except ImportError:
    zxbc_main = None

# Path to the zxbc console script installed by the zxbasic package. Console
# scripts live alongside the Python interpreter (e.g. the venv's bin/), so
# resolve it from sys.executable rather than relying on PATH.
ZXBC_EXECUTABLE = os.path.join(os.path.dirname(sys.executable), 'zxbc')


class SessionVars(BaseModel):
    x_hasura_role: str = Field(alias="x-hasura-role")
    x_hasura_user_id: Optional[UUID] = Field(alias="x-hasura-user-id")


class Input(BaseModel):
    basic: str

    @field_validator('basic')
    @classmethod
    def validate_basic_size(cls, v):
        MAX_INPUT_SIZE = 10 * 1024  # 10KB max
        MIN_INPUT_SIZE = 1  # At least 1 character

        # Check for empty or whitespace-only input
        if not v or not v.strip():
            raise ValueError('Input cannot be empty')

        # Check size limits
        if len(v) > MAX_INPUT_SIZE:
            raise ValueError(f'Input too large. Maximum size is {MAX_INPUT_SIZE} bytes (10KB)')

        if len(v.strip()) < MIN_INPUT_SIZE:
            raise ValueError('Input too small. Please provide valid BASIC code')

        return v


class Action(BaseModel):
    name: str


class RequestArgs(BaseModel):
    session_variables: SessionVars
    input: Input
    action: Action


class CompileResult(BaseModel):
    base64_encoded: str


compile_endpoint = APIRouter()

# Security configuration
COMPILATION_TIMEOUT = 5  # seconds
MAX_REQUESTS_PER_MINUTE = 10
MAX_REQUESTS_PER_HOUR = 100


class TimeoutException(Exception):
    pass


class RateLimiter:
    """Simple in-memory rate limiter"""

    def __init__(self):
        # Store request timestamps for each client
        self.requests = defaultdict(deque)
        # Store blocked clients with unblock time
        self.blocked_until = {}

    def _clean_old_requests(self, client_id: str, now: datetime):
        """Remove requests older than 1 hour"""
        if client_id in self.requests:
            cutoff = now - timedelta(hours=1)
            # Remove old timestamps
            while self.requests[client_id] and self.requests[client_id][0] < cutoff:
                self.requests[client_id].popleft()

    def is_allowed(self, client_id: str) -> tuple[bool, str]:
        """
        Check if a client is allowed to make a request.
        Returns (allowed, reason_if_blocked)
        """
        now = datetime.now()

        # Check if client is temporarily blocked
        if client_id in self.blocked_until:
            if now < self.blocked_until[client_id]:
                remaining = int((self.blocked_until[client_id] - now).total_seconds())
                return False, f"Rate limit exceeded. Try again in {remaining} seconds."
            else:
                # Unblock period has passed
                del self.blocked_until[client_id]

        # Clean old requests
        self._clean_old_requests(client_id, now)

        # Count recent requests
        minute_ago = now - timedelta(minutes=1)
        hour_ago = now - timedelta(hours=1)

        requests_in_minute = sum(1 for ts in self.requests[client_id] if ts > minute_ago)
        requests_in_hour = len(self.requests[client_id])

        # Check minute limit
        if requests_in_minute >= MAX_REQUESTS_PER_MINUTE:
            # Block for 1 minute
            self.blocked_until[client_id] = now + timedelta(minutes=1)
            return False, f"Rate limit exceeded: {MAX_REQUESTS_PER_MINUTE} requests per minute maximum."

        # Check hour limit
        if requests_in_hour >= MAX_REQUESTS_PER_HOUR:
            # Block for 5 minutes
            self.blocked_until[client_id] = now + timedelta(minutes=5)
            return False, f"Rate limit exceeded: {MAX_REQUESTS_PER_HOUR} requests per hour maximum."

        # Record this request
        self.requests[client_id].append(now)
        return True, ""


# Global rate limiter instance
rate_limiter = RateLimiter()

def compile_with_subprocess(bas_filename):
    """
    Compile using subprocess that can actually be killed.
    Falls back to threading approach if subprocess fails.
    """
    tap_filename = f'{Path(bas_filename).stem}.tap'

    # First try subprocess approach (can be killed)
    try:
        # Try to run as subprocess
        proc = subprocess.Popen(
            [ZXBC_EXECUTABLE, '-f', 'tap', '-a', '-B', bas_filename],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )

        # Register with monitor so it will be killed if it runs too long
        process_monitor.register_process(proc.pid)

        try:
            # Wait for completion with timeout
            stdout, stderr = proc.communicate(timeout=COMPILATION_TIMEOUT)

            if proc.returncode != 0:
                print(f"Compilation failed: {stderr}")
                return False

            return os.path.exists(tap_filename)

        except subprocess.TimeoutExpired:
            # Kill the subprocess
            proc.kill()
            proc.wait()  # Clean up zombie
            raise TimeoutException(f"Compilation timeout after {COMPILATION_TIMEOUT} seconds")

    except (FileNotFoundError, OSError) as e:
        # Subprocess failed, fall back to threading approach
        print(f"Subprocess failed ({e}), falling back to threading approach")

        if zxbc_main:
            # Use threading approach as fallback
            try:
                run_with_threading(zxbc_main, ['-f', 'tap', '-a', '-B', bas_filename], COMPILATION_TIMEOUT)
                return os.path.exists(tap_filename)
            except TimeoutException:
                raise
        else:
            raise Exception("Cannot compile: zxbc not available")


def run_with_threading(func, args, timeout):
    """Fallback: Run a function with timeout using threading (won't kill process)"""
    result = [None]
    exception = [None]

    def target():
        try:
            result[0] = func(args)
        except Exception as e:
            exception[0] = e

    thread = threading.Thread(target=target)
    thread.daemon = True
    thread.start()
    thread.join(timeout)

    if thread.is_alive():
        raise TimeoutException(f"Operation timed out after {timeout} seconds")

    if exception[0]:
        raise exception[0]

    return result[0]


@compile_endpoint.post("/", response_model=CompileResult)
def handle_compile_request(
        args: RequestArgs,
        authorization: Optional[str] = Header(None),
        x_forwarded_for: Optional[str] = Header(None),
        x_real_ip: Optional[str] = Header(None)) -> Optional[CompileResult]:

    # Identify the client for rate limiting
    # Priority: user_id > x-forwarded-for > x-real-ip > "anonymous"
    client_id = "anonymous"
    if args.session_variables.x_hasura_user_id:
        client_id = str(args.session_variables.x_hasura_user_id)
    elif x_forwarded_for:
        # Take the first IP if there's a chain of proxies
        client_id = x_forwarded_for.split(',')[0].strip()
    elif x_real_ip:
        client_id = x_real_ip

    # Apply rate limiting
    allowed, reason = rate_limiter.is_allowed(client_id)
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=reason
        )

    # Write ZX Basic to file.
    tmp = tempfile.NamedTemporaryFile(delete=False)
    bas_filename = f'{tmp.name}.bas'
    tap_filename = f'{Path(bas_filename).stem}.tap'

    try:
        with open(bas_filename, 'w') as f:
            f.write(args.input.basic)

        # Compile the tape file from basic source with timeout
        try:
            success = compile_with_subprocess(bas_filename)
            if not success:
                raise Exception("Compilation failed")
        except TimeoutException:
            # Compilation took too long - likely an infinite loop or complex computation
            raise HTTPException(
                status_code=status.HTTP_408_REQUEST_TIMEOUT,
                detail=f"Compilation timeout exceeded ({COMPILATION_TIMEOUT} seconds). Code may contain infinite loops or be too complex."
            )
        except Exception as e:
            # Compilation failed
            print(f"Compilation error: {str(e)}")
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Compilation failed. Please check your BASIC code."
            )

        # Check if output file was created
        if not os.path.exists(tap_filename):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Compilation produced no output file."
            )

        # Read and base64 encode the binary tape file.
        with open(tap_filename, 'rb') as f:
            base64_encoded = base64.b64encode(f.read()).decode()
            return CompileResult(base64_encoded=base64_encoded)

    finally:
        # Always clean up temporary files
        for filename in [bas_filename, tap_filename, tmp.name]:
            if os.path.exists(filename):
                try:
                    os.remove(filename)
                except Exception as e:
                    print(f"Warning: Could not remove {filename}: {e}")
