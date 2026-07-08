import base64
import os
import shutil
import signal
import subprocess
import tempfile
from pathlib import Path
from fastapi import APIRouter, Header, HTTPException, status
from typing import Optional
from pydantic import BaseModel, Field, field_validator
from uuid import UUID

# Bound an assembly run so a hostile/pathological source can't pin the
# container. Kept under gif-service's 20s upstream timeout so the caller gets
# a clean error.
COMPILE_TIMEOUT = int(os.environ.get("COMPILE_TIMEOUT", "15"))
MAX_INPUT_SIZE = 64 * 1024  # 64KB of assembly source is ample for this use

# sjasmplus only writes what the source's output directives ask for; without
# them an error-free assembly produces nothing runnable.
NO_OUTPUT_HINT = (
    'No TAP or NEX output was produced. Add output directives to your source: '
    'DEVICE ZXSPECTRUM48 with SAVETAP "out.tap",start for a classic tape, or '
    'DEVICE ZXSPECTRUMNEXT with SAVENEX OPEN "out.nex",start / SAVENEX CLOSE '
    'for a ZX Spectrum Next program.'
)


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


@compile_endpoint.post("/", response_model=CompileResult)
def handle_compile_request(
        args: RequestArgs,
        authorization: Optional[str] = Header(None)) -> Optional[CompileResult]:

    # A fresh directory per request: the source is always program.asm and the
    # assembler runs with cwd here, so diagnostics say program.asm(N) with no
    # server paths to scrub, and SAVETAP/SAVENEX outputs land alongside it.
    workdir = tempfile.mkdtemp(prefix='sjasmplus-')
    try:
        with open(os.path.join(workdir, 'program.asm'), 'w') as f:
            f.write(args.input.code)

        # Assemble in its own process group so a timeout can kill sjasmplus
        # and anything it spawned, not just the parent.
        proc = subprocess.Popen(
            ['sjasmplus', '--nologo', 'program.asm'],
            cwd=workdir,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        try:
            stdout, stderr = proc.communicate(timeout=COMPILE_TIMEOUT)
        except subprocess.TimeoutExpired:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            proc.communicate()
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f'Compilation timed out after {COMPILE_TIMEOUT}s',
            )

        if proc.returncode != 0:
            # sjasmplus interleaves pass-progress chatter with its real
            # diagnostics (program.asm(N): error: ...) on stderr. Keep just
            # the error/warning lines when present, and defensively scrub the
            # temp dir in case a message embeds an absolute path.
            output = (stderr or b'').decode(errors='replace')
            output = output.replace(workdir + os.sep, '').replace(workdir, '')
            lines = [l for l in output.splitlines() if ': error:' in l or ': warning:' in l]
            diagnostics = '\n'.join(lines) if lines else output
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=diagnostics.strip()[:2000] or 'Compilation failed')

        outputs = sorted(Path(workdir).glob('*.tap')) + sorted(Path(workdir).glob('*.nex'))
        if not outputs:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=NO_OUTPUT_HINT)
        if len(outputs) > 1:
            names = ', '.join(p.name for p in outputs)
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f'Produced more than one output ({names}). '
                       'Use exactly one SAVETAP or SAVENEX output.')

        with open(outputs[0], 'rb') as f:
            return CompileResult(base64_encoded=base64.b64encode(f.read()).decode())

    finally:
        shutil.rmtree(workdir, ignore_errors=True)
