import tempfile
import base64
import contextlib
import io
import json
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
# resolves relative to program.bas. Names are relative paths (e.g.
# lib/util.bas) staged under their folders — mirroring the project's download
# ZIP — whose segments are held to a safe charset with no leading dot (so no
# '.'/'..' segments: staging can never escape the workdir; mirrors the
# project_file DB constraints). Segments stemmed 'program' are reserved for
# the main source and its outputs so a staged file or folder can't shadow
# them.
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
    basic: str
    files: Optional[list[ProjectFile]] = None

    @field_validator('files')
    @classmethod
    def validate_file_count(cls, v):
        if v and len(v) > MAX_PROJECT_FILES:
            raise ValueError(f'Too many files. Maximum is {MAX_PROJECT_FILES}')
        if v and sum(len(f.content) for f in v) > MAX_TOTAL_FILES_SIZE:
            raise ValueError(
                f'Files too large. Maximum total is {MAX_TOTAL_FILES_SIZE} bytes')
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
    # Debugger line map, riding the CompileResult.sld field the Hasura action
    # type already declares (the sjasmplus service returns SLD text in it;
    # here it carries JSON): {"kind": "zxbasic", "anchor": N, "lines": [...]}.
    # anchor = the address of the runtime's per-line CHECK_BREAK call target
    # (from zxbc's -M label map); lines = the source lines that received an
    # --enable-break check (from a -f asm pass). Null when the debug-info
    # phase fails — the compile itself still succeeds without it.
    sld: Optional[str] = None


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
    """Build the zxbc argument list for a program source.

    --enable-break makes the BREAK key work in compiled programs AND is what
    the IDE's line breakpoints ride on: it compiles in one CHECK_BREAK call
    per source line with the line number in HL, which the emulator's
    linecall breakpoints anchor to (see build_debug_info).
    """
    args = ['-f', 'tap', '-a', '-B', '--enable-break']
    if ZXNEXT_DIRECTIVE_RE.search(source) or ZXNEXT_INCLUDE_RE.search(source):
        args += ['--arch', 'zxnext']
    return args


# The zxbc/zxbasm -M label map is `HEX: label` per line; the linecall
# anchor is the runtime's per-line break-check routine.
CHECK_BREAK_LABEL = '.core.CHECK_BREAK'
MMAP_LINE_RE = re.compile(r'^([0-9A-Fa-f]{4}):\s+(\S+)\s*$')

# In `-f asm` output, each --enable-break check is the adjacent pair
#   ld hl, <LINE>
#   call .core.CHECK_BREAK
# where LINE is the statement's line number WITHIN ITS OWN FILE — includes
# overlap the main source's numbering, so a bare HL value cannot say which
# file it belongs to. The generated asm is organised as the main flow
# (`.core.__MAIN_PROGRAM__:` …) followed by one `_name:` block per
# SUB/FUNCTION, and the preprocessor (zxbpp) reports which file defined
# each function — so every check pair attributes to a file by its
# enclosing block. Include-file pairs are then REWRITTEN to disjoint
# virtual line ranges (base 10000·k per include; `ld hl, N` assembles to
# 3 bytes for any N, so the binary layout is untouched) and the asm is
# assembled with zxbasm — the same assembler zxbc drives internally. The
# emulator's linecall breakpoints arm the virtual numbers unchanged.
#
# Pairs attributable to neither the main source nor a staged include
# (stdlib functions) are rewritten to the UNMAPPED sentinel so they can
# never alias a real line's breakpoint or highlight.
ASM_LD_HL_RE = re.compile(r'^\s*ld hl, (\d+)\s*$')
ASM_CHECK_BREAK_RE = re.compile(r'^\s*call \.core\.CHECK_BREAK\s*$')
ASM_MAIN_LABEL = '.core.__MAIN_PROGRAM__:'
ASM_FUNC_LABEL_RE = re.compile(r'^(_\w+):\s*$')

VIRTUAL_BASE_STEP = 10000
UNMAPPED_SENTINEL = 0xFFFF

# zxbpp's flattened output: `#line N "path"` directives mark file context;
# SUB/FUNCTION statements under an include's context tell us which file
# each generated `_name:` block came from. Any other executable-looking
# top-level statement inside an include makes attribution unsafe (its
# check would sit in the MAIN flow with include-file numbering), so the
# pipeline bails to the main-only map.
PP_LINE_DIRECTIVE_RE = re.compile(r'^#line \d+ "([^"]*)"')
PP_FUNC_RE = re.compile(
    r'(?i)^(?:SUB|FUNCTION)\s+(?:FASTCALL\s+|STDCALL\s+)*([A-Za-z_]\w*)')
PP_END_FUNC_RE = re.compile(r'(?i)^END\s+(?:SUB|FUNCTION)\b')
PP_HARMLESS_RE = re.compile(r"(?i)^(?:REM\b|'|#|DECLARE\s+(?:SUB|FUNCTION)\b)")


class UnsafeIncludeError(Exception):
    """An include holds top-level executable statements — per-file
    attribution would be wrong, so the caller falls back to main-only."""


def parse_check_break_anchor(mmap_path: str) -> Optional[int]:
    """The CHECK_BREAK address from a -M label map, or None."""
    with open(mmap_path) as f:
        for row in f:
            m = MMAP_LINE_RE.match(row)
            if m and m.group(2) == CHECK_BREAK_LABEL:
                return int(m.group(1), 16)
    return None


def parse_function_files(pp_output: str, staged: set) -> dict:
    """{'_name' (lowercased): file_key} from zxbpp's flattened output.

    file_key is '' for the main source, the staged relative path for a
    project include, and the raw path otherwise (stdlib — attributable but
    never mapped). Raises UnsafeIncludeError when a staged include carries
    top-level statements other than SUB/FUNCTION definitions, comments and
    directives.
    """
    func_to_file = {}
    cur = ''
    depth = 0
    for raw in pp_output.split('\n'):
        m = PP_LINE_DIRECTIVE_RE.match(raw)
        if m:
            name = m.group(1)
            if name == 'program.bas' or name.endswith('/program.bas'):
                cur = ''
            elif name in staged or name.lstrip('./') in staged:
                cur = name.lstrip('./') if name.lstrip('./') in staged else name
            else:
                cur = name
            continue
        s = raw.strip()
        if not s or PP_HARMLESS_RE.match(s):
            continue
        m = PP_FUNC_RE.match(s)
        if m:
            func_to_file['_' + m.group(1).lower()] = cur
            depth += 1
            continue
        if PP_END_FUNC_RE.match(s):
            depth = max(0, depth - 1)
            continue
        if cur != '' and cur in staged and depth == 0:
            raise UnsafeIncludeError(
                f'top-level statement in include {cur!r}: {s[:60]!r}')
    return func_to_file


def attribute_and_rewrite_asm(asm_path: str, func_to_file: dict,
                              staged: set) -> dict:
    """Attribute every check pair to its file, rewrite include pairs to
    virtual line numbers in place, and return {file_key: [[line, virt]]}.

    Bases are assigned per staged include in sorted-name order so the
    mapping is deterministic. Pairs beyond the 16-bit virtual space and
    pairs from non-project files rewrite to the unmapped sentinel.
    """
    bases = {name: VIRTUAL_BASE_STEP * (i + 1)
             for i, name in enumerate(sorted(staged))}
    rows = open(asm_path, errors='replace').read().split('\n')
    entries = {}
    region = None  # None until the main label; '' = main; else a file/path
    pending = None  # (row index, line) of an ld hl awaiting its check call
    for i, row in enumerate(rows):
        if row.strip() == ASM_MAIN_LABEL.strip():
            region = ''
            pending = None
            continue
        m = ASM_FUNC_LABEL_RE.match(row)
        if m and m.group(1).lower() in func_to_file:
            region = func_to_file[m.group(1).lower()]
            pending = None
            continue
        m = ASM_LD_HL_RE.match(row)
        if m:
            pending = (i, int(m.group(1)))
            continue
        if pending is not None and ASM_CHECK_BREAK_RE.match(row):
            idx, line = pending
            pending = None
            if region == '' and 1 <= line <= 0xFFFE:
                entries.setdefault('', {}).setdefault(line, line)
                continue
            if region in bases:
                virt = bases[region] + line
                if 1 <= line and virt < UNMAPPED_SENTINEL:
                    rows[idx] = f'\tld hl, {virt}'
                    entries.setdefault(region, {}).setdefault(line, virt)
                    continue
            # Stdlib / out-of-range / pre-main: neutralise so the value can
            # never alias a mappable line.
            rows[idx] = f'\tld hl, {UNMAPPED_SENTINEL}'
            continue
        pending = None
    with open(asm_path, 'w') as f:
        f.write('\n'.join(rows))
    return {
        key: [[line, virt] for line, virt in sorted(per_file.items())]
        for key, per_file in entries.items()
    }


def run_tool(argv: list, workdir: str, extra_env: dict = None) -> tuple:
    """Run a toolchain executable (zxbpp/zxbasm) under the same rlimits,
    process-group kill and monitor discipline as the compiler. Returns
    (returncode, stdout, stderr); raises TimeoutException on timeout."""
    env = None
    if extra_env:
        env = {**os.environ, **extra_env}
    proc = subprocess.Popen(
        argv,
        cwd=workdir,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
        preexec_fn=_apply_rlimits,
        env=env,
    )
    process_monitor.register_process(proc.pid)
    try:
        stdout, stderr = proc.communicate(timeout=COMPILATION_TIMEOUT)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        raise TimeoutException(
            f"Tool timeout after {COMPILATION_TIMEOUT} seconds: {argv[0]}")
    return proc.returncode, stdout, stderr


def build_multifile_tap(workdir: str, bas_filename: str, tap_filename: str,
                        mmap_filename: str, source: str,
                        staged: set) -> Optional[str]:
    """The per-file-breakpoints pipeline: preprocess for attribution,
    compile to asm, rewrite include check pairs to virtual lines, assemble
    with zxbasm. On success program.tap and the mmap exist and the return
    value is the sld JSON; any bail returns None with no tap produced (the
    caller then runs the plain zxbc pipeline).

    Known cosmetic trade-off of the rewrite: pressing the BREAK key inside
    include code reports the virtual line number in the ROM error message.
    """
    bindir = os.path.dirname(sys.executable)
    asm_filename = os.path.join(workdir, 'program.asm')
    zxnext = bool(ZXNEXT_DIRECTIVE_RE.search(source)
                  or ZXNEXT_INCLUDE_RE.search(source))
    try:
        rc, pp_out, pp_err = run_tool(
            [os.path.join(bindir, 'zxbpp'), bas_filename], workdir)
        if rc != 0:
            return None
        func_to_file = parse_function_files(pp_out, staged)

        args = ['-f', 'asm', '--enable-break']
        if zxnext:
            args += ['--arch', 'zxnext']
        if not compile_with_subprocess(bas_filename, asm_filename, args):
            return None

        files = attribute_and_rewrite_asm(asm_filename, func_to_file, staged)
        files = {k: v for k, v in files.items() if v}
        if not files:
            return None

        # zxbasm's CLI cannot express "tap with BASIC loader" in the pinned
        # release (see app/zxbasm_tap.py); drive it through the workaround
        # module in its own process.
        app_root = os.path.dirname(os.path.dirname(os.path.dirname(
            os.path.abspath(__file__))))
        basm = [sys.executable, '-m', 'app.zxbasm_tap', '-t', '-a', '-B',
                '-M', mmap_filename, '-o', tap_filename, asm_filename]
        if zxnext:
            basm.insert(3, '-N')
        rc, _, basm_err = run_tool(basm, workdir, extra_env={
            'PYTHONPATH': app_root + os.pathsep + os.environ.get('PYTHONPATH', '')})
        if rc != 0 or not os.path.exists(tap_filename):
            print(f"zxbasm assembly failed (falling back): {basm_err[:400]}")
            return None

        anchor = parse_check_break_anchor(mmap_filename)
        if not anchor:
            return None
        return json.dumps({'kind': 'zxbasic', 'anchor': anchor, 'files': files})
    except UnsafeIncludeError as e:
        print(f"multi-file map unavailable ({e}); falling back to main-only")
        return None
    except TimeoutException:
        raise
    except Exception as e:
        print(f"multi-file pipeline failed (falling back): {e}")
        return None


def build_debug_info(workdir: str, bas_filename: str, source: str) -> Optional[str]:
    """The main-only debugger line map (fallback pipeline), or None.

    Best-effort by design: the anchor comes from a -M label map emitted by
    the tap compile, and the breakable-line set from a dedicated asm pass.
    Any failure here only costs the debug map, never the compile.
    """
    asm_filename = os.path.join(workdir, 'program.asm')
    mmap_filename = os.path.join(workdir, 'program.mmap')
    try:
        args = ['-f', 'asm', '--enable-break']
        if ZXNEXT_DIRECTIVE_RE.search(source) or ZXNEXT_INCLUDE_RE.search(source):
            args += ['--arch', 'zxnext']
        if not compile_with_subprocess(bas_filename, asm_filename, args):
            return None
        # Attribute in main-only mode: no function map, so every function
        # block is unknown (region None) and only main-flow pairs map.
        # The rewrite is skipped by pointing at a copy? No — main-only mode
        # must not modify the asm it does not assemble; parse without
        # rewriting by working on a throwaway copy.
        anchor = parse_check_break_anchor(mmap_filename)
        lines = set()
        pending = None
        region = None
        for row in open(asm_filename, errors='replace'):
            if row.strip() == ASM_MAIN_LABEL.strip():
                region = ''
                continue
            if ASM_FUNC_LABEL_RE.match(row):
                # Function blocks are unattributable without the
                # preprocessor map; their pairs stay unmapped (they may be
                # main-file functions, a loss the multi-file pipeline
                # avoids).
                region = None
                continue
            m = ASM_LD_HL_RE.match(row)
            if m:
                pending = int(m.group(1))
                continue
            if pending is not None and ASM_CHECK_BREAK_RE.match(row) \
                    and region == '' and 1 <= pending <= 0xFFFE:
                lines.add(pending)
            pending = None
        if not anchor or not lines:
            return None
        return json.dumps({
            'kind': 'zxbasic', 'anchor': anchor,
            'files': {'': [[line, line] for line in sorted(lines)]},
        })
    except Exception as e:
        print(f"debug-info generation failed (compile unaffected): {e}")
        return None


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
    mmap_filename = os.path.join(workdir, 'program.mmap')

    try:
        with open(bas_filename, 'w') as f:
            f.write(args.input.basic)
        stage_project_files(workdir, args.input.files)

        # Per-file breakpoints pipeline first (preprocess → asm → virtual
        # line rewrite → zxbasm). Any bail returns None and the plain zxbc
        # build below runs instead with a main-only map.
        staged_names = {pf.name for pf in args.input.files or []
                        if not pf.is_binary}
        try:
            multifile_sld = build_multifile_tap(
                workdir, bas_filename, tap_filename, mmap_filename,
                args.input.basic, staged_names)
        except TimeoutException:
            raise HTTPException(
                status_code=status.HTTP_408_REQUEST_TIMEOUT,
                detail=f"Compilation timeout exceeded ({COMPILATION_TIMEOUT} seconds). Code may contain infinite loops or be too complex."
            )
        if multifile_sld and os.path.exists(tap_filename):
            with open(tap_filename, 'rb') as f:
                return CompileResult(
                    base64_encoded=base64.b64encode(f.read()).decode(),
                    sld=multifile_sld)

        # Compile the tape file from basic source with timeout. -M emits the
        # label memory map the debugger's linecall anchor is read from.
        try:
            success = compile_with_subprocess(
                bas_filename, tap_filename,
                [*zxbc_args(args.input.basic), '-M', mmap_filename])
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
        return CompileResult(
            base64_encoded=base64_encoded,
            sld=build_debug_info(workdir, bas_filename, args.input.basic))

    finally:
        # Always clean up the per-request directory
        shutil.rmtree(workdir, ignore_errors=True)
