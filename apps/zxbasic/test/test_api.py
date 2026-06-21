"""Contract tests guarding the API wrapper against upstream ZX Basic changes.

The downstream consumer of this service relies on a stable contract:

    POST /compile/  ->  {"base64_encoded": "<valid ZX Spectrum TAP>"}

An upstream bump of the ZX Basic compiler (the ``zxbasic`` package) can break
that contract in three ways, each covered below:

1. The ``zxbc`` console script the wrapper shells out to changes (invoking
   ``zxbc -f tap -a -B <file>`` must exit 0 and write ``<stem>.tap``).
                                          -- test_cli_contract_produces_tap
2. The ``from src.zxbc import main`` symbol used by the fallback path is moved
   or renamed.                            -- test_import_main_produces_tap
3. The emitted TAP bytes stop being a well-formed BASIC-loader tape.
                                          -- all three (via assert_valid_tap)

The HTTP test (test_compile_endpoint_returns_valid_tap) exercises the whole
stack end to end and is the closest mirror of what the other project sees.
"""

import base64
import functools
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from uuid import uuid4

import pytest

# Path to the repository root (parent of this test/ directory).
REPO_ROOT = Path(__file__).resolve().parent.parent

# A trivial but non-empty program. Keep it minimal so the test pins the
# compiler contract, not any particular language feature.
SAMPLE_BASIC = '10 PRINT "Hello"'


def parse_tap_blocks(data: bytes):
    """Split a .tap file into its blocks, validating the framing.

    A TAP file is a sequence of ``[length:2 LE][data:length]`` records that
    must consume the file exactly.  Raises ValueError on any malformed framing.
    """
    blocks, off, n = [], 0, len(data)
    while off < n:
        if off + 2 > n:
            raise ValueError(f"truncated length field at offset {off}")
        length = data[off] | (data[off + 1] << 8)
        off += 2
        if length == 0 or off + length > n:
            raise ValueError(f"block length {length} overruns file at offset {off}")
        blocks.append(data[off:off + length])
        off += length
    if off != n:
        raise ValueError("trailing bytes after final block")
    return blocks


def assert_valid_tap(data: bytes):
    """Assert ``data`` is a well-formed TAP whose first block is a BASIC header.

    Compiling with ``-f tap -a -B`` (TAP + BASIC loader) must yield a tape whose first
    block is a 19-byte header describing a BASIC program, with a valid XOR
    checksum.  This is exactly the structure the downstream consumer expects.
    """
    assert data, "TAP output is empty"
    blocks = parse_tap_blocks(data)
    assert blocks, "TAP contains no blocks"

    header = blocks[0]
    assert len(header) == 19, f"first block must be a 19-byte header, got {len(header)}"
    assert header[0] == 0x00, "first block must be a header (flag byte 0x00)"
    assert header[1] == 0x00, "header must describe a BASIC program (type byte 0x00)"

    # A correct ZX Spectrum block XORs to zero across all its bytes.
    checksum = functools.reduce(lambda a, b: a ^ b, header, 0)
    assert checksum == 0, "header block checksum is invalid"


def _write_sample(tmpdir: str) -> str:
    bas_filename = os.path.join(tmpdir, "prog.bas")
    with open(bas_filename, "w") as f:
        f.write(SAMPLE_BASIC)
    return bas_filename


def test_cli_contract_produces_tap(tmp_path):
    """The wrapper shells out to the ``zxbc`` console script; pin that.

    Mirrors compile.py's primary path: invoking the installed compiler must
    exit 0 and write ``<stem>.tap`` into the working directory (the wrapper
    derives the output name the same way).
    """
    bas_filename = _write_sample(str(tmp_path))
    tap_filename = tmp_path / f"{Path(bas_filename).stem}.tap"
    # Console scripts live alongside the interpreter; resolve from sys.executable
    # rather than relying on PATH, exactly as the wrapper does.
    zxbc = os.path.join(os.path.dirname(sys.executable), "zxbc")

    proc = subprocess.run(
        [zxbc, "-f", "tap", "-a", "-B", bas_filename],
        cwd=str(tmp_path),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=30,
    )

    assert proc.returncode == 0, f"compiler exited {proc.returncode}: {proc.stderr}"
    assert tap_filename.exists(), "compiler did not produce the expected .tap file"
    assert_valid_tap(tap_filename.read_bytes())


def test_import_main_produces_tap(tmp_path, monkeypatch):
    """The fallback path imports ``main`` from src.zxbc; pin that symbol too."""
    from src.zxbc import main

    # The compiler writes <stem>.tap into the current working directory.
    monkeypatch.chdir(tmp_path)
    bas_filename = _write_sample(str(tmp_path))
    tap_filename = tmp_path / f"{Path(bas_filename).stem}.tap"

    main(["-f", "tap", "-a", "-B", bas_filename])

    assert tap_filename.exists(), "main() did not produce the expected .tap file"
    assert_valid_tap(tap_filename.read_bytes())


def test_compile_endpoint_returns_valid_tap(monkeypatch):
    """End-to-end: the HTTP contract the downstream project consumes."""
    # Skip cleanly where the web stack is not installed (e.g. compiler-only env).
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient
    from app.main import app

    # The endpoint writes the .tap into the process CWD and reads it back, so
    # run the server from a stable writable directory (the repo root, as in the
    # container). The endpoint cleans up its own .tap afterwards.
    monkeypatch.chdir(REPO_ROOT)

    request_body = {
        "session_variables": {
            "x-hasura-role": "user",
            "x-hasura-user-id": str(uuid4()),
        },
        "input": {"basic": SAMPLE_BASIC},
        "action": {"name": "compile"},
    }

    with TestClient(app) as client:
        response = client.post("/compile/", json=request_body)

    assert response.status_code == 200, response.text
    payload = response.json()
    assert "base64_encoded" in payload, payload

    assert_valid_tap(base64.b64decode(payload["base64_encoded"]))


def test_compile_endpoint_rejects_empty_input(monkeypatch):
    """Input validation contract: empty BASIC is rejected, not 500'd."""
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient
    from app.main import app

    monkeypatch.chdir(REPO_ROOT)

    request_body = {
        "session_variables": {
            "x-hasura-role": "user",
            "x-hasura-user-id": str(uuid4()),
        },
        "input": {"basic": "   "},
        "action": {"name": "compile"},
    }

    with TestClient(app) as client:
        response = client.post("/compile/", json=request_body)

    assert response.status_code == 422, response.text
