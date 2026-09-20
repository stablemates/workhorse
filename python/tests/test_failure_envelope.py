"""The shared failure-envelope table, executed against the Python worker.

`protocol/v1/failures.json` owns the shape PostgreSQL stores for a handler failure. TypeScript,
Python, and Go each run this table, so an operator grouping a dead letter by name reads the same
field in every language.
"""

from __future__ import annotations

from typing import Any

import pytest
from protocol_fixtures import read_protocol_fixture

from workhorse.worker import _error_envelope

FAILURES: dict[str, Any] = read_protocol_fixture("failures.json")
ENVELOPE: dict[str, Any] = FAILURES["envelope"]
FIXTURES: list[dict[str, Any]] = FAILURES["fixtures"]

DECLARED_NAME = "PaymentDeclined"


class PaymentDeclined(Exception):
    """An error that names itself, the way a Python handler declares a failure."""


def _fixture_error(fixture: dict[str, Any]) -> Exception:
    message = fixture["error"]["message"]
    error: Exception = (
        PaymentDeclined(message) if fixture["error"]["declaresName"] else Exception(message)
    )
    if fixture["error"]["declaresStack"]:
        # Raising is how a Python exception acquires a traceback.
        try:
            raise error
        except Exception as raised:
            return raised
    return error


def _envelope(fixture: dict[str, Any]) -> dict[str, Any]:
    envelope = _error_envelope(_fixture_error(fixture), fixture["redactErrorDetails"])
    assert isinstance(envelope, dict)
    return envelope


@pytest.mark.parametrize("fixture", FIXTURES, ids=[fixture["id"] for fixture in FIXTURES])
def test_failure_envelope_matches_shared_table(fixture: dict[str, Any]) -> None:
    envelope = _envelope(fixture)
    expected_fields = (
        ENVELOPE["redactedFields"] if fixture["redactErrorDetails"] else ENVELOPE["fields"]
    )
    assert sorted(envelope) == sorted(expected_fields)
    assert envelope["message"] == fixture["envelope"]["message"]
    expected_name = fixture["envelope"]["name"]
    if expected_name == "$generic":
        expected_name = ENVELOPE["genericName"]["python"]
    assert envelope["name"] == expected_name
    stack = fixture["envelope"].get("stack")
    if stack == "string":
        assert isinstance(envelope["stack"], str)
        assert envelope["stack"] != ""
    if stack == "stringOrNull":
        assert envelope["stack"] is None or isinstance(envelope["stack"], str)


@pytest.mark.parametrize("fixture", FIXTURES, ids=[fixture["id"] for fixture in FIXTURES])
def test_failure_envelope_never_records_a_type_system_artifact(fixture: dict[str, Any]) -> None:
    name = _envelope(fixture)["name"]
    assert name
    for character in ENVELOPE["forbiddenNameCharacters"]:
        assert character not in name


def test_redaction_matches_redact_error_details_v1() -> None:
    assert _error_envelope(PaymentDeclined("card declined"), True) == ENVELOPE["redacted"]
