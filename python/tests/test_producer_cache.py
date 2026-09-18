from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from typing import Any

import asyncpg
import psycopg
import pytest
from test_enqueue import Connection

from workhorse import AsyncQueue, Queue, TaskContractVersion, TaskTypeContracts
from workhorse._statements import MINIMUM_SCHEMA_VERSION, PROTOCOL_VERSION

COMPATIBLE: list[dict[str, Any]] = [
    {"kind": "schema", "version": MINIMUM_SCHEMA_VERSION},
    {"kind": "protocol", "version": PROTOCOL_VERSION},
]


def definition(version: str) -> dict[str, Any]:
    return {
        "version": version,
        "schema": {"payload": {"type": "object", "required": ["name"]}, "result": True},
        "payload_max_bytes": 2048,
        "result_max_bytes": 4096,
        "payload_redact_keys": [],
        "result_redact_keys": [],
    }


def accepted(task_id: str) -> list[dict[str, Any]]:
    return [{"ordinal": 1, "task_id": task_id, "outcome": "accepted", "reason": None}]


def mismatch(*task_types: str) -> list[dict[str, Any]]:
    reason = json.dumps({"taskTypes": list(task_types)})
    return [{"ordinal": 0, "task_id": None, "outcome": "contract_mismatch", "reason": reason}]


def contracts(version: str) -> dict[str, TaskTypeContracts]:
    return {"email.send": TaskTypeContracts(version, {version: TaskContractVersion()})}


def contract_version(call: tuple[str, tuple[object, ...]]) -> object:
    return json.loads(str(call[1][0]))[0]["contractVersion"]


def test_warm_enqueue_issues_only_the_enqueue_statement() -> None:
    connection = Connection(
        [COMPATIBLE, [], COMPATIBLE, [definition("v1")], accepted("first"), accepted("second")]
    )
    queue = Queue(connection)
    queue.sync_contracts(contracts("v1"))
    queue.enqueue("email.send", {"name": "warm-up"})

    before = len(connection.calls)
    queue.enqueue("email.send", {"name": "warm"})

    warm = connection.calls[before:]
    assert len(warm) == 1
    assert "enqueue_many_v1" in warm[0][0]
    assert contract_version(warm[0]) == "v1"


def test_contract_mismatch_refreshes_the_cache_and_retries_once() -> None:
    connection = Connection(
        [
            COMPATIBLE,
            [],
            COMPATIBLE,
            [definition("v1")],
            accepted("first"),
            mismatch("email.send"),
            [definition("v2")],
            accepted("second"),
            accepted("third"),
        ]
    )
    queue = Queue(connection)
    queue.sync_contracts(contracts("v1"))
    queue.enqueue("email.send", {"name": "one"})

    before = len(connection.calls)
    assert queue.enqueue("email.send", {"name": "two"}) == "second"
    refreshed = connection.calls[before:]
    assert len(refreshed) == 3
    assert "get_contract_definition_v1" in refreshed[1][0]
    assert contract_version(refreshed[2]) == "v2"

    before = len(connection.calls)
    queue.enqueue("email.send", {"name": "three"})
    assert [contract_version(call) for call in connection.calls[before:]] == ["v2"]


def test_a_second_contract_mismatch_is_refused() -> None:
    connection = Connection(
        [
            COMPATIBLE,
            [],
            COMPATIBLE,
            [definition("v1")],
            mismatch("email.send"),
            [definition("v2")],
            mismatch("email.send"),
            [definition("v3")],
        ]
    )
    queue = Queue(connection)
    queue.sync_contracts(contracts("v1"))

    with pytest.raises(RuntimeError, match="contract policy changed again"):
        queue.enqueue("email.send", {"name": "one"})
    assert connection.responses == []


def test_sync_contracts_invalidates_cached_definitions() -> None:
    connection = Connection(
        [
            COMPATIBLE,
            [],
            COMPATIBLE,
            [definition("v1")],
            accepted("first"),
            COMPATIBLE,
            [],
            [definition("v2")],
            accepted("second"),
        ]
    )
    queue = Queue(connection)
    queue.sync_contracts(contracts("v1"))
    queue.enqueue("email.send", {"name": "one"})

    queue.sync_contracts(contracts("v2"))
    before = len(connection.calls)
    queue.enqueue("email.send", {"name": "two"})

    calls = connection.calls[before:]
    assert len(calls) == 2
    assert "get_contract_definition_v1" in calls[0][0]
    assert contract_version(calls[1]) == "v2"


class FlakyConnection(Connection):
    def __init__(self, responses: list[list[dict[str, Any]]]) -> None:
        super().__init__(responses)
        self.fail_next = True

    def cursor(self) -> Any:
        if self.fail_next:
            self.fail_next = False
            raise psycopg.OperationalError("connection reset")
        return super().cursor()


def test_a_transient_compatibility_failure_is_retried() -> None:
    connection = FlakyConnection([COMPATIBLE, accepted("first"), accepted("second")])
    queue = Queue(connection)

    with pytest.raises(psycopg.OperationalError):
        queue.enqueue("email.send", {})
    queue.enqueue("email.send", {})
    queue.enqueue("email.send", {})

    compatibility = [sql for sql, _ in connection.calls if "schema_version" in sql]
    assert len(compatibility) == 1


class ScriptedAsyncpg:
    def __init__(self, responses: list[list[dict[str, Any]]]) -> None:
        self.responses = responses
        self.calls: list[tuple[str, tuple[object, ...]]] = []

    async def fetch(self, sql: str, *parameters: object) -> Sequence[Mapping[str, object]]:
        self.calls.append((sql, parameters))
        return self.responses.pop(0)


@pytest.mark.asyncio
async def test_async_queue_caches_and_refreshes_on_mismatch() -> None:
    connection = ScriptedAsyncpg(
        [
            COMPATIBLE,
            [],
            COMPATIBLE,
            [definition("v1")],
            accepted("first"),
            accepted("second"),
            mismatch("email.send"),
            [definition("v2")],
            accepted("third"),
        ]
    )
    queue = AsyncQueue.from_asyncpg(connection)
    await queue.sync_contracts(contracts("v1"))
    await queue.enqueue("email.send", {"name": "warm-up"})

    before = len(connection.calls)
    await queue.enqueue("email.send", {"name": "warm"})
    assert len(connection.calls) - before == 1

    before = len(connection.calls)
    assert await queue.enqueue("email.send", {"name": "changed"}) == "third"
    refreshed = connection.calls[before:]
    assert len(refreshed) == 3
    assert contract_version(refreshed[2]) == "v2"


class StatementLog:
    """Forward a psycopg connection and record every statement sent to PostgreSQL."""

    def __init__(self, connection: psycopg.Connection[Any]) -> None:
        self.connection = connection
        self.statements: list[str] = []

    def cursor(self) -> Any:
        log = self
        cursor = self.connection.cursor()

        class LoggedCursor:
            description = property(lambda _self: cursor.description)

            def __enter__(self) -> LoggedCursor:
                cursor.__enter__()
                return self

            def __exit__(self, *arguments: Any) -> None:
                cursor.__exit__(*arguments)

            def execute(self, sql: str, parameters: Sequence[object] = ()) -> None:
                log.statements.append(sql)
                cursor.execute(sql, parameters)

            def fetchall(self) -> list[tuple[Any, ...]]:
                return cursor.fetchall()

        return LoggedCursor()


def set_policy(database_url: str, version: str) -> None:
    with psycopg.connect(database_url, autocommit=True) as other:
        Queue(other, default_queue="producer-cache").sync_contracts(contracts(version))


@pytest.mark.integration
def test_psycopg_warm_enqueue_is_one_round_trip(database_url: str) -> None:
    with psycopg.connect(database_url, autocommit=True) as connection:
        log = StatementLog(connection)
        queue = Queue(log, default_queue="producer-cache")  # type: ignore[arg-type]
        queue.sync_contracts(contracts("v1"))
        queue.enqueue("email.send", {"name": "warm-up"})

        before = len(log.statements)
        queue.enqueue("email.send", {"name": "warm"})
        warm = log.statements[before:]
        assert len(warm) == 1, warm
        assert "enqueue_many_v1" in warm[0]

        set_policy(database_url, "v2")
        before = len(log.statements)
        task_id = queue.enqueue("email.send", {"name": "after-change"})
        assert len(log.statements) - before == 3
        row = connection.execute(
            "SELECT contract_version FROM workhorse.task WHERE id = %s::uuid", (task_id,)
        ).fetchone()
        assert row == ("v2",)


class AsyncpgStatementLog:
    """Forward an asyncpg connection and record every statement sent to PostgreSQL."""

    def __init__(self, connection: asyncpg.Connection) -> None:
        self.connection = connection
        self.statements: list[str] = []

    async def fetch(self, sql: str, *parameters: object) -> Sequence[Mapping[str, object]]:
        self.statements.append(sql)
        return await self.connection.fetch(sql, *parameters)


@pytest.mark.integration
@pytest.mark.asyncio
async def test_asyncpg_warm_enqueue_is_one_round_trip(database_url: str) -> None:
    connection = await asyncpg.connect(database_url)
    try:
        log = AsyncpgStatementLog(connection)
        queue = AsyncQueue.from_asyncpg(log)  # type: ignore[arg-type]
        await queue.sync_contracts(contracts("v1"))
        await queue.enqueue("email.send", {"name": "warm-up"})

        before = len(log.statements)
        await queue.enqueue("email.send", {"name": "warm"})
        warm = log.statements[before:]
        assert len(warm) == 1, warm
        assert "enqueue_many_v1" in warm[0]

        set_policy(database_url, "v2")
        before = len(log.statements)
        await queue.enqueue("email.send", {"name": "after-change"})
        assert len(log.statements) - before == 3
    finally:
        await connection.close()
