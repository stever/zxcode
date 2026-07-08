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


def compile_request(code):
    return client.post('/compile/', json={
        'session_variables': {'x-hasura-role': 'public'},
        'input': {'code': code},
        'action': {'name': 'compileSjasmplus'},
    })


def test_savetap():
    response = compile_request(TAP_SOURCE)
    assert response.status_code == 200
    tap = base64.b64decode(response.json()['base64_encoded'])
    assert len(tap) > 0


def test_savenex():
    response = compile_request(NEX_SOURCE)
    assert response.status_code == 200
    nex = base64.b64decode(response.json()['base64_encoded'])
    assert nex[:4] == b'Next'


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
