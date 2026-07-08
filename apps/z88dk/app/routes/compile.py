import tempfile
import base64
import os
import re
import signal
import subprocess
from pathlib import Path
from fastapi import APIRouter, Header, HTTPException, status
from typing import Optional
from pydantic import BaseModel, Field, field_validator
from uuid import UUID

# Bound a compile so a hostile/pathological C program can't pin the container.
# Kept under gif-service's 20s upstream timeout so the caller gets a clean error.
COMPILE_TIMEOUT = int(os.environ.get("COMPILE_TIMEOUT", "15"))
MAX_INPUT_SIZE = 64 * 1024  # 64KB of C source is ample for this use


class SessionVars(BaseModel):
    x_hasura_role: str = Field(alias="x-hasura-role")
    # Absent for the public/unauthenticated role (e.g. the bot rendering a
    # public project). In pydantic v2 Optional[...] without a default is still
    # required, so default to None to make the field genuinely optional.
    x_hasura_user_id: Optional[UUID] = Field(default=None, alias="x-hasura-user-id")


class Input(BaseModel):
    code: str

    @field_validator('code')
    @classmethod
    def validate_code_size(cls, v):
        if not v or not v.strip():
            raise ValueError('Input cannot be empty')
        if len(v) > MAX_INPUT_SIZE:
            raise ValueError(f'Input too large. Maximum size is {MAX_INPUT_SIZE} bytes')
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

# z88dk has two mutually exclusive C libraries. The default here is newlib
# (-clib=sdcc_iy: <arch/zx.h>, zx_cls(attr), ...). Sources written against the
# classic library announce themselves by including <spectrum.h>, which only
# exists there; those must be built with the classic lib instead, and on the
# +zx target classic stdio needs -lndos to satisfy its file-I/O stubs
# (writebyte etc.) or the link fails.
CLASSIC_INCLUDE_RE = re.compile(r"#include\s*[<\"]spectrum\.h[>\"]")


def zcc_args(source: str) -> list:
    """Build the zcc argument list for a program source."""
    if CLASSIC_INCLUDE_RE.search(source):
        return ['zcc', '+zx', '-vn', '-create-app', '-lndos']
    return ['zcc', '+zx', '-vn', '-create-app', '-clib=sdcc_iy', '-startup=0']


def sanitize_compiler_output(output: str, c_filename: str) -> str:
    """Strip server-side paths from the compiler output before returning it to
    the client. zcc prefixes diagnostics with the source path we passed it
    (a temp file), so replace that with a neutral name and defensively scrub
    any other temp-file reference."""
    if not output:
        return ""

    cleaned = output.replace(c_filename, "program.c")
    # Defensive: catch any leftover /path/to/tmpXXXX.c that slipped through.
    cleaned = re.sub(r"\S*/tmp\w+\.c", "program.c", cleaned)
    return cleaned.strip()


@compile_endpoint.post("/", response_model=CompileResult)
def handle_compile_request(
        args: RequestArgs,
        authorization: Optional[str] = Header(None)) -> Optional[CompileResult]:

    # Write C code to file.
    tmp = tempfile.NamedTemporaryFile(delete=False)
    tmp.close()
    c_filename = f'{tmp.name}.c'
    with open(c_filename, 'w') as f:
        f.write(args.input.code)

    path = os.path.dirname(os.path.abspath(c_filename))
    stem = Path(c_filename).stem
    out_filename = f'{os.path.join(path, stem)}'
    tap_filename = f'{out_filename}.tap'

    try:
        # Compile in its own process group so a timeout can kill zcc and every
        # child it spawned (sdcc etc.), not just the parent.
        proc = subprocess.Popen(
            [*zcc_args(args.input.code), c_filename, '-o', out_filename],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        try:
            _, stderr = proc.communicate(timeout=COMPILE_TIMEOUT)
        except subprocess.TimeoutExpired:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            proc.communicate()
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f'Compilation timed out after {COMPILE_TIMEOUT}s',
            )

        if not os.path.exists(tap_filename):
            detail = sanitize_compiler_output(
                (stderr or b'').decode(errors='replace'), c_filename)[:2000]
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=detail or 'Compilation failed')

        with open(tap_filename, 'rb') as f:
            base64_encoded = base64.b64encode(f.read()).decode()
            return CompileResult(base64_encoded=base64_encoded)

    finally:
        # Clean up the source, the tape, and any intermediates zcc left behind.
        for leftover in Path(path).glob(f'{stem}*'):
            try:
                leftover.unlink()
            except OSError:
                pass
