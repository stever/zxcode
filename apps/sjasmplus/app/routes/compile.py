import base64
import os
import resource
import shutil
import signal
import subprocess
import tempfile
import threading
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

# Per-compile resource ceilings applied to the assembler subprocess, so a
# single hostile source can't exhaust the container regardless of the
# container-level cgroup caps: CPU seconds (a backstop to the wall-clock
# timeout), max size of any single output/intermediate file (defends against
# disk fill), and total address space (defends against a memory blow-up).
# Kept under the container mem_limit so a greedy compile fails on its own
# RLIMIT rather than tripping a cgroup OOM that could catch a concurrent one.
RLIMIT_CPU_SECONDS = COMPILE_TIMEOUT + 10
RLIMIT_FSIZE_BYTES = 32 * 1024 * 1024
RLIMIT_AS_BYTES = 1024 * 1024 * 1024

# Compiles are strictly serialized. With Lua enabled in the assembler
# (USE_LUA in the Dockerfile) a source can run arbitrary code, and all
# compiles share one uid and one tmpfs, so an overlapping compile could read
# another request's in-flight source — which may be a logged-in user's
# private project. Unlinking the source after spawn is no substitute:
# sjasmplus is multi-pass and reopens program.asm, and the unlink would race
# the child's first open anyway. Serializing here (not via uvicorn
# --limit-concurrency 1) keeps /health answering during a compile. The wait
# is bounded so a queue sheds as 503 instead of stacking threads; typical
# assemblies finish well under a second, so contention is rare.
COMPILE_QUEUE_TIMEOUT = 10
_compile_lock = threading.Lock()


def _apply_rlimits():
    resource.setrlimit(resource.RLIMIT_CPU, (RLIMIT_CPU_SECONDS, RLIMIT_CPU_SECONDS))
    resource.setrlimit(resource.RLIMIT_FSIZE, (RLIMIT_FSIZE_BYTES, RLIMIT_FSIZE_BYTES))
    resource.setrlimit(resource.RLIMIT_AS, (RLIMIT_AS_BYTES, RLIMIT_AS_BYTES))

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


# The SLD file scales with source size (a handful of lines per source line);
# 64KB of source stays well under this. Oversized means something pathological
# (Lua-generated code), so drop the map rather than the compile.
MAX_SLD_SIZE = 1024 * 1024


class CompileResult(BaseModel):
    base64_encoded: str
    # sjasmplus source-level-debugging map (file:line <-> address records) for
    # the IDE debugger. Absent when the assembly produced none.
    sld: Optional[str] = None


compile_endpoint = APIRouter()


@compile_endpoint.post("/", response_model=CompileResult)
def handle_compile_request(
        args: RequestArgs,
        authorization: Optional[str] = Header(None)) -> Optional[CompileResult]:

    if not _compile_lock.acquire(timeout=COMPILE_QUEUE_TIMEOUT):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail='The assembler is busy. Try again shortly.')

    # A fresh directory per request: the source is always program.asm and the
    # assembler runs with cwd here, so diagnostics say program.asm(N) with no
    # server paths to scrub, and SAVETAP/SAVENEX outputs land alongside it.
    workdir = None
    try:
        workdir = tempfile.mkdtemp(prefix='sjasmplus-')
        with open(os.path.join(workdir, 'program.asm'), 'w') as f:
            f.write(args.input.code)

        # Assemble in its own process group so a timeout can kill sjasmplus
        # and anything it spawned, not just the parent.
        # --sld emits the source-level-debugging map the IDE debugger uses for
        # source-line breakpoints. No --fullpath: with cwd here the records
        # say program.asm with no server paths to scrub (sjasmplus warns about
        # the omission; harmless for a single-file assembly).
        proc = subprocess.Popen(
            ['sjasmplus', '--nologo', '--sld=program.sld', 'program.asm'],
            cwd=workdir,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
            preexec_fn=_apply_rlimits,
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

        sld = None
        sld_path = Path(workdir) / 'program.sld'
        if sld_path.is_file() and sld_path.stat().st_size <= MAX_SLD_SIZE:
            sld = sld_path.read_text(errors='replace')

        with open(outputs[0], 'rb') as f:
            return CompileResult(
                base64_encoded=base64.b64encode(f.read()).decode(),
                sld=sld)

    finally:
        if workdir:
            shutil.rmtree(workdir, ignore_errors=True)
        _compile_lock.release()
