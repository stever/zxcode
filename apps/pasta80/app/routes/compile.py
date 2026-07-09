import base64
import os
import re
import resource
import shutil
import signal
import subprocess
import tempfile
from fastapi import APIRouter, Header, HTTPException, status
from typing import Optional
from pydantic import BaseModel, Field, field_validator
from uuid import UUID

# Bound a compile run so a hostile/pathological source can't pin the
# container. Kept under gif-service's 20s upstream timeout so the caller gets
# a clean error.
COMPILE_TIMEOUT = int(os.environ.get("COMPILE_TIMEOUT", "15"))
MAX_INPUT_SIZE = 64 * 1024  # 64KB of Pascal source is ample for this use

# Per-compile resource ceilings applied to the compiler subprocess (inherited
# by the sjasmplus child it spawns), so a single hostile source can't exhaust
# the container regardless of the container-level cgroup caps: CPU seconds (a
# backstop to the wall-clock timeout), max size of any single
# output/intermediate file (defends against disk fill), and total address
# space (defends against a memory blow-up). Kept under the container
# mem_limit so a greedy compile fails on its own RLIMIT rather than tripping
# a cgroup OOM that could catch a concurrent one.
RLIMIT_CPU_SECONDS = COMPILE_TIMEOUT + 10
RLIMIT_FSIZE_BYTES = 32 * 1024 * 1024
RLIMIT_AS_BYTES = 1024 * 1024 * 1024

# The project machine selects pasta's codegen target: the runtime differs per
# machine (48K/128K/Next) even though every target ships as a TAP.
MACHINE_FLAGS = {
    '48': '--zx48',
    '128': '--zx128',
    'next': '--zxnext',
}


def _apply_rlimits():
    resource.setrlimit(resource.RLIMIT_CPU, (RLIMIT_CPU_SECONDS, RLIMIT_CPU_SECONDS))
    resource.setrlimit(resource.RLIMIT_FSIZE, (RLIMIT_FSIZE_BYTES, RLIMIT_FSIZE_BYTES))
    resource.setrlimit(resource.RLIMIT_AS, (RLIMIT_AS_BYTES, RLIMIT_AS_BYTES))


class SessionVars(BaseModel):
    x_hasura_role: str = Field(alias="x-hasura-role")
    # Absent for the public/unauthenticated role (e.g. the bot rendering a
    # public project). In pydantic v2 Optional[...] without a default is still
    # required, so default to None to make the field genuinely optional.
    x_hasura_user_id: Optional[UUID] = Field(default=None, alias="x-hasura-user-id")


# Additional project files staged into the compile workdir so {$I file}
# includes resolve next to program.pas. Names become real filenames there,
# so they are held to a safe charset with no path separators (mirrors the
# project_file DB constraint), and names stemmed 'program' are reserved for
# the main source, its intermediates and the TAP output so a staged file
# can't shadow them.
MAX_PROJECT_FILES = 32
MAX_FILE_CONTENT_SIZE = 256 * 1024  # matches the DB cap; base64 for binaries
# Bound the whole request, not just each file: 32 x 256KB would otherwise
# let one compile call carry ~8MB into the tmpfs.
MAX_TOTAL_FILES_SIZE = 2 * 1024 * 1024
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
    code: str
    # Optional so existing single-argument callers (and the GraphQL schema's
    # nullable machine) keep working; unset means the classic 48K target.
    machine: Optional[str] = '48'
    files: Optional[list[ProjectFile]] = None

    @field_validator('code')
    @classmethod
    def validate_code_size(cls, v):
        if not v or not v.strip():
            raise ValueError('Input cannot be empty')
        if len(v) > MAX_INPUT_SIZE:
            raise ValueError(f'Input too large. Maximum size is {MAX_INPUT_SIZE} bytes')
        return v

    @field_validator('files')
    @classmethod
    def validate_file_count(cls, v):
        if v and len(v) > MAX_PROJECT_FILES:
            raise ValueError(f'Too many files. Maximum is {MAX_PROJECT_FILES}')
        if v and sum(len(f.content) for f in v) > MAX_TOTAL_FILES_SIZE:
            raise ValueError(
                f'Files too large. Maximum total is {MAX_TOTAL_FILES_SIZE} bytes')
        return v

    @field_validator('machine')
    @classmethod
    def validate_machine(cls, v):
        if v is None:
            return '48'
        if v not in MACHINE_FLAGS:
            raise ValueError("machine must be one of '48', '128' or 'next'")
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

    # A fresh directory per request: the source is always program.pas and the
    # compiler runs with cwd here, so intermediates (program.z80, .lst, .brk)
    # and the program.tap output land alongside it with no server paths in
    # any diagnostic.
    workdir = tempfile.mkdtemp(prefix='pasta80-')
    try:
        with open(os.path.join(workdir, 'program.pas'), 'w') as f:
            f.write(args.input.code)
        stage_project_files(workdir, args.input.files)

        # Compile in its own process group so a timeout can kill pasta and
        # the sjasmplus backend it spawns, not just the parent. --opt --dep
        # is the author-recommended flag set: without dependency analysis
        # the full runtime is linked in and larger programs don't fit.
        proc = subprocess.Popen(
            ['pasta', MACHINE_FLAGS[args.input.machine], '--opt', '--dep',
             '--tap', 'program.pas'],
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

        output = ((stdout or b'') + (stderr or b'')).decode(errors='replace')
        output = output.replace(workdir + os.sep, '').replace(workdir, '')
        tap_path = os.path.join(workdir, 'program.tap')

        # pasta's exit code is unreliable after a compile error (its Error()
        # longjmps out of Build and clobbers the result), so failure is
        # detected from the diagnostics and the absence of the TAP. The
        # compiler stops at the first error, printing the offending source
        # line, a caret, and '*** Error at LINE,COL: message' on stdout;
        # sjasmplus diagnostics (': error:') cover the assembly stage.
        failed = (proc.returncode != 0
                  or '*** Error' in output
                  or not os.path.exists(tap_path))
        if failed:
            lines = [l for l in output.splitlines()
                     if '*** Error' in l or ': error:' in l]
            diagnostics = '\n'.join(lines) if lines else output
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=diagnostics.strip()[:2000] or 'Compilation failed')

        with open(tap_path, 'rb') as f:
            return CompileResult(base64_encoded=base64.b64encode(f.read()).decode())

    finally:
        shutil.rmtree(workdir, ignore_errors=True)
