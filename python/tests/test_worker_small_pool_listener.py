"""SM-1585: under the shared heartbeat opt-out, a pool of 1 polls, and a pool of 2 listens.

A shared listener holds one pooled connection. On a pool of 1 it would hold the only connection,
so registration, claims, and handler statements could not borrow one. Each test runs in the three
Python domains: ``Worker`` on a psycopg pool, ``AsyncWorker.from_psycopg``, and
``AsyncWorker.from_asyncpg``.
"""

from __future__ import annotations

import asyncio
import threading
from collections.abc import Callable
from contextlib import AsyncExitStack, ExitStack
from typing import Any
from uuid import uuid4

import asyncpg
import psycopg
import pytest
from psycopg_pool import AsyncConnectionPool, ConnectionPool

import workhorse.worker
from workhorse import (
    AsyncHandlerContext,
    AsyncWorker,
    EnqueueOptions,
    HandlerContext,
    Queue,
    Worker,
)

pytestmark = pytest.mark.integration

TASK_TYPE = "small.pool"
POLLING_ONLY = "workhorse.worker.polling_only"
# Every wait of a test ends well before the 30 s psycopg pool timeout. A worker whose listener
# holds the only connection fails a wait instead of a pool timeout.
WAIT_SECONDS = 10
POOL_TIMEOUT_SECONDS = 30
STOP_SECONDS = 15
# After the stop, each connection of the pool must come back within this time. A pool with
# min_size=0 can open a new connection here, which can take more than 1 s on a busy host.
RETURN_SECONDS = 5
DOMAINS = ("sync", "psycopg", "asyncpg")


def enqueue(database_url: str, queue: str, count: int) -> list[str]:
    with psycopg.connect(database_url) as connection:
        tasks = [
            Queue(connection, default_queue=queue).enqueue(
                TASK_TYPE, {}, EnqueueOptions(max_attempts=1)
            )
            for _ in range(count)
        ]
        connection.commit()
    return tasks


def succeeded(database_url: str, tasks: list[str]) -> int:
    with psycopg.connect(database_url, autocommit=True) as observer:
        row = observer.execute(
            "SELECT count(*) FROM workhorse.task_outcome "
            "WHERE task_id = ANY(%s) AND state = 'succeeded'",
            (tasks,),
        ).fetchone()
    assert row is not None
    return int(row[0])


def listener_backends(database_url: str, application_name: str) -> int:
    """The backends of the pool whose latest statement is LISTEN."""
    with psycopg.connect(database_url, autocommit=True) as observer:
        rows = observer.execute(
            "SELECT query FROM pg_stat_activity "
            "WHERE datname = current_database() AND application_name = %s",
            (application_name,),
        ).fetchall()
    return sum(1 for (query,) in rows if str(query).upper().startswith("LISTEN"))


class Handled:
    """Set one event for each handler that finished its database statement, in order."""

    def __init__(self, count: int) -> None:
        self._lock = threading.Lock()
        self._count = 0
        self.events = [threading.Event() for _ in range(count)]
        # The listener backends that each handler saw while it ran.
        self.listeners: list[int] = []

    def record(self, listeners: int) -> None:
        with self._lock:
            index = self._count
            self._count += 1
            self.listeners.append(listeners)
        if index < len(self.events):
            self.events[index].set()


@pytest.fixture
def warnings(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str, dict[str, Any]]]:
    """The polling-only records that the worker logged: severity, body, and attributes."""
    logged: list[tuple[str, str, dict[str, Any]]] = []
    emit = workhorse.worker._emit_log

    def record(severity: Any, event_name: Any, body: str, attributes: Any = None) -> None:
        if event_name == POLLING_ONLY:
            logged.append((severity, body, dict(attributes or {})))
        emit(severity, event_name, body, attributes)

    monkeypatch.setattr(workhorse.worker, "_emit_log", record)
    return logged


class Run:
    """One worker on a fresh pool of `size` connections, with the shared heartbeat opt-out."""

    def __init__(
        self, database_url: str, domain: str, size: int, resize_to: int | None = None
    ) -> None:
        self.database_url = database_url
        self.domain = domain
        self.size = size
        # The maximum size that the pool gets after the worker is constructed, before it runs.
        self.resize_to = resize_to
        self.queue = f"small-pool-{domain}-{size}-{uuid4().hex[:8]}"
        self.handled = Handled(3)
        self.errors: list[BaseException] = []
        self.pool: Any = None
        self.worker: Worker | AsyncWorker | None = None

    def options(self) -> dict[str, Any]:
        return {
            "queue": self.queue,
            "worker_id": self.queue,
            "concurrency": 1,
            "poll_ms": 50,
            "lease_ms": 5_000,
            "heartbeat_ms": 200,
            "shared_heartbeats": True,
            "on_registration_error": self.errors.append,
            "on_notification_error": self.errors.append,
        }

    def observe(self) -> int:
        return listener_backends(self.database_url, self.queue)

    def listening(self) -> threading.Event:
        worker = self.worker
        inner = worker._inner if isinstance(worker, AsyncWorker) else worker
        assert inner is not None
        return inner._notification_listening


def run_sync(run: Run, between: Callable[[], None]) -> None:
    def handler(_payload: Any, _context: HandlerContext) -> dict[str, bool]:
        with run.pool.connection() as connection:
            connection.execute("SELECT 1")
        run.handled.record(run.observe())
        return {"ok": True}

    with ConnectionPool(
        run.database_url,
        min_size=0,
        max_size=run.size,
        timeout=POOL_TIMEOUT_SECONDS,
        kwargs={"autocommit": True, "application_name": run.queue},
    ) as pool:
        run.pool = pool
        worker = Worker(pool, **run.options()).handle(TASK_TYPE, handler)
        run.worker = worker
        if run.resize_to is not None:
            pool.resize(min_size=0, max_size=run.resize_to)

        def target() -> None:
            try:
                worker.run()
            except BaseException as error:
                run.errors.append(error)

        thread = threading.Thread(target=target)
        thread.start()
        try:
            between()
        finally:
            worker.stop()
            thread.join(STOP_SECONDS)
        assert not thread.is_alive(), "the worker did not stop"
        # After the stop, the pool lends every connection at once.
        with ExitStack() as held:
            for _ in range(run.resize_to or run.size):
                held.enter_context(pool.connection(timeout=RETURN_SECONDS)).execute("SELECT 1")


async def run_async(run: Run, between: Callable[[], None]) -> None:
    async def handler(_payload: Any, _context: AsyncHandlerContext) -> dict[str, bool]:
        if run.domain == "psycopg":
            async with run.pool.connection() as connection:
                await connection.execute("SELECT 1")
        else:
            async with run.pool.acquire() as connection:
                await connection.fetchval("SELECT 1")
        run.handled.record(await asyncio.to_thread(run.observe))
        return {"ok": True}

    if run.domain == "psycopg":
        pool: Any = AsyncConnectionPool(
            run.database_url,
            min_size=0,
            max_size=run.size,
            timeout=POOL_TIMEOUT_SECONDS,
            kwargs={"autocommit": True, "application_name": run.queue},
            open=False,
        )
        await pool.open()
        worker = AsyncWorker.from_psycopg(pool, **run.options())
        if run.resize_to is not None:
            await pool.resize(min_size=0, max_size=run.resize_to)
    else:
        pool = await asyncpg.create_pool(
            run.database_url,
            min_size=0,
            max_size=run.size,
            server_settings={"application_name": run.queue},
        )
        worker = AsyncWorker.from_asyncpg(pool, **run.options())
    run.pool = pool
    run.worker = worker.handle(TASK_TYPE, handler)
    task = asyncio.create_task(worker.run())
    try:
        try:
            await asyncio.to_thread(between)
        finally:
            worker.stop()
            try:
                await asyncio.wait_for(asyncio.shield(task), STOP_SECONDS)
            except BaseException as error:
                run.errors.append(error)
        # After the stop, the pool lends every connection at once.
        async with AsyncExitStack() as held:
            for _ in range(run.resize_to or run.size):
                if run.domain == "psycopg":
                    connection = await held.enter_async_context(
                        pool.connection(timeout=RETURN_SECONDS)
                    )
                    await connection.execute("SELECT 1")
                else:
                    connection = await held.enter_async_context(
                        pool.acquire(timeout=RETURN_SECONDS)
                    )
                    await connection.fetchval("SELECT 1")
    finally:
        task.cancel()
        await asyncio.wait_for(pool.close(), 10)


async def complete_three_tasks(run: Run, started: Callable[[], None] = lambda: None) -> None:
    """Run two tasks enqueued before the start, then one enqueued once both ran.

    The third task needs a claim after the worker started, so it proves that dispatch continues.
    """
    tasks = await asyncio.to_thread(enqueue, run.database_url, run.queue, 2)

    def between() -> None:
        started()
        assert run.handled.events[1].wait(WAIT_SECONDS), (
            f"the first two tasks did not run: {run.errors!r}"
        )
        tasks.extend(enqueue(run.database_url, run.queue, 1))
        assert run.handled.events[2].wait(WAIT_SECONDS), (
            f"the third task did not run: {run.errors!r}"
        )

    if run.domain == "sync":
        await asyncio.to_thread(run_sync, run, between)
    else:
        await run_async(run, between)
    assert run.errors == []
    assert await asyncio.to_thread(succeeded, run.database_url, tasks) == 3


@pytest.mark.asyncio
@pytest.mark.parametrize("domain", DOMAINS)
async def test_the_opt_out_polls_on_a_pool_of_one_and_listens_on_a_pool_of_two(
    database_url: str, domain: str, warnings: list[tuple[str, str, dict[str, Any]]]
) -> None:
    # A pool of 1: no listener ever holds the only connection, and the worker warns once.
    single = Run(database_url, domain, 1)
    await complete_three_tasks(single)
    assert single.handled.listeners == [0, 0, 0]
    assert not single.listening().is_set()
    assert warnings == [
        (
            "WARN",
            "Worker has no notification listener and dispatches by polling",
            {
                "workhorse.worker.id": single.queue,
                "workhorse.worker.queues": (single.queue,),
                "workhorse.worker.pool_max_size": 1,
            },
        )
    ]

    # A pool of 2: the worker keeps one shared listener and does not warn.
    pair = Run(database_url, domain, 2)
    seen: list[int] = []

    def listens() -> None:
        # The worker reports its listener once the LISTEN statement has returned.
        assert pair.listening().wait(WAIT_SECONDS), "the worker never listened"
        seen.append(pair.observe())

    await complete_three_tasks(pair, listens)
    assert seen == [1]
    assert len(warnings) == 1, warnings


@pytest.mark.asyncio
@pytest.mark.parametrize("domain", ("sync", "psycopg"))
async def test_the_opt_out_reads_the_pool_size_again_before_the_listener_starts(
    database_url: str, domain: str, warnings: list[tuple[str, str, dict[str, Any]]]
) -> None:
    # SM-1677: the worker is constructed on a pool of 2, and the application then resizes the pool
    # to 1 before the run. The worker reads the current size, so it polls and warns once, and no
    # listener holds the only connection. asyncpg has no resize, so it is not in this test.
    resized = Run(database_url, domain, 2, resize_to=1)
    await complete_three_tasks(resized)
    assert resized.handled.listeners == [0, 0, 0]
    assert not resized.listening().is_set()
    assert warnings == [
        (
            "WARN",
            "Worker has no notification listener and dispatches by polling",
            {
                "workhorse.worker.id": resized.queue,
                "workhorse.worker.queues": (resized.queue,),
                "workhorse.worker.pool_max_size": 1,
            },
        )
    ]
