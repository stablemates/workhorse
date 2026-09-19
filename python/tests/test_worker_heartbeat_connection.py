from __future__ import annotations
# ruff: noqa


import asyncio
from itertools import pairwise
from threading import Event, Lock, Thread
from time import monotonic, sleep
from typing import Any

import asyncpg
import psycopg
import pytest

from workhorse import (
    AsyncHandlerContext,
    AsyncWorker,
    EnqueueOptions,
    HandlerContext,
    Queue,
    Worker,
)

worker_pool: Any

pytestmark = pytest.mark.integration

# The acceptance scenario: a handler's checkpoint statement is held for ten seconds.
CHECKPOINT_HOLD_SECONDS = 10
LEASE_MS = 3_000
HEARTBEAT_MS = 1_000


class StatementLog:
    """Record each statement a connection sends to PostgreSQL, with the time it was sent."""

    def __init__(self) -> None:
        self._lock = Lock()
        self.entries: list[tuple[float, str]] = []

    def record(self, statement: object) -> None:
        with self._lock:
            self.entries.append((monotonic(), str(statement)))

    def statements(self) -> list[str]:
        with self._lock:
            return [statement for _, statement in self.entries]

    def times(self, fragment: str) -> list[float]:
        with self._lock:
            return [at for at, statement in self.entries if fragment in statement]

    def cursor_factory(self) -> type[psycopg.Cursor[Any]]:
        log = self

        class LoggedCursor(psycopg.Cursor[Any]):
            def execute(self, query: Any, params: Any = None, **kwargs: Any) -> Any:
                log.record(query)
                return super().execute(query, params, **kwargs)

        return LoggedCursor


def enqueue(database_url: str, task_type: str, queue: str) -> str:
    with psycopg.connect(database_url) as connection:
        task_id = Queue(connection, default_queue=queue).enqueue(
            task_type, {}, EnqueueOptions(max_attempts=1)
        )
        connection.commit()
    return task_id


def outcome(database_url: str, task_id: str) -> tuple[Any, ...] | None:
    with psycopg.connect(database_url, autocommit=True) as observer:
        return observer.execute(
            "SELECT state FROM workhorse.task_outcome WHERE task_id = %s", (task_id,)
        ).fetchone()


class CheckpointHold:
    """Block every checkpoint statement for the hold, starting once the handler runs."""

    def __init__(self, database_url: str, async_psycopg_pool, asyncpg_pool) -> None:
        self.handler_running = Event()
        self.lock_held = Event()
        self.held_from = 0.0
        self._thread = Thread(target=self._hold, args=(database_url,))
        self._thread.start()

    def _hold(self, database_url: str, async_psycopg_pool, asyncpg_pool) -> None:
        if not self.handler_running.wait(30):
            return
        with psycopg.connect(database_url) as blocker:
            blocker.execute("LOCK TABLE workhorse.task_checkpoint IN ACCESS EXCLUSIVE MODE")
            self.held_from = monotonic()
            self.lock_held.set()
            sleep(CHECKPOINT_HOLD_SECONDS)
            blocker.rollback()

    def enter(self) -> None:
        """Called by the handler: wait for the lock so its checkpoint statement blocks."""
        self.handler_running.set()
        assert self.lock_held.wait(30)

    def join(self) -> None:
        self._thread.join()


def assert_heartbeats_kept_pace(times: list[float], held_from: float, held_until: float) -> None:
    during_hold = [at for at in times if held_from <= at <= held_until]
    assert len(during_hold) >= CHECKPOINT_HOLD_SECONDS * 1000 // HEARTBEAT_MS - 2, times
    gaps = [later - earlier for earlier, later in pairwise(during_hold)]
    # A heartbeat may be late by at most one interval.
    assert max(gaps) <= 2 * HEARTBEAT_MS / 1000, gaps


@pytest.mark.slow
def test_a_held_checkpoint_does_not_delay_heartbeats(
    database_url: str, async_psycopg_pool, asyncpg_pool
) -> None:
    task_id = enqueue(database_url, "checkpoint.held", "heartbeat-connection")
    heartbeat_log = StatementLog()
    hold = CheckpointHold(database_url)
    handler_resumed_at: list[float] = []

    def handler(_payload: Any, context: HandlerContext) -> dict[str, bool]:
        hold.enter()
        context.checkpoint("held", lambda: {"held": True})
        handler_resumed_at.append(monotonic())
        return {"ok": True}

    with psycopg.connect(database_url, autocommit=True) as worker_connection:
        worker = Worker(
            worker_pool,
            queue="heartbeat-connection",
            worker_id="python-heartbeat-connection",
            lease_ms=LEASE_MS,
            heartbeat_ms=HEARTBEAT_MS,
        ).handle("checkpoint.held", handler)
        assert worker.run_once() is True
        hold.join()

    assert handler_resumed_at
    assert handler_resumed_at[0] - hold.held_from >= CHECKPOINT_HOLD_SECONDS - 1
    assert_heartbeats_kept_pace(
        heartbeat_log.times("heartbeat_many_v1"), hold.held_from + 1, handler_resumed_at[0]
    )
    assert outcome(database_url, task_id) == ("succeeded",)


@pytest.mark.slow
@pytest.mark.asyncio
async def test_a_held_async_checkpoint_does_not_delay_heartbeats(
    database_url: str, async_psycopg_pool, asyncpg_pool
) -> None:
    task_id = enqueue(database_url, "checkpoint.held.async", "heartbeat-connection-async")
    heartbeat_log = StatementLog()
    hold = CheckpointHold(database_url)
    handler_resumed_at: list[float] = []

    async def handler(_payload: Any, context: AsyncHandlerContext) -> dict[str, bool]:
        async def operation() -> dict[str, bool]:
            return {"held": True}

        await asyncio.to_thread(hold.enter)
        await context.checkpoint("held", operation)
        handler_resumed_at.append(monotonic())
        return {"ok": True}

    class LoggedConnection:
        """Forward an asyncpg connection and log each heartbeat statement."""

        def __init__(self, connection: asyncpg.Connection) -> None:
            self._connection = connection

        async def fetch(self, sql: str, *parameters: object) -> Any:
            heartbeat_log.record(sql)
            return await self._connection.fetch(sql, *parameters)

        def is_in_transaction(self) -> bool:
            return bool(self._connection.is_in_transaction())

        async def close(self) -> None:
            await self._connection.close()

    async def heartbeat_connection() -> LoggedConnection:
        return LoggedConnection(await asyncpg.connect(database_url))

    connection = await asyncpg.connect(database_url)
    try:
        worker = AsyncWorker.from_asyncpg(
            asyncpg_pool,
            queue="heartbeat-connection-async",
            worker_id="python-async-heartbeat-connection",
            lease_ms=LEASE_MS,
            heartbeat_ms=HEARTBEAT_MS,
        ).handle("checkpoint.held.async", handler)
        assert await worker.run_once() is True
        await asyncio.to_thread(hold.join)
    finally:
        await connection.close()

    assert handler_resumed_at
    assert handler_resumed_at[0] - hold.held_from >= CHECKPOINT_HOLD_SECONDS - 1
    assert_heartbeats_kept_pace(
        heartbeat_log.times("heartbeat_many_v1"), hold.held_from + 1, handler_resumed_at[0]
    )
    assert outcome(database_url, task_id) == ("succeeded",)


def test_a_dispatch_pass_leaves_promotion_and_recovery_to_the_tick(
    database_url: str, async_psycopg_pool, asyncpg_pool
) -> None:
    log = StatementLog()
    with psycopg.connect(
        database_url, autocommit=True, cursor_factory=log.cursor_factory()
    ) as worker_connection:
        worker = Worker(
            worker_pool,
            queue="dispatch-pass",
            worker_id="python-dispatch-pass",
            maintenance_interval_ms=3_600_000,
            registry_interval_ms=0,
        ).handle("dispatch.pass", lambda _payload, _context: {"ok": True})
        worker.run_once()
        assert any("tick_v1" in statement for statement in log.statements())

        enqueue(database_url, "dispatch.pass", "dispatch-pass")
        before = len(log.statements())
        assert worker.run_once() is True
        dispatch_pass = log.statements()[before:]

    assert any("claim_many_v1" in statement for statement in dispatch_pass)
    for statement in dispatch_pass:
        assert "promote_v1" not in statement, dispatch_pass
        assert "recover_expired" not in statement, dispatch_pass
