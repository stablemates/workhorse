"""The shared failure-envelope table, executed against the Python worker.

`protocol/v1/failures.json` owns the shape PostgreSQL stores for a handler failure. Each SDK runs
this table, so an operator grouping a dead letter by name reads the same field in every language.
"""

from __future__ import annotations

from typing import Any

import psycopg
import pytest
from protocol_fixtures import read_protocol_fixture
from psycopg_pool import ConnectionPool

from workhorse import Admin, AdminAudit, EnqueueOptions, Queue, Worker
from workhorse.worker import _error_envelope

FAILURES: dict[str, Any] = read_protocol_fixture("failures.json")
ENVELOPE: dict[str, Any] = FAILURES["envelope"]
FIXTURES: list[dict[str, Any]] = FAILURES["fixtures"]

DECLARED_NAME = "PaymentDeclined"


class PaymentDeclined(Exception):
    """An error that names itself, the way a Python handler declares a failure."""


def _fixture_message(message: str | list[Any]) -> str:
    """Return the message a fixture describes. A Python string holds an unpaired surrogate."""
    if isinstance(message, str):
        return message
    return "".join(
        part if isinstance(part, str) else chr(int(part["unpairedSurrogate"], 16))
        for part in message
    )


def _fixture_error(fixture: dict[str, Any]) -> Exception:
    message = _fixture_message(fixture["error"]["message"])
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


def test_failure_envelope_replaces_the_text_jsonb_cannot_store() -> None:
    try:
        raise Exception("a\x00b \ud800 c \U0001f600 \ud83d\ude00 \udc80")
    except Exception as raised:
        envelope = _error_envelope(raised, False)
    assert isinstance(envelope, dict)
    # The joined pair is the character that a JSON reader takes from the pair's escapes.
    assert envelope["message"] == "a\ufffdb \ufffd c \U0001f600 \U0001f600 \ufffd"
    stack = envelope["stack"]
    assert isinstance(stack, str)
    assert "\x00" not in stack
    assert "\ufffd" in stack
    stack.encode("utf-8")


TASK = "failure.unstorable"


@pytest.mark.integration
@pytest.mark.parametrize("fast", [False, True], ids=["full-tier", "fast-tier"])
def test_unstorable_failure_settles_by_its_retry_policy(
    database_url: str, worker_pool: ConnectionPool, fast: bool
) -> None:
    """A handler error with a NUL used to make fail_v1 refuse the envelope (SM-1650)."""
    queue_name = f"python-unstorable-failure-{'fast' if fast else 'full'}"
    with psycopg.connect(database_url, autocommit=True) as operator:
        if fast:
            audit = AdminAudit(
                actor="python-failure-test", reason="exercise the fast tier", request_id=queue_name
            )
            assert Admin(operator).set_queue_tier(queue_name, "fast", audit) == "fast"
        retried = EnqueueOptions(max_attempts=2, retry_policy={"type": "fixed", "delayMs": 0})
        task_id = Queue(operator, default_queue=queue_name).enqueue(TASK, {}, retried)

    def handle(_payload: object, _context: object) -> object:
        raise PaymentDeclined("card\x00declined \ud800")

    worker = Worker(
        worker_pool, queue=queue_name, worker_id=queue_name, registry_interval_ms=0
    ).handle(TASK, handle)
    for _ in range(2):
        worker.run_once()

    outcome_table, attempt_column = (
        ("fast_task_outcome", "attempt") if fast else ("task_outcome", "current_attempt")
    )
    with psycopg.connect(database_url, autocommit=True) as observer:
        row = observer.execute(
            f"SELECT state, {attempt_column}, error->>'name', error->>'message' "
            f"FROM workhorse.{outcome_table} WHERE task_id = %s",
            (task_id,),
        ).fetchone()
    assert row == ("failed", 2, DECLARED_NAME, "card\ufffddeclined \ufffd")
