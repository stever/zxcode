"""The compile endpoint's debugger line map (CompileResult.sld).

The IDE's Pascal breakpoints ride the sjasmplus listing pasta80 leaves
behind with --keepint: the generated .z80 marks every Pascal source line
with `; [N] <raw line>` and the listing pairs each marker with the address
where that line's code begins. The service parses that into
{"kind": "pasta80", "entries": [[line, addr], ...]} in the optional ``sld``
field. These tests pin the endpoint contract against the real toolchain,
and the parser against synthetic listings.
"""

import base64
import json

from fastapi.testclient import TestClient

from app.main import app
from app.routes.compile import parse_listing_line_map

client = TestClient(app, raise_server_exceptions=False)

# Line 2 (var) and line 3 (declaration) emit no code; 1 (program) usually
# none either. Lines 5-8 are statements.
DEBUG_SOURCE = """program Probe;
var
  I: Integer;
begin
  WriteLn('A');
  for I := 1 to 3 do
    WriteLn(I);
  WriteLn('B')
end.
"""


def compile_request(code, machine=None):
    payload = {'code': code}
    if machine is not None:
        payload['machine'] = machine
    return client.post('/compile/', json={
        'session_variables': {'x-hasura-role': 'public'},
        'input': payload,
        'action': {'name': 'compilePascal'},
    })


def test_parse_listing_line_map(tmp_path):
    source = "program T;\nbegin\n  WriteLn(1);\nend.\n"
    lst = tmp_path / "program.lst"
    lst.write_text(
        # Include rows (flagged +) are ignored even when they look like code.
        "   9+ 8003 21 00 00     ld hl,0\n"
        # A runtime .pas marker whose text does not match the source line.
        "  40  8100              ; [2] (* runtime comment *)\n"
        "  41  8100 AF                           xor a\n"
        # Main-source markers: matched by echoed text.
        " 100  A000              ; [0] program T;\n"
        " 101  A000              ; [1] begin\n"
        " 102  A000 CD 34 12                     call something\n"
        " 103  A003              ; [2]   WriteLn(1);\n"
        " 104  A003 21 01 00                     ld hl,1\n"
        " 105  A006              ; [3] end.\n"
        " 106  A006 C3 00 80                     jp __exit\n")
    # Line 1 (program header) emits nothing before the next marker; lines
    # 2 (begin -> call), 3 (WriteLn) and 4 (end.) carry code. The runtime
    # marker at 8100 must not map (text mismatch against the source).
    assert parse_listing_line_map(str(lst), source) == [
        [2, 0xA000], [3, 0xA003], [4, 0xA006]]


def test_parse_listing_requires_code_before_next_marker(tmp_path):
    source = "program T;\nvar\n  I: Integer;\nbegin\nend.\n"
    lst = tmp_path / "program.lst"
    lst.write_text(
        " 100  A000              ; [1] var\n"
        " 101  A000              ; [2]   I: Integer;\n"
        " 102  A000              ; [3] begin\n"
        " 103  A000 C9                           ret\n")
    # Only `begin` maps: the declarations alias onto its address and are
    # filtered out.
    assert parse_listing_line_map(str(lst), source) == [[4, 0xA000]]


def test_compile_endpoint_returns_debug_map():
    """End-to-end against the real pasta + sjasmplus toolchain."""
    response = compile_request(DEBUG_SOURCE)
    assert response.status_code == 200, response.text
    payload = response.json()
    assert base64.b64decode(payload['base64_encoded'])  # still a real tap

    assert payload.get('sld'), 'debug map missing from compile response'
    info = json.loads(payload['sld'])
    assert info['kind'] == 'pasta80'
    entries = dict(info['entries'])
    # The statement lines must be breakable, at addresses in the program
    # area, ascending with the source.
    for required in (5, 6, 7, 8):
        assert required in entries, f'line {required} missing from {entries}'
    assert entries[5] < entries[6] < entries[7] < entries[8]
    assert all(0x8000 <= addr <= 0xFFFF for addr in entries.values())
    # The `program` header and bare `var` keyword emit nothing and must not
    # be breakable. (A typed declaration like `I: Integer` MAY map: pasta
    # emits the global's storage attributed to that line — a dot there
    # simply never fires, the same as a dot on an asm `dw` line.)
    assert 1 not in entries and 2 not in entries


def test_debug_map_present_for_every_machine_target():
    for machine in ('48', '128', 'next'):
        response = compile_request(DEBUG_SOURCE, machine=machine)
        assert response.status_code == 200, (machine, response.text)
        assert response.json().get('sld'), f'no debug map for machine {machine}'
