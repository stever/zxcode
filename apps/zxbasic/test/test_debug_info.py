"""The compile endpoint's debugger line map (CompileResult.sld).

The IDE's zxbasic breakpoints ride two artifacts produced at compile time:
the address of the runtime's per-line CHECK_BREAK routine (from zxbc's -M
label map) and the set of source lines that received an --enable-break
check (from a -f asm pass). Both travel to the client as JSON in the
optional ``sld`` field. These tests pin that contract against the real
toolchain, and the parsers against synthetic inputs.
"""

import base64
import json
from pathlib import Path
from uuid import uuid4

import pytest

from app.routes.compile import parse_check_break_anchor, parse_checked_lines

REPO_ROOT = Path(__file__).resolve().parent.parent

# Line 1 REM and line 4 blank must not be breakable; lines 2, 3, 5, 6
# carry statements. (zxbc line numbers are file lines - leading BASIC
# numbers are just labels.)
DEBUG_SAMPLE = 'REM setup\nPRINT "A"\nLET x = 1\n\nFOR i = 1 TO 2\n  PRINT i\nNEXT i\n'


def test_parse_check_break_anchor(tmp_path):
    mmap = tmp_path / "program.mmap"
    mmap.write_text(
        "8000: .core.__START_PROGRAM\n"
        "9333: .core.CHECK_BREAK\n"
        "92B9: .core.__MAIN_PROGRAM__\n")
    assert parse_check_break_anchor(str(mmap)) == 0x9333


def test_parse_check_break_anchor_absent(tmp_path):
    mmap = tmp_path / "program.mmap"
    mmap.write_text("8000: .core.__START_PROGRAM\n")
    assert parse_check_break_anchor(str(mmap)) is None


def test_parse_checked_lines_pairs_and_file_context(tmp_path):
    asm = tmp_path / "program.asm"
    asm.write_text(
        "\tld hl, 2\n"
        "\tcall .core.CHECK_BREAK\n"
        "\tld hl, 42\n"
        "\tld a, 1\n"                       # broken pair: not a check
        '#line 1 "/opt/venv/runtime/break.asm"\n'
        "\tld hl, 99\n"
        "\tcall .core.CHECK_BREAK\n"        # runtime region: excluded
        '#line 9 "/tmp/x/program.bas"\n'
        "\tld hl, 5\n"
        "\tcall .core.CHECK_BREAK\n"
        "\tld hl, 3\n"
        "\tcall .core.CHECK_BREAK\n")
    assert parse_checked_lines(str(asm)) == [2, 3, 5]


def test_compile_endpoint_returns_debug_map(monkeypatch):
    """End-to-end against the real zxbc: sld carries anchor + exact lines."""
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient
    from app.main import app

    monkeypatch.chdir(REPO_ROOT)

    request_body = {
        "session_variables": {
            "x-hasura-role": "user",
            "x-hasura-user-id": str(uuid4()),
        },
        "input": {"basic": DEBUG_SAMPLE},
        "action": {"name": "compile"},
    }

    with TestClient(app) as client:
        response = client.post("/compile/", json=request_body)

    assert response.status_code == 200, response.text
    payload = response.json()
    assert base64.b64decode(payload["base64_encoded"])  # still a real tap

    assert payload.get("sld"), "debug map missing from compile response"
    info = json.loads(payload["sld"])
    assert info["kind"] == "zxbasic"
    assert 0x8000 <= info["anchor"] <= 0xFFFF
    # REM (1) and the blank line (4) are not breakable; the statement
    # lines are. Exact placement of FOR/NEXT checks is compiler detail,
    # so pin the essentials rather than the full set.
    lines = info["lines"]
    assert 1 not in lines and 4 not in lines
    for required in (2, 3, 6):
        assert required in lines, f"line {required} missing from {lines}"
