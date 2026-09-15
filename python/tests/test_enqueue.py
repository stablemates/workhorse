from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

import pytest
from protocol_fixtures import assert_fixture_execution, read_protocol_fixture
from test_protocol_conformance import assert_value

from workhorse import (
    EnqueueOptions,
    EnqueueRequest,
    Idempotency,
    ProtocolCompatibilityError,
    Queue,
    TaskContractValidationError,
    TaskContractVersion,
    TaskTypeContracts,
)
from workhorse._statements import MINIMUM_SCHEMA_VERSION, PROTOCOL_VERSION


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


def test_serializes_every_shared_request_fixture_and_returns_the_canonical_result() -> None:
    fixtures = read_protocol_fixture("requests.json")
    executed: set[str] = set()
    for fixture in fixtures:
        connection = Connection(
            [
                [
                    {"kind": "schema", "version": MINIMUM_SCHEMA_VERSION},
                    {"kind": "protocol", "version": PROTOCOL_VERSION},
                ],
                [
                    {
                        "ordinal": 1,
                        "task_id": "00000000-0000-4000-8000-000000000001",
                        "outcome": "accepted",
                        "reason": None,
                    }
                ],
            ]
        )
        application = fixture["application"]
        options = application["options"]
        idempotency = options.get("idempotency")
        result = Queue(connection).enqueue_with_result(
            application["type"],
            application["payload"],
            EnqueueOptions(
                queue=options.get("queue"),
                priority=options.get("priority", 0),
                concurrency_key=options.get("concurrencyKey"),
                max_attempts=options.get("maxAttempts", 25),
                retry_policy=options.get("retryPolicy"),
                tags=tuple(options.get("tags", [])),
                idempotency=(
                    Idempotency(
                        scope=idempotency["scope"],
                        key=idempotency["key"],
                        ttl_ms=idempotency["ttlMs"],
                    )
                    if idempotency is not None
                    else None
                ),
            ),
        )

        assert result.task_id == "00000000-0000-4000-8000-000000000001"
        assert result.outcome == "accepted"
        serialized = json.loads(connection.calls[1][1][0])
        assert_value([fixture["postgres"]], serialized, {}, fixture["id"])
        assert connection.calls[0][0].startswith("SELECT 'protocol' AS kind, version")
        assert "workhorse.enqueue_many_v1" in connection.calls[1][0]
        executed.add(fixture["id"])
    assert_fixture_execution("requests", fixtures, executed)


def test_refuses_an_incompatible_schema_before_enqueueing() -> None:
    connection = Connection([[{"kind": "schema", "version": 0}]])

    with pytest.raises(ProtocolCompatibilityError) as raised:
        Queue(connection).enqueue("email.send", {"message": "hello"})

    assert raised.value.code == "schema-too-old"
    assert len(connection.calls) == 1


def test_empty_batch_does_not_open_a_transaction_or_query_postgres() -> None:
    connection = Connection([])

    assert Queue(connection).enqueue_many([]) == []
    assert connection.calls == []


def test_cancel_returns_postgres_cancellation_metadata() -> None:
    requested_at = datetime(2026, 8, 23, 2, 0, tzinfo=UTC)
    connection = Connection(
        [
            [
                {"kind": "schema", "version": MINIMUM_SCHEMA_VERSION},
                {"kind": "protocol", "version": PROTOCOL_VERSION},
            ],
            [
                {
                    "status": "cancel_requested",
                    "state": "active",
                    "current_attempt": 2,
                    "requested_at": requested_at,
                    "requested_by": "api",
                    "reason": "request ended",
                    "finished_at": None,
                }
            ],
        ]
    )

    result = Queue(connection).cancel(
        "00000000-0000-4000-8000-000000000001",
        requested_by="api",
        reason="request ended",
    )

    assert result.status == "cancel_requested"
    assert result.state == "active"
    assert result.current_attempt == 2
    assert result.requested_at == requested_at
    assert result.requested_by == "api"
    assert result.reason == "request ended"
    assert result.finished_at is None
    assert connection.calls[1][1] == (
        "00000000-0000-4000-8000-000000000001",
        "api",
        "request ended",
    )


def test_batch_preserves_result_order() -> None:
    connection = Connection(
        [
            [
                {"kind": "schema", "version": MINIMUM_SCHEMA_VERSION},
                {"kind": "protocol", "version": PROTOCOL_VERSION},
            ],
            [
                {"ordinal": 1, "task_id": "one", "outcome": "accepted", "reason": None},
                {"ordinal": 2, "task_id": "two", "outcome": "replayed", "reason": None},
            ],
        ]
    )

    results = Queue(connection).enqueue_many_with_results(
        [
            EnqueueRequest("email.send", {"message": "one"}),
            EnqueueRequest("email.send", {"message": "two"}),
        ]
    )

    assert [(result.task_id, result.outcome) for result in results] == [
        ("one", "accepted"),
        ("two", "replayed"),
    ]


def test_contracted_batches_look_each_task_type_up_once() -> None:
    compatibility = [
        {"kind": "schema", "version": MINIMUM_SCHEMA_VERSION},
        {"kind": "protocol", "version": PROTOCOL_VERSION},
    ]
    definition = {
        "version": "v1",
        "schema": {"payload": {"type": "object", "required": ["name"]}, "result": True},
        "payload_max_bytes": 2048,
        "result_max_bytes": 4096,
        "payload_redact_keys": ["secret"],
        "result_redact_keys": [],
    }
    connection = Connection(
        [
            compatibility,
            [{"synced": True}],
            compatibility,
            [definition],
            [],
            [
                {"ordinal": 1, "task_id": "first", "outcome": "accepted", "reason": None},
                {"ordinal": 2, "task_id": "second", "outcome": "accepted", "reason": None},
                {"ordinal": 3, "task_id": "third", "outcome": "accepted", "reason": None},
            ],
        ]
    )
    queue = Queue(connection, default_queue="go-contract")
    queue.sync_contracts({"email.send": TaskTypeContracts("v1", {"v1": TaskContractVersion()})})

    results = queue.enqueue_many_with_results(
        [
            EnqueueRequest("email.send", {"name": "one"}),
            EnqueueRequest("email.send", {"name": "two"}),
            EnqueueRequest("audit.log", {}),
        ]
    )
    assert [result.task_id for result in results] == ["first", "second", "third"]
    lookups = [sql for sql, _ in connection.calls if "get_contract_definition_v1" in sql]
    assert len(lookups) == 2
    assert len(connection.calls) == 6
    serialized = json.loads(str(connection.calls[5][1][0]))
    assert serialized[0]["contractVersion"] == "v1"
    assert serialized[1]["contractVersion"] == "v1"
    assert serialized[0]["payloadMaxBytes"] == 2048
    assert serialized[0]["sensitivePayloadKeys"] == ["secret"]
    assert serialized[2]["contractVersion"] is None
    assert serialized[2]["payloadMaxBytes"] == 1048576

    connection.responses = [compatibility, [definition]]
    with pytest.raises(TaskContractValidationError) as rejected:
        queue.enqueue_many_with_results([EnqueueRequest("email.send", {"missing": "name"})])
    assert rejected.value.kind == "payload"
