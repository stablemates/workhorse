from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from workhorse import EnqueueOptions, EnqueueRequest, Idempotency, ProtocolCompatibilityError, Queue

REPOSITORY = Path(__file__).parents[2]


class Cursor:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.description = [(name,) for name in rows[0]] if rows else []
        self._rows = rows

    def __enter__(self) -> Cursor:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def execute(self, sql: str, parameters: tuple[object, ...] = ()) -> None:
        self.connection_calls.append((sql, parameters))

    def fetchall(self) -> list[tuple[object, ...]]:
        return [tuple(row.values()) for row in self._rows]

    connection_calls: list[tuple[str, tuple[object, ...]]]


class Connection:
    def __init__(self, responses: list[list[dict[str, Any]]]) -> None:
        self.responses = responses
        self.calls: list[tuple[str, tuple[object, ...]]] = []

    def cursor(self) -> Cursor:
        cursor = Cursor(self.responses.pop(0))
        cursor.connection_calls = self.calls
        return cursor


def test_serializes_the_shared_request_fixture_and_returns_the_canonical_result() -> None:
    fixture = json.loads((REPOSITORY / "protocol/v1/requests.json").read_text())[0]
    connection = Connection(
        [
            [{"version": 45}],
            [
                {
                    "ordinal": 1,
                    "job_id": "00000000-0000-4000-8000-000000000001",
                    "outcome": "accepted",
                    "reason": None,
                }
            ],
        ]
    )

    result = Queue(connection).enqueue_with_result(
        fixture["application"]["type"],
        fixture["application"]["payload"],
        EnqueueOptions(
            queue="protocol-contract",
            priority=70,
            concurrency_key="acct-1",
            max_attempts=3,
            retry_policy={"type": "fixed", "delayMs": 25},
            tags=("conformance",),
            idempotency=Idempotency(scope="protocol", key="serialize", ttl_ms=60_000),
        ),
    )

    assert result.job_id == "00000000-0000-4000-8000-000000000001"
    assert result.outcome == "accepted"
    assert json.loads(connection.calls[1][1][0]) == [fixture["postgres"]]
    assert connection.calls[0][0].startswith("SELECT version FROM workhorse.schema_version")
    assert "workhorse.enqueue_many_v2" in connection.calls[1][0]


def test_refuses_an_incompatible_schema_before_enqueueing() -> None:
    connection = Connection([[{"version": 42}]])

    with pytest.raises(ProtocolCompatibilityError) as raised:
        Queue(connection).enqueue("email.send", {"message": "hello"})

    assert raised.value.code == "schema-too-old"
    assert len(connection.calls) == 1


def test_empty_batch_does_not_open_a_transaction_or_query_postgres() -> None:
    connection = Connection([])

    assert Queue(connection).enqueue_many([]) == []
    assert connection.calls == []


def test_batch_preserves_result_order() -> None:
    connection = Connection(
        [
            [{"version": 45}],
            [
                {"ordinal": 1, "job_id": "one", "outcome": "accepted", "reason": None},
                {"ordinal": 2, "job_id": "two", "outcome": "replayed", "reason": None},
            ],
        ]
    )

    results = Queue(connection).enqueue_many_with_results(
        [
            EnqueueRequest("email.send", {"message": "one"}),
            EnqueueRequest("email.send", {"message": "two"}),
        ]
    )

    assert [(result.job_id, result.outcome) for result in results] == [
        ("one", "accepted"),
        ("two", "replayed"),
    ]
