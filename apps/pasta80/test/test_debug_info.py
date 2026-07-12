"""The compile endpoint's debugger line map (CompileResult.sld).

The IDE's Pascal breakpoints ride the sjasmplus listing pasta80 leaves
behind with --keepint: the generated .z80 marks every Pascal source line
with `; [N] <raw line>` and the listing pairs each marker with the address
where that line's code begins. The service parses that into
{"kind": "pasta80", "files": {"<file>": [[line, addr], ...]}} in the
optional ``sld`` field ("" = the main source, other keys = staged {$i}
include files). These tests pin the endpoint contract against the real
toolchain, and the parser against synthetic listings.
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


def compile_request(code, machine=None, files=None):
    payload = {'code': code}
    if machine is not None:
        payload['machine'] = machine
    if files is not None:
        payload['files'] = files
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
    assert parse_listing_line_map(str(lst), {'': source}) == {
        '': [[2, 0xA000], [3, 0xA003], [4, 0xA006]]}


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
    assert parse_listing_line_map(str(lst), {'': source}) == {'': [[4, 0xA000]]}


def test_compile_endpoint_returns_debug_map():
    """End-to-end against the real pasta + sjasmplus toolchain."""
    response = compile_request(DEBUG_SOURCE)
    assert response.status_code == 200, response.text
    payload = response.json()
    assert base64.b64decode(payload['base64_encoded'])  # still a real tap

    assert payload.get('sld'), 'debug map missing from compile response'
    info = json.loads(payload['sld'])
    assert info['kind'] == 'pasta80'
    entries = dict(info['files'][''])
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


def test_parse_listing_include_files_and_ambiguity(tmp_path):
    # `end;` sits at the same 0-based line (2) in BOTH candidates —
    # ambiguous, dropped. The include's WriteLn line is unique and maps
    # under its file key.
    main = "program T;\nbegin\nend;\nend.\n"
    inc = "procedure Greet;\nbegin\nend;\n"
    lst = tmp_path / "program.lst"
    lst.write_text(
        " 100  A000              ; [1]   WriteLn(9);\n"   # matches nothing
        " 101  A000 AF                           xor a\n"
        " 102  A010              ; [0] procedure Greet;\n"
        " 103  A010 C5                           push bc\n"
        " 104  A020              ; [2] end;\n"            # ambiguous
        " 105  A020 C9                           ret\n"
        " 106  A030              ; [1] begin\n"           # ambiguous too
        " 107  A030 00                           nop\n"
        " 108  A040              ; [3] end.\n"            # main only
        " 109  A040 C3 00 80                     jp __exit\n")
    result = parse_listing_line_map(
        str(lst), {'': main, 'inc/greet.pas': inc})
    assert result == {
        '': [[4, 0xA040]],
        'inc/greet.pas': [[1, 0xA010]],
    }


def test_parse_listing_maps_linked_asm_rows(tmp_path):
    # A staged {$l} asm file maps through its flagged listing rows: the
    # 1-based listing line numbers are the editor's, byte-emitting rows
    # only (labels, comments and blank lines don't arm).
    work = tmp_path / "work"
    work.mkdir()
    helper = "my_nop:\n\tret\n"
    (work / "helper.asm").write_text(helper)
    lst = work / "program.lst"
    lst.write_text(
        "# file opened: program.z80\n"
        " 100  A000              ; [1] {$l helper.asm}\n"
        f' 101  A000                              include "{work}/helper.asm"\n'
        "# file opened: helper.asm\n"
        "   1+ A000              my_nop:\n"
        "   2+ A000 C9           \tret\n"
        "   3+ A001\n"
        "# file closed: helper.asm\n"
        " 102  A001              ; [2] begin\n"
        " 103  A001 C9                           ret\n"
        "# file closed: program.z80\n")
    source = "program T;\n{$l helper.asm}\nbegin\nend.\n"
    # The {$l} marker's pending state survives the include section (the
    # begin marker replaces it before any main-level bytes), and only the
    # helper's byte-emitting row maps — not its label or blank line.
    assert parse_listing_line_map(
        str(lst), {'': source, 'helper.asm': helper}) == {
        '': [[3, 0xA001]],
        'helper.asm': [[2, 0xA000]],
    }


def test_parse_listing_asm_nesting_and_rtl_shadowing(tmp_path):
    # The listing echoes only basenames on '# file opened', so the staged
    # identity resolves from the include directive's path: an RTL file
    # outside the workdir must not map even when a staged file shares its
    # basename, a relative include resolves against the including file's
    # directory, and depth-2 rows lose the space before the address
    # ('1++A001') yet still parse.
    work = tmp_path / "work"
    work.mkdir()
    rtl = tmp_path / "rtl"
    rtl.mkdir()
    (rtl / "system.asm").write_text("\txor a\n")
    staged = {
        "system.asm": "\tinc a\n",
        "helper.asm": "my_nop:\n\tret\n\tinclude \"inner.asm\"\n\tld b, 2\n",
        "inner.asm": "\tld a, 1\n\tret\n",
    }
    for name, text in staged.items():
        (work / name).write_text(text)
    lst = work / "program.lst"
    lst.write_text(
        "# file opened: program.z80\n"
        f'  26  8003                              include "{rtl}/system.asm"\n'
        "# file opened: system.asm\n"
        "   1+ 8003 AF           \txor a\n"
        "# file closed: system.asm\n"
        f' 100  A000                              include "{work}/helper.asm"\n'
        "# file opened: helper.asm\n"
        "   1+ A000              my_nop:\n"
        "   2+ A000 C9           \tret\n"
        '   3+ A001              \tinclude "inner.asm"\n'
        "# file opened: inner.asm\n"
        "   1++A001 3E 01        \tld a, 1\n"
        "   2++A003 C9           \tret\n"
        "# file closed: inner.asm\n"
        "   4+ A004 06 02        \tld b, 2\n"
        "# file closed: helper.asm\n"
        "# file closed: program.z80\n")
    sources = {'': "program T;\nbegin\nend.\n", **staged}
    assert parse_listing_line_map(str(lst), sources) == {
        'helper.asm': [[2, 0xA000], [4, 0xA004]],
        'inner.asm': [[1, 0xA001], [2, 0xA003]],
    }


INCLUDE_MAIN = """program Multi;
{$i inc/greet.pas}
begin
  Greet;
  WriteLn('done')
end.
"""

INCLUDE_FILE = """procedure Greet;
begin
  WriteLn('hello from include')
end;
"""


def test_compile_endpoint_maps_include_files():
    """End-to-end: {$i} include lines map under their own file key."""
    response = compile_request(INCLUDE_MAIN, files=[
        {'name': 'inc/greet.pas', 'content': INCLUDE_FILE, 'is_binary': False},
    ])
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload.get('sld'), 'debug map missing from compile response'
    info = json.loads(payload['sld'])
    assert 'inc/greet.pas' in info['files'], info['files'].keys()
    inc_entries = dict(info['files']['inc/greet.pas'])
    # The include's WriteLn (line 3) must be breakable.
    assert 3 in inc_entries, inc_entries
    main_entries = dict(info['files'][''])
    # The main body's statements too.
    assert 4 in main_entries and 5 in main_entries, main_entries


ASM_MAIN = """program AsmLink;
procedure SetBorder(Color: Byte); register; external 'set_border';
{$l lib/helper.asm}
begin
  SetBorder(2)
end.
"""

ASM_FILE = """; sets the border to the colour in L
set_border:
        ld      a, l
        out     ($fe), a
        ret
"""


def test_compile_endpoint_maps_linked_asm_files():
    """End-to-end: a {$l}-linked asm file's lines map under its own key."""
    response = compile_request(ASM_MAIN, files=[
        {'name': 'lib/helper.asm', 'content': ASM_FILE, 'is_binary': False},
    ])
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload.get('sld'), 'debug map missing from compile response'
    info = json.loads(payload['sld'])
    assert 'lib/helper.asm' in info['files'], info['files'].keys()
    entries = dict(info['files']['lib/helper.asm'])
    # The instruction lines are breakable, ascending; the comment and the
    # label emit nothing and must not be.
    for required in (3, 4, 5):
        assert required in entries, f'line {required} missing from {entries}'
    assert entries[3] < entries[4] < entries[5]
    assert 1 not in entries and 2 not in entries
    # The Pascal side still maps: the call line at least.
    assert 5 in dict(info['files']['']), info['files']['']


def test_debug_map_present_for_every_machine_target():
    for machine in ('48', '128', 'next'):
        response = compile_request(DEBUG_SOURCE, machine=machine)
        assert response.status_code == 200, (machine, response.text)
        assert response.json().get('sld'), f'no debug map for machine {machine}'
