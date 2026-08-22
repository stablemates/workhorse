from __future__ import annotations

from collections.abc import Mapping, Sequence

import pytest

from workhorse import AsyncQueue


class AsyncpgConnection:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple[object, ...]]] = []

    async def fetch(self, sql: str, *parameters: object) -> Sequence[Mapping[str, object]]:
        self.calls.append((sql, parameters))
        if "schema_version" in sql:
            return [{"version": 1}]
        if "send_signal_v1" in sql:
            return [
                {
                    "status": "delivered",
                    "payload": {"approved": True},
                    "delivered_at": None,
                    "delivered_by": "service",
                }
            ]
        if "complete_human_wait_v1" in sql:
            return [
                {
                    "status": "completed",
                    "result": {"approved": True},
                    "completed_at": None,
                    "completed_by": "reviewer",
                }
            ]
        return [{"ordinal": 1, "job_id": "asyncpg", "outcome": "accepted", "reason": None}]

    async def commit(self) -> None:
        raise AssertionError("the Workhorse client must not commit")

    async def rollback(self) -> None:
        raise AssertionError("the Workhorse client must not roll back")

    async def close(self) -> None:
        raise AssertionError("the Workhorse client must not close the connection")


class AsyncPsycopgCursor:
    def __init__(self, connection: AsyncPsycopgConnection) -> None:
        self.connection = connection
        self.sql = ""
        self.description = [("ordinal",), ("job_id",), ("outcome",), ("reason",)]

    async def __aenter__(self) -> AsyncPsycopgCursor:
        return self

    async def __aexit__(self, *_args: object) -> None:
        return None

    async def execute(self, sql: str, parameters: Sequence[object] = ()) -> None:
        self.sql = sql
        if "schema_version" in sql:
            self.description = [("version",)]
        self.connection.calls.append((sql, tuple(parameters)))

    async def fetchall(self) -> Sequence[Sequence[object]]:
        if "schema_version" in self.sql:
            return [(1,)]
        return [(1, "psycopg", "accepted", None)]


class AsyncPsycopgConnection:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple[object, ...]]] = []

    def cursor(self) -> AsyncPsycopgCursor:
        return AsyncPsycopgCursor(self)


@pytest.mark.asyncio
async def test_asyncpg_uses_native_parameters_without_owning_the_transaction() -> None:
    connection = AsyncpgConnection()

    result = await AsyncQueue.from_asyncpg(connection).enqueue("email.send", {"id": 1})

    assert result == "asyncpg"
    assert "$1::jsonb" in connection.calls[1][0]
    assert len(connection.calls) == 2


@pytest.mark.asyncio
async def test_async_psycopg_uses_native_parameters() -> None:
    connection = AsyncPsycopgConnection()

    result = await AsyncQueue.from_psycopg(connection).enqueue("email.send", {"id": 1})

    assert result == "psycopg"
    assert "%s::jsonb" in connection.calls[1][0]
    assert len(connection.calls) == 2


@pytest.mark.asyncio
async def test_asyncpg_schedule_sync_uses_numbered_parameters() -> None:
    connection = AsyncpgConnection()

    await AsyncQueue.from_asyncpg(connection).sync_schedules("billing", [])

    assert "$1::text, $2::jsonb, $3::boolean" in connection.calls[1][0]
    assert len(connection.calls) == 2


@pytest.mark.asyncio
async def test_asyncpg_delivers_external_wait_results() -> None:
    connection = AsyncpgConnection()
    queue = AsyncQueue.from_asyncpg(connection)

    signal = await queue.send_signal(
        "00000000-0000-4000-8000-000000000001",
        "approval",
        {"approved": True},
        idempotency_key="signal-key",
        requested_by="service",
    )
    decision = await queue.complete_human_wait(
        "00000000-0000-4000-8000-000000000001",
        "review",
        {"approved": True},
        idempotency_key="review-key",
        requested_by="reviewer",
    )

    assert signal.status == "delivered"
    assert decision.status == "completed"
    assert "$1::uuid" in connection.calls[1][0]
    assert "$1::uuid" in connection.calls[3][0]
