import tempfile
import base64
import os
import re
import resource
import shutil
import signal
import subprocess
from fastapi import APIRouter, Header, HTTPException, status
from typing import Optional
from pydantic import BaseModel, Field, field_validator
from uuid import UUID

# Bound a compile so a hostile/pathological C program can't pin the container.
# Kept under gif-service's 20s upstream timeout so the caller gets a clean error.
COMPILE_TIMEOUT = int(os.environ.get("COMPILE_TIMEOUT", "15"))
MAX_INPUT_SIZE = 64 * 1024  # 64KB of C source is ample for this use

# Per-compile resource ceilings applied to the compiler subprocess (inherited
# by the sccz80/zsdcc/appmake children zcc spawns), so a single hostile source
# can't exhaust the container regardless of the cgroup caps: CPU seconds (a
# backstop to the wall-clock timeout), max size of any single output/
# intermediate file (defends against disk fill), and total address space per
# process. Kept under the container mem_limit so a greedy process fails on its
# own RLIMIT rather than tripping a cgroup OOM that could catch a concurrent
# compile.
RLIMIT_CPU_SECONDS = COMPILE_TIMEOUT + 10
RLIMIT_FSIZE_BYTES = 32 * 1024 * 1024
RLIMIT_AS_BYTES = 1024 * 1024 * 1024


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


# Additional project files staged into the compile workdir so #include
# "header.h" (and #incbin-style data pulls) resolve next to program.c. Names
# become real filenames there, so they are held to a safe charset with no
# path separators (mirrors the project_file DB constraint), and names stemmed
# 'program' are reserved for the main source, the zcc intermediates and the
# TAP output so a staged file can't shadow them.
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
    code: str
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
    # Diagnostics from staged include files carry the workdir prefix; strip
    # it so they read as the bare project filename.
    workdir = os.path.dirname(c_filename)
    if workdir:
        cleaned = cleaned.replace(workdir + os.sep, "").replace(workdir, "")
    # Defensive: catch any leftover /path/to/tmpXXXX.c that slipped through.
    cleaned = re.sub(r"\S*/tmp\w+\.c", "program.c", cleaned)
    return cleaned.strip()


@compile_endpoint.post("/", response_model=CompileResult)
def handle_compile_request(
        args: RequestArgs,
        authorization: Optional[str] = Header(None)) -> Optional[CompileResult]:

    # A fresh directory per request: the source is always program.c and any
    # additional project files are staged alongside it so #include "..."
    # resolves. Outputs and intermediates land in the same directory.
    path = tempfile.mkdtemp(prefix='z88dk-')
    c_filename = os.path.join(path, 'program.c')
    out_filename = os.path.join(path, 'program')
    tap_filename = f'{out_filename}.tap'

    try:
        with open(c_filename, 'w') as f:
            f.write(args.input.code)
        stage_project_files(path, args.input.files)
        # Compile in its own process group so a timeout can kill zcc and every
        # child it spawned (sdcc etc.), not just the parent.
        proc = subprocess.Popen(
            [*zcc_args(args.input.code), c_filename, '-o', out_filename],
            cwd=path,  # the temp dir (/tmp tmpfs), so any CWD-relative
                       # intermediate zcc drops lands there, not the read-only
                       # image layer
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
            preexec_fn=_apply_rlimits,
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
        # Clean up the per-request directory: source, staged files, the tape,
        # and any intermediates zcc left behind.
        shutil.rmtree(path, ignore_errors=True)
