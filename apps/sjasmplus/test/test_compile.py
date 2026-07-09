import base64
from fastapi.testclient import TestClient
from app.main import app

# NOTE: These tests require the 'sjasmplus' binary on PATH (run them inside
# the service image).

client = TestClient(app, raise_server_exceptions=False)

TAP_SOURCE = """    DEVICE ZXSPECTRUM48
    ORG $8000
start:
    ld a,2
    call $1601
    ld hl,msg
print:
    ld a,(hl)
    or a
    jr z,done
    rst $10
    inc hl
    jr print
done:
    jr done
msg:
    DB "HELLO FROM SJASMPLUS",0
    SAVETAP "out.tap",start
"""

NEX_SOURCE = """    DEVICE ZXSPECTRUMNEXT
    ORG $8000
start:
    ld a,2
    call $1601
    ld hl,msg
print:
    ld a,(hl)
    or a
    jr z,done
    rst $10
    inc hl
    jr print
done:
    jr done
msg:
    DB "HELLO NEXT",0
    SAVENEX OPEN "out.nex",start,$FF40
    SAVENEX AUTO
    SAVENEX CLOSE
"""


# Proves the assembler was built with USE_LUA=1: with Lua compiled out the
# LUA directive itself is an assembly error, and the stdlib call inside the
# block exercises the interpreter.
LUA_TAP_SOURCE = """    DEVICE ZXSPECTRUM48
    ORG $8000
start:
    ret
    LUA
local greeting = string.format("lua %d", 1 + 1)
if greeting ~= "lua 2" then sj.error("lua stdlib broken") end
    ENDLUA
    SAVETAP "out.tap",start
"""


def compile_request(code, files=None):
    payload = {'code': code}
    if files is not None:
        payload['files'] = files
    return client.post('/compile/', json={
        'session_variables': {'x-hasura-role': 'public'},
        'input': payload,
        'action': {'name': 'compileSjasmplus'},
    })


def test_savetap():
    response = compile_request(TAP_SOURCE)
    assert response.status_code == 200
    tap = base64.b64decode(response.json()['base64_encoded'])
    assert len(tap) > 0


def test_sld_returned_with_line_records():
    response = compile_request(TAP_SOURCE)
    assert response.status_code == 200
    sld = response.json()['sld']
    assert sld.startswith('|SLD.data.version|')
    # The ld a,2 on source line 4 assembles at ORG $8000 = 32768.
    assert 'program.asm|4||0|' in sld
    assert '|32768|T|' in sld
    # No server paths leak: every record names the fixed source file.
    assert '/tmp' not in sld


def test_savenex():
    response = compile_request(NEX_SOURCE)
    assert response.status_code == 200
    nex = base64.b64decode(response.json()['base64_encoded'])
    assert nex[:4] == b'Next'


def test_lua_scripting_enabled():
    response = compile_request(LUA_TAP_SOURCE)
    assert response.status_code == 200
    tap = base64.b64decode(response.json()['base64_encoded'])
    assert len(tap) > 0


def test_syntax_error_surfaces_diagnostics():
    response = compile_request("    ORG $8000\n    ld a,,2\n")
    assert response.status_code == 400
    message = response.json()['message']
    assert 'program.asm(' in message
    assert 'error' in message


def test_no_output_directives_hint():
    response = compile_request("    ORG $8000\n    ret\n")
    assert response.status_code == 400
    assert 'SAVETAP' in response.json()['message']


def test_multiple_outputs_rejected():
    source = TAP_SOURCE + '    SAVETAP "other.tap",start\n'
    response = compile_request(source)
    assert response.status_code == 400
    assert 'more than one output' in response.json()['message']


def test_empty_input_rejected():
    response = compile_request('   ')
    assert response.status_code == 400
    assert response.json()['message'] == 'Invalid compile request.'


INCLUDE_MAIN = """    DEVICE ZXSPECTRUM48
    ORG $8000
start:
    INCLUDE "part.asm"
    SAVETAP "out.tap",start
"""

INCBIN_MAIN = """    DEVICE ZXSPECTRUM48
    ORG $8000
start:
    ret
data:
    INCBIN "sprite.bin"
    SAVETAP "out.tap",start
"""


def test_include_staged_project_file():
    response = compile_request(INCLUDE_MAIN, files=[
        {'name': 'part.asm', 'content': '    ld a,2\n    ret\n'},
    ])
    assert response.status_code == 200
    tap = base64.b64decode(response.json()['base64_encoded'])
    assert len(tap) > 0


def test_incbin_staged_binary_asset():
    sprite = bytes(range(16))
    response = compile_request(INCBIN_MAIN, files=[
        {'name': 'sprite.bin',
         'content': base64.b64encode(sprite).decode(),
         'is_binary': True},
    ])
    assert response.status_code == 200
    tap = base64.b64decode(response.json()['base64_encoded'])
    assert sprite in tap


def test_missing_include_surfaces_diagnostics():
    response = compile_request(INCLUDE_MAIN)
    assert response.status_code == 400
    assert 'part.asm' in response.json()['message']


def test_reserved_file_name_rejected():
    response = compile_request(TAP_SOURCE, files=[
        {'name': 'program.asm', 'content': 'nop'},
    ])
    assert response.status_code == 400
    assert 'reserved' in response.json()['message']


def test_output_extension_file_name_rejected():
    response = compile_request(TAP_SOURCE, files=[
        {'name': 'data.tap', 'content': 'x', 'is_binary': False},
    ])
    assert response.status_code == 400
    assert 'clashes with compiler output' in response.json()['message']


def test_duplicate_file_name_rejected():
    response = compile_request(TAP_SOURCE, files=[
        {'name': 'part.asm', 'content': 'nop'},
        {'name': 'PART.ASM', 'content': 'nop'},
    ])
    assert response.status_code == 400
    assert 'Duplicate' in response.json()['message']


def test_path_traversal_file_name_rejected():
    response = compile_request(TAP_SOURCE, files=[
        {'name': '../evil.asm', 'content': 'nop'},
    ])
    assert response.status_code == 400
    assert response.json()['message'] == 'Invalid compile request.'


def test_invalid_base64_rejected():
    response = compile_request(TAP_SOURCE, files=[
        {'name': 'data.bin', 'content': 'not base64!!!', 'is_binary': True},
    ])
    assert response.status_code == 400
    assert 'base64' in response.json()['message']
