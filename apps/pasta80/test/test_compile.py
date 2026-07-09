import base64
from fastapi.testclient import TestClient
from app.main import app

# NOTE: These tests require the 'pasta' and 'sjasmplus' binaries plus the
# Pasta80 runtime (~/.pasta80.cfg pointing at rtl/ and misc/), so run them
# inside the service image.

client = TestClient(app, raise_server_exceptions=False)

HELLO_SOURCE = """program Hello;
begin
  WriteLn('Hello from Pasta80!')
end.
"""

# Turbo Pascal 3 style embedded machine code: LD A,'B' via inline() opcodes.
# (The program name must avoid 'inline' itself — it is a reserved word.)
INLINE_SOURCE = """program Embedded;
var C: Char;
begin
  C := 'A';
  inline($3e/66);
  WriteLn(C)
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


def decoded_tap(response):
    assert response.status_code == 200
    tap = base64.b64decode(response.json()['base64_encoded'])
    assert len(tap) > 0
    # First TAP block is the BASIC loader header ("run.bas").
    assert b'run.bas' in tap[:20]
    return tap


def test_hello_default_machine():
    decoded_tap(compile_request(HELLO_SOURCE))


def test_hello_all_machines():
    sizes = {m: len(decoded_tap(compile_request(HELLO_SOURCE, m)))
             for m in ('48', '128', 'next')}
    # Each target links a different runtime, so the TAPs must differ.
    assert len(set(sizes.values())) == 3


def test_inline_machine_code():
    decoded_tap(compile_request(INLINE_SOURCE))


def test_unknown_machine_rejected():
    response = compile_request(HELLO_SOURCE, 'zx81')
    assert response.status_code == 400
    assert response.json()['message'] == 'Invalid compile request.'


def test_syntax_error_surfaces_diagnostics():
    response = compile_request("program Bad;\nbegin\n  WriteLn('x'\nend.\n")
    assert response.status_code == 400
    message = response.json()['message']
    assert '*** Error at' in message
    # Diagnostics point at the Pascal source position (line 4, column 1).
    assert '4,1' in message


def test_unknown_identifier_error():
    response = compile_request("program Bad;\nbegin\n  Nonsense(42)\nend.\n")
    assert response.status_code == 400
    assert '*** Error at' in response.json()['message']


def test_empty_input_rejected():
    response = compile_request('   ')
    assert response.status_code == 400
    assert response.json()['message'] == 'Invalid compile request.'


INCLUDE_SOURCE = """program Included;
{$i hello.inc}
begin
  Hello
end.
"""

INCLUDE_FILE = """procedure Hello;
begin
  WriteLn('Hello from include!')
end;
"""


def test_include_staged_project_file():
    decoded_tap(compile_request(INCLUDE_SOURCE, files=[
        {'name': 'hello.inc', 'content': INCLUDE_FILE},
    ]))


def test_reserved_file_name_rejected():
    response = compile_request(HELLO_SOURCE, files=[
        {'name': 'program.pas', 'content': 'x'},
    ])
    assert response.status_code == 400
    assert 'reserved' in response.json()['message']


def test_path_traversal_file_name_rejected():
    response = compile_request(HELLO_SOURCE, files=[
        {'name': '../evil.pas', 'content': 'x'},
    ])
    assert response.status_code == 400
    assert response.json()['message'] == 'Invalid compile request.'
