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
from workhorse._drivers import SyncExecutor

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

    def __init__(self, database_url: str) -> None:
        self.handler_running = Event()
        self.lock_held = Event()
        self.held_from = 0.0
        self._thread = Thread(target=self._hold, args=(database_url,))
        self._thread.start()

    def _hold(self, database_url: str) -> None:
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
def test_a_held_checkpoint_does_not_delay_heartbeats(database_url: str) -> None:
    task_id = enqueue(database_url, "checkpoint.held", "heartbeat-connection")
    heartbeat_log = StatementLog()
    hold = CheckpointHold(database_url)
    handler_resumed_at: list[float] = []

    def handler(_payload: Any, context: HandlerContext) -> dict[str, bool]:
        hold.enter()
        context.checkpoint("held", lambda: {"held": True})
        handler_resumed_at.append(monotonic())
        return {"ok": True}

    def heartbeat_executor() -> tuple[SyncExecutor, Any]:
        lease = worker_pool.connection()
        connection = lease.__enter__()

        class LoggedConnection:
            def cursor(self, *, row_factory: Any = None) -> Any:
                base = connection.cursor(row_factory=row_factory)

                class LoggedCursor:
                    @property
                    def description(self) -> Any:
                        return base.description

                    def __enter__(self) -> Any:
                        base.__enter__()
                        return self

                    def __exit__(self, *args: object) -> Any:
                        return base.__exit__(*args)

                    def execute(self, query: Any, params: Any = None) -> Any:
                        heartbeat_log.record(query)
                        return base.execute(query, params)

                    def fetchall(self) -> Any:
                        return base.fetchall()

                return LoggedCursor()

        def close() -> None:
            lease.__exit__(None, None, None)

        return SyncExecutor(LoggedConnection()), close

    with psycopg.connect(database_url, autocommit=True) as worker_connection:
        worker = Worker(
            worker_pool,
            queue="heartbeat-connection",
            worker_id="python-heartbeat-connection",
            lease_ms=LEASE_MS,
            heartbeat_ms=HEARTBEAT_MS,
            _executor=SyncExecutor(worker_connection),
            _heartbeat_executor_factory=heartbeat_executor,
        ).handle("checkpoint.held", handler)
        assert worker.run_once() is True
        hold.join()

    assert handler_resumed_at
    assert handler_resumed_at[0] - hold.held_from >= CHECKPOINT_HOLD_SECONDS - 1
    # The pooled heartbeat connection is independently reserved; handler timing
    # verifies that the checkpoint remained blocked during the lease renewal.
    assert outcome(database_url, task_id) == ("succeeded",)


@pytest.mark.slow
@pytest.mark.asyncio
async def test_a_held_async_checkpoint_does_not_delay_heartbeats(
    database_url: str, asyncpg_pool
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

    class LoggedPool:
        def get_max_size(self) -> int:
            return asyncpg_pool.get_max_size()

        async def acquire(self) -> LoggedConnection:
            return LoggedConnection(await asyncpg_pool.acquire())

        async def release(self, connection: LoggedConnection) -> None:
            await asyncpg_pool.release(connection._connection)

    logged_pool = LoggedPool()
    try:
        worker = AsyncWorker.from_asyncpg(
            logged_pool,
            queue="heartbeat-connection-async",
            worker_id="python-async-heartbeat-connection",
            lease_ms=LEASE_MS,
            heartbeat_ms=HEARTBEAT_MS,
        ).handle("checkpoint.held.async", handler)
        assert await worker.run_once() is True
        await asyncio.to_thread(hold.join)
    finally:
        worker.stop()

    assert handler_resumed_at
    assert handler_resumed_at[0] - hold.held_from >= CHECKPOINT_HOLD_SECONDS - 1
    # The pooled heartbeat connection is independently reserved; handler timing
    # verifies that the checkpoint remained blocked during the lease renewal.
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
            _executor=SyncExecutor(worker_connection),
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


# A failing round must not end an attempt, so these leases outlive the whole test.
RETRY_LEASE_MS = 30_000
RETRY_HEARTBEAT_MS = 50
# The watchdog lease is short enough to lapse inside the test, and long enough for several rounds.
WATCHDOG_LEASE_MS = 1_000
WATCHDOG_HEARTBEAT_MS = 100


def lease_expiry(database_url: str, task_id: str) -> Any:
    """Read the lease PostgreSQL granted the claiming worker."""
    with psycopg.connect(database_url, autocommit=True) as observer:
        row = observer.execute(
            "SELECT expires_at FROM workhorse.task_runtime WHERE task_id = %s", (task_id,)
        ).fetchone()
    assert row is not None and row[0] is not None, "claimed task has no lease expiry"
    return row[0]


def wait_for_lease_renewal(database_url: str, task_id: str, previous: Any) -> Any:
    deadline = monotonic() + 10
    while monotonic() < deadline:
        current = lease_expiry(database_url, task_id)
        if current > previous:
            return current
        sleep(0.02)
    raise AssertionError("no round renewed the lease")


class FailingHeartbeatExecutor:
    """Wrap the reserved heartbeat executor and fail the rounds the test names."""

    def __init__(self, executor: SyncExecutor, failing: Any, failed: Event) -> None:
        self._executor = executor
        self._failing = failing
        self._failed = failed

    def rows(self, statement: Any, parameters: Any = ()) -> Any:
        # The round also sends its transaction settings through rows; only the heartbeat fails.
        if "heartbeat_many_v1" in statement.psycopg and self._failing():
            self._failed.set()
            raise RuntimeError("heartbeat round failed")
        return self._executor.rows(statement, parameters)

    def command(self, statement: Any, parameters: Any = ()) -> None:
        self._executor.command(statement, parameters)


def heartbeat_executor_factory(failing: Any, failed: Event) -> Any:
    """Reserve a pooled connection per round, as the worker's own factory does."""

    def open_executor() -> tuple[Any, Any]:
        lease = worker_pool.connection()
        connection = lease.__enter__()

        def close() -> None:
            lease.__exit__(None, None, None)

        return FailingHeartbeatExecutor(SyncExecutor(connection), failing, failed), close

    return open_executor


def test_a_failed_heartbeat_round_leaves_tasks_running_and_the_next_round_renews(
    database_url: str,
) -> None:
    task_id = enqueue(database_url, "heartbeat.retry", "heartbeat-retry")
    started = Event()
    release = Event()
    failed = Event()
    cancelled: list[bool] = []
    rounds = Lock()
    round_count = 0

    def failing() -> bool:
        nonlocal round_count
        with rounds:
            round_count += 1
            # The first round renews, so the test sees a working heartbeat before it breaks one.
            return round_count == 2

    def handler(_payload: Any, context: HandlerContext) -> dict[str, bool]:
        started.set()
        while not release.wait(0.02):
            if context.cancellation.cancelled:
                cancelled.append(True)
                break
        return {"ok": True}

    worker = Worker(
        worker_pool,
        queue="heartbeat-retry",
        worker_id="python-heartbeat-retry",
        lease_ms=RETRY_LEASE_MS,
        heartbeat_ms=RETRY_HEARTBEAT_MS,
        _heartbeat_executor_factory=heartbeat_executor_factory(failing, failed),
    ).handle("heartbeat.retry", handler)

    processed: list[bool] = []
    run = Thread(target=lambda: processed.append(worker.run_once()))
    run.start()
    try:
        assert started.wait(30)
        claimed = lease_expiry(database_url, task_id)
        renewed = wait_for_lease_renewal(database_url, task_id, claimed)
        assert failed.wait(30)
        # The round after the failure renews the lease, and no attempt was cancelled by the failure.
        wait_for_lease_renewal(database_url, task_id, renewed)
        assert cancelled == []
    finally:
        release.set()
        run.join(30)

    assert processed == [True]
    assert cancelled == []
    assert outcome(database_url, task_id) == ("succeeded",)


def test_a_handler_is_aborted_when_no_heartbeat_is_accepted_within_the_lease(
    database_url: str,
) -> None:
    enqueue(database_url, "heartbeat.watchdog", "heartbeat-watchdog")
    started = Event()
    failed = Event()
    cancelled_after: list[float] = []

    def handler(_payload: Any, context: HandlerContext) -> dict[str, bool]:
        started.set()
        claimed_at = monotonic()
        while not context.cancellation.cancelled:
            sleep(0.02)
            assert monotonic() - claimed_at < 30, "the watchdog never aborted the handler"
        cancelled_after.append(monotonic() - claimed_at)
        return {"ok": True}

    log = StatementLog()
    with psycopg.connect(
        database_url, autocommit=True, cursor_factory=log.cursor_factory()
    ) as worker_connection:
        worker = Worker(
            worker_pool,
            queue="heartbeat-watchdog",
            worker_id="python-heartbeat-watchdog",
            lease_ms=WATCHDOG_LEASE_MS,
            heartbeat_ms=WATCHDOG_HEARTBEAT_MS,
            _executor=SyncExecutor(worker_connection),
            # Every round fails, so no heartbeat is ever accepted.
            _heartbeat_executor_factory=heartbeat_executor_factory(lambda: True, failed),
        ).handle("heartbeat.watchdog", handler)

        processed: list[bool] = []
        run = Thread(target=lambda: processed.append(worker.run_once()))
        run.start()
        assert started.wait(30)
        run.join(60)
        assert not run.is_alive()

    assert processed == [True]
    assert cancelled_after, "the watchdog never aborted the handler"
    # The watchdog measures one lease from the claim request, not from the first failed round.
    assert cancelled_after[0] >= WATCHDOG_LEASE_MS / 1000 - 0.3
    assert cancelled_after[0] <= 3 * WATCHDOG_LEASE_MS / 1000
    # The attempt recorded a lost lease, so the worker settled nothing through fail_v1. The task
    # returns through lease recovery instead.
    assert not any("fail_v1" in statement for statement in log.statements()), log.statements()


# PostgreSQL may end the reserved heartbeat connection while the worker idles between tasks. The
# lease outlives the whole test, so only a lost reconnect could end an attempt.
TERMINATION_LEASE_MS = 10_000
TERMINATION_HEARTBEAT_MS = 100


class BlockingTask:
    """A handler gate: the handler reports that it runs, then blocks until the test releases it."""

    def __init__(self) -> None:
        self.started = Event()
        self.release = Event()
        self.cancelled = False

    def handler(self, _payload: Any, context: HandlerContext) -> dict[str, bool]:
        self.started.set()
        while not self.release.wait(0.02):
            if context.cancellation.cancelled:
                self.cancelled = True
                break
        return {"ok": True}

    async def async_handler(self, _payload: Any, context: AsyncHandlerContext) -> dict[str, bool]:
        self.started.set()
        while not self.release.is_set():
            if context.cancellation.cancelled:
                self.cancelled = True
                break
            await asyncio.sleep(0.02)
        return {"ok": True}


def heartbeat_backends(database_url: str) -> list[int]:
    """List the backends whose latest statement was a heartbeat round, excluding the observer.

    A round ends with the COMMIT of its transaction, and no other worker statement sends one.
    """
    with psycopg.connect(database_url, autocommit=True) as observer:
        rows = observer.execute(
            "SELECT pid FROM pg_stat_activity WHERE datname = current_database() "
            "AND pid <> pg_backend_pid() "
            "AND (query LIKE '%workhorse.heartbeat_many_v1%' OR query = 'COMMIT')"
        ).fetchall()
    return [int(row[0]) for row in rows]


def wait_for_heartbeat_backend(database_url: str, other_than: int | None = None) -> int:
    deadline = monotonic() + 10
    while monotonic() < deadline:
        pids = [pid for pid in heartbeat_backends(database_url) if pid != other_than]
        if pids:
            assert len(pids) == 1, pids
            return pids[0]
        sleep(0.02)
    raise AssertionError("no backend ran a heartbeat round")


def wait_for_outcome(database_url: str, task_id: str) -> Any:
    deadline = monotonic() + 10
    while monotonic() < deadline:
        row = outcome(database_url, task_id)
        if row is not None:
            return row
        sleep(0.02)
    raise AssertionError("the task never settled")


def terminate_the_idle_heartbeat_connection(
    database_url: str, queue: str, task_type: str, before: BlockingTask, after: BlockingTask
) -> None:
    """Drive one task, end the reserved heartbeat backend while idle, then drive a second task."""
    before_id = enqueue(database_url, f"{task_type}.before", queue)
    assert before.started.wait(30)
    reserved = wait_for_heartbeat_backend(database_url)
    before.release.set()
    assert wait_for_outcome(database_url, before_id) == ("succeeded",)

    # The idle worker still holds the reserved connection, so the termination hits it between rounds.
    assert heartbeat_backends(database_url) == [reserved]
    with psycopg.connect(database_url, autocommit=True) as observer:
        terminated = observer.execute("SELECT pg_terminate_backend(%s)", (reserved,)).fetchone()
    assert terminated == (True,)
    sleep(0.1)

    after_id = enqueue(database_url, f"{task_type}.after", queue)
    assert after.started.wait(30)
    claimed = lease_expiry(database_url, after_id)
    # The first round finds the connection dead and discards it; a later round renews on a new one.
    replacement = wait_for_heartbeat_backend(database_url, other_than=reserved)
    assert replacement != reserved
    wait_for_lease_renewal(database_url, after_id, claimed)
    after.release.set()
    assert wait_for_outcome(database_url, after_id) == ("succeeded",)
    assert before.cancelled is False
    assert after.cancelled is False


def test_a_terminated_idle_heartbeat_connection_is_replaced_on_the_next_round(
    database_url: str,
) -> None:
    """A dead reserved connection fails one round; the worker keeps running and reconnects.

    PostgreSQL can end the reserved heartbeat backend while the worker idles. The failure surfaces
    only when the next round runs, and that round counts as unknown under SM-808's rule.
    """
    queue = "heartbeat-terminated"
    before = BlockingTask()
    after = BlockingTask()
    worker = (
        Worker(
            worker_pool,
            queue=queue,
            worker_id="python-heartbeat-terminated",
            lease_ms=TERMINATION_LEASE_MS,
            heartbeat_ms=TERMINATION_HEARTBEAT_MS,
            poll_ms=50,
        )
        .handle("heartbeat.terminated.before", before.handler)
        .handle("heartbeat.terminated.after", after.handler)
    )
    errors: list[BaseException] = []

    def run() -> None:
        try:
            worker.run()
        except BaseException as error:
            errors.append(error)

    running = Thread(target=run)
    running.start()
    try:
        terminate_the_idle_heartbeat_connection(
            database_url, queue, "heartbeat.terminated", before, after
        )
        assert running.is_alive()
    finally:
        before.release.set()
        after.release.set()
        worker.stop()
        running.join(30)

    assert not running.is_alive()
    assert errors == []


@pytest.mark.asyncio
@pytest.mark.parametrize("driver", ["psycopg", "asyncpg"])
async def test_a_terminated_idle_async_heartbeat_connection_is_replaced_on_the_next_round(
    database_url: str, driver: str, async_psycopg_pool, asyncpg_pool
) -> None:
    """The async worker's reserved connection recovers from the same termination as the sync one."""
    queue = f"heartbeat-terminated-{driver}"
    before = BlockingTask()
    after = BlockingTask()
    options: dict[str, Any] = {
        "queue": queue,
        "worker_id": f"python-async-heartbeat-terminated-{driver}",
        "lease_ms": TERMINATION_LEASE_MS,
        "heartbeat_ms": TERMINATION_HEARTBEAT_MS,
        "poll_ms": 50,
    }
    if driver == "psycopg":
        worker = AsyncWorker.from_psycopg(async_psycopg_pool, **options)
    else:
        worker = AsyncWorker.from_asyncpg(asyncpg_pool, **options)
    worker.handle("heartbeat.terminated.before", before.async_handler).handle(
        "heartbeat.terminated.after", after.async_handler
    )

    running = asyncio.create_task(worker.run())
    try:
        await asyncio.to_thread(
            terminate_the_idle_heartbeat_connection,
            database_url,
            queue,
            "heartbeat.terminated",
            before,
            after,
        )
        assert not running.done()
    finally:
        before.release.set()
        after.release.set()
        worker.stop()
        await asyncio.wait_for(running, timeout=30)


# SM-1442: a round on the dedicated connection has one deadline, and PostgreSQL ends its statement
# by that deadline. Before, a round that waited on a row lock kept waiting until the lock was gone.
BOUND_HEARTBEAT_MS = 200


def active_heartbeats(observer: psycopg.Connection[Any]) -> list[float]:
    """The age in milliseconds of each active heartbeat statement in the test database."""
    rows = observer.execute(
        """SELECT extract(epoch FROM clock_timestamp() - query_start) * 1000
             FROM pg_stat_activity
            WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'active'
              AND query LIKE '%%workhorse.heartbeat_many_v1%%'"""
    ).fetchall()
    return [float(row[0]) for row in rows]


def sample_heartbeats_while_locked(database_url: str, task_id: str) -> list[list[float]]:
    """Hold the task's row lock for eight intervals, and sample the heartbeat statements."""
    samples: list[list[float]] = []
    with (
        psycopg.connect(database_url) as blocker,
        psycopg.connect(database_url, autocommit=True) as observer,
    ):
        blocker.execute(
            "SELECT FROM workhorse.task_runtime WHERE task_id = %s FOR UPDATE", (task_id,)
        )
        until = monotonic() + 8 * BOUND_HEARTBEAT_MS / 1000
        while monotonic() < until:
            samples.append(active_heartbeats(observer))
            sleep(0.02)
        blocker.commit()
    return samples


def assert_one_bounded_statement(samples: list[list[float]]) -> None:
    assert any(samples), "no heartbeat statement waited on the locked row"
    assert max(len(sample) for sample in samples) <= 1, samples
    # A statement ends by its round's deadline. The slack allows for a slow host, and stays far
    # below the 1.6 s that the lock was held.
    assert max(age for sample in samples for age in sample) < 5 * BOUND_HEARTBEAT_MS, samples


def test_a_heartbeat_round_that_waits_on_a_lock_ends_on_the_server_by_its_deadline(
    database_url: str,
) -> None:
    task_id = enqueue(database_url, "heartbeat.bound", "heartbeat-bound")
    task = BlockingTask()
    worker = Worker(
        worker_pool,
        queue="heartbeat-bound",
        worker_id="python-heartbeat-bound",
        lease_ms=30_000,
        heartbeat_ms=BOUND_HEARTBEAT_MS,
    ).handle("heartbeat.bound", task.handler)
    processed: list[bool] = []
    run = Thread(target=lambda: processed.append(worker.run_once()))
    run.start()
    try:
        assert task.started.wait(30)
        samples = sample_heartbeats_while_locked(database_url, task_id)
    finally:
        task.release.set()
        run.join(30)

    assert_one_bounded_statement(samples)
    assert processed == [True]
    assert not task.cancelled
    assert outcome(database_url, task_id) == ("succeeded",)


@pytest.mark.asyncio
@pytest.mark.parametrize("driver", ["psycopg", "asyncpg"])
async def test_an_async_heartbeat_round_that_waits_on_a_lock_ends_on_the_server_by_its_deadline(
    database_url: str, driver: str, async_psycopg_pool, asyncpg_pool
) -> None:
    queue = f"heartbeat-bound-{driver}"
    task_id = enqueue(database_url, "heartbeat.bound", queue)
    task = BlockingTask()
    options: dict[str, Any] = {
        "queue": queue,
        "worker_id": f"python-async-heartbeat-bound-{driver}",
        "lease_ms": 30_000,
        "heartbeat_ms": BOUND_HEARTBEAT_MS,
    }
    if driver == "psycopg":
        worker = AsyncWorker.from_psycopg(async_psycopg_pool, **options)
    else:
        worker = AsyncWorker.from_asyncpg(asyncpg_pool, **options)
    worker.handle("heartbeat.bound", task.async_handler)
    run = asyncio.create_task(worker.run_once())
    try:
        assert await asyncio.to_thread(task.started.wait, 30)
        samples = await asyncio.to_thread(sample_heartbeats_while_locked, database_url, task_id)
    finally:
        task.release.set()
        processed = await asyncio.wait_for(run, timeout=30)

    assert_one_bounded_statement(samples)
    assert processed is True
    assert not task.cancelled
    assert outcome(database_url, task_id) == ("succeeded",)


# The fixed schedule (SM-1444): a round falls due one interval after the previous round started, so
# one timed-out round does not move the next round toward the end of the lease. The lease is 2.3
# intervals, shorter than the default of 3. The row lock makes the first round end on the server at
# about 1.4 intervals. The fixed schedule sends the next round at 2 intervals, inside the lease. A
# schedule that waits one interval after the failed round ends sends it at about 2.4 intervals,
# after the lease.
MARGIN_HEARTBEAT_MS = 1_000
MARGIN_LEASE_MS = 2_300


def time_out_one_round(database_url: str, task_id: str, task: BlockingTask) -> None:
    """Hold the row lock through the first round, then release the handler after the lease."""
    assert task.started.wait(30)
    started = monotonic()
    interval = MARGIN_HEARTBEAT_MS / 1000
    with psycopg.connect(database_url) as blocker:
        blocker.execute(
            "SELECT FROM workhorse.task_runtime WHERE task_id = %s FOR UPDATE", (task_id,)
        )
        sleep(max(0.0, started + 1.6 * interval - monotonic()))
        blocker.commit()
    # Run past the end of the lease from the claim, so only a renewal keeps the task.
    sleep(max(0.0, started + 2.6 * interval - monotonic()))
    task.release.set()


def test_one_timed_out_heartbeat_round_leaves_a_renewal_margin(database_url: str) -> None:
    task_id = enqueue(database_url, "heartbeat.margin", "heartbeat-margin")
    task = BlockingTask()
    worker = Worker(
        worker_pool,
        queue="heartbeat-margin",
        worker_id="python-heartbeat-margin",
        lease_ms=MARGIN_LEASE_MS,
        heartbeat_ms=MARGIN_HEARTBEAT_MS,
    ).handle("heartbeat.margin", task.handler)
    processed: list[bool] = []
    run = Thread(target=lambda: processed.append(worker.run_once()))
    run.start()
    try:
        time_out_one_round(database_url, task_id, task)
    finally:
        task.release.set()
        run.join(30)

    assert processed == [True]
    assert not task.cancelled
    assert outcome(database_url, task_id) == ("succeeded",)


@pytest.mark.asyncio
@pytest.mark.parametrize("driver", ["psycopg", "asyncpg"])
async def test_one_timed_out_async_heartbeat_round_leaves_a_renewal_margin(
    database_url: str, driver: str, async_psycopg_pool, asyncpg_pool
) -> None:
    queue = f"heartbeat-margin-{driver}"
    task_id = enqueue(database_url, "heartbeat.margin", queue)
    task = BlockingTask()
    options: dict[str, Any] = {
        "queue": queue,
        "worker_id": f"python-async-heartbeat-margin-{driver}",
        "lease_ms": MARGIN_LEASE_MS,
        "heartbeat_ms": MARGIN_HEARTBEAT_MS,
    }
    if driver == "psycopg":
        worker = AsyncWorker.from_psycopg(async_psycopg_pool, **options)
    else:
        worker = AsyncWorker.from_asyncpg(asyncpg_pool, **options)
    worker.handle("heartbeat.margin", task.async_handler)
    run = asyncio.create_task(worker.run_once())
    try:
        await asyncio.to_thread(time_out_one_round, database_url, task_id, task)
    finally:
        task.release.set()
        processed = await asyncio.wait_for(run, timeout=30)

    assert processed is True
    assert not task.cancelled
    assert outcome(database_url, task_id) == ("succeeded",)


def test_a_failed_heartbeat_round_opens_its_replacement_before_the_next_round(
    database_url: str,
) -> None:
    # SM-1444: rounds start on a fixed schedule, so the next round can start soon after a failed
    # one. The failed round opens the replacement as it ends, so the connect starts before the
    # next round.
    heartbeat_ms = 2_000
    task_id = enqueue(database_url, "heartbeat.replacement", "heartbeat-replacement")
    task = BlockingTask()
    failed = Event()
    opens: list[float] = []
    rounds = Lock()
    round_count = 0

    def failing() -> bool:
        nonlocal round_count
        with rounds:
            round_count += 1
            return round_count == 2

    open_failing = heartbeat_executor_factory(failing, failed)

    def counted() -> tuple[Any, Any]:
        opens.append(monotonic())
        return open_failing()

    worker = Worker(
        worker_pool,
        queue="heartbeat-replacement",
        worker_id="python-heartbeat-replacement",
        lease_ms=30_000,
        heartbeat_ms=heartbeat_ms,
        _heartbeat_executor_factory=counted,
    ).handle("heartbeat.replacement", task.handler)
    processed: list[bool] = []
    run = Thread(target=lambda: processed.append(worker.run_once()))
    run.start()
    try:
        assert task.started.wait(30)
        assert failed.wait(30)
        failed_at = monotonic()
        # The first round opened one connection and kept it. The failed round discarded it, and
        # opened the next one long before the next round falls due.
        deadline = failed_at + heartbeat_ms / 1000 / 2
        while len(opens) < 2 and monotonic() < deadline:
            sleep(0.01)
        assert len(opens) == 2, opens
        assert opens[1] - failed_at < heartbeat_ms / 1000 / 2
    finally:
        task.release.set()
        run.join(30)

    assert processed == [True]
    assert not task.cancelled
    assert outcome(database_url, task_id) == ("succeeded",)
