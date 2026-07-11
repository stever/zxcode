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
import os
from pathlib import Path
from uuid import uuid4

import pytest

from app.routes.compile import (
    UnsafeIncludeError,
    attribute_and_rewrite_asm,
    parse_check_break_anchor,
    parse_function_files,
)

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


def test_parse_function_files_attribution_and_bail():
    pp = (
        '#line 1 "program.bas"\n'
        'PRINT "main"\n'
        '#line 1 "lib/util.bas"\n'
        "' a comment is fine at top level\n"
        'SUB greet()\n'
        '    PRINT "hi"\n'
        'END SUB\n'
        '#line 3 "program.bas"\n'
        'SUB local()\n'
        'END SUB\n'
        '#line 1 "/opt/venv/lib/stdlib/foo.bas"\n'
        'FUNCTION StdThing() AS Integer\n'
        'END FUNCTION\n')
    funcs = parse_function_files(pp, {"lib/util.bas"})
    assert funcs == {
        "_greet": "lib/util.bas",
        "_local": "",
        "_stdthing": "/opt/venv/lib/stdlib/foo.bas",
    }

    unsafe = (
        '#line 1 "lib/util.bas"\n'
        'PRINT "top-level code in an include"\n')
    with pytest.raises(UnsafeIncludeError):
        parse_function_files(unsafe, {"lib/util.bas"})


def test_attribute_and_rewrite_asm(tmp_path):
    asm = tmp_path / "program.asm"
    asm.write_text(
        "\tld hl, 99\n"
        "\tcall .core.CHECK_BREAK\n"        # pre-main: neutralised
        ".core.__MAIN_PROGRAM__:\n"
        "\tld hl, 2\n"
        "\tcall .core.CHECK_BREAK\n"        # main line 2
        "\tld hl, 42\n"
        "\tld a, 1\n"                       # broken pair: not a check
        "_greet:\n"
        "\tld hl, 3\n"
        "\tcall .core.CHECK_BREAK\n"        # include line 3 -> virtual
        "_stdthing:\n"
        "\tld hl, 7\n"
        "\tcall .core.CHECK_BREAK\n")       # stdlib: neutralised
    files = attribute_and_rewrite_asm(str(asm), {
        "_greet": "lib/util.bas",
        "_stdthing": "/opt/stdlib/foo.bas",
    }, {"lib/util.bas"})
    assert files == {
        "": [[2, 2]],
        "lib/util.bas": [[3, 10003]],
    }
    rewritten = asm.read_text()
    assert "\tld hl, 10003\n" in rewritten            # include virtualised
    assert rewritten.count("\tld hl, 65535\n") == 2   # pre-main + stdlib
    assert "\tld hl, 2\n" in rewritten                # main untouched
    assert "\tld hl, 42\n" in rewritten               # non-check untouched


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
    # so pin the essentials rather than the full set. Main-file virtual
    # numbers equal the real lines.
    entries = dict(info["files"][""])
    assert 1 not in entries and 4 not in entries
    for required in (2, 3, 6):
        assert required in entries, f"line {required} missing from {entries}"
    assert all(line == virt for line, virt in entries.items())


MULTI_MAIN = 'PRINT "main line 1"\n#include "lib/util.bas"\ngreet()\nPRINT "main line 4"\n'
MULTI_INCLUDE = "REM include line 1\nSUB greet()\n    PRINT \"include line 3\"\n    PRINT \"include line 4\"\nEND SUB\n"


def compile_payload(basic, files=None):
    body = {
        "session_variables": {
            "x-hasura-role": "user",
            "x-hasura-user-id": str(uuid4()),
        },
        "input": {"basic": basic},
        "action": {"name": "compile"},
    }
    if files is not None:
        body["input"]["files"] = files
    return body


def test_compile_endpoint_maps_include_files(monkeypatch):
    """End-to-end: include SUB lines arm under their own file key with
    virtual line numbers (base 10000 for the first include)."""
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient
    from app.main import app

    monkeypatch.chdir(REPO_ROOT)
    with TestClient(app) as client:
        response = client.post("/compile/", json=compile_payload(
            MULTI_MAIN,
            files=[{"name": "lib/util.bas", "content": MULTI_INCLUDE}]))

    assert response.status_code == 200, response.text
    payload = response.json()
    assert base64.b64decode(payload["base64_encoded"])  # still a real tap
    info = json.loads(payload["sld"])
    assert "lib/util.bas" in info["files"], info["files"].keys()
    inc = dict(info["files"]["lib/util.bas"])
    # The SUB body's PRINTs (include lines 3 and 4) map to virtuals in
    # the include's 10000 range.
    for required in (3, 4):
        assert required in inc, inc
        assert 10000 < inc[required] < 20000, inc
    main = dict(info["files"][""])
    assert 1 in main and 3 in main, main


def test_compile_endpoint_unsafe_include_falls_back(monkeypatch):
    """An include with top-level code still compiles; the map falls back
    to main-only rather than guessing attribution."""
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient
    from app.main import app

    monkeypatch.chdir(REPO_ROOT)
    with TestClient(app) as client:
        response = client.post("/compile/", json=compile_payload(
            'PRINT "main"\n#include "lib/top.bas"\nPRINT "after"\n',
            files=[{"name": "lib/top.bas", "content": 'PRINT "top-level"\n'}]))

    assert response.status_code == 200, response.text
    payload = response.json()
    assert base64.b64decode(payload["base64_encoded"])
    info = json.loads(payload["sld"])
    assert list(info["files"].keys()) == [""], info["files"].keys()


def test_multifile_pipeline_tap_matches_plain_build(monkeypatch, tmp_path):
    """Safety pin: for a program with no includes, the zxbasm-assembled
    TAP from the multi-file pipeline is byte-identical to zxbc's own -f
    tap output (no rewrites apply, so the pipelines must agree)."""
    import subprocess
    import sys as _sys

    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient
    from app.main import app

    monkeypatch.chdir(REPO_ROOT)
    with TestClient(app) as client:
        response = client.post("/compile/", json=compile_payload(DEBUG_SAMPLE))
    assert response.status_code == 200, response.text
    via_endpoint = base64.b64decode(response.json()["base64_encoded"])

    bas = tmp_path / "program.bas"
    bas.write_text(DEBUG_SAMPLE)
    tap = tmp_path / "program.tap"  # same stem: the TAP embeds the output name
    zxbc = os.path.join(os.path.dirname(_sys.executable), "zxbc")
    subprocess.run(
        [zxbc, "-f", "tap", "-a", "-B", "--enable-break",
         "-o", str(tap), str(bas)],
        cwd=tmp_path, check=True, capture_output=True)
    assert via_endpoint == tap.read_bytes()
