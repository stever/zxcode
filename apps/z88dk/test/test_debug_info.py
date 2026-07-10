"""The compile endpoint's debugger line map (CompileResult.sld).

The IDE's C breakpoints ride two artifacts zcc emits with
--list --c-code-in-asm -m: the program.c.lis listing, whose C-line markers
(zsdcc `;file:line:` comments or sccz80 C_LINE directives) sit next to
module-relative code offsets, and the program.map, whose user-module
symbols anchor those offsets to linked absolute addresses. The service
parses both into {"kind": "z88dk", "files": {"<file>": [[line, addr],
...]}} in the optional ``sld`` field ("" = the main source). These tests
pin the parsers against synthetic inputs and the endpoint contract against
the real toolchain in both compiler modes.
"""

import base64
import json

from fastapi.testclient import TestClient

from app.main import app
from app.routes.compile import (
    build_debug_info,
    parse_listing_line_map,
    parse_map_symbols,
)

client = TestClient(app, raise_server_exceptions=False)

SDCC_SOURCE = """#include <stdio.h>

int square(int n)
{
    return n * n;
}

int main(void)
{
    int i;
    printf("start\\n");
    for (i = 1; i <= 3; i++) {
        printf("%d\\n", square(i));
    }
    printf("end\\n");
    return 0;
}
"""

# <spectrum.h> routes the build to the classic lib (sccz80).
CLASSIC_SOURCE = """#include <spectrum.h>
#include <stdio.h>

int main(void)
{
    int i;
    printf("classic\\n");
    for (i = 0; i < 3; i++) {
        printf("%d\\n", i);
    }
    return 0;
}
"""


def compile_request(code, files=None):
    payload = {'code': code}
    if files is not None:
        payload['files'] = files
    return client.post('/compile/', json={
        'session_variables': {'x-hasura-role': 'public'},
        'input': payload,
        'action': {'name': 'compileC'},
    })


def test_parse_map_symbols(tmp_path):
    mp = tmp_path / 'program.map'
    mp.write_text(
        "_main                           = $9380 ; addr, public, , program_c, code_compiler, program.c:438\n"
        "_square                         = $9364 ; addr, public, , program_c, code_compiler, program.c:419\n"
        "_puts                           = $8D00 ; addr, public, , puts, code_clib, puts.asm:10\n"
        "CHAR_BELL                       = $0007 ; const, local, , other, , x.inc:150\n")
    assert parse_map_symbols(str(mp)) == {'_main': 0x9380, '_square': 0x9364}


def test_parse_listing_sdcc_dialect(tmp_path):
    lis = tmp_path / 'program.c.lis'
    lis.write_text(
        "   415                          ;program.c:3: int square(int n)\n"
        "   419                          _square:\n"
        "   420  0000  dde5              \tpush\tix\n"
        "   423                          ;program.c:5: return n * n;\n"
        "   424  0008  dd6e04            \tld\tl,(ix+4)\n"
        "   430                          ;/opt/z88dk/include/stdio.h:99: junk\n"
        "   431  0010  00                \tnop\n"
        "   438                          _main:\n"
        "   439                          ;program.c:11: printf(\"start\");\n"
        "   440  001c  210000            \tld\thl,___str_1\n")
    lines, labels = parse_listing_line_map(str(lis), set())
    assert lines == {'': {3: 0x0000, 5: 0x0008, 11: 0x001C}}
    assert labels['_square'] == 0x0000
    assert labels['_main'] == 0x001C


def test_parse_listing_classic_dialect(tmp_path):
    lis = tmp_path / 'program.c.lis'
    lis.write_text(
        "     4                          \tC_LINE\t5,\"program.c::main::0::1\"\n"
        "     5                          ._main\n"
        "     5                          \tC_LINE\t7,\"program.c::main::1::2\"\n"
        "     7  0000  c5                \tpush\tbc\n"
        "     7                          \tC_LINE\t8,\"program.c::main::1::2\"\n"
        "     8  0001  210000            \tld\thl,i_1+0\n"
        "     8                          \tC_LINE\t2,\"/opt/z88dk/include/stdio.h\"\n"
        "     2  0005  00                \tnop\n")
    lines, labels = parse_listing_line_map(str(lis), set())
    # Line 5 (C_LINE 5) is superseded by C_LINE 7 before any code row: it
    # emitted nothing and correctly drops, like every no-code line.
    assert lines == {'': {7: 0x0000, 8: 0x0001}}
    assert labels['_main'] == 0x0000


def test_parse_listing_staged_include_keys_by_path(tmp_path):
    lis = tmp_path / 'program.c.lis'
    lis.write_text(
        "   10                          ;lib/util.h:4: int helper(void)\n"
        "   11  0100  af                \txor\ta\n"
        "   12                          ;other.h:9: not staged\n"
        "   13  0110  00                \tnop\n")
    lines, _ = parse_listing_line_map(str(lis), {'lib/util.h'})
    assert lines == {'lib/util.h': {4: 0x0100}}


def test_build_debug_info_rebases_and_verifies(tmp_path):
    (tmp_path / 'program.map').write_text(
        "_main                           = $9380 ; addr, public, , program_c, code_compiler, program.c:438\n"
        "_square                         = $9364 ; addr, public, , program_c, code_compiler, program.c:419\n")
    (tmp_path / 'program.c.lis').write_text(
        "   419                          _square:\n"
        "   420  0000  dde5              \tpush\tix\n"
        "   423                          ;program.c:5: return n * n;\n"
        "   424  0008  dd6e04            \tld\tl,(ix+4)\n"
        "   438                          _main:\n"
        "   440  001c  210000            \tld\thl,0\n")
    info = json.loads(build_debug_info(str(tmp_path), set()))
    # base = $9364; line 5 at offset 8 -> $936C.
    assert info == {'kind': 'z88dk', 'files': {'': [[5, 0x936C]]}}

    # An inconsistent base (map/listing from different layouts) drops the
    # map rather than shipping wrong addresses.
    (tmp_path / 'program.map').write_text(
        "_main                           = $9000 ; addr, public, , program_c, code_compiler, program.c:438\n"
        "_square                         = $9364 ; addr, public, , program_c, code_compiler, program.c:419\n")
    assert build_debug_info(str(tmp_path), set()) is None


def test_compile_endpoint_returns_debug_map_sdcc():
    response = compile_request(SDCC_SOURCE)
    assert response.status_code == 200, response.text
    payload = response.json()
    assert base64.b64decode(payload['base64_encoded'])
    assert payload.get('sld'), 'debug map missing (sdcc mode)'
    info = json.loads(payload['sld'])
    assert info['kind'] == 'z88dk'
    entries = dict(info['files'][''])
    # square's body, main's statements: all present, ascending, in RAM.
    for required in (5, 11, 12, 13, 15):
        assert required in entries, f'line {required} missing from {entries}'
    assert entries[11] < entries[12] < entries[13]
    assert all(0x8000 <= addr <= 0xFFFF for addr in entries.values())


def test_compile_endpoint_returns_debug_map_classic():
    response = compile_request(CLASSIC_SOURCE)
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload.get('sld'), 'debug map missing (classic mode)'
    info = json.loads(payload['sld'])
    entries = dict(info['files'][''])
    # Exactly which line sccz80 attributes each statement to is compiler
    # detail (the loop body lands on a neighbour); pin the essentials: the
    # first statements map, several lines are breakable, addresses ascend
    # with the source and live in RAM.
    for required in (7, 8):
        assert required in entries, f'line {required} missing from {entries}'
    assert len(entries) >= 3
    ordered = [entries[k] for k in sorted(entries)]
    assert ordered == sorted(ordered)
    assert all(0x5CCB <= addr <= 0xFFFF for addr in entries.values())
