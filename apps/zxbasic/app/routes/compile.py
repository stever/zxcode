import tempfile
import base64
import contextlib
import io
import os
import re
import resource
import shutil
import sys
import signal
import threading
import subprocess
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta
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
    # Absent for the public/unauthenticated role (e.g. the bot rendering a public
    # project). In pydantic v2 Optional[...] without a default is still required,
    # so default to None to make the field genuinely optional.
    x_hasura_user_id: Optional[UUID] = Field(default=None, alias="x-hasura-user-id")


# Additional project files staged into the compile workdir so #include
# resolves next to program.bas. Names become real filenames there, so they
# are held to a safe charset with no path separators (mirrors the
# project_file DB constraint), and names stemmed 'program' are reserved for
# the main source and its outputs so a staged file can't shadow them.
MAX_PROJECT_FILES = 32
MAX_FILE_CONTENT_SIZE = 256 * 1024  # matches the DB cap; base64 for binaries
PROJECT_FILE_NAME_RE = re.compile(r'[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}')


class ProjectFile(BaseModel):
    name: str
    content: str
    is_binary: Optional[bool] = False

    @field_validator('name')
    @classmethod
    def validate_name(cls, v):
        if not PROJECT_FILE_NAME_RE.fullmatch(v):
            raise ValueError(
                'File names may only use letters, digits, dots, dashes and '
                'underscores (max 64 chars, no leading dot)')
        return v

    @field_validator('content')
    @classmethod
    def validate_content_size(cls, v):
        if len(v) > MAX_FILE_CONTENT_SIZE:
            raise ValueError(
                f'File too large. Maximum size is {MAX_FILE_CONTENT_SIZE} bytes')
        return v


def stage_project_files(workdir, files):
    """Write the additional project files into the compile workdir."""
    seen = set()
    for pf in files or []:
        lower = pf.name.lower()
        stem = lower.split('.', 1)[0]
        if stem == 'program':
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"File name '{pf.name}' is reserved for the main source")
        if lower in seen:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Duplicate file name '{pf.name}'")
        seen.add(lower)
        path = os.path.join(workdir, pf.name)
        if pf.is_binary:
            try:
                data = base64.b64decode(pf.content, validate=True)
            except (ValueError, TypeError):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"File '{pf.name}' is not valid base64")
            with open(path, 'wb') as f:
                f.write(data)
        else:
            with open(path, 'w') as f:
                f.write(pf.content)


class Input(BaseModel):
    basic: str
    files: Optional[list[ProjectFile]] = None

    @field_validator('files')
    @classmethod
    def validate_file_count(cls, v):
        if v and len(v) > MAX_PROJECT_FILES:
            raise ValueError(f'Too many files. Maximum is {MAX_PROJECT_FILES}')
        return v

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

# Per-compile resource ceilings applied to the zxbc subprocess, so a single
# hostile source can't exhaust the container regardless of the cgroup caps:
# CPU seconds (a backstop to the wall-clock timeout), max size of any single
# output/intermediate file (defends against disk fill), and total address
# space. Kept under the container mem_limit so a greedy compile fails on its
# own RLIMIT rather than tripping a cgroup OOM that could catch a concurrent
# one.
RLIMIT_CPU_SECONDS = COMPILATION_TIMEOUT + 10
RLIMIT_FSIZE_BYTES = 32 * 1024 * 1024
RLIMIT_AS_BYTES = 1024 * 1024 * 1024


def _apply_rlimits():
    resource.setrlimit(resource.RLIMIT_CPU, (RLIMIT_CPU_SECONDS, RLIMIT_CPU_SECONDS))
    resource.setrlimit(resource.RLIMIT_FSIZE, (RLIMIT_FSIZE_BYTES, RLIMIT_FSIZE_BYTES))
    resource.setrlimit(resource.RLIMIT_AS, (RLIMIT_AS_BYTES, RLIMIT_AS_BYTES))


class TimeoutException(Exception):
    pass


class CompilationError(Exception):
    """Raised when the compiler rejects the source. Carries the compiler's own
    diagnostics (line numbers + messages) so they can be surfaced to the user."""

    def __init__(self, output: str = ""):
        super().__init__(output)
        self.output = output or ""


def sanitize_compiler_output(output: str, bas_filename: str) -> str:
    """Strip server-side paths from the compiler output before returning it to
    the client. zxbc prefixes each diagnostic with the source path we passed it
    (a temp file), so replace that with a neutral name and defensively scrub any
    other temp-file reference."""
    if not output:
        return ""

    cleaned = output.replace(bas_filename, "program.bas")
    # Diagnostics from staged include files carry the workdir prefix; strip
    # it so they read as the bare project filename.
    workdir = os.path.dirname(bas_filename)
    if workdir:
        cleaned = cleaned.replace(workdir + os.sep, "").replace(workdir, "")
    # Defensive: catch any leftover /path/to/tmpXXXX.bas that slipped through.
    cleaned = re.sub(r"\S*/tmp\w+\.bas", "program.bas", cleaned)
    cleaned = cleaned.strip()

    # Keep the error payload bounded.
    MAX_OUTPUT = 4000
    if len(cleaned) > MAX_OUTPUT:
        cleaned = cleaned[:MAX_OUTPUT] + "\n... (truncated)"

    return cleaned


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

# Sources targeting the ZX Spectrum Next must be compiled with zxbc's zxnext
# architecture: it enables the Z80N opcodes and the zxnext stdlib (which is
# where NextLibLite.bas lives). It cannot be the default — zxnext codegen is
# not valid on classic machines. Two signals opt a program in: an explicit
# NextBuild-style directive comment, or including the Next-only stdlib file.
ZXNEXT_DIRECTIVE_RE = re.compile(r"(?im)^\s*'!\s*arch\s*=\s*zxnext\s*$")
ZXNEXT_INCLUDE_RE = re.compile(r"(?i)#include\s*<NextLibLite\.bas>")


def zxbc_args(source: str) -> list[str]:
    """Build the zxbc argument list for a program source."""
    args = ['-f', 'tap', '-a', '-B']
    if ZXNEXT_DIRECTIVE_RE.search(source) or ZXNEXT_INCLUDE_RE.search(source):
        args += ['--arch', 'zxnext']
    return args


def compile_with_subprocess(bas_filename, tap_filename, args):
    """
    Compile using subprocess that can actually be killed.
    Falls back to threading approach if subprocess fails.

    The output path (tap_filename) is passed explicitly with -o so the .tap
    lands in the caller's temp dir (a writable tmpfs) rather than the process
    CWD — the container runs read-only, and this keeps compiler output off the
    image layer on both the subprocess and the in-process fallback path.
    """
    workdir = os.path.dirname(bas_filename)

    # First try subprocess approach (can be killed)
    try:
        # Try to run as subprocess, in its own process group (so a timeout can
        # kill it) with per-compile resource ceilings applied in the child.
        proc = subprocess.Popen(
            [ZXBC_EXECUTABLE, *args, '-o', tap_filename, bas_filename],
            cwd=workdir,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
            preexec_fn=_apply_rlimits,
        )

        # Register with monitor so it will be killed if it runs too long
        process_monitor.register_process(proc.pid)

        try:
            # Wait for completion with timeout
            stdout, stderr = proc.communicate(timeout=COMPILATION_TIMEOUT)

            if proc.returncode != 0:
                # zxbc writes its diagnostics (line numbers + messages) to
                # stderr. Carry them up so the user sees the actual error.
                print(f"Compilation failed: {stderr}")
                raise CompilationError(stderr or stdout)

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
            # Use threading approach as fallback, capturing the compiler's stderr
            # so the same diagnostics are available on this path too.
            stderr_buffer = io.StringIO()
            try:
                with contextlib.redirect_stderr(stderr_buffer):
                    # Pass -o too so this in-process path also writes the .tap
                    # to the writable temp dir rather than the (read-only) CWD.
                    run_with_threading(
                        zxbc_main, [*args, '-o', tap_filename, bas_filename], COMPILATION_TIMEOUT)
            except TimeoutException:
                raise

            if not os.path.exists(tap_filename):
                raise CompilationError(stderr_buffer.getvalue())

            return True
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

    # A fresh directory per request: the source is always program.bas and any
    # additional project files are staged alongside it so #include resolves.
    # Everything lives in the temp dir (a writable tmpfs under read-only
    # root), addressed absolutely so the compiler never writes into the
    # process CWD / image layer.
    workdir = tempfile.mkdtemp(prefix='zxbasic-')
    bas_filename = os.path.join(workdir, 'program.bas')
    tap_filename = os.path.join(workdir, 'program.tap')

    try:
        with open(bas_filename, 'w') as f:
            f.write(args.input.basic)
        stage_project_files(workdir, args.input.files)

        # Compile the tape file from basic source with timeout
        try:
            success = compile_with_subprocess(bas_filename, tap_filename, zxbc_args(args.input.basic))
            if not success:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail="Compilation produced no output."
                )
        except TimeoutException:
            # Compilation took too long - likely an infinite loop or complex computation
            raise HTTPException(
                status_code=status.HTTP_408_REQUEST_TIMEOUT,
                detail=f"Compilation timeout exceeded ({COMPILATION_TIMEOUT} seconds). Code may contain infinite loops or be too complex."
            )
        except CompilationError as e:
            # The compiler rejected the source. Surface its own diagnostics
            # (line numbers + messages) instead of a generic message.
            detail = sanitize_compiler_output(e.output, bas_filename)
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=detail or "Compilation failed. Please check your BASIC code."
            )
        except HTTPException:
            raise
        except Exception as e:
            # Unexpected failure - keep the message generic.
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
        # Always clean up the per-request directory
        shutil.rmtree(workdir, ignore_errors=True)
