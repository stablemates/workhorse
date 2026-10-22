"""SM-1571: the shared hub of one pool, its claim gate, and its bounded acquisitions (ADR 0071)."""

from __future__ import annotations

import asyncio
import sys
import threading
import weakref
from collections.abc import AsyncIterator, Callable
from concurrent.futures import Future, TimeoutError as FutureTimeoutError
from contextlib import contextmanager, suppress
from time import monotonic, sleep
from typing import Any
from uuid import uuid4

import asyncpg
import psycopg
import pytest
from psycopg_pool import AsyncConnectionPool, ConnectionPool

import workhorse._pool_hub as pool_hub_module
import workhorse.worker as worker_module
from workhorse import AsyncWorker, EnqueueOptions, HandlerContext, Queue, Worker
from workhorse._drivers import PooledAsyncpgExecutor
from workhorse._notifications import SharedTaskNotificationListener
from workhorse._pool_hub import (
    ASYNC_PSYCOPG_HUBS,
    ASYNCPG_HUBS,
    HEARTBEAT,
    LISTENER,
    SYNC_HUBS,
    AsyncConnectionOwner,
    AsyncTaskNotificationListener,
    HeartbeatGroup,
    HeartbeatReservation,
    PoolHub,
    PoolRegistry,
)
from workhorse._statements import STATEMENTS

TASK_TYPE = "shared.gate"
HEARTBEAT_MS = 200
LEASE_MS = 5_000
STOP_GRACE_SECONDS = 10
# A lease that no outage of the gate test can expire.
OUTAGE_LEASE_MS = 60_000
# The backoff is capped at heartbeat_ms, and the replacement wakes dispatch. A claim inside this
# bound did not wait for the 5 s poll interval.
CLAIM_WAKE_SECONDS = 4


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


def heartbeat_backends(database_url: str, application_name: str) -> set[int]:
    """The backends of one pool whose latest statement ended a heartbeat round."""
    with psycopg.connect(database_url, autocommit=True) as observer:
        rows = observer.execute(
            "SELECT pid FROM pg_stat_activity WHERE datname = current_database() "
            "AND application_name = %s AND query = 'COMMIT'",
            (application_name,),
        ).fetchall()
    return {int(row[0]) for row in rows}


def hub_of(registry: PoolRegistry) -> PoolHub:
    (hub,) = registry.hubs()
    return hub


@pytest.mark.integration
def test_no_claim_runs_while_the_heartbeat_connection_is_missing(
    database_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A lost heartbeat connection closes the claim gate until its replacement arrives.

    The replacement cannot open during the outage. A task enqueued then stays unclaimed, though
    the worker has a free slot. When the outage ends, the replacement arrives and dispatch claims
    the task at once, long before the 5 s poll interval.
    """
    outage = threading.Event()
    open_heartbeat = worker_module._psycopg_heartbeat_acquire

    def heartbeat_with_outage(pool_ref: Any) -> Callable[..., Any]:
        acquire = open_heartbeat(pool_ref)

        def acquire_unless_out(timeout: float | None = None) -> Any:
            if outage.is_set():
                raise psycopg.OperationalError("the database is unreachable")
            return acquire(timeout)

        return acquire_unless_out

    monkeypatch.setattr(worker_module, "_psycopg_heartbeat_acquire", heartbeat_with_outage)
    queue = f"shared-gate-{uuid4().hex[:8]}"
    (first,) = enqueue(database_url, queue, 1)
    started = threading.Event()
    release = threading.Event()
    ran: set[str] = set()

    def handler(_payload: Any, context: HandlerContext) -> dict[str, bool]:
        ran.add(context.task.id)
        if context.task.id == first:
            started.set()
            release.wait(30)
        return {"ok": True}

    with ConnectionPool(
        database_url,
        min_size=0,
        max_size=6,
        kwargs={"autocommit": True, "application_name": queue},
    ) as pool:
        worker = Worker(
            pool,
            queue=queue,
            worker_id=queue,
            concurrency=2,
            heartbeat_ms=HEARTBEAT_MS,
            # The outage must never expire the first lease, so this lease outlasts the test.
            lease_ms=OUTAGE_LEASE_MS,
            poll_ms=5_000,
        )
        worker.handle(TASK_TYPE, handler)
        thread = threading.Thread(target=worker.run)
        thread.start()
        second = ""
        try:
            assert started.wait(20)
            wait_until(lambda: bool(heartbeat_backends(database_url, queue)), 5, "no round ran")
            (heartbeat,) = heartbeat_backends(database_url, queue)
            outage.set()
            with psycopg.connect(database_url, autocommit=True) as observer:
                observer.execute("SELECT pg_terminate_backend(%s)", (heartbeat,))
            reservation = hub_of(SYNC_HUBS).heartbeat
            wait_until(lambda: not reservation.ready(), 5, "the round never lost its connection")

            # A checkpoint: after the second task is committed, the dispatcher reads the closed
            # gate. The watcher counts only reads after the commit, and the test then wakes the
            # dispatcher itself, so the check never waits for the poll interval.
            committed = threading.Event()
            refused = threading.Event()
            gate = worker._heartbeat_ready

            def watched_gate(generation: int | None = None) -> bool:
                open_ = gate(generation)
                if not open_ and committed.is_set():
                    refused.set()
                return open_

            worker._heartbeat_ready = watched_gate  # type: ignore[method-assign]
            (second,) = enqueue(database_url, queue, 1)
            committed.set()
            worker._wake_dispatcher()
            assert refused.wait(10), "the dispatcher never read the gate"
            assert second not in ran, "a claim ran without a heartbeat connection"

            outage.clear()
            recovered_at = monotonic()
            wait_until(lambda: second in ran, CLAIM_WAKE_SECONDS, "dispatch never woke")
            claim_delay = monotonic() - recovered_at
        finally:
            release.set()
            worker.stop()
            thread.join(STOP_GRACE_SECONDS)

    assert not thread.is_alive()
    # The backoff is capped at I, and the replacement wakes dispatch. The poll interval is 5 s.
    assert claim_delay < CLAIM_WAKE_SECONDS, claim_delay
    assert ran == {first, second}
    assert succeeded(database_url, [first]) == 1, "the first task did not complete"
    assert succeeded(database_url, [second]) == 1, "the second task did not complete"


class _Pool:
    max_size = 3


def test_the_registry_shares_one_hub_per_pool_and_forgets_it_with_the_last_worker() -> None:
    registry = PoolRegistry("test")
    created: list[PoolHub] = []

    def create(_pool_ref: Callable[[], Any]) -> PoolHub:
        hub = PoolHub("test", object(), HeartbeatReservation(lambda _timeout: (None, lambda: None)))  # type: ignore[arg-type]
        created.append(hub)
        return hub

    pool = _Pool()
    other = _Pool()
    hubs: list[PoolHub] = []
    threads = [
        threading.Thread(target=lambda: hubs.append(registry.attach(pool, create)))
        for _ in range(16)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    # Concurrent workers on one pool get one hub. Another pool gets its own.
    assert len(created) == 1 and all(hub is created[0] for hub in hubs)
    assert registry.attach(other, create) is not created[0]
    registry.detach(created[1])
    for hub in hubs[:-1]:
        registry.detach(hub)
    assert registry.hubs() == [created[0]]
    registry.detach(hubs[-1])
    assert registry.hubs() == []


def test_the_registry_does_not_keep_a_pool_alive() -> None:
    """The registry and its hub hold no strong reference to the pool.

    The check counts references. It does not wait for the garbage collector.
    """
    registry = PoolRegistry("test")
    pool = _Pool()
    references = sys.getrefcount(pool)
    refs: list[Callable[[], Any]] = []

    def create(pool_ref: Callable[[], Any]) -> PoolHub:
        refs.append(pool_ref)
        return PoolHub(
            "test",
            object(),
            HeartbeatReservation(lambda _timeout: (None, lambda: None)),  # type: ignore[arg-type]
        )

    hub = registry.attach(pool, create)

    assert sys.getrefcount(pool) == references
    assert isinstance(refs[0], weakref.ref) and refs[0]() is pool
    registry.detach(hub)
    assert registry.hubs() == []


def test_the_registry_forgets_the_hub_of_a_collected_pool() -> None:
    """The weakref callback only queues the key. The next registry call removes the entry."""
    registry = PoolRegistry("test")
    pool = _Pool()
    registry.attach(
        pool,
        lambda _pool_ref: PoolHub(
            "test",
            object(),
            HeartbeatReservation(lambda _timeout: (None, lambda: None)),  # type: ignore[arg-type]
        ),
    )
    # Stand in for the collection of the pool: its weak reference is dead, and its callback ran.
    entry = registry._entries[id(pool)]
    entry.pool = lambda: None
    registry._forget(id(pool))

    assert registry.hubs() == []


class _RecordingAsyncpgPool:
    def __init__(self) -> None:
        self.timeouts: list[float | None] = []

    async def acquire(self, *, timeout: float | None = None) -> Any:  # noqa: ASYNC109
        self.timeouts.append(timeout)
        return _NoRows()

    async def release(self, _connection: Any) -> None:
        return None


class _NoRows:
    async def fetch(self, _sql: str, *_parameters: object) -> list[Any]:
        return []


@pytest.mark.asyncio
async def test_every_asyncpg_acquire_of_the_worker_has_an_explicit_timeout() -> None:
    pool = _RecordingAsyncpgPool()
    executor = PooledAsyncpgExecutor(pool)  # type: ignore[arg-type]

    await executor.rows(STATEMENTS.compatibility)
    await executor.within(0.25).rows(STATEMENTS.compatibility)

    assert pool.timeouts == [30.0, 0.25]


@pytest.mark.integration
def test_the_last_sync_worker_releases_the_hub_of_its_pool(database_url: str) -> None:
    queue = f"hub-release-{uuid4().hex[:8]}"
    with ConnectionPool(database_url, min_size=0, max_size=4, kwargs={"autocommit": True}) as pool:
        workers = [
            Worker(pool, queue=queue, worker_id=f"{queue}-{index}", heartbeat_ms=HEARTBEAT_MS)
            for index in range(2)
        ]
        threads = [threading.Thread(target=worker.run) for worker in workers]
        for thread in threads:
            thread.start()
        wait_until(lambda: len(SYNC_HUBS.hubs()) == 1, 10, "the workers never attached")
        hub = hub_of(SYNC_HUBS)
        wait_until(hub.heartbeat.ready, 10, "the heartbeat connection never opened")
        workers[0].stop()
        threads[0].join(STOP_GRACE_SECONDS)
        # The other worker still uses the shared connections.
        assert hub_of(SYNC_HUBS) is hub and hub.heartbeat.ready()
        workers[1].stop()
        threads[1].join(STOP_GRACE_SECONDS)
        assert SYNC_HUBS.hubs() == []
        assert not hub.heartbeat.ready()
        wait_until(
            lambda: pool.get_stats().get("pool_available", 0) == pool.get_stats()["pool_size"],
            5,
            "a shared connection did not return to the pool",
        )


@pytest.mark.asyncio
async def test_an_async_hub_is_forgotten_with_its_last_worker(asyncpg_pool: Any) -> None:
    worker = AsyncWorker.from_asyncpg(asyncpg_pool, queue=f"hub-{uuid4().hex[:8]}")
    run = asyncio.create_task(worker.run())
    deadline = monotonic() + 10
    while not ASYNCPG_HUBS.hubs():
        assert monotonic() < deadline, "the worker never attached"
        await asyncio.sleep(0.02)
    worker.stop()
    await asyncio.wait_for(run, STOP_GRACE_SECONDS)

    assert ASYNCPG_HUBS.hubs() == []
    assert ASYNC_PSYCOPG_HUBS.hubs() == []


def test_a_late_heartbeat_connection_has_one_owner() -> None:
    """A connection that arrives after every worker left is closed, not kept."""
    arrive = threading.Event()
    closed: list[str] = []

    def acquire(_timeout: float) -> Any:
        arrive.wait(5)
        return object(), lambda: closed.append("closed")

    reservation = HeartbeatReservation(acquire)
    subscription = reservation.subscribe(100, lambda: None)
    assert not reservation.wait_ready(monotonic() + 0.1)
    subscription.close()
    arrive.set()
    wait_until(lambda: closed == ["closed"], 5, "the late connection was not closed")
    assert not reservation.ready()


def test_repeated_round_timeouts_run_one_acquisition_at_a_time() -> None:
    """Rounds that time out while the pool lends nothing never pile up connection requests."""
    lock = threading.Lock()
    calls = 0
    in_flight = 0
    most = 0
    acquiring = threading.Event()
    lend = threading.Event()

    def acquire(_timeout: float) -> Any:
        nonlocal calls, in_flight, most
        with lock:
            calls += 1
            in_flight += 1
            most = max(most, in_flight)
        acquiring.set()
        lend.wait(10)
        with lock:
            in_flight -= 1
        raise TimeoutError("the pool lent nothing")

    reservation = HeartbeatReservation(acquire)
    subscription = reservation.subscribe(100, lambda: None)
    # A checkpoint: the one acquisition waits for the pool.
    assert acquiring.wait(5)
    for _ in range(20):
        assert reservation.take(monotonic() + 0.01) is None
    with lock:
        assert calls == 1 and in_flight == 1
    subscription.close()
    lend.set()
    wait_until(lambda: reservation._acquirer is None, 5, "the acquirer never stopped")

    assert most == 1


def test_a_configuration_error_of_the_heartbeat_connection_fails_startup_at_once() -> None:
    def acquire(_timeout: float) -> Any:
        raise ValueError("Heartbeat connection must be in autocommit mode")

    reservation = HeartbeatReservation(acquire)
    subscription = reservation.subscribe(100, lambda: None)
    started_at = monotonic()
    with pytest.raises(ValueError, match="autocommit"):
        reservation.wait_ready(monotonic() + 5)
    subscription.close()

    assert monotonic() - started_at < 1


def test_a_round_that_hangs_past_its_lend_time_no_longer_holds_the_connection() -> None:
    """A round stuck in its driver cannot keep the claim gate open or block the replacement."""
    opened: list[str] = []
    closed: list[str] = []

    def acquire(_timeout: float) -> Any:
        name = f"connection-{len(opened)}"
        opened.append(name)
        return name, lambda: closed.append(name)

    reservation = HeartbeatReservation(acquire)
    subscription = reservation.subscribe(100, lambda: None)
    assert reservation.wait_ready(monotonic() + 5)
    hung = reservation.take(monotonic() + 0.05)
    assert hung is not None and reservation.ready()

    # The round's deadline and the 1 s grace pass. A readiness check then sees the hung round,
    # and the reservation opens a replacement.
    wait_until(lambda: reservation.ready() and len(opened) == 2, 5, "no replacement opened")
    # The hung round returns at last. Its connection is closed, and the replacement stays.
    reservation.put_back(hung)
    assert closed == ["connection-0"]
    replacement = reservation.take(monotonic() + 1)
    assert replacement is not None and replacement[0] == "connection-1"
    subscription.close()


@contextmanager
def loop_in_thread() -> Any:
    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()
    try:
        yield loop
    finally:
        loop.call_soon_threadsafe(loop.stop)
        thread.join(5)
        loop.close()


def owner_of(
    loop: asyncio.AbstractEventLoop, open_: Callable[[], Any], released: list[str]
) -> AsyncConnectionOwner:
    """An owner whose connections come from `open_` and go back into `released`."""

    async def open_connection(_timeout: float) -> tuple[Any, Callable[[], Any]]:
        connection = await open_()

        async def release() -> None:
            released.append(connection)

        return connection, release

    return AsyncConnectionOwner(loop, open_connection)


def test_a_result_that_arrives_after_the_wait_ended_has_one_owner() -> None:
    released: list[str] = []
    with loop_in_thread() as loop:
        arrive = asyncio.Event()

        async def late_open() -> str:
            await arrive.wait()
            return "late connection"

        owner = owner_of(loop, late_open, released)
        with pytest.raises(TimeoutError):
            owner.acquire(HEARTBEAT, monotonic() + 0.05)
        # The caller left. The connection arrives now and has no waiter, so the owner gives it
        # back as its next step.
        loop.call_soon_threadsafe(arrive.set)
        wait_until(lambda: released == ["late connection"], 5, "the late connection leaked")
        wait_until(lambda: not owner.busy(), 5, "the owner stayed busy")
        owner.close()
    assert released == ["late connection"]


def test_a_stalled_loop_keeps_no_abandoned_acquisition() -> None:
    """Repeated timeouts on a stalled loop leave requests that the owner drops unopened."""
    started: list[int] = []
    released: list[str] = []
    unstall = threading.Event()
    with loop_in_thread() as loop:
        stalled = threading.Event()

        def stall() -> None:
            stalled.set()
            assert unstall.wait(10)

        loop.call_soon_threadsafe(stall)
        assert stalled.wait(5)

        async def open_() -> str:
            started.append(len(started))
            return "connection"

        owner = owner_of(loop, open_, released)
        for _ in range(5):
            with pytest.raises(TimeoutError):
                owner.acquire(HEARTBEAT, monotonic() + 0.01)
            assert owner.busy()
        unstall.set()
        wait_until(lambda: not owner.busy(), 5, "the owner never settled the requests")
        owner.close()

    # Every caller left before the loop ran, so no acquisition started.
    assert started == []
    assert released == []


def test_a_configuration_error_at_runtime_keeps_the_acquirer_retrying() -> None:
    attempts = 0
    ready = threading.Event()

    def acquire(_timeout: float) -> Any:
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            raise ValueError("Heartbeat connection must be in autocommit mode")
        return object(), lambda: None

    reservation = HeartbeatReservation(acquire)
    subscription = reservation.subscribe(100, ready.set)
    # No worker waits at startup, and no task is active. The acquirer still retries.
    assert ready.wait(5), "the acquirer stopped after a configuration error"
    assert reservation.ready()
    subscription.close()


class _RecordedWaits(threading.Condition):
    """A condition that records the timeout of each wait of the acquirer thread, and returns at
    once."""

    def __init__(self) -> None:
        super().__init__()
        self.timeouts: list[float] = []

    def wait(self, timeout: float | None = None) -> bool:
        if threading.current_thread().name != "workhorse-heartbeat-acquire":
            return super().wait(timeout)
        assert timeout is not None
        self.timeouts.append(timeout)
        return super().wait(0)


@pytest.mark.parametrize(
    ("factor", "expected"),
    [
        (1.1, [0.11, 0.22, 0.44, 0.88, 1.0, 1.0]),
        (0.9, [0.09, 0.18, 0.36, 0.72, 0.9, 0.9]),
    ],
)
def test_no_replacement_wait_is_longer_than_the_heartbeat_interval(
    monkeypatch: pytest.MonkeyPatch, factor: float, expected: list[float]
) -> None:
    """SM-1584: the cap applies after the random factor (ADR 0071, rule 6)."""
    monkeypatch.setattr(pool_hub_module.random, "uniform", lambda _low, _high: factor)
    attempts = 0
    ready = threading.Event()

    def acquire(_timeout: float) -> Any:
        nonlocal attempts
        attempts += 1
        if attempts <= len(expected):
            raise TimeoutError("the pool lent nothing")
        return object(), lambda: None

    reservation = HeartbeatReservation(acquire)
    waits = _RecordedWaits()
    reservation._condition = waits
    subscription = reservation.subscribe(1_000, ready.set)
    assert ready.wait(5), "the acquirer never got the connection"
    subscription.close()

    assert waits.timeouts == pytest.approx(expected)


def test_a_replacement_wait_uses_the_interval_of_a_worker_that_joined_during_the_attempt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """SM-1584: the cap is the shortest interval of the subscribers when the wait starts."""
    monkeypatch.setattr(pool_hub_module.random, "uniform", lambda _low, _high: 1.0)
    attempts = 0
    ready = threading.Event()
    joined: list[Any] = []

    def acquire(_timeout: float) -> Any:
        nonlocal attempts
        attempts += 1
        if attempts == 6:
            # The backoff reached the 1,000 ms cap. A worker with a 100 ms interval joins.
            joined.append(reservation.subscribe(100, lambda: None))
        if attempts <= 7:
            raise TimeoutError("the pool lent nothing")
        return object(), lambda: None

    reservation = HeartbeatReservation(acquire)
    waits = _RecordedWaits()
    reservation._condition = waits
    subscription = reservation.subscribe(1_000, ready.set)
    assert ready.wait(5), "the acquirer never got the connection"
    subscription.close()
    for late in joined:
        late.close()

    assert waits.timeouts == pytest.approx([0.1, 0.2, 0.4, 0.8, 1.0, 0.1, 0.1])


class _ListeningConnection:
    """A listener connection for both drivers: psycopg async and asyncpg."""

    autocommit = True

    async def execute(self, _query: str) -> None:
        return None

    async def notifies(self, *, timeout: float, stop_after: int) -> AsyncIterator[Any]:  # noqa: ASYNC109
        del stop_after
        await asyncio.sleep(timeout)
        return
        yield

    def is_in_transaction(self) -> bool:
        return False

    def is_closed(self) -> bool:
        return False

    async def add_listener(self, _channel: str, _callback: object) -> None:
        return None

    async def remove_listener(self, _channel: str, _callback: object) -> None:
        return None


class _HeldReleases:
    """Listener connections whose release waits until the test opens `gate`."""

    def __init__(self) -> None:
        self.held = 0
        self.most = 0
        self.opened = 0
        self.releasing = asyncio.Event()
        self.gate = asyncio.Event()

    async def open(self) -> Any:
        self.opened += 1
        self.held += 1
        self.most = max(self.most, self.held)

        async def release() -> None:
            self.releasing.set()
            await self.gate.wait()
            self.held -= 1

        return _ListeningConnection(), release


async def until(condition: Callable[[], bool]) -> None:
    deadline = monotonic() + 5
    while not condition():
        assert monotonic() < deadline, "the condition never held"
        await asyncio.sleep(0.005)


@pytest.mark.asyncio
@pytest.mark.parametrize("driver", ["psycopg", "asyncpg"])
async def test_a_new_async_listener_waits_for_the_stopping_one_to_release(driver: str) -> None:
    """The listener of one pool never holds two connections, also across a quick restart."""
    connections = _HeldReleases()
    listener = AsyncTaskNotificationListener(driver, connections.open)
    first = listener.subscribe(["q"], lambda: None)
    await until(lambda: listener.listening)
    stopping = first.close()
    assert stopping is not None
    await asyncio.wait_for(connections.releasing.wait(), 5)

    # A worker subscribes while the old task still gives its connection back.
    second = listener.subscribe(["q"], lambda: None)
    await asyncio.sleep(0)
    assert connections.opened == 1 and listener.busy()
    connections.gate.set()
    with suppress(asyncio.CancelledError):
        await asyncio.wait_for(stopping, 5)
    await until(lambda: listener.listening)
    # The old task stopped after the new one subscribed, and it did not clear the new state.
    assert listener.listening and connections.opened == 2
    restarted = second.close()
    assert restarted is not None
    with suppress(asyncio.CancelledError):
        await asyncio.wait_for(restarted, 5)

    assert connections.most == 1


@pytest.mark.asyncio
async def test_a_cancelled_release_ends_the_listener_without_a_reconnect() -> None:
    """The last worker leaves while the listener gives its connection back after a failure.

    The release finishes within its bound, the task ends cancelled, and no connection opens again.
    """
    connections = _HeldReleases()

    class FailingConnection(_ListeningConnection):
        async def add_listener(self, _channel: str, _callback: object) -> None:
            raise OSError("LISTEN failed")

    async def open_failing() -> Any:
        _connection, release = await connections.open()
        return FailingConnection(), release

    listener = AsyncTaskNotificationListener("asyncpg", open_failing)
    subscription = listener.subscribe(["q"], lambda: None)
    await asyncio.wait_for(connections.releasing.wait(), 5)
    task = subscription.close()
    assert task is not None
    connections.gate.set()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 5)

    assert connections.opened == 1
    assert connections.held == 0
    assert not listener.busy()


@pytest.mark.asyncio
async def test_a_release_that_hangs_ends_within_its_bound_and_blocks_a_second_connection() -> None:
    connections = _HeldReleases()
    listener = AsyncTaskNotificationListener("asyncpg", connections.open)
    subscription = listener.subscribe(["q"], lambda: None)
    await until(lambda: listener.listening)
    task = subscription.close()
    assert task is not None
    started_at = monotonic()
    with suppress(asyncio.CancelledError):
        await asyncio.wait_for(task, 5)
    # The release keeps the connection past the 1 s bound, and the listener stays busy.
    assert monotonic() - started_at < 2
    assert connections.held == 1 and listener.busy()

    again = listener.subscribe(["q"], lambda: None)
    await asyncio.sleep(0)
    assert connections.opened == 1, "a second connection opened while the first one was held"
    connections.gate.set()
    await until(lambda: listener.listening)
    assert connections.opened == 2 and connections.most == 1
    task = again.close()
    assert task is not None
    with suppress(asyncio.CancelledError):
        await asyncio.wait_for(task, 5)


class _BlockingListenerConnection:
    """A sync listener connection whose close waits until the test opens `gate`."""

    autocommit = True

    def __init__(self, gate: threading.Event) -> None:
        self._gate = gate

    def execute(self, _query: str) -> None:
        return None

    def notifies(self, *, timeout: float, stop_after: int) -> Any:
        del stop_after
        sleep(timeout)
        return iter(())

    def close(self) -> None:
        assert self._gate.wait(10)


def test_a_sync_restart_reuses_the_hub_while_its_listener_still_stops() -> None:
    """A worker starts while the last worker's listener still closes its connection.

    The registry keeps the hub until the listener stopped, so the new worker shares its listener,
    and the pool never holds two listener connections.
    """
    gate = threading.Event()
    opened: list[int] = []

    def open_connection() -> Any:
        opened.append(len(opened))
        return _BlockingListenerConnection(gate)

    registry = PoolRegistry("test")
    pool = _Pool()

    def create(_pool_ref: Callable[[], Any]) -> PoolHub:
        return PoolHub(
            "test",
            SharedTaskNotificationListener(open_connection),
            HeartbeatReservation(lambda _timeout: (object(), lambda: None)),
        )

    hub = registry.attach(pool, create)
    first = hub.listener.subscribe(["q"], lambda: None)
    wait_until(hub.listener.is_listening, 5, "the listener never listened")
    first.close()
    registry.detach(hub)
    # The listener thread still closes its connection, so the hub is still the pool's hub.
    assert hub.busy()
    again = registry.attach(pool, create)
    assert again is hub
    second = hub.listener.subscribe(["q"], lambda: None)
    gate.set()
    wait_until(hub.listener.is_listening, 5, "the listener never listened again")
    second.close()
    registry.detach(hub)
    wait_until(lambda: not hub.busy(), 5, "the listener never stopped")

    assert registry.hubs() == []
    assert len(opened) == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("driver", ["psycopg", "asyncpg"])
async def test_an_async_restart_reuses_the_hub_while_its_listener_still_releases(
    driver: str,
) -> None:
    connections = _HeldReleases()
    registry = PoolRegistry("test")
    pool = _Pool()
    loop = asyncio.get_running_loop()

    def create(_pool_ref: Callable[[], Any]) -> PoolHub:
        return PoolHub(
            "test",
            AsyncTaskNotificationListener(driver, connections.open),
            HeartbeatReservation(lambda _timeout: (object(), lambda: None)),
            loop,
        )

    hub = registry.attach(pool, create, loop)
    first = hub.listener.subscribe(["q"], lambda: None)
    await until(lambda: hub.listener.listening)
    stopping = first.close()
    registry.detach(hub)
    await asyncio.wait_for(connections.releasing.wait(), 5)
    assert hub.busy()
    assert registry.attach(pool, create, loop) is hub
    second = hub.listener.subscribe(["q"], lambda: None)
    connections.gate.set()
    with suppress(asyncio.CancelledError):
        await asyncio.wait_for(stopping, 5)
    await until(lambda: hub.listener.listening)
    task = second.close()
    registry.detach(hub)
    with suppress(asyncio.CancelledError):
        await asyncio.wait_for(task, 5)

    assert connections.most == 1
    assert registry.hubs() == []


def test_the_registry_remembers_the_loop_of_a_pool_after_its_last_worker() -> None:
    registry = PoolRegistry("test")
    pool = _Pool()
    owner = asyncio.new_event_loop()
    other = asyncio.new_event_loop()
    try:

        def create(_pool_ref: Callable[[], Any]) -> PoolHub:
            return PoolHub(
                "test",
                object(),
                HeartbeatReservation(lambda _timeout: (object(), lambda: None)),
                owner,
            )

        hub = registry.attach(pool, create, owner)
        registry.detach(hub)
        assert registry.hubs() == []
        with pytest.raises(RuntimeError, match="another event loop"):
            registry.attach(pool, create, other)
        assert registry.remembered_loop(pool) is owner
    finally:
        owner.close()
        other.close()


def test_rounds_take_the_shared_connection_in_arrival_order() -> None:
    """No worker on a pool waits behind the others for more than one turn each."""
    reservation = HeartbeatReservation(lambda _timeout: (object(), lambda: None))
    subscription = reservation.subscribe(1_000, lambda: None)
    assert reservation.wait_ready(monotonic() + 5)
    first = reservation.take(monotonic() + 5)
    assert first is not None
    order: list[int] = []

    def round_(index: int) -> None:
        connection = reservation.take(monotonic() + 5)
        assert connection is not None
        order.append(index)
        reservation.put_back(connection)

    rounds = []
    for index in range(8):
        rounds.append(threading.Thread(target=round_, args=(index,)))
        rounds[-1].start()
        # Each round queues before the next one starts.
        wait_until(lambda queued=index + 1: len(reservation._waiters) == queued, 5, "not queued")
    reservation.put_back(first)
    for thread in rounds:
        thread.join(5)
    subscription.close()

    assert order == list(range(8))


class GroupRound:
    """A heartbeat round in a `HeartbeatGroup`, with the turn that its wait returned."""

    def __init__(self, name: str, deadline: float) -> None:
        self.name = name
        self.deadline = deadline
        self.turn: str | None = None
        self._thread = threading.Thread(target=self._wait, daemon=True)

    def start(self, group: HeartbeatGroup) -> GroupRound:
        """Start the wait, and return once the round waits or has its turn."""
        self._group = group
        waiting = waiting_rounds(group)
        self._thread.start()
        wait_until(
            lambda: waiting_rounds(group) > waiting or self.turn is not None, 5, "never waited"
        )
        return self

    def _wait(self) -> None:
        self.turn = self._group.wait(self)

    def join(self, seconds: float = 5) -> str | None:
        self._thread.join(seconds)
        return self.turn


def waiting_rounds(group: HeartbeatGroup) -> int:
    with group._condition:
        return len(group._waiting)


def test_rounds_with_a_deadline_not_earlier_than_the_leader_join_its_transaction() -> None:
    """One transaction carries the rounds of every worker whose deadline allows it."""
    group = HeartbeatGroup()
    now = monotonic()
    leader = GroupRound("leader", now + 5)
    assert group.wait(leader) == "lead"
    # While the leader runs its transaction, three rounds arrive.
    later = GroupRound("later", now + 6).start(group)
    equal = GroupRound("equal", now + 5).start(group)
    earlier = GroupRound("earlier", now + 4).start(group)

    # Just before its heartbeat statement, the leader takes the rounds that can join, in arrival
    # order.
    joined = group.join(leader)

    assert [heartbeat_round.name for heartbeat_round in joined] == ["later", "equal"]  # type: ignore[attr-defined]
    assert later.join() == "joined" and equal.join() == "joined"
    # The round with the earlier deadline waits for the next transaction, and leads it.
    assert earlier.turn is None
    group.finish(leader)
    assert earlier.join() == "lead"
    group.finish(earlier)


def test_a_round_that_arrives_after_the_heartbeat_statement_waits_for_the_next_transaction() -> (
    None
):
    group = HeartbeatGroup()
    now = monotonic()
    leader = GroupRound("leader", now + 5)
    assert group.wait(leader) == "lead"
    assert group.join(leader) == []
    late = GroupRound("late", now + 6).start(group)

    assert late.turn is None
    group.finish(leader)
    assert late.join() == "lead"
    group.finish(late)


def test_the_waiting_round_with_the_earliest_deadline_leads_the_next_transaction() -> None:
    group = HeartbeatGroup()
    now = monotonic()
    leader = GroupRound("leader", now + 1)
    assert group.wait(leader) == "lead"
    rounds = [
        GroupRound(name, now + seconds).start(group)
        for name, seconds in (("third", 4.0), ("first", 2.0), ("second", 3.0))
    ]

    group.finish(leader)
    wait_until(lambda: any(r.turn for r in rounds), 5, "no round led")
    (next_leader,) = [r for r in rounds if r.turn == "lead"]
    assert next_leader.name == "first"
    # The next leader takes the others into its transaction.
    assert [r.name for r in group.join(next_leader)] == ["third", "second"]  # type: ignore[attr-defined]
    group.finish(next_leader)
    assert [r.join() for r in rounds] == ["joined", "lead", "joined"]


def test_a_waiting_round_whose_deadline_passes_expires() -> None:
    group = HeartbeatGroup()
    now = monotonic()
    leader = GroupRound("leader", now + 5)
    assert group.wait(leader) == "lead"

    short = GroupRound("short", now + 0.1).start(group)

    assert short.join() == "expired"
    assert waiting_rounds(group) == 0
    group.finish(leader)


def test_a_leader_past_its_deadline_and_the_grace_no_longer_blocks_the_others() -> None:
    group = HeartbeatGroup(grace_seconds=0.1)
    now = monotonic()
    hung = GroupRound("hung", now + 0.1)
    assert group.wait(hung) == "lead"

    next_round = GroupRound("next", now + 5).start(group)

    # The hung leader never finishes. After its deadline and the grace, the next round leads.
    assert next_round.join() == "lead"
    # The hung leader takes no round, and its late finish does not end the new transaction.
    assert group.join(hung) == []
    group.finish(hung)
    assert group._leader is next_round
    group.finish(next_round)


def test_a_round_with_too_little_time_left_skips_and_keeps_the_connection() -> None:
    closed: list[str] = []
    reservation = HeartbeatReservation(lambda _timeout: ("shared", lambda: closed.append("x")))
    subscription = reservation.subscribe(1_000, lambda: None)
    assert reservation.wait_ready(monotonic() + 5)

    assert reservation.take(monotonic() + 0.01, minimum=0.5) is None
    connection = reservation.take(monotonic() + 1, minimum=0.25)
    assert connection is not None and connection[0] == "shared"
    reservation.put_back(connection)
    subscription.close()

    assert closed == ["x"]


@contextmanager
def stalled_sync_listener(monkeypatch: pytest.MonkeyPatch) -> Any:
    """Make the listener of each new sync hub hang in LISTEN while it holds a pool connection."""
    stalled = threading.Event()
    release = threading.Event()
    create_hub = worker_module._psycopg_pool_hub

    class StalledConnection:
        autocommit = True

        def __init__(self, lease: Any) -> None:
            self._lease = lease

        def execute(self, _query: str) -> None:
            stalled.set()
            release.wait(60)
            raise psycopg.OperationalError("LISTEN stalled")

        def close(self) -> None:
            self._lease.close()

    def hub_with_stalled_listener(pool_ref: Callable[[], Any]) -> PoolHub:
        hub = create_hub(pool_ref)

        def open_stalled() -> Any:
            return StalledConnection(worker_module._pool_connection(pool_ref(), 7.5))

        hub.listener = SharedTaskNotificationListener(open_stalled)
        return hub

    monkeypatch.setattr(worker_module, "_psycopg_pool_hub", hub_with_stalled_listener)
    try:
        yield stalled
    finally:
        release.set()


@pytest.mark.integration
def test_a_sync_worker_starts_and_polls_while_listen_stalls(
    database_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The listener is best effort. A stalled LISTEN on a pool of 3 delays no start."""
    queue = f"stalled-listen-{uuid4().hex[:8]}"
    (task,) = enqueue(database_url, queue, 1)
    with (
        stalled_sync_listener(monkeypatch) as stalled,
        ConnectionPool(database_url, min_size=0, max_size=3, kwargs={"autocommit": True}) as pool,
    ):
        worker = Worker(
            pool, queue=queue, worker_id=queue, heartbeat_ms=HEARTBEAT_MS, poll_ms=100
        ).handle(TASK_TYPE, lambda _payload, _context: {"ok": True})
        thread = threading.Thread(target=worker.run)
        thread.start()
        try:
            assert stalled.wait(10), "the listener never sent LISTEN"
            # The listener holds one of the 3 connections and never listens. The worker polls.
            wait_until(lambda: succeeded(database_url, [task]) == 1, 10, "the task never ran")
        finally:
            worker.stop()
            thread.join(STOP_GRACE_SECONDS)
    assert not thread.is_alive()


@pytest.mark.integration
@pytest.mark.asyncio
@pytest.mark.parametrize("driver", ["psycopg", "asyncpg"])
async def test_an_async_worker_starts_and_polls_while_listen_stalls(
    database_url: str, driver: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The listener is best effort. A stalled LISTEN on a pool of 3 delays no start."""
    stalled = asyncio.Event()

    async def stall(_self: Any, _connection: Any) -> None:
        # The listener holds its pool connection and never listens.
        stalled.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(AsyncTaskNotificationListener, "_listen_psycopg", stall)
    monkeypatch.setattr(AsyncTaskNotificationListener, "_listen_asyncpg", stall)
    queue = f"stalled-listen-{driver}-{uuid4().hex[:8]}"
    (task,) = await asyncio.to_thread(enqueue, database_url, queue, 1)
    if driver == "psycopg":
        pool: Any = AsyncConnectionPool(
            database_url, min_size=0, max_size=3, kwargs={"autocommit": True}, open=False
        )
        await pool.open()
        worker = AsyncWorker.from_psycopg(
            pool, queue=queue, worker_id=queue, heartbeat_ms=HEARTBEAT_MS, poll_ms=100
        )
    else:
        pool = await asyncpg.create_pool(database_url, min_size=0, max_size=3)
        worker = AsyncWorker.from_asyncpg(
            pool, queue=queue, worker_id=queue, heartbeat_ms=HEARTBEAT_MS, poll_ms=100
        )

    async def handler(_payload: Any, _context: Any) -> dict[str, bool]:
        return {"ok": True}

    worker.handle(TASK_TYPE, handler)
    run = asyncio.create_task(worker.run())
    try:
        await asyncio.wait_for(stalled.wait(), 10)
        deadline = monotonic() + 10
        while await asyncio.to_thread(succeeded, database_url, [task]) != 1:
            assert monotonic() < deadline, "the task never ran"
            await asyncio.sleep(0.05)
    finally:
        worker.stop()
        await asyncio.wait_for(run, STOP_GRACE_SECONDS)
        await asyncio.wait_for(pool.close(), 10)


def test_an_operation_that_raises_its_own_timeout_is_settled() -> None:
    """An acquisition raises TimeoutError before the caller's wait ends. The next one is new."""
    started: list[str] = []
    released: list[str] = []
    with loop_in_thread() as loop:

        async def open_() -> str:
            started.append("attempt")
            if len(started) == 1:
                raise TimeoutError("the pool timed out first")
            return "connection"

        owner = owner_of(loop, open_, released)
        with pytest.raises(TimeoutError, match="the pool timed out first"):
            owner.acquire(HEARTBEAT, monotonic() + 5)
        assert owner.acquire(HEARTBEAT, monotonic() + 5) == "connection"
        owner.release(HEARTBEAT, "connection", broken=False, deadline=monotonic() + 5)
        owner.close()

    assert started == ["attempt", "attempt"]
    assert released == ["connection"]


class _HeartbeatConnection:
    autocommit = True


class _OnceTimingOutAsyncpgPool:
    """An asyncpg pool whose first acquisition raises asyncpg's own TimeoutError."""

    def __init__(self) -> None:
        self.calls = 0

    def get_max_size(self) -> int:
        return 5

    async def acquire(self, *, timeout: float | None = None) -> Any:  # noqa: ASYNC109, ARG002
        self.calls += 1
        if self.calls == 1:
            raise TimeoutError("asyncpg connection timeout")
        return _HeartbeatConnection()

    async def release(self, _connection: object) -> None:
        return None


@pytest.mark.asyncio
async def test_an_asyncpg_heartbeat_reservation_recovers_after_its_own_timeout() -> None:
    pool = _OnceTimingOutAsyncpgPool()
    worker = AsyncWorker.from_asyncpg(pool)  # type: ignore[arg-type]
    worker._start_run()
    registry = PoolRegistry("test")
    hub = registry.attach(pool, worker._create_hub, asyncio.get_running_loop())
    subscription = hub.heartbeat.subscribe(100, lambda: None)
    try:
        await until(hub.heartbeat.ready)
    finally:
        subscription.close()
        registry.detach(hub)
        worker._threads.close()
        worker._running = False

    assert pool.calls == 2


class _ListenFails(_ListeningConnection):
    async def execute(self, _query: str) -> None:
        raise OSError("LISTEN failed")

    async def add_listener(self, _channel: str, _callback: object) -> None:
        raise OSError("LISTEN failed")


async def loop_ticks(count: int = 50) -> None:
    """Let the event loop run `count` steps, so a task that may proceed does proceed."""
    for _ in range(count):
        await asyncio.sleep(0)


@pytest.mark.asyncio
@pytest.mark.parametrize("driver", ["psycopg", "asyncpg"])
async def test_a_reconnect_waits_for_a_release_that_outlived_its_bound(
    driver: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """LISTEN fails, and the release of that connection outlives its bound.

    The listener must not open another connection while that release still holds one.
    """
    monkeypatch.setattr(pool_hub_module, "CLEANUP_SECONDS", 0.05)
    monkeypatch.setattr(pool_hub_module, "_RECONNECT_INITIAL_SECONDS", 0.0)
    connections = _HeldReleases()

    async def open_failing() -> Any:
        _connection, release = await connections.open()
        return _ListenFails(), release

    listener = AsyncTaskNotificationListener(driver, open_failing)
    subscription = listener.subscribe(["q"], lambda: None)
    # A checkpoint: the release outlived its bound, and the reconnect waits in the owner for it.
    await until(
        lambda: (
            listener._owner is not None
            and bool(listener._owner._queues[LISTENER] or listener._owner._deferred[LISTENER])
        )
    )
    await loop_ticks()
    assert connections.opened == 1, "a connection opened while the late release held one"

    connections.gate.set()
    await until(lambda: connections.opened >= 2)
    task = subscription.close()
    assert task is not None
    with suppress(asyncio.CancelledError):
        await asyncio.wait_for(task, 5)

    assert connections.most == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("driver", ["psycopg", "asyncpg"])
async def test_a_restart_waits_for_the_late_release_of_the_stopped_task(
    driver: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A worker subscribes while the last task stops, and that task's release outlives its bound.

    The new task waits for the old task, and then also for the late release it left.
    """
    monkeypatch.setattr(pool_hub_module, "CLEANUP_SECONDS", 0.05)
    connections = _HeldReleases()
    listener = AsyncTaskNotificationListener(driver, connections.open)
    first = listener.subscribe(["q"], lambda: None)
    await until(lambda: listener.listening)
    stopping = first.close()
    assert stopping is not None
    second = listener.subscribe(["q"], lambda: None)
    with suppress(asyncio.CancelledError):
        await asyncio.wait_for(stopping, 5)
    # A checkpoint: the old task ended, and the owner still releases its connection.
    assert listener.busy() and connections.held == 1
    await loop_ticks()
    assert connections.opened == 1, "the new task opened a connection during the late release"

    connections.gate.set()
    await until(lambda: listener.listening)
    task = second.close()
    assert task is not None
    with suppress(asyncio.CancelledError):
        await asyncio.wait_for(task, 5)

    assert connections.opened == 2 and connections.most == 1


class _StalledAcquisitionPool:
    """An async pool of either driver whose heartbeat acquisition waits for `gate`."""

    max_size = 5

    def __init__(self) -> None:
        self.calls = 0
        self.in_flight = 0
        self.most = 0
        self.called = threading.Event()
        self.gate = asyncio.Event()

    def get_max_size(self) -> int:
        return 5

    async def _acquire(self) -> _HeartbeatConnection:
        self.calls += 1
        self.in_flight += 1
        self.most = max(self.most, self.in_flight)
        self.called.set()
        try:
            await self.gate.wait()
        finally:
            self.in_flight -= 1
        return _HeartbeatConnection()

    async def acquire(self, *, timeout: float | None = None) -> Any:  # noqa: ASYNC109, ARG002
        return await self._acquire()

    async def release(self, _connection: object) -> None:
        return None

    def connection(self, timeout: float | None = None) -> Any:  # noqa: ARG002
        pool = self

        class Borrow:
            async def __aenter__(self) -> _HeartbeatConnection:
                return await pool._acquire()

            async def __aexit__(self, *_arguments: object) -> None:
                return None

        return Borrow()


@pytest.mark.asyncio
@pytest.mark.parametrize("driver", ["psycopg", "asyncpg"])
async def test_a_pending_async_acquisition_keeps_its_hub_across_detach(driver: str) -> None:
    """The last worker leaves while the heartbeat acquisition still waits on the event loop.

    The registry keeps the hub, so the next worker waits for the same acquisition and the pool
    never has two acquisitions pending.
    """
    pool = _StalledAcquisitionPool()
    worker = (
        AsyncWorker.from_psycopg(pool)  # type: ignore[arg-type]
        if driver == "psycopg"
        else AsyncWorker.from_asyncpg(pool)  # type: ignore[arg-type]
    )
    worker._start_run()
    loop = asyncio.get_running_loop()
    registry = PoolRegistry("test")
    hub = registry.attach(pool, worker._create_hub, loop)
    try:
        first = hub.heartbeat.subscribe(100, lambda: None)
        await asyncio.to_thread(pool.called.wait, 5)
        # A checkpoint: the acquirer stopped waiting, and the acquisition still runs.
        await until(lambda: isinstance(hub.heartbeat.last_error, TimeoutError))
        first.close()
        await until(lambda: hub.heartbeat._acquirer is None)
        registry.detach(hub)

        assert hub.busy(), "the pending acquisition did not keep the hub"
        again = registry.attach(pool, worker._create_hub, loop)
        assert again is hub, "the registry made a second hub for the pool"
        second = hub.heartbeat.subscribe(100, lambda: None)
        pool.gate.set()
        await until(hub.heartbeat.ready)
        second.close()
        registry.detach(hub)
    finally:
        pool.gate.set()
        worker._threads.close()
        worker._running = False

    assert pool.most == 1


class _GatedPool:
    """An async pool of either driver. Acquisitions wait for `lend`, releases wait for `give`.

    `held` counts the connections out of the pool, and `most` the largest count at one time.
    """

    max_size = 5

    def __init__(self) -> None:
        self.calls = 0
        self.held = 0
        self.most = 0
        self.called = threading.Event()
        self.releasing = threading.Event()
        self.lend = asyncio.Event()
        self.give = asyncio.Event()
        self.give.set()

    def get_max_size(self) -> int:
        return 5

    async def _acquire(self) -> _HeartbeatConnection:
        self.calls += 1
        self.called.set()
        await self.lend.wait()
        self.held += 1
        self.most = max(self.most, self.held)
        return _HeartbeatConnection()

    async def _release(self) -> None:
        self.releasing.set()
        await self.give.wait()
        self.held -= 1

    async def acquire(self, *, timeout: float | None = None) -> Any:  # noqa: ASYNC109, ARG002
        return await self._acquire()

    async def release(self, _connection: object) -> None:
        await self._release()

    def connection(self, timeout: float | None = None) -> Any:  # noqa: ARG002
        pool = self

        class Borrow:
            async def __aenter__(self) -> _HeartbeatConnection:
                return await pool._acquire()

            async def __aexit__(self, *_arguments: object) -> None:
                await pool._release()

        return Borrow()


def async_worker_on(pool: Any, driver: str) -> AsyncWorker:
    worker = (
        AsyncWorker.from_psycopg(pool)  # type: ignore[arg-type]
        if driver == "psycopg"
        else AsyncWorker.from_asyncpg(pool)  # type: ignore[arg-type]
    )
    worker._start_run()
    return worker


def end_run(worker: AsyncWorker) -> None:
    worker._threads.close()
    worker._running = False


@contextmanager
def caller_times_out_first(loop: asyncio.AbstractEventLoop, pool: _GatedPool) -> Any:
    """Order the race at a timeout: the caller's wait ends, and then the acquisition succeeds.

    The first wait with a timeout on this thread times out. Before the caller handles that, the
    pool lends the connection, and the loop finishes the acquisition.
    """
    original = Future.result
    caller = threading.get_ident()
    armed = [True]

    def result(self: Future[Any], timeout: float | None = None) -> Any:
        try:
            return original(self, timeout)
        except FutureTimeoutError:
            if not (armed[0] and timeout is not None and threading.get_ident() == caller):
                raise
            armed[0] = False
            loop.call_soon_threadsafe(pool.lend.set)
            deadline = monotonic() + 5
            while not self.done() and monotonic() < deadline:
                sleep(0.001)
            raise

    Future.result = result  # type: ignore[method-assign]
    try:
        yield
    finally:
        Future.result = original  # type: ignore[method-assign]


@pytest.mark.asyncio
@pytest.mark.parametrize("driver", ["psycopg", "asyncpg"])
async def test_a_connection_that_arrives_as_the_wait_ends_has_one_owner(driver: str) -> None:
    """The caller's wait for the heartbeat connection ends, and then the connection arrives.

    The connection reaches the caller or goes back to the pool. It never reaches neither.
    """
    pool = _GatedPool()
    worker = async_worker_on(pool, driver)
    loop = asyncio.get_running_loop()
    registry = PoolRegistry("test")
    hub = registry.attach(pool, worker._create_hub, loop)
    outcome: list[str] = []

    def acquire_once() -> None:
        with caller_times_out_first(loop, pool):
            try:
                _executor, close = hub.heartbeat._acquire(0.05)
            except TimeoutError:
                outcome.append("timed out")
                return
        outcome.append("delivered")
        close()

    try:
        await asyncio.to_thread(acquire_once)
        # The connection must be back in the pool, through the caller or through its owner.
        await until(lambda: pool.held == 0)
    finally:
        pool.lend.set()
        registry.detach(hub)
        end_run(worker)

    assert pool.calls == 1
    assert outcome in (["delivered"], ["timed out"])


@pytest.mark.asyncio
@pytest.mark.parametrize("driver", ["psycopg", "asyncpg"])
async def test_two_quick_restarts_keep_one_listener_connection(driver: str) -> None:
    """Stop, start, stop, and start the listener while the first release still runs.

    The middle task stops before it gets a connection. The last task must still wait until the
    first connection is back in the pool.
    """
    connections = _HeldReleases()
    listener = AsyncTaskNotificationListener(driver, connections.open)
    first = listener.subscribe(["q"], lambda: None)
    await until(lambda: listener.listening)
    stopping = first.close()
    assert stopping is not None
    await asyncio.wait_for(connections.releasing.wait(), 5)

    second = listener.subscribe(["q"], lambda: None)
    await loop_ticks()
    middle = second.close()
    assert middle is not None
    with suppress(asyncio.CancelledError):
        await asyncio.wait_for(middle, 5)
    third = listener.subscribe(["q"], lambda: None)
    await loop_ticks()
    assert connections.opened == 1, "a connection opened while the first release held one"
    assert connections.held == 1

    connections.gate.set()
    await until(lambda: listener.listening)
    task = third.close()
    assert task is not None
    with suppress(asyncio.CancelledError):
        await asyncio.wait_for(task, 5)
    with suppress(asyncio.CancelledError):
        await asyncio.wait_for(stopping, 5)

    assert connections.opened == 2 and connections.most == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("driver", ["psycopg", "asyncpg"])
async def test_a_late_heartbeat_release_keeps_its_hub_and_blocks_a_second_connection(
    driver: str,
) -> None:
    """A heartbeat connection arrives after the last worker left, and its release blocks.

    The hub stays the pool's hub until that release ends. A worker that starts meanwhile gets the
    same hub, and its connection opens only after the late one is back in the pool.
    """
    pool = _GatedPool()
    pool.give.clear()
    worker = async_worker_on(pool, driver)
    loop = asyncio.get_running_loop()
    registry = PoolRegistry("test")
    hub = registry.attach(pool, worker._create_hub, loop)
    try:
        first = hub.heartbeat.subscribe(100, lambda: None)
        await asyncio.to_thread(pool.called.wait, 5)
        await until(lambda: isinstance(hub.heartbeat.last_error, TimeoutError))
        first.close()
        await until(lambda: hub.heartbeat._acquirer is None)

        # The late connection arrives, and its release blocks.
        pool.lend.set()
        await asyncio.to_thread(pool.releasing.wait, 5)
        registry.detach(hub)
        assert hub.busy(), "the late release did not keep the hub"
        again = registry.attach(pool, worker._create_hub, loop)
        assert again is hub, "the registry made a second hub for the pool"

        second = hub.heartbeat.subscribe(100, lambda: None)
        await until(lambda: hub.heartbeat._acquirer is not None)
        await loop_ticks()
        assert pool.held == 1, "a second heartbeat connection opened during the late release"

        pool.give.set()
        await until(hub.heartbeat.ready)
        second.close()
        registry.detach(hub)
    finally:
        pool.lend.set()
        pool.give.set()
        end_run(worker)

    assert pool.most == 1


def test_a_sync_disposal_keeps_its_hub_and_blocks_a_second_connection() -> None:
    """A sync heartbeat connection arrives after the last worker left, and its close blocks.

    The reservation stays busy, so the hub stays the pool's hub. A new worker gets the same hub,
    and no acquisition starts until the close ends.
    """
    lend = threading.Event()
    give = threading.Event()
    called = threading.Event()
    closing = threading.Event()
    lock = threading.Lock()
    calls = 0
    held = 0
    most = 0

    def acquire(_timeout: float) -> Any:
        nonlocal calls, held, most
        with lock:
            calls += 1
            first = calls == 1
        called.set()
        if first:
            assert lend.wait(10)

        def close() -> None:
            nonlocal held
            if first:
                closing.set()
                assert give.wait(10)
            with lock:
                held -= 1

        with lock:
            held += 1
            most = max(most, held)
        return object(), close

    registry = PoolRegistry("test")
    pool = _Pool()

    def create(_pool_ref: Callable[[], Any]) -> PoolHub:
        return PoolHub("test", object(), HeartbeatReservation(acquire))

    hub = registry.attach(pool, create)
    try:
        first = hub.heartbeat.subscribe(100, lambda: None)
        assert called.wait(5)
        first.close()
        registry.detach(hub)

        lend.set()
        assert closing.wait(5), "the late connection was not closed"
        assert hub.busy(), "the disposal did not keep the hub"
        again = registry.attach(pool, create)
        assert again is hub, "the registry made a second hub for the pool"
        second = hub.heartbeat.subscribe(100, lambda: None)
        assert hub.heartbeat._acquirer is None, "an acquisition started during the disposal"

        give.set()
        wait_until(hub.heartbeat.ready, 5, "the replacement never opened")
        second.close()
        registry.detach(hub)
    finally:
        lend.set()
        give.set()

    assert calls == 2 and most == 1


class _FailingReleasePool(_GatedPool):
    """A gated pool whose first release takes the connection back and then raises."""

    def __init__(self) -> None:
        super().__init__()
        self.failed = 0

    async def _release(self) -> None:
        if not self.failed:
            self.failed += 1
            self.held -= 1
            raise OSError("the release failed")
        await super()._release()


@pytest.mark.asyncio
@pytest.mark.parametrize("driver", ["psycopg", "asyncpg"])
async def test_a_failed_late_disposal_keeps_the_owner_working(driver: str) -> None:
    """The caller of an acquisition leaves, and the late connection's release then raises.

    The owner gives the late connection back, and the error of that release does not stop it. The
    listener acquisition that waits behind it gets its connection, and the next request succeeds.
    """
    pool = _FailingReleasePool()
    worker = async_worker_on(pool, driver)
    loop = asyncio.get_running_loop()
    registry = PoolRegistry("test")
    hub = registry.attach(pool, worker._create_hub, loop)
    owner = hub.owner
    assert owner is not None
    try:
        # 1. The acquisition starts, and the pool holds its result.
        caller = asyncio.ensure_future(owner.acquire_async(HEARTBEAT, monotonic() + 5))
        await asyncio.to_thread(pool.called.wait, 5)
        # 2. The caller leaves.
        caller.cancel()
        with suppress(asyncio.CancelledError):
            await caller
        # 3. A listener acquisition waits behind the late connection.
        listening = asyncio.ensure_future(owner.acquire_async(LISTENER, monotonic() + 2))
        await loop_ticks()
        # 4. The pool delivers the connection, and its release raises.
        pool.lend.set()
        # 5. The owner still works: the listener gets its connection, and a new request succeeds.
        listener = await listening
        await asyncio.wrap_future(owner.release_soon(LISTENER, listener))
        heartbeat = await owner.acquire_async(HEARTBEAT, monotonic() + 2)
        await asyncio.wrap_future(owner.release_soon(HEARTBEAT, heartbeat))
        await until(lambda: not owner.busy())
    finally:
        pool.lend.set()
        registry.detach(hub)
        end_run(worker)

    assert pool.failed == 1
    assert pool.held == 0
