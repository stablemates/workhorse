"""SM-1571: every worker on one pool shares one listener and one heartbeat connection (ADR 0071).

Each test runs in the three Python domains where it applies: ``Worker`` on a psycopg pool,
``AsyncWorker.from_psycopg``, and ``AsyncWorker.from_asyncpg``.
"""

from __future__ import annotations

import asyncio
import threading
from collections.abc import Awaitable, Callable, Iterator
from contextlib import contextmanager, suppress
from dataclasses import dataclass, field
from time import monotonic, sleep
from typing import Any
from uuid import uuid4

import asyncpg
import psycopg
import pytest
from psycopg_pool import AsyncConnectionPool, ConnectionPool

from workhorse import (
    AsyncHandlerContext,
    AsyncWorker,
    EnqueueOptions,
    HandlerContext,
    Queue,
    Worker,
)

pytestmark = pytest.mark.integration

TASK_TYPE = "shared.connections"
HEARTBEAT_MS = 200
LEASE_MS = 5_000
# The boundary cells hold every task for three leases, so a worker that cannot renew loses its
# lease, and the heartbeat connections hold their pool connections before the refill.
CELL_HEARTBEAT_MS = 300
CELL_LEASE_MS = 1_500
CELL_HOLD_SECONDS = 3 * CELL_LEASE_MS / 1000
# A stop with a full pool spends at most the stop budget, max(I, 5 s), and the cleanup window of
# 1 s. The psycopg pool timeout is 30 s, and asyncpg has none, so a wait for either fails this.
STOP_GRACE_SECONDS = 10


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


def wait_until(condition: Callable[[], bool], seconds: float, message: str) -> None:
    deadline = monotonic() + seconds
    while not condition():
        assert monotonic() < deadline, message
        sleep(0.02)


def reserved_backends(database_url: str, application_name: str) -> tuple[set[int], set[int]]:
    """The listener backends and the heartbeat backends of one pool, seen now.

    A listener's latest statement is LISTEN. A heartbeat round ends with COMMIT, and no other
    worker statement sends one.
    """
    with psycopg.connect(database_url, autocommit=True) as observer:
        rows = observer.execute(
            "SELECT pid, query FROM pg_stat_activity "
            "WHERE datname = current_database() AND application_name = %s",
            (application_name,),
        ).fetchall()
    listeners = {int(pid) for pid, query in rows if str(query).upper().startswith("LISTEN")}
    heartbeats = {
        int(pid)
        for pid, query in rows
        if str(query) == "COMMIT" or "heartbeat_many_v2" in str(query)
    }
    return listeners, heartbeats


@contextmanager
def sync_pool(database_url: str, size: int, application_name: str) -> Iterator[ConnectionPool]:
    with ConnectionPool(
        database_url,
        min_size=0,
        max_size=size,
        kwargs={"autocommit": True, "application_name": application_name},
    ) as pool:
        yield pool


async def async_pool(database_url: str, domain: str, size: int, application_name: str) -> Any:
    if domain == "psycopg":
        pool: AsyncConnectionPool[Any] = AsyncConnectionPool(
            database_url,
            min_size=0,
            max_size=size,
            kwargs={"autocommit": True, "application_name": application_name},
            open=False,
        )
        await pool.open()
        return pool
    return await asyncpg.create_pool(
        database_url,
        min_size=0,
        max_size=size,
        server_settings={"application_name": application_name},
    )


async def close_async_pool(pool: Any) -> None:
    with suppress(Exception):
        await asyncio.wait_for(pool.close(), 10)


def async_worker(pool: Any, domain: str, **options: Any) -> AsyncWorker:
    if domain == "psycopg":
        return AsyncWorker.from_psycopg(pool, **options)
    return AsyncWorker.from_asyncpg(pool, **options)


def worker_options(queue: str, index: int, **overrides: Any) -> dict[str, Any]:
    options: dict[str, Any] = {
        "queue": queue,
        "worker_id": f"{queue}-{index}",
        "concurrency": 1,
        "heartbeat_ms": HEARTBEAT_MS,
        "lease_ms": LEASE_MS,
        "poll_ms": 100,
    }
    options.update(overrides)
    return options


class Slots:
    """Count the handlers that run at once. Each holds its slot until the test releases it.

    A handler whose attempt the worker cancels, because its lease was lost, counts in ``lost``.
    """

    def __init__(self, workers: int) -> None:
        self.workers = workers
        self._lock = threading.Lock()
        self.running = 0
        self.peak = 0
        self.lost = 0
        self.all_running = threading.Event()
        self.release = threading.Event()

    def lose(self) -> None:
        with self._lock:
            self.lost += 1

    def enter(self) -> None:
        with self._lock:
            self.running += 1
            self.peak = max(self.peak, self.running)
            if self.running >= self.workers:
                self.all_running.set()

    def leave(self) -> None:
        with self._lock:
            self.running -= 1


@dataclass
class CellResult:
    # The count of handlers that ran at once, at most.
    peak: int
    # The count of attempts that lost their lease while the test held them.
    lost: int
    # The count of tasks that succeeded.
    succeeded: int
    errors: list[BaseException]


def cell_options(queue: str, index: int) -> dict[str, Any]:
    return worker_options(queue, index, heartbeat_ms=CELL_HEARTBEAT_MS, lease_ms=CELL_LEASE_MS)


def run_sync_workers(database_url: str, workers: int, pool_size: int) -> CellResult:
    """Start `workers` sync workers on one pool, run two waves of tasks, and stop them.

    The first wave fills every slot and stays for three leases. The second wave needs a free
    connection for each completion and claim.
    """
    queue = f"shared-sync-{uuid4().hex[:8]}"
    tasks = enqueue(database_url, queue, 2 * workers)
    slots = Slots(workers)

    def handler(_payload: Any, context: HandlerContext) -> dict[str, bool]:
        slots.enter()
        try:
            while not slots.release.wait(0.05):
                if context.cancellation.cancelled:
                    slots.lose()
                    break
        finally:
            slots.leave()
        return {"ok": True}

    errors: list[BaseException] = []
    with sync_pool(database_url, pool_size, queue) as pool:
        running = [
            Worker(pool, **cell_options(queue, index)).handle(TASK_TYPE, handler)
            for index in range(workers)
        ]

        def run(worker: Worker) -> None:
            try:
                worker.run()
            except BaseException as error:
                errors.append(error)

        threads = [threading.Thread(target=run, args=(worker,)) for worker in running]
        for thread in threads:
            thread.start()
        try:
            if slots.all_running.wait(20):
                sleep(CELL_HOLD_SECONDS)
            slots.release.set()
            with suppress(AssertionError):
                wait_until(lambda: succeeded(database_url, tasks) == len(tasks), 20, "")
        finally:
            slots.release.set()
            for worker in running:
                worker.stop()
            for thread in threads:
                thread.join(STOP_GRACE_SECONDS)
        assert not any(thread.is_alive() for thread in threads), "a worker did not stop in time"
    return CellResult(slots.peak, slots.lost, succeeded(database_url, tasks), errors)


async def run_async_workers(
    database_url: str, domain: str, workers: int, pool_size: int
) -> CellResult:
    """The async form of `run_sync_workers`, for one async domain."""
    queue = f"shared-{domain}-{uuid4().hex[:8]}"
    tasks = await asyncio.to_thread(enqueue, database_url, queue, 2 * workers)
    slots = Slots(workers)

    async def handler(_payload: Any, context: AsyncHandlerContext) -> dict[str, bool]:
        slots.enter()
        try:
            while not slots.release.is_set():
                if context.cancellation.cancelled:
                    slots.lose()
                    break
                await asyncio.sleep(0.05)
        finally:
            slots.leave()
        return {"ok": True}

    pool = await async_pool(database_url, domain, pool_size, queue)
    try:
        running = [
            async_worker(pool, domain, **cell_options(queue, index)).handle(TASK_TYPE, handler)
            for index in range(workers)
        ]
        runs = [asyncio.create_task(worker.run()) for worker in running]
        try:
            if await asyncio.to_thread(slots.all_running.wait, 20):
                await asyncio.sleep(CELL_HOLD_SECONDS)
            slots.release.set()
            deadline = monotonic() + 20
            while monotonic() < deadline:
                if await asyncio.to_thread(succeeded, database_url, tasks) == len(tasks):
                    break
                await asyncio.sleep(0.05)
        finally:
            slots.release.set()
            for worker in running:
                worker.stop()
            done, _pending = await asyncio.wait(runs, timeout=STOP_GRACE_SECONDS)
        assert len(done) == len(runs), "a worker did not stop in time"
        errors = [error for run in runs if (error := run.exception()) is not None]
    finally:
        for run in runs:
            run.cancel()
        await close_async_pool(pool)
    done = await asyncio.to_thread(succeeded, database_url, tasks)
    return CellResult(slots.peak, slots.lost, done, errors)


# Two workers on a pool of 4, and 16 workers on a pool of 20. With one listener connection and one
# heartbeat connection for each worker, the workers hold most or all of these pools.
CELLS = [pytest.param(2, 4, id="2-workers-pool-4"), pytest.param(16, 20, id="16-workers-pool-20")]


@pytest.mark.parametrize(("workers", "pool_size"), CELLS)
def test_sync_workers_on_one_pool_all_claim_and_complete(
    database_url: str, workers: int, pool_size: int
) -> None:
    result = run_sync_workers(database_url, workers, pool_size)

    assert result.peak == workers, f"only {result.peak} of {workers} slots ran a task"
    assert result.lost == 0, f"{result.lost} of {workers} held attempts lost their lease"
    assert result.succeeded == 2 * workers
    assert result.errors == []


@pytest.mark.asyncio
@pytest.mark.parametrize("domain", ["psycopg", "asyncpg"])
@pytest.mark.parametrize(("workers", "pool_size"), CELLS)
async def test_async_workers_on_one_pool_all_claim_and_complete(
    database_url: str, domain: str, workers: int, pool_size: int
) -> None:
    result = await run_async_workers(database_url, domain, workers, pool_size)

    assert result.peak == workers, f"only {result.peak} of {workers} slots ran a task"
    assert result.lost == 0, f"{result.lost} of {workers} held attempts lost their lease"
    assert result.succeeded == 2 * workers
    assert result.errors == []


@dataclass
class ReservedSamples:
    """The reserved backends of one pool, sampled at a time each.

    A failed round may discard the shared heartbeat connection, and its replacement has a new
    backend. So the rule holds for each sample: at most one listener and one heartbeat backend at
    a time. With a connection for each worker, every sample shows one of each for every worker.
    """

    most_listeners: int = 0
    most_heartbeats: int = 0
    seen: list[tuple[set[int], set[int]]] = field(default_factory=list)


def sample_reserved_backends(
    database_url: str, application_name: str, seconds: float
) -> ReservedSamples:
    samples = ReservedSamples()
    deadline = monotonic() + seconds
    while monotonic() < deadline:
        listeners, heartbeats = reserved_backends(database_url, application_name)
        samples.most_listeners = max(samples.most_listeners, len(listeners))
        samples.most_heartbeats = max(samples.most_heartbeats, len(heartbeats))
        samples.seen.append((listeners, heartbeats))
        sleep(0.02)
    return samples


def test_two_sync_workers_hold_one_listener_and_one_heartbeat_connection(
    database_url: str,
) -> None:
    queue = f"shared-budget-sync-{uuid4().hex[:8]}"
    enqueue(database_url, queue, 2)
    slots = Slots(2)

    def handler(_payload: Any, _context: HandlerContext) -> dict[str, bool]:
        slots.enter()
        try:
            slots.release.wait(30)
        finally:
            slots.leave()
        return {"ok": True}

    with sync_pool(database_url, 6, queue) as pool:
        workers = [
            Worker(pool, **worker_options(queue, index)).handle(TASK_TYPE, handler)
            for index in range(2)
        ]
        threads = [threading.Thread(target=worker.run) for worker in workers]
        for thread in threads:
            thread.start()
        try:
            assert slots.all_running.wait(20), "the two tasks never ran at once"
            samples = sample_reserved_backends(database_url, queue, 1.5)
        finally:
            slots.release.set()
            for worker in workers:
                worker.stop()
            for thread in threads:
                thread.join(STOP_GRACE_SECONDS)

    assert samples.most_listeners == 1, samples.seen
    assert samples.most_heartbeats == 1, samples.seen


@pytest.mark.asyncio
@pytest.mark.parametrize("domain", ["psycopg", "asyncpg"])
async def test_two_async_workers_hold_one_listener_and_one_heartbeat_connection(
    database_url: str, domain: str
) -> None:
    queue = f"shared-budget-{domain}-{uuid4().hex[:8]}"
    await asyncio.to_thread(enqueue, database_url, queue, 2)
    slots = Slots(2)

    async def handler(_payload: Any, _context: AsyncHandlerContext) -> dict[str, bool]:
        slots.enter()
        try:
            await asyncio.to_thread(slots.release.wait, 30)
        finally:
            slots.leave()
        return {"ok": True}

    pool = await async_pool(database_url, domain, 6, queue)
    try:
        workers = [
            async_worker(pool, domain, **worker_options(queue, index)).handle(TASK_TYPE, handler)
            for index in range(2)
        ]
        runs = [asyncio.create_task(worker.run()) for worker in workers]
        try:
            assert await asyncio.to_thread(slots.all_running.wait, 20), "no two tasks at once"
            samples = await asyncio.to_thread(sample_reserved_backends, database_url, queue, 1.5)
        finally:
            slots.release.set()
            for worker in workers:
                worker.stop()
            await asyncio.wait_for(asyncio.gather(*runs), STOP_GRACE_SECONDS)
    finally:
        await close_async_pool(pool)

    assert samples.most_listeners == 1, samples.seen
    assert samples.most_heartbeats == 1, samples.seen


def started(database_url: str, application_name: str) -> bool:
    """True once the worker named `application_name` listens and has registered."""
    with psycopg.connect(database_url, autocommit=True) as observer:
        row = observer.execute(
            "SELECT count(*) FROM workhorse.worker_registry WHERE worker_id = %s",
            (f"{application_name}-0",),
        ).fetchone()
    registered = row is not None and int(row[0]) > 0
    return registered and bool(reserved_backends(database_url, application_name)[0])


def take_every_connection(pool: ConnectionPool, held: list[Any], hogging: threading.Event) -> None:
    while hogging.is_set():
        with suppress(Exception):
            held.append(pool.getconn(timeout=0.2))


class AsyncHog:
    """Another user of the pool that takes every connection the pool lends or gets back."""

    def __init__(self, pool: Any, domain: str) -> None:
        self.pool = pool
        self.domain = domain
        self.held: list[Any] = []
        # Set once a request found the pool empty and waited for its whole timeout.
        self.starved = asyncio.Event()

    async def run(self) -> None:
        while True:
            try:
                if self.domain == "psycopg":
                    self.held.append(await self.pool.getconn(timeout=0.2))
                else:
                    self.held.append(await self.pool.acquire(timeout=0.2))
            except Exception:
                self.starved.set()

    def full(self) -> bool:
        """True while the pool lends every connection it may open."""
        if self.domain == "psycopg":
            stats = self.pool.get_stats()
            return stats.get("pool_available", 0) == 0 and stats["pool_size"] == stats["pool_max"]
        return self.pool.get_idle_size() == 0 and self.pool.get_size() == self.pool.get_max_size()

    async def give_back(self) -> None:
        for connection in self.held:
            if self.domain == "psycopg":
                await self.pool.putconn(connection)
            else:
                await self.pool.release(connection)


def test_a_sync_stop_with_a_full_pool_finishes_within_the_grace(database_url: str) -> None:
    queue = f"shared-stop-sync-{uuid4().hex[:8]}"
    with sync_pool(database_url, 3, queue) as pool:
        worker = Worker(pool, **worker_options(queue, 0, poll_ms=5_000))
        thread = threading.Thread(target=worker.run)
        thread.start()
        held: list[Any] = []
        hogging = threading.Event()
        hogging.set()
        hog: threading.Thread | None = None
        try:
            wait_until(lambda: started(database_url, queue), 10, "the worker never started")
            # Another user of the pool takes every connection that the worker leaves or gives
            # back, the listener connection too.
            hog = threading.Thread(target=take_every_connection, args=(pool, held, hogging))
            hog.start()
            wait_until(lambda: pool.get_stats().get("requests_waiting", 0) > 0, 10, "pool free")
            stopped_at = monotonic()
            worker.stop()
            thread.join(STOP_GRACE_SECONDS + 5)
            stop_seconds = monotonic() - stopped_at
        finally:
            hogging.clear()
            if hog is not None:
                hog.join(5)
            for connection in held:
                pool.putconn(connection)
            thread.join(30)

    assert not thread.is_alive()
    assert stop_seconds < STOP_GRACE_SECONDS, stop_seconds


@pytest.mark.asyncio
@pytest.mark.parametrize("domain", ["psycopg", "asyncpg"])
async def test_an_async_stop_with_a_full_pool_finishes_within_the_grace(
    database_url: str, domain: str
) -> None:
    queue = f"shared-stop-{domain}-{uuid4().hex[:8]}"
    pool = await async_pool(database_url, domain, 3, queue)
    hog: AsyncHog | None = None
    hogging: asyncio.Task[None] | None = None
    try:
        worker = async_worker(pool, domain, **worker_options(queue, 0, poll_ms=5_000))
        run = asyncio.create_task(worker.run())
        deadline = monotonic() + 10
        while not await asyncio.to_thread(started, database_url, queue):
            assert monotonic() < deadline, "the worker never listened"
            await asyncio.sleep(0.02)
        # Another user of the pool takes every connection that the worker leaves or gives back,
        # the listener connection too.
        hog = AsyncHog(pool, domain)
        hogging = asyncio.create_task(hog.run())
        # A checkpoint: a request found the pool empty, and the pool lends every connection.
        await asyncio.wait_for(hog.starved.wait(), 10)
        assert hog.full(), "the pool still had a free connection"
        stopped_at = monotonic()
        worker.stop()
        done, _pending = await asyncio.wait({run}, timeout=STOP_GRACE_SECONDS + 5)
        stop_seconds = monotonic() - stopped_at
        assert done == {run}, "the worker did not stop"
        assert run.exception() is None
    finally:
        if hogging is not None:
            hogging.cancel()
            with suppress(asyncio.CancelledError):
                await hogging
        if hog is not None:
            await hog.give_back()
        await close_async_pool(pool)

    assert stop_seconds < STOP_GRACE_SECONDS, stop_seconds


def test_a_sync_worker_refuses_to_start_when_it_cannot_reserve_its_heartbeat_connection(
    database_url: str,
) -> None:
    queue = f"shared-refusal-{uuid4().hex[:8]}"
    with sync_pool(database_url, 3, queue) as pool:
        held = [pool.getconn() for _ in range(3)]
        try:
            worker = Worker(pool, **worker_options(queue, 0, heartbeat_ms=100))
            started_at = monotonic()
            with pytest.raises(TimeoutError) as raised:
                worker.run_once()
            elapsed = monotonic() - started_at
        finally:
            for connection in held:
                pool.putconn(connection)

    # The startup budget is max(I, 5 s), so the error names 5000 ms, the pool, and the opt-out.
    assert 4.5 < elapsed < 9, elapsed
    message = str(raised.value)
    assert "reserve its heartbeat connection" in message
    assert "5000 ms" in message
    assert "ConnectionPool" in message
    assert "shared_heartbeats=True" in message


def run_in_new_loop(operation: Callable[[], Awaitable[Any]]) -> BaseException | None:
    """Run `operation` on a new event loop in another thread, and return its error."""
    errors: list[BaseException] = []

    def run() -> None:
        try:
            asyncio.run(operation())  # type: ignore[arg-type]
        except BaseException as error:
            errors.append(error)

    thread = threading.Thread(target=run)
    thread.start()
    thread.join(20)
    assert not thread.is_alive()
    return errors[0] if errors else None


@pytest.mark.asyncio
async def test_an_async_psycopg_worker_on_another_event_loop_refuses_to_start(
    database_url: str,
) -> None:
    queue = f"shared-loop-{uuid4().hex[:8]}"
    pool = await async_pool(database_url, "psycopg", 4, queue)
    first = AsyncWorker.from_psycopg(pool, **worker_options(queue, 0))
    run = asyncio.create_task(first.run())
    try:
        deadline = monotonic() + 10
        while not await asyncio.to_thread(started, database_url, queue):
            assert monotonic() < deadline, "the first worker never started"
            await asyncio.sleep(0.02)
        second = AsyncWorker.from_psycopg(pool, **worker_options(queue, 1))
        error = await asyncio.to_thread(run_in_new_loop, second.run)
    finally:
        first.stop()
        await asyncio.wait_for(run, STOP_GRACE_SECONDS)
        await close_async_pool(pool)

    assert isinstance(error, RuntimeError)
    assert "another event loop" in str(error)


@pytest.mark.asyncio
async def test_an_async_psycopg_pool_refuses_another_loop_before_its_first_worker(
    database_url: str,
) -> None:
    queue = f"shared-loop-first-{uuid4().hex[:8]}"
    pool = await async_pool(database_url, "psycopg", 4, queue)
    try:
        worker = AsyncWorker.from_psycopg(pool, **worker_options(queue, 0))
        error = await asyncio.to_thread(run_in_new_loop, worker.run)
    finally:
        await close_async_pool(pool)

    assert isinstance(error, RuntimeError)
    assert "another event loop" in str(error)


@pytest.mark.asyncio
async def test_an_async_psycopg_pool_refuses_another_loop_after_its_last_worker(
    database_url: str,
) -> None:
    queue = f"shared-loop-last-{uuid4().hex[:8]}"
    pool = await async_pool(database_url, "psycopg", 4, queue)
    try:
        first = AsyncWorker.from_psycopg(pool, **worker_options(queue, 0))
        run = asyncio.create_task(first.run())
        deadline = monotonic() + 10
        while not await asyncio.to_thread(started, database_url, queue):
            assert monotonic() < deadline, "the first worker never started"
            await asyncio.sleep(0.02)
        first.stop()
        await asyncio.wait_for(run, STOP_GRACE_SECONDS)
        second = AsyncWorker.from_psycopg(pool, **worker_options(queue, 1))
        error = await asyncio.to_thread(run_in_new_loop, second.run)
    finally:
        await close_async_pool(pool)

    assert isinstance(error, RuntimeError)
    assert "another event loop" in str(error)


@pytest.mark.asyncio
async def test_an_asyncpg_worker_on_another_event_loop_refuses_to_start(database_url: str) -> None:
    queue = f"shared-loop-asyncpg-{uuid4().hex[:8]}"
    pool = await async_pool(database_url, "asyncpg", 4, queue)
    try:
        worker = AsyncWorker.from_asyncpg(pool, **worker_options(queue, 0))
        error = await asyncio.to_thread(run_in_new_loop, worker.run)
    finally:
        await close_async_pool(pool)

    assert isinstance(error, RuntimeError)
    assert "another event loop" in str(error)
