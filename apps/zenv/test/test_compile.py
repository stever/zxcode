"""zenv Forth compile service tests.

The unit tests pin the user.asm generator (the user's program embedded as
data bytes plus a per-line EVALUATE boot word); the endpoint tests run the
real toolchain inside the image (sjasmplus assembling the vendored, patched
zenv tree) and require Docker — see README.md.
"""

import base64

from fastapi.testclient import TestClient

from app.main import app
from app.routes.compile import generate_user_asm, PROGRAM_TOO_LARGE

client = TestClient(app, raise_server_exceptions=False)

FORTH_SOURCE = """\\ squares demo
: SQUARE DUP * ;
: DEMO 5 SQUARE . ;
DEMO
"""


def compile_request(code):
    return client.post('/compile/', json={
        'session_variables': {'x-hasura-role': 'public'},
        'input': {'code': code},
        'action': {'name': 'compileForth'},
    })


# ---------------------------------------------------------------------------
# Generator unit tests


def test_generator_evaluates_each_line():
    asm = generate_user_asm(": A 1 ;\n: B 2 ;\nA B")
    assert asm.count("DX evaluate") == 3
    assert "\nuser_line_0:" in asm and "\nuser_line_2:" in asm
    # The boot word ends before the data blobs (match the label
    # definitions at line starts, not the boot word's references).
    assert asm.index("DX exit") < asm.index("\nuser_line_0:")


def test_generator_drops_blank_lines_and_normalises_whitespace():
    asm = generate_user_asm("\n  \n: A\t1 ;\r\n\nA\n")
    assert asm.count("DX evaluate") == 2
    # Tab embedded as a space (0x20), no 0x09 and no stray CR (0x0D).
    data_lines = [l for l in asm.splitlines() if l.startswith("\tDB ")]
    all_bytes = [int(b) for l in data_lines for b in l[4:].split(",")]
    assert 9 not in all_bytes and 13 not in all_bytes
    assert 32 in all_bytes


def test_generator_emits_data_bytes_only():
    # Hostile text must never appear verbatim in the asm — only as DB
    # byte values, so it cannot escape into directives (Lua, INCLUDE...).
    hostile = ': X ." LUA PASS" ; \\ INCBIN "/etc/passwd"'
    asm = generate_user_asm(hostile)
    assert 'LUA' not in asm.replace('user_line', '')
    assert 'INCBIN' not in asm
    assert '"' not in asm
    data_lines = [l for l in asm.splitlines() if l.startswith("\tDB ")]
    decoded = bytes(int(b) for l in data_lines for b in l[4:].split(","))
    assert b'LUA PASS' in decoded


def test_generator_empty_program():
    asm = generate_user_asm("   \n  ")
    assert "user_boot:" in asm and "DX exit" in asm
    assert "DX evaluate" not in asm


# ---------------------------------------------------------------------------
# Endpoint tests (real toolchain; run inside the Docker image)


def test_compile_returns_tap():
    response = compile_request(FORTH_SOURCE)
    assert response.status_code == 200, response.text
    payload = response.json()
    tap = base64.b64decode(payload['base64_encoded'])
    # SAVETAP output: a BASIC loader header block leads the tape.
    assert len(tap) > 8000
    assert tap[0] == 0x13 and tap[1] == 0x00
    # No debug map for runtime-compiled Forth.
    assert payload.get('sld') is None


def test_compile_is_deterministic():
    a = compile_request(FORTH_SOURCE).json()['base64_encoded']
    b = compile_request(FORTH_SOURCE).json()['base64_encoded']
    assert a == b


def test_empty_input_rejected():
    response = compile_request("   ")
    assert response.status_code == 400
    assert 'message' in response.json()


def test_program_too_large_maps_to_friendly_error():
    # ~30KB of definitions overflows the image limit; the wrapper's ASSERT
    # trips and maps to the friendly message.
    big = "\n".join(f": W{i} {i} ;" for i in range(3000))
    response = compile_request(big)
    assert response.status_code == 400, response.text
    assert response.json()['message'] == PROGRAM_TOO_LARGE


def test_validation_error_is_hasura_shaped():
    response = client.post('/compile/', json={'input': {'code': 'X'}})
    assert response.status_code == 400
    assert 'message' in response.json()
