import tempfile
import base64
import glob
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

# Bound a compile so a hostile/pathological input can't pin the container.
# Must stay under gif-service's GRAPHQL_TIMEOUT_MS (default 20s) so the caller
# gets a clean error; a deployment raising COMPILE_TIMEOUT must raise that too.
COMPILE_TIMEOUT = int(os.environ.get("COMPILE_TIMEOUT", "15"))
MAX_INPUT_SIZE = 64 * 1024  # 64KB of Forth source is ample for this use

# Per-compile resource ceilings applied to the assembler subprocess, so a
# single hostile source can't exhaust the container regardless of the cgroup
# caps: CPU seconds (a backstop to the wall-clock timeout), max size of any
# single output/intermediate file (defends against disk fill), and total
# address space per process. Kept under the container mem_limit so a greedy
# process fails on its own RLIMIT rather than tripping a cgroup OOM that
# could catch a concurrent compile.
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
    # Debugger line map, riding the CompileResult.sld field the Hasura
    # action type declares. zenv compiles Forth at RUNTIME, so there is no
    # line->ADDRESS map — instead the image carries a Boriel-style per-line
    # runtime marker (see build_debug_info) and the payload names its
    # anchor: {"kind": "forth", "anchor": addr, "lines": [n, ...]}. Null
    # when the debug-info phase fails — the compile itself still succeeds.
    sld: Optional[str] = None


compile_endpoint = APIRouter()

# ---------------------------------------------------------------------------
# How a Forth program becomes a TAP.
#
# zenv is an interactive Forth environment assembled from /opt/zenv/src by
# sjasmplus. The vendored tree carries a small patch (zenv-boot.patch): the
# `main` word runs a `user_boot` word before falling into the interpreter
# loop, and the image includes a generated `user.asm` just before `h_init:`
# (so the runtime dictionary starts after it).
#
# The service generates user.asm from the user's source: each line becomes
# a data blob plus an unrolled threaded `literal addr / literal len /
# EVALUATE` sequence — the same `DX literal_raw: DW ...` idiom zenv's own
# code uses, so it works under either threading mode. Per-LINE evaluation
# is required: zenv's `\` comment word skips to the end of the current
# input source, so a whole-program EVALUATE would let one comment swallow
# everything after it (interactively each typed line is its own source;
# this reproduces that).
#
# The user's text is embedded strictly as DB byte values — it can never be
# parsed as assembler directives, so the LUA directive is not reachable
# from user input and compiles need no serialization (same threat model as
# pasta80's compiler-generated asm).
#
# On boot the program runs, then execution falls into the interactive `ok`
# prompt with the user's words defined. Forth errors surface at runtime on
# the Spectrum screen (like BASIC); the assembly itself only fails for
# oversized programs (the wrapper's ASSERT) or service bugs.
# ---------------------------------------------------------------------------

ZENV_SRC_DIR = os.environ.get("ZENV_SRC_DIR", "/opt/zenv/src")

# End of image must leave dictionary headroom below zenv's workspace areas
# (PAD and friends start at 0xFB00; the image starts at 0x8000 and the core
# is ~7.5KB, so users get roughly 15KB of embedded program and ~9KB of
# runtime dictionary).
IMAGE_LIMIT = 0xD800

BUILD_WRAPPER = f"""\
	DEVICE ZXSPECTRUM48
	INCLUDE "zenv.asm"
	ASSERT $ <= 0x{IMAGE_LIMIT:04X}
	SAVETAP "program.tap", load_addr
"""

PROGRAM_TOO_LARGE = (
    "Program too large: the embedded source and the zenv core must fit "
    f"below ${IMAGE_LIMIT:04X} to leave room for the runtime dictionary."
)


def split_source_lines(code: str) -> list:
    """[(1-based line number, bytes)] for each non-blank source line.
    Tabs become spaces (zenv's parser only treats space as a delimiter)
    and blank lines are dropped."""
    normalised = code.replace('\r\n', '\n').replace('\r', '\n')
    lines = []
    for n, line in enumerate(normalised.split('\n'), start=1):
        line = line.replace('\t', ' ').rstrip()
        if line.strip():
            lines.append((n, line.encode('utf-8')))
    return lines


def generate_user_asm(code: str) -> str:
    """The generated user.asm: a `user_boot` word EVALUATEing the user's
    program line by line, plus the line texts as data bytes.

    Text is emitted as DB byte values only, never as quoted strings, so
    no user input can escape into assembler directives.

    Each line's evaluation is preceded by the patch's `user_line` word
    with the line number: while interpreting it reports the line at the
    debugger's marker anchor immediately, and while compiling it compiles
    `n user_mark` into the current definition — so lines inside colon
    definitions report at RUNTIME each time the word executes (the same
    per-line runtime check Boriel's --enable-break makes, feeding the
    emulator's linecall breakpoint/step machinery).
    """
    lines = split_source_lines(code)

    out = [
        "; Generated by the zxcode Forth service — the user's program,",
        "; evaluated line by line at boot with per-line debug markers",
        "; (see zenv-boot.patch).",
        "user_boot:",
        "\tCALL colon_code",
    ]
    for n, data in lines:
        out.append(f"\tDX literal_raw: DW {n}: DX user_line")
        out.append(f"\tDX literal_raw: DW user_line_{n}: "
                   f"DX literal_raw: DW {len(data)}: DX evaluate")
    out.append("\tDX exit")
    for n, data in lines:
        out.append(f"user_line_{n}:")
        for chunk_at in range(0, len(data), 16):
            chunk = data[chunk_at:chunk_at + 16]
            out.append("\tDB " + ",".join(str(b) for b in chunk))
    out.append("")
    return "\n".join(out)


# The sym file names every label; the marker anchor is the address the
# engine's linecall check watches (PC there with the line number in HL).
SYM_ANCHOR_RE = re.compile(
    r'^user_mark_anchor:\s+EQU\s+0x([0-9A-Fa-f]+)', re.MULTILINE)


def build_debug_info(workdir: str, code: str) -> Optional[str]:
    """The debugger line map JSON, or None. Best-effort by design: any
    failure here only costs the debug map, never the compile.

    Forth has no build-time line->address map (words are compiled at
    runtime by zenv), so the payload is linecall-shaped instead: the
    marker anchor's address plus the set of breakable lines (every
    non-blank source line — each one's marker reports its number in HL
    at the anchor)."""
    try:
        with open(os.path.join(workdir, 'program.sym'), errors='replace') as f:
            m = SYM_ANCHOR_RE.search(f.read())
        if not m:
            return None
        anchor = int(m.group(1), 16)
        if not 0x8000 <= anchor <= 0xFFFF:
            return None
        lines = [n for n, _ in split_source_lines(code)]
        if not lines:
            return None
        return json.dumps({'kind': 'forth', 'anchor': anchor, 'lines': lines})
    except Exception as e:
        print(f"debug-info generation failed (compile unaffected): {e}")
        return None


def filter_error_lines(output: str, workdir: str) -> str:
    """sjasmplus diagnostics with server paths scrubbed, error lines only,
    bounded. Errors here are service-side (the user's text is data bytes),
    so this mostly feeds the logs — except the size ASSERT, which maps to
    a friendly message for the user."""
    if not output:
        return ""
    cleaned = output.replace(workdir + os.sep, "").replace(workdir, "")
    lines = [l for l in cleaned.splitlines() if ": error:" in l]
    text = "\n".join(lines)[:2000]
    return text


@compile_endpoint.post("/", response_model=CompileResult)
def handle_compile_request(
        args: RequestArgs,
        authorization: Optional[str] = Header(None)) -> Optional[CompileResult]:

    # A fresh directory per request: the (patched) zenv sources are copied
    # in beside the generated user.asm and build wrapper, so every include
    # resolves in one flat directory. Outputs land in the same directory.
    path = tempfile.mkdtemp(prefix='zenv-')
    tap_filename = os.path.join(path, 'program.tap')

    try:
        for src in glob.glob(os.path.join(ZENV_SRC_DIR, '*.asm')):
            shutil.copy(src, path)
        with open(os.path.join(path, 'user.asm'), 'w') as f:
            f.write(generate_user_asm(args.input.code))
        with open(os.path.join(path, 'build.asm'), 'w') as f:
            f.write(BUILD_WRAPPER)

        # Compile in its own process group so a timeout can kill the
        # assembler and anything it spawned, not just the parent.
        proc = subprocess.Popen(
            ['sjasmplus', '--nologo', '--sym=program.sym', 'build.asm'],
            cwd=path,  # the temp dir (/tmp tmpfs), so any CWD-relative
                       # intermediate lands there, not the read-only
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

        # Exit code matters as well as the file: sjasmplus still writes the
        # SAVETAP output after a failed ASSERT, so an oversized image would
        # otherwise ship a tape whose program tramples zenv's workspace.
        if proc.returncode != 0 or not os.path.exists(tap_filename):
            text = (stderr or b'').decode(errors='replace')
            if '[ASSERT]' in text:
                detail = PROGRAM_TOO_LARGE
            else:
                detail = filter_error_lines(text, path) or 'Compilation failed'
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=detail)

        with open(tap_filename, 'rb') as f:
            base64_encoded = base64.b64encode(f.read()).decode()
        return CompileResult(
            base64_encoded=base64_encoded,
            sld=build_debug_info(path, args.input.code))

    finally:
        # Clean up the per-request directory: sources, the generated files,
        # the tape, and any intermediates the assembler left behind.
        shutil.rmtree(path, ignore_errors=True)
