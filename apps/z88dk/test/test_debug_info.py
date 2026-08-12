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
    normalise_marker_file,
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
    # base = $9364; line 5 at offset 8 -> $936C. The user module's symbols
    # ride along as absolute labels for the engine's sym table.
    assert info == {'kind': 'z88dk', 'files': {'': [[5, 0x936C]]},
                    'labels': {'_main': 0x9380, '_square': 0x9364}}

    # An inconsistent base (map/listing from different layouts) drops the
    # map rather than shipping wrong addresses.
    (tmp_path / 'program.map').write_text(
        "_main                           = $9000 ; addr, public, , program_c, code_compiler, program.c:438\n"
        "_square                         = $9364 ; addr, public, , program_c, code_compiler, program.c:419\n")
    assert build_debug_info(str(tmp_path), set()) is None


def test_normalise_marker_file_relpaths_workdir_prefixed():
    staged = {'lib/util.h'}
    wd = '/tmp/z88dk-abc'
    # Workdir-prefixed absolute spellings fold back to the staged key...
    assert normalise_marker_file('/tmp/z88dk-abc/lib/util.h', staged, wd) == 'lib/util.h'
    assert normalise_marker_file('/tmp/z88dk-abc/program.c', staged, wd) == ''
    # ...with the sccz80 scope suffix stripped first.
    assert normalise_marker_file(
        '/tmp/z88dk-abc/lib/util.h::add::0::1', staged, wd) == 'lib/util.h'
    # Absolute paths outside the workdir (system headers, preprocessor
    # temp files) still drop.
    assert normalise_marker_file('/opt/z88dk/include/stdio.h', staged, wd) is None
    assert normalise_marker_file('/tmp/tmpXY123.i', staged, wd) is None
    # No workdir given: absolute paths drop as before.
    assert normalise_marker_file('/tmp/z88dk-abc/lib/util.h', staged) is None


# Mirrors the real zsdcc listing shape around an __asm block: ONE marker
# citing the __endasm line, placed BEFORE the body rows; the body rows echo
# their source with whitespace re-tokenised (tabs), blank source lines
# dropped, comments as no-byte rows and labels as label rows.
INLINE_ASM_C = """int main(void)
{
    int c = 0;
    __asm
    ; set border
    ld a, 1

    out (254), a
loop_top:
    nop
    nop
    djnz loop_top
    __endasm;
    return c;
}
"""

INLINE_ASM_LIS = (
    "   418                          _main:\n"
    "   419                          ;program.c:13: __endasm;\n"
    "   420                          ;\tset border\n"
    "   421  0000  3e01              \tld\ta, 1\n"
    "   422  0002  d3fe              \tout\t(254), a\n"
    "   423                          loop_top:\n"
    "   424  0004  00                \tnop\n"
    "   425  0005  00                \tnop\n"
    "   426  0006  10fc              \tdjnz\tloop_top\n"
    "   427                          ;program.c:14: return c;\n"
    "   428  0008  210000            \tld\thl,0x0000\n"
)


def test_parse_listing_inline_asm_sdcc_per_row(tmp_path):
    lis = tmp_path / 'program.c.lis'
    lis.write_text(INLINE_ASM_LIS)
    lines, labels = parse_listing_line_map(
        str(lis), set(), sources={'': INLINE_ASM_C})
    # Each instruction maps to its own source line; the two identical nops
    # attribute monotonically; the comment (5), blank (7), label (9) and
    # __asm (4) lines don't map; the __endasm marker line still binds the
    # block's first row.
    assert lines == {'': {6: 0x0000, 8: 0x0002, 10: 0x0004, 11: 0x0005,
                          12: 0x0006, 13: 0x0000, 14: 0x0008}}
    assert labels['loop_top'] == 0x0004


def test_parse_listing_inline_asm_without_sources_keeps_old_shape(tmp_path):
    lis = tmp_path / 'program.c.lis'
    lis.write_text(INLINE_ASM_LIS)
    lines, _ = parse_listing_line_map(str(lis), set())
    # No sources: the whole block maps to the marker line, as before.
    assert lines == {'': {13: 0x0000, 14: 0x0008}}


def test_parse_listing_inline_asm_skips_unmatched_rows(tmp_path):
    lis = tmp_path / 'program.c.lis'
    lis.write_text(
        "   419                          ;program.c:13: __endasm;\n"
        "   421  0000  cd0000            \tcall\t_macro_expansion\n"
        "   422  0003  d3fe              \tout\t(254), a\n"
    )
    lines, _ = parse_listing_line_map(
        str(lis), set(), sources={'': INLINE_ASM_C})
    # A row whose echoed text matches no source line (macro expansion)
    # stays unmapped and leaves the cursor alone for later rows.
    assert lines == {'': {8: 0x0003, 13: 0x0000}}


def test_parse_listing_inline_asm_in_staged_header(tmp_path):
    header = ("int add2(int a, int b)\n"
              "{\n"
              "    int r = a + b;\n"
              "    __asm\n"
              "    nop\n"
              "    nop\n"
              "    __endasm;\n"
              "    return r;\n"
              "}\n")
    lis = tmp_path / 'program.c.lis'
    lis.write_text(
        "   500                          ;lib/util.h:7: __endasm;\n"
        "   501  0010  00                \tnop\n"
        "   502  0011  00                \tnop\n"
    )
    lines, _ = parse_listing_line_map(
        str(lis), {'lib/util.h'}, sources={'lib/util.h': header})
    assert lines == {'lib/util.h': {5: 0x0010, 6: 0x0011, 7: 0x0010}}


def test_parse_listing_classic_asm_marker_window_noop(tmp_path):
    source = ("int main()\n"
              "{\n"
              "#asm\n"
              " nop\n"
              "#endasm\n"
              " return 0;\n"
              "}\n")
    lis = tmp_path / 'program.c.lis'
    lis.write_text(
        "     3                          \tC_LINE\t4,\"program.c::main::1::1\"\n"
        "     4  0000  00                    nop\n"
        "     4                          \tC_LINE\t5,\"program.c::main::1::1\"\n"
        "     5                          \tC_LINE\t6,\"program.c::main::1::1\"\n"
        "     6  0001  210000            \tld\thl,0\n"
    )
    lines, _ = parse_listing_line_map(
        str(lis), set(), sources={'': source})
    # sccz80 marks asm lines individually (C_LINE 4 -> nop); its #endasm
    # C_LINE is immediately superseded by the next marker, so the window
    # opens and closes without consuming or double-mapping anything.
    assert lines == {'': {4: 0x0000, 6: 0x0001}}


def test_parse_listing_clamps_marker_beyond_source_eof(tmp_path):
    source = "int main()\n{\n return 0;\n}\n"
    lis = tmp_path / 'program.c.lis'
    lis.write_text(
        "     3                          \tC_LINE\t3,\"program.c\"\n"
        "     3  0000  210000            \tld\thl,0\n"
        "     3                          \tC_LINE\t12,\"program.c\"\n"
        "    12  0003  c9                \tret\n"
    )
    lines, _ = parse_listing_line_map(str(lis), set(), sources={'': source})
    # sccz80 can emit a C_LINE past the file's EOF after an #asm block: a
    # line the editor doesn't have must not map.
    assert lines == {'': {3: 0x0000}}


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


# Header with C code and an inline asm block, staged as lib/util.h.
SDCC_HEADER = """int add2(int a, int b)
{
    int r = a + b;
    __asm
    nop
    nop
    __endasm;
    return r;
}
"""

SDCC_HEADER_SOURCE = """#include <stdio.h>
#include "lib/util.h"

int main(void)
{
    printf("%d\\n", add2(2, 3));
    __asm
    ld a, 2
    out (254), a
    nop
    __endasm;
    return 0;
}
"""


def test_compile_endpoint_maps_staged_header_and_inline_asm_sdcc():
    response = compile_request(
        SDCC_HEADER_SOURCE, files=[{'name': 'lib/util.h', 'content': SDCC_HEADER}])
    assert response.status_code == 200, response.text
    info = json.loads(response.json()['sld'])

    # The staged header's C lines map under its relative path...
    assert 'lib/util.h' in info['files'], info['files'].keys()
    header = dict(info['files']['lib/util.h'])
    assert 3 in header, f'header C line missing from {header}'
    # ...and so do the individual instructions of its __asm block.
    assert 5 in header and 6 in header, f'header asm lines missing from {header}'
    assert header[5] < header[6]

    # The main source's __asm block maps per instruction line too.
    main = dict(info['files'][''])
    assert 8 in main and 9 in main and 10 in main, f'asm lines missing from {main}'
    assert main[8] < main[9] < main[10]

    # User-module symbols ride along for the engine's sym table.
    labels = info.get('labels', {})
    assert '_main' in labels and '_add2' in labels, labels.keys()
    assert all(0x8000 <= addr <= 0xFFFF for addr in labels.values())


CLASSIC_HEADER = """int add2(int a, int b)
{
    int r = a + b;
    #asm
    nop
    nop
    #endasm
    return r;
}
"""

CLASSIC_HEADER_SOURCE = """#include <spectrum.h>
#include <stdio.h>
#include "lib/cutil.h"

int main(void)
{
    printf("%d\\n", add2(2, 3));
    #asm
    ld a, 2
    out (254), a
    nop
    #endasm
    return 0;
}
"""


def test_compile_endpoint_maps_staged_header_and_inline_asm_classic():
    response = compile_request(
        CLASSIC_HEADER_SOURCE,
        files=[{'name': 'lib/cutil.h', 'content': CLASSIC_HEADER}])
    assert response.status_code == 200, response.text
    info = json.loads(response.json()['sld'])

    # The staged header maps under its relative path (sccz80 attribution
    # carries ±1 line of fuzz, so pin coverage and ordering, not exact
    # line numbers).
    assert 'lib/cutil.h' in info['files'], info['files'].keys()
    header = dict(info['files']['lib/cutil.h'])
    assert len(header) >= 2
    ordered = [header[k] for k in sorted(header)]
    assert ordered == sorted(ordered)
    # The header's #asm instructions land inside the block's line range.
    assert any(4 <= line <= 7 for line in header), header.keys()

    # sccz80 marks inline asm lines individually: the main source's block
    # instructions (ld/out/nop on lines 9-11) map per line.
    main = dict(info['files'][''])
    for required in (9, 10, 11):
        assert required in main, f'line {required} missing from {main}'
    assert main[9] < main[10] < main[11]
