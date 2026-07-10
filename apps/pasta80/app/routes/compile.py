import base64
import json
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
# includes resolve relative to program.pas. Names are relative paths (e.g.
# lib/util.pas) staged under their folders — mirroring the project's download
# ZIP — whose segments are held to a safe charset with no leading dot (so no
# '.'/'..' segments: staging can never escape the workdir; mirrors the
# project_file DB constraints). Segments stemmed 'program' are reserved for
# the main source, its intermediates and the TAP output so a staged file or
# folder can't shadow them.
MAX_PROJECT_FILES = 32
MAX_FILE_CONTENT_SIZE = 256 * 1024  # matches the DB cap; base64 for binaries
# Bound the whole request, not just each file: 32 x 256KB would otherwise
# let one compile call carry ~8MB into the tmpfs.
MAX_TOTAL_FILES_SIZE = 2 * 1024 * 1024
PROJECT_FILE_SEGMENT_RE = re.compile(r'[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}')
MAX_FILE_PATH_LENGTH = 193  # DB folder cap (128) + '/' + name cap (64)


class ProjectFile(BaseModel):
    name: str
    content: str
    is_binary: Optional[bool] = False

    @field_validator('name')
    @classmethod
    def validate_name(cls, v):
        if len(v) > MAX_FILE_PATH_LENGTH or not all(
                PROJECT_FILE_SEGMENT_RE.fullmatch(seg) for seg in v.split('/')):
            raise ValueError(
                'File paths may only use letters, digits, dots, dashes and '
                'underscores in each segment (max 64 chars, no leading dot), '
                'joined by single slashes')
        return v

    @field_validator('content')
    @classmethod
    def validate_content_size(cls, v):
        if len(v) > MAX_FILE_CONTENT_SIZE:
            raise ValueError(
                f'File too large. Maximum size is {MAX_FILE_CONTENT_SIZE} bytes')
        return v


def stage_project_files(workdir, files):
    """Write the additional project files into the compile workdir, creating
    their folders. Validated segments cannot traverse out of workdir."""
    seen = set()
    for pf in files or []:
        lower = pf.name.lower()
        # Once folders exist on disk, a directory can shadow the main source
        # or its outputs just like a file, so the rule covers every segment.
        if any(seg.split('.', 1)[0] == 'program' for seg in lower.split('/')):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Path '{pf.name}' is reserved for the main source")
        if lower in seen:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Duplicate file name '{pf.name}'")
        seen.add(lower)
        path = os.path.join(workdir, *pf.name.split('/'))
        if pf.is_binary:
            try:
                payload = base64.b64decode(pf.content, validate=True)
            except (ValueError, TypeError):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"File '{pf.name}' is not valid base64")
            mode = 'wb'
        else:
            payload, mode = pf.content, 'w'
        # A file and a folder cannot share a name on disk; the OS error from
        # creating one over the other surfaces as a clean rejection.
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, mode) as f:
                f.write(payload)
        except (FileExistsError, NotADirectoryError, IsADirectoryError):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Path '{pf.name}' clashes with another project file")


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
    # Debugger line map, riding the CompileResult.sld field the Hasura action
    # type already declares (SLD text for sjasmplus, JSON for zxbasic; JSON
    # here): {"kind": "pasta80", "files": {"<file>": [[line, addr], ...]}}
    # mapping 1-based source lines to the address of the first code emitted
    # for them — "" keys the main source, other keys are staged {$i} include
    # files by their relative path. Null when the debug-info phase fails —
    # the compile itself still succeeds without it.
    sld: Optional[str] = None


# Pasta80's code generator writes every Pascal source line into the .z80 as
# a comment marker `; [N] <raw source line>` (N 0-based within the file
# being inlined at that point), and the sjasmplus listing then carries each
# marker WITH the address where that line's code begins:
#
#     2145  A21C              ; [6]     WriteLn(I);
#     2146  A21C 21 B8 A1                     ld      hl,global102 + 0
#
# Rows from include files (the rtl .asm sources) are flagged with `+` after
# the listing line number; the compiler-generated .z80 — runtime .pas
# markers, user includes and the main program alike — lists unflagged.
# Markers are attributed to a source by their echoed text matching that
# source at the marker's 0-based line, which holds regardless of how {$i}
# includes interleave their own `[0]`-based blocks: the main source, each
# staged include, and the runtime's .pas files all become candidates, and a
# marker matching MORE than one candidate is ambiguous and dropped rather
# than guessed (a marker matching only runtime text matches no candidate
# and drops the same way).
LST_ROW_RE = re.compile(r'^\s*(\d+)(\+*)\s+([0-9A-F]{4})(.*)$')
LST_MARKER_RE = re.compile(r'^\s*; \[(\d+)\] (.*)$')
LST_BYTES_RE = re.compile(r'^\s[0-9A-F]{2}[\s$]')


def parse_listing_line_map(lst_path: str, sources: dict) -> dict:
    """{file_key: [[1-based line, address], ...]} for source lines with code.

    `sources` maps file keys to their text ('' = the main source, staged
    text files by relative path). A marker only maps when at least one
    unflagged row between it and the next marker emits bytes — declarations
    and blank lines produce no code and would otherwise alias onto the next
    real line's address.
    """
    split = {key: text.split('\n') for key, text in sources.items()}
    pending = None  # (file_key, line0, addr) awaiting a code row
    entries = {}
    with open(lst_path, errors='replace') as f:
        for row in f:
            m = LST_ROW_RE.match(row)
            if not m or m.group(2):
                continue
            addr, rest = int(m.group(3), 16), m.group(4)
            marker = LST_MARKER_RE.match(rest)
            if marker:
                line0 = int(marker.group(1))
                echoed = marker.group(2).rstrip()
                candidates = [
                    key for key, lines in split.items()
                    if line0 < len(lines) and echoed == lines[line0].rstrip()
                ]
                pending = ((candidates[0], line0, addr)
                           if len(candidates) == 1 else None)
                continue
            if pending is not None and LST_BYTES_RE.match(rest):
                key, line0, marker_addr = pending
                entries.setdefault(key, {}).setdefault(line0 + 1, marker_addr)
                pending = None
    return {
        key: [[line, addr] for line, addr in sorted(per_file.items())]
        for key, per_file in entries.items()
    }


def build_debug_info(workdir: str, source: str, files) -> Optional[str]:
    """The debugger line-map JSON from the --keepint listing, or None.
    Best-effort by design: any failure here only costs the debug map,
    never the compile."""
    try:
        sources = {'': source}
        for pf in files or []:
            if not pf.is_binary:
                sources[pf.name] = pf.content
        file_maps = parse_listing_line_map(
            os.path.join(workdir, 'program.lst'), sources)
        file_maps = {k: v for k, v in file_maps.items() if v}
        if not file_maps:
            return None
        return json.dumps({'kind': 'pasta80', 'files': file_maps})
    except Exception as e:
        print(f"debug-info generation failed (compile unaffected): {e}")
        return None


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
        # --keepint keeps the intermediates (program.z80, program.lst) the
        # debugger line map is parsed from; they live in the per-request
        # tmpfs workdir and vanish with it.
        proc = subprocess.Popen(
            ['pasta', MACHINE_FLAGS[args.input.machine], '--opt', '--dep',
             '--keepint', '--tap', 'program.pas'],
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
            return CompileResult(
                base64_encoded=base64.b64encode(f.read()).decode(),
                sld=build_debug_info(workdir, args.input.code, args.input.files))

    finally:
        shutil.rmtree(workdir, ignore_errors=True)
