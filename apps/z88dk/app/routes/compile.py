import tempfile
import base64
import json
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
# Must stay under gif-service's GRAPHQL_TIMEOUT_MS (default 20s) so the caller
# gets a clean error; a deployment raising COMPILE_TIMEOUT must raise that too.
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
# "header.h" (and #incbin-style data pulls) resolve relative to program.c.
# Names are relative paths (e.g. lib/util.h) staged under their folders —
# mirroring the project's download ZIP — whose segments are held to a safe
# charset with no leading dot (so no '.'/'..' segments: staging can never
# escape the workdir; mirrors the project_file DB constraints). Segments
# stemmed 'program' are reserved for the main source, the zcc intermediates
# and the TAP output so a staged file or folder can't shadow them.
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


class Action(BaseModel):
    name: str


class RequestArgs(BaseModel):
    session_variables: SessionVars
    input: Input
    action: Action


class CompileResult(BaseModel):
    base64_encoded: str
    # Debugger line map, riding the CompileResult.sld field the Hasura action
    # type already declares (SLD text for sjasmplus, JSON for zxbasic and
    # pasta80; JSON here): {"kind": "z88dk", "files": {"<file>": [[line,
    # addr], ...]}, "labels": {"<symbol>": addr}} where the "" file key is
    # the main source (program.c) and other keys are staged project files by
    # their relative path; labels are the user module's code symbols (linked
    # absolute addresses) for the engine's sym table, omitted when empty.
    # Null when the debug-info phase fails — the compile itself still
    # succeeds without it.
    sld: Optional[str] = None


compile_endpoint = APIRouter()

# z88dk has two mutually exclusive C libraries. The default here is newlib
# (-clib=sdcc_iy: <arch/zx.h>, zx_cls(attr), ...). Sources written against the
# classic library announce themselves by including <spectrum.h>, which only
# exists there; those must be built with the classic lib instead, and on the
# +zx target classic stdio needs -lndos to satisfy its file-I/O stubs
# (writebyte etc.) or the link fails.
CLASSIC_INCLUDE_RE = re.compile(r"#include\s*[<\"]spectrum\.h[>\"]")


def zcc_args(source: str) -> list:
    """Build the zcc argument list for a program source.

    --list --c-code-in-asm -m emit the debug artifacts the IDE's line
    breakpoints are parsed from (program.c.lis + program.map — see
    build_debug_info); they do not change codegen.
    """
    debug = ['--list', '--c-code-in-asm', '-m']
    if CLASSIC_INCLUDE_RE.search(source):
        return ['zcc', '+zx', '-vn', '-create-app', '-lndos', *debug]
    return ['zcc', '+zx', '-vn', '-create-app', '-clib=sdcc_iy', '-startup=0', *debug]


# ---------------------------------------------------------------------------
# Debugger line map.
#
# Only program.c is compiled (staged files are #include material), so all
# user code appears in program.c.lis with MODULE-RELATIVE offsets; the .map
# from -m carries the linked absolute addresses. The listing marks C lines
# in one of two dialects, depending on which compiler zcc picked:
#
#   zsdcc  (sdcc_iy):   ;<file>:<line>: <source text>     (comment rows)
#   sccz80 (classic):   C_LINE <line>,"<file[::scope]>"   (directives)
#
# In both, the code emitted for the marked line follows as rows carrying a
# 4-hex-digit module offset plus byte columns. Absolute address = offset +
# module base, where base comes from any user-module symbol the .map and
# the listing share (e.g. _main: map $9380, listing offset 001c -> base
# $9364). Marker files that are neither the main source nor a staged
# project file (system headers) are dropped; zcc is handed a relative
# program.c so markers for staged headers come out relative, and
# workdir-prefixed absolute spellings are folded back defensively.
#
# Inline assembly differs per dialect: sccz80 emits a C_LINE per asm source
# line inside #asm...#endasm, so those rows map like any C line. zsdcc
# emits a single marker citing the __endasm line BEFORE the block's rows,
# each of which echoes its (whitespace-reformatted) source text — those
# rows are attributed to their own source lines by matching the echoed
# text against the block's source, with a monotonic cursor so repeated
# instructions map in order. Blank/comment source lines emit no rows; a
# row whose text matches nothing (e.g. a macro expansion) stays unmapped.
# ---------------------------------------------------------------------------

# z80asm derives the module name from the source path: 'program_c' for the
# relative program.c the endpoint passes ('X_tmp_..._program_c' for an
# absolute path). Match by suffix — the 'program' stem is reserved for the
# main source, so nothing else can end this way.
USER_MODULE_SUFFIX = 'program_c'
MAP_SYMBOL_RE = re.compile(
    r'^(\w+)\s+= \$([0-9A-Fa-f]{1,4}) ; addr, (?:public|local), , (\S+), (\S+),')
LIS_OFFSET_RE = re.compile(r'^\s*\d*\s+([0-9a-f]{4})\s+[0-9a-f]{2}')
LIS_LABEL_RE = re.compile(r'^\s*\d*\s+\.?(\w+):?\s*$')
LIS_SDCC_MARKER_RE = re.compile(r'^\s*\d*\s+;([^\s:][^:]*):(\d+):')
LIS_CLINE_RE = re.compile(r'^\s*\d*\s+C_LINE\s+(\d+),"([^"]+)"')
# An offset row with its echoed source text (the trailing column after the
# byte pairs) — used to attribute zsdcc inline-asm rows to source lines.
LIS_ROW_TEXT_RE = re.compile(r'^\s*\d*\s+([0-9a-f]{4})\s+(?:[0-9a-f]{2})+\s+(\S.*)$')
# Inline-assembly block delimiters as they appear in the C source.
ASM_START_RE = re.compile(r'^\s*(?:__asm|#asm)\b')
ASM_END_RE = re.compile(r'^\s*(?:__endasm|#endasm)\b')


def _asm_text_key(text: str) -> str:
    """Whitespace-free, case-folded form for matching a listing row's echoed
    asm text against a source line: zsdcc re-tokenises whitespace (spaces
    become tabs, comma spacing may shift) but preserves the token text."""
    return ''.join(text.split()).casefold()


def parse_map_symbols(map_path: str) -> dict:
    """{symbol: address} for the user module's code section."""
    symbols = {}
    with open(map_path, errors='replace') as f:
        for row in f:
            m = MAP_SYMBOL_RE.match(row)
            if (m and m.group(3).endswith(USER_MODULE_SUFFIX)
                    and m.group(4) == 'code_compiler'):
                symbols[m.group(1)] = int(m.group(2), 16)
    return symbols


def normalise_marker_file(raw: str, staged: set, workdir: str = '') -> Optional[str]:
    """The project-file key for a marker's file reference, or None to drop.
    '' = the main source; staged files key by their relative path."""
    # sccz80 suffixes scope onto the file ("c.c::main::0::1"): strip it.
    name = raw.split('::', 1)[0].strip()
    # zcc is handed a relative program.c so markers normally come out
    # relative, but fold workdir-prefixed absolute spellings back to their
    # staged relative path in case a toolchain version absolutises them.
    # Absolute paths outside the workdir (system headers, preprocessor
    # temp files) fall through and drop on the staged-membership check.
    if workdir and os.path.isabs(name):
        rel = os.path.relpath(name, workdir)
        if not rel.startswith('..'):
            name = rel
    if name in ('program.c', './program.c') or name.endswith('/program.c'):
        return ''
    if name.startswith('./'):
        name = name[2:]
    return name if name in staged else None


def parse_listing_line_map(lis_path: str, staged: set, sources: dict = None,
                           workdir: str = '') -> tuple:
    """({file_key: {line: offset}}, {symbol: offset}) from a .lis.

    Offsets are module-relative; the caller rebases them with the map. The
    marker (either dialect) applies to the first offset-bearing row after
    it; first-wins per (file, line), so a line maps to where its code
    starts. Labels are collected alongside so the caller can anchor the
    module base.

    sources ({file_key: source text}) enables inline-assembly attribution:
    when a marker cites a __endasm/#endasm line, the block's echoed rows
    are matched against the source lines between the opener and closer so
    each instruction maps to its own line (zsdcc emits exactly one marker
    per block, before the rows; sccz80 marks asm lines individually, so
    its windows close on the next marker without consuming anything).
    Without sources the whole block maps to the marker line as before.
    """
    lines = {}
    labels = {}
    pending = None        # (file_key, line) awaiting a code row
    pending_labels = []   # label names awaiting their offset
    src_lines = {k: v.splitlines() for k, v in (sources or {}).items()}
    asm_window = None     # (file_key, endasm line) of an open inline-asm block
    asm_cursor = 0        # next candidate source line within the window
    with open(lis_path, errors='replace') as f:
        for row in f:
            m = LIS_SDCC_MARKER_RE.match(row) or LIS_CLINE_RE.match(row)
            if m:
                # The two regexes disagree on group order.
                raw_file, line = ((m.group(1), m.group(2))
                                  if m.re is LIS_SDCC_MARKER_RE
                                  else (m.group(2), m.group(1)))
                key = normalise_marker_file(raw_file, staged, workdir)
                asm_window = None  # any marker ends the previous block
                pending = None
                if key is not None:
                    line_no = int(line)
                    src = src_lines.get(key)
                    if src is not None and line_no > len(src):
                        # sccz80 can emit a C_LINE past the file's EOF
                        # after an #asm block; a ghost line must not map.
                        continue
                    pending = (key, line_no)
                    if src is not None and ASM_END_RE.match(src[line_no - 1]):
                        for start in range(line_no - 1, 0, -1):
                            if ASM_START_RE.match(src[start - 1]):
                                asm_window = (key, line_no)
                                asm_cursor = start + 1
                                break
                continue
            lm = LIS_LABEL_RE.match(row)
            if lm:
                pending_labels.append(lm.group(1))
                continue
            om = LIS_OFFSET_RE.match(row)
            if not om:
                continue
            offset = int(om.group(1), 16)
            for name in pending_labels:
                labels.setdefault(name, offset)
            pending_labels = []
            if asm_window is not None:
                key, end_line = asm_window
                tm = LIS_ROW_TEXT_RE.match(row)
                text = _asm_text_key(tm.group(2)) if tm else ''
                if text:
                    src = src_lines[key]
                    # Monotonic cursor: repeated identical instructions
                    # match in source order; an unmatched row (e.g. a
                    # macro expansion) leaves the cursor alone and simply
                    # stays unmapped.
                    for ln in range(asm_cursor, end_line):
                        if _asm_text_key(src[ln - 1]) == text:
                            # setdefault: an asm row can never steal a C
                            # line's first-wins slot.
                            lines.setdefault(key, {}).setdefault(ln, offset)
                            asm_cursor = ln + 1
                            break
            if pending is not None:
                key, line = pending
                lines.setdefault(key, {}).setdefault(line, offset)
                pending = None
    return lines, labels


def build_debug_info(workdir: str, staged: set,
                     sources: dict = None) -> Optional[str]:
    """The debugger line-map JSON from the --list/-m artifacts, or None.
    Best-effort by design: any failure here only costs the debug map,
    never the compile. sources ({file_key: text}) feeds the inline-asm
    line attribution — see parse_listing_line_map."""
    try:
        symbols = parse_map_symbols(os.path.join(workdir, 'program.map'))
        lines, labels = parse_listing_line_map(
            os.path.join(workdir, 'program.c.lis'), staged, sources, workdir)
        # Anchor the module base on a symbol both artifacts know. Verify
        # with a second when available: a disagreement means the listing
        # and map came from different layouts, and wrong addresses are
        # worse than no map.
        bases = [addr - labels[sym] for sym, addr in symbols.items()
                 if sym in labels]
        if not bases or any(b != bases[0] or b < 0 for b in bases):
            return None
        base = bases[0]
        files = {
            key: sorted([line, base + off] for line, off in per_file.items())
            for key, per_file in lines.items()
        }
        files = {k: v for k, v in files.items() if v}
        if not files:
            return None
        payload = {'kind': 'z88dk', 'files': files}
        # User-module code symbols (functions, asm labels) are already
        # absolute — the engine annotates disassembly/backtrace with them.
        if symbols:
            payload['labels'] = symbols
        return json.dumps(payload)
    except Exception as e:
        print(f"debug-info generation failed (compile unaffected): {e}")
        return None


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


# Diagnostics returned to the client are bounded (they travel as a GraphQL
# error message and end up in the IDE's build-output view). A plain tail
# truncation loses whatever comes last — and zcc emits its warnings as it
# meets them, so a warning-heavy build could push the actual error lines
# past the cap and the user saw only warnings (#217).
DIAGNOSTICS_LIMIT = 2000
_ERROR_LINE = re.compile(r'(^|\W)errors?(\W|$)', re.IGNORECASE)


def clamp_diagnostics(output: str, limit: int = DIAGNOSTICS_LIMIT) -> str:
    """Bound the diagnostic block without losing the error lines. Output that
    fits is passed through untouched (the client does its own presentation);
    over the limit, the lines naming an error are kept in full and the rest
    is dropped with a note saying how much."""
    if len(output) <= limit:
        return output

    lines = output.splitlines()
    error_lines = [line for line in lines if _ERROR_LINE.search(line)]
    if error_lines:
        omitted = len(lines) - len(error_lines)
        kept = "\n".join(error_lines)
        if omitted:
            kept += f"\n... ({omitted} lines of warnings/other output omitted)"
        if len(kept) <= limit:
            return kept
        return kept[:limit] + "\n... (truncated)"

    return output[:limit] + "\n... (truncated)"


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
        # The source and output are passed RELATIVE (cwd is the workdir):
        # that makes the listing's markers for staged headers come out as
        # their staged relative paths, which is what the debug map keys by.
        proc = subprocess.Popen(
            [*zcc_args(args.input.code), 'program.c', '-o', 'program'],
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
            detail = clamp_diagnostics(sanitize_compiler_output(
                (stderr or b'').decode(errors='replace'), c_filename))
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=detail or 'Compilation failed')

        with open(tap_filename, 'rb') as f:
            base64_encoded = base64.b64encode(f.read()).decode()
        staged_names = {pf.name for pf in args.input.files or []}
        sources = {'': args.input.code}
        sources.update({pf.name: pf.content
                        for pf in args.input.files or [] if not pf.is_binary})
        return CompileResult(
            base64_encoded=base64_encoded,
            sld=build_debug_info(path, staged_names, sources))

    finally:
        # Clean up the per-request directory: source, staged files, the tape,
        # and any intermediates zcc left behind.
        shutil.rmtree(path, ignore_errors=True)
