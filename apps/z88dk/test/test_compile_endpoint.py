import base64
from fastapi.testclient import TestClient
from app.main import app

# NOTE: These tests require the z88dk toolchain on PATH (run them inside the
# service image).

client = TestClient(app, raise_server_exceptions=False)

MAIN_SOURCE = """#include <stdio.h>

int main(void)
{
    puts("Hello, world!");
    return 0;
}
"""

INCLUDE_MAIN_SOURCE = """#include <stdio.h>
#include "greeting.h"

int main(void)
{
    puts(GREETING);
    return 0;
}
"""

INCLUDE_HEADER = '#define GREETING "Hello from header!"\n'


def compile_request(code, files=None):
    payload = {'code': code}
    if files is not None:
        payload['files'] = files
    return client.post('/compile/', json={
        'session_variables': {'x-hasura-role': 'public'},
        'input': payload,
        'action': {'name': 'compileC'},
    })


def test_compile_endpoint():
    response = compile_request(MAIN_SOURCE)
    assert response.status_code == 200
    tap = base64.b64decode(response.json()['base64_encoded'])
    assert len(tap) > 0


def test_include_staged_project_file():
    response = compile_request(INCLUDE_MAIN_SOURCE, files=[
        {'name': 'greeting.h', 'content': INCLUDE_HEADER},
    ])
    assert response.status_code == 200
    tap = base64.b64decode(response.json()['base64_encoded'])
    assert len(tap) > 0


def test_missing_include_fails():
    response = compile_request(INCLUDE_MAIN_SOURCE)
    assert response.status_code == 400


def test_reserved_file_name_rejected():
    response = compile_request(MAIN_SOURCE, files=[
        {'name': 'program.h', 'content': 'x'},
    ])
    assert response.status_code == 400
    assert 'reserved' in response.json()['message']


def test_path_traversal_file_name_rejected():
    response = compile_request(MAIN_SOURCE, files=[
        {'name': '../evil.h', 'content': 'x'},
    ])
    assert response.status_code == 400
    assert response.json()['message'] == 'Invalid compile request.'


FOLDER_INCLUDE_MAIN_SOURCE = """#include <stdio.h>
#include "lib/greeting.h"

int main()
{
    printf(GREETING);
    return 0;
}
"""


def test_include_staged_folder_file():
    response = compile_request(FOLDER_INCLUDE_MAIN_SOURCE, files=[
        {'name': 'lib/greeting.h', 'content': INCLUDE_HEADER},
    ])
    assert response.status_code == 200
    tap = base64.b64decode(response.json()['base64_encoded'])
    assert len(tap) > 0


def test_folder_path_traversal_rejected():
    for name in ('lib/../evil.h', '/etc/evil.h', 'lib//evil.h', 'lib/'):
        response = compile_request(MAIN_SOURCE, files=[
            {'name': name, 'content': 'x'},
        ])
        assert response.status_code == 400, name
        assert response.json()['message'] == 'Invalid compile request.'


def test_file_and_folder_name_clash_rejected():
    response = compile_request(MAIN_SOURCE, files=[
        {'name': 'lib', 'content': 'x'},
        {'name': 'lib/greeting.h', 'content': INCLUDE_HEADER},
    ])
    assert response.status_code == 400
    assert 'clashes with another project file' in response.json()['message']
