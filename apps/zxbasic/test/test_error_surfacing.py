"""The compile endpoint must surface the compiler's own diagnostics.

When zxbc rejects a program it prints ``<file>:<line>: error: <message>`` to
stderr. The endpoint used to swallow that and return a generic "Compilation
failed" message, leaving the user with nothing to act on. These tests pin the
contract that the real diagnostic (line number + message) reaches the client,
with the server-side temp path scrubbed out.
"""

from uuid import uuid4

import pytest


def _payload(basic: str) -> dict:
    return {
        "session_variables": {
            "x-hasura-role": "user",
            "x-hasura-user-id": str(uuid4()),
        },
        "input": {"basic": basic},
        "action": {"name": "compile"},
    }


def test_compiler_diagnostics_are_surfaced(monkeypatch):
    """A syntax error returns the compiler's message, not a generic one."""
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient
    from app.main import app

    # nextreg is a Z80N op needing the zxnext arch; without the '! arch=zxnext
    # directive the classic grammar rejects it on line 3.
    bad = "\n".join([
        "SUB turboMax()",
        "    ASM",
        "        nextreg 7, 3",
        "    END ASM",
        "END SUB",
        "turboMax()",
    ])

    with TestClient(app) as client:
        response = client.post("/compile/", json=_payload(bad))

    assert response.status_code == 422, response.text
    message = response.json()["message"]

    # The real diagnostic (line number + message) is surfaced...
    assert "Unexpected token" in message
    assert "3:" in message
    # ...and the server-side temp path is never leaked to the client.
    assert "/tmp/" not in message
    assert "program.bas" in message
