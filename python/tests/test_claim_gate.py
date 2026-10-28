"""SM-1571: the claim gate and the startup checks of every Python domain (ADR 0071, rules 3 and 6).

Each test drives the shared worker core through the executor of one domain: the psycopg sync
pool, the psycopg async pool, and the asyncpg pool. Fake pools stand in for the database. Events,
not sleeps, put each test in its state: a borrow that waits, a lost heartbeat connection, a
completion that waits behind another batch, a deadlock, and a stalled query.
"""

from __future__ import annotations

import asyncio
import threading
from collections.abc import AsyncIterator, Callable, Iterator, Sequence
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass, field
from queue import SimpleQueue
from time import monotonic
from types import SimpleNamespace
from typing import Any

import psycopg
import pytest
from reservations import reserve

import workhorse._compatibility as compatibility_module
import workhorse.worker as worker_module
from workhorse import AsyncWorker, Worker
from workhorse._pool_hub import ReservationSubscription
from workhorse._statements import STATEMENTS

DOMAINS = ["sync", "psycopg", "asyncpg"]
# Every test bounds each wait for an event by this, so a failed test ends.
EVENT_SECONDS = 10


class Deadlock(Exception):
    sqlstate = "40P01"


@dataclass
class Database:
    """What the fake pools of every domain record and answer.

    A borrow sets `borrowing` and then waits for `lend`. `on_statement` runs for each statement
    and can raise, or block on `stall`.
    """

    statements: list[tuple[str, tuple[object, ...]]] = field(default_factory=list)
    borrowing: threading.Event = field(default_factory=threading.Event)
    lend: threading.Event = field(default_factory=threading.Event)
    stall: threading.Event = field(default_factory=threading.Event)
    on_statement: Callable[[str, tuple[object, ...]], None] | None = None

    def __post_init__(self) -> None:
        self.lend.set()

    def borrow(self) -> None:
        self.borrowing.set()
        assert self.lend.wait(EVENT_SECONDS), "the test never lent the connection"

    def run(self, sql: str, parameters: Sequence[object]) -> list[dict[str, object]]:
        sent = tuple(parameters)
        self.statements.append((sql, sent))
        if self.on_statement is not None:
            self.on_statement(sql, sent)
        # A fused completion answers with its accepted tasks and no claimed task.
        accepted = list(sent[1]) if len(sent) > 1 and isinstance(sent[1], list) else []
        return [{"accepted": accepted, "task_id": None}]

    def sent(self, statement: Any) -> list[tuple[object, ...]]:
        texts = {statement.psycopg, statement.asyncpg}
        return [parameters for sql, parameters in self.statements if sql in texts]


class _SyncCursor:
    def __init__(self, database: Database) -> None:
        self._database = database
        self.description: list[tuple[str]] = []
        self._rows: list[tuple[object, ...]] = []

    def __enter__(self) -> _SyncCursor:
        return self

    def __exit__(self, *_arguments: object) -> None:
        return None

    def execute(self, sql: str, parameters: Sequence[object] = (), **_options: Any) -> None:
        rows = self._database.run(sql, parameters)
        self.description = [(name,) for name in rows[0]]
        self._rows = [tuple(row.values()) for row in rows]

    def fetchall(self) -> list[tuple[object, ...]]:
        return self._rows


class _SyncConnection:
    def __init__(self, database: Database) -> None:
        self._database = database

    def cursor(self, **_options: Any) -> _SyncCursor:
        return _SyncCursor(self._database)


class _SyncBorrow:
    def __init__(self, database: Database) -> None:
        self._database = database

    def __enter__(self) -> _SyncConnection:
        self._database.borrow()
        return _SyncConnection(self._database)

    def __exit__(self, *_arguments: object) -> None:
        return None


class SyncPool:
    max_size = 5

    def __init__(self, database: Database) -> None:
        self._database = database

    def connection(self, **_options: Any) -> _SyncBorrow:
        return _SyncBorrow(self._database)


class _AsyncCursor:
    def __init__(self, database: Database) -> None:
        self._database = database
        self.description: list[tuple[str]] = []
        self._rows: list[tuple[object, ...]] = []

    async def __aenter__(self) -> _AsyncCursor:
        return self

    async def __aexit__(self, *_arguments: object) -> None:
        return None

    async def execute(self, sql: str, parameters: Sequence[object] = (), **_options: Any) -> None:
        rows = await asyncio.to_thread(self._database.run, sql, parameters)
        self.description = [(name,) for name in rows[0]]
        self._rows = [tuple(row.values()) for row in rows]

    async def fetchall(self) -> list[tuple[object, ...]]:
        return self._rows


class _AsyncConnection:
    autocommit = True

    def __init__(self, database: Database) -> None:
        self._database = database

    def cursor(self, **_options: Any) -> _AsyncCursor:
        return _AsyncCursor(self._database)


class _AsyncBorrow:
    def __init__(self, database: Database) -> None:
        self._database = database

    async def __aenter__(self) -> _AsyncConnection:
        await asyncio.to_thread(self._database.borrow)
        return _AsyncConnection(self._database)

    async def __aexit__(self, *_arguments: object) -> None:
        return None


class PsycopgAsyncPool:
    max_size = 5

    def __init__(self, database: Database) -> None:
        self._database = database

    def connection(self, **_options: Any) -> _AsyncBorrow:
        return _AsyncBorrow(self._database)


class _AsyncpgConnection:
    def __init__(self, database: Database) -> None:
        self._database = database

    async def fetch(self, sql: str, *parameters: object) -> list[dict[str, object]]:
        return await asyncio.to_thread(self._database.run, sql, parameters)


class AsyncpgPool:
    def __init__(self, database: Database) -> None:
        self._database = database

    def get_max_size(self) -> int:
        return 5

    async def acquire(self, *, timeout: float | None = None) -> _AsyncpgConnection:  # noqa: ASYNC109
        assert timeout is not None, "every asyncpg acquire of the worker needs a timeout"
        await asyncio.to_thread(self._database.borrow)
        return _AsyncpgConnection(self._database)

    async def release(self, _connection: object) -> None:
        return None


class Heartbeats:
    """Heartbeat connections that open while `fail` is clear, after `delay` is set."""

    def __init__(self) -> None:
        self.fail = threading.Event()
        self.delay = threading.Event()
        self.delay.set()

    def open(self) -> Any:
        assert self.delay.wait(EVENT_SECONDS)
        if self.fail.is_set():
            raise psycopg.OperationalError("the database is unreachable")
        return object(), lambda: None


@dataclass
class Gated:
    core: Worker
    database: Database
    heartbeats: Heartbeats
    subscription: ReservationSubscription | None = None

    def lose_the_heartbeat_connection(self) -> None:
        """Lose the shared heartbeat connection while no replacement can open."""
        reservation = self.core._reservation
        assert reservation is not None
        self.heartbeats.fail.set()
        connection = reservation.take(monotonic() + 1)
        assert connection is not None
        reservation.lose(connection)
        assert not reservation.ready()


@asynccontextmanager
async def domain_core(
    domain: str, *, reserved: bool = True, registry_interval_ms: int = 0
) -> AsyncIterator[Gated]:
    """The shared worker core of `domain`, over a fake pool, with a private heartbeat source."""
    database = Database()
    heartbeats = Heartbeats()
    options: dict[str, Any] = {
        "queue": "gate",
        "worker_id": f"gate-{domain}",
        "concurrency": 4,
        "heartbeat_ms": 200,
        "lease_ms": 5_000,
        "registry_interval_ms": registry_interval_ms,
    }
    async_worker: AsyncWorker | None = None
    if domain == "sync":
        core = Worker(
            SyncPool(database),  # type: ignore[arg-type]
            _heartbeat_executor_factory=heartbeats.open,
            **options,
        )
    else:
        async_worker = (
            AsyncWorker.from_psycopg(PsycopgAsyncPool(database), **options)  # type: ignore[arg-type]
            if domain == "psycopg"
            else AsyncWorker.from_asyncpg(AsyncpgPool(database), **options)  # type: ignore[arg-type]
        )
        # The run binds the bridge to this event loop, as AsyncWorker.run does.
        async_worker._start_run()
        core = async_worker._inner
        core._heartbeat_executor_factory = heartbeats.open
    gated = Gated(core, database, heartbeats)
    if reserved:
        gated.subscription = await asyncio.to_thread(reserve, core)
    try:
        yield gated
    finally:
        database.lend.set()
        database.stall.set()
        heartbeats.delay.set()
        if gated.subscription is not None:
            gated.subscription.close()
        if async_worker is not None:
            async_worker._threads.close()
            async_worker._running = False


async def run_claim(core: Worker) -> Any:
    results: SimpleQueue[Any] = SimpleQueue()
    await asyncio.to_thread(core._run_dispatch_claim, 0, 4, 4, 0, False, results)
    return results.get_nowait()


async def wait_for(event: threading.Event, message: str) -> None:
    assert await asyncio.to_thread(event.wait, EVENT_SECONDS), message


def queue_completion(core: Worker) -> tuple[Any, tuple[str, int]]:
    """A fast-tier completion that waits behind a statement of the same batch key in flight."""
    key = ("gate", 0)
    core._pending_completions[key] = []
    task = SimpleNamespace(id="task-1", fence_token=7)
    pending = worker_module._PendingCompletion(task, "{}", 2, threading.Event())  # type: ignore[arg-type]
    return pending, key


def hand_over_the_batch(core: Worker, key: tuple[str, int]) -> None:
    """End the statement ahead, which hands the next statement to the waiting completion."""
    with core._completion_lock:
        waiting = core._pending_completions[key]
        waiting[0].lead = True
        waiting[0].done.set()


@pytest.mark.asyncio
@pytest.mark.parametrize("domain", DOMAINS)
async def test_a_claim_reads_the_gate_after_its_borrow(domain: str) -> None:
    """The heartbeat connection is lost while a claim waits for its connection.

    The claim borrows the connection, reads the closed gate, and sends no statement.
    """
    async with domain_core(domain) as gated:
        gated.database.lend.clear()
        claim = asyncio.create_task(run_claim(gated.core))
        await wait_for(gated.database.borrowing, "the claim never asked for a connection")

        gated.lose_the_heartbeat_connection()
        gated.database.lend.set()
        outcome = await claim

    assert gated.database.statements == []
    assert outcome.claimed is None and outcome.error is None


@pytest.mark.asyncio
@pytest.mark.parametrize("domain", DOMAINS)
async def test_a_claim_sends_nothing_after_its_run_released_the_reservation(domain: str) -> None:
    """The stop deadline leaves a claim waiting for its connection, and the run cleans up.

    The cleanup releases the reservation. The claim then borrows its connection and sends nothing.
    """
    async with domain_core(domain) as gated:
        gated.database.lend.clear()
        claim = asyncio.create_task(run_claim(gated.core))
        await wait_for(gated.database.borrowing, "the claim never asked for a connection")

        gated.core._end_connections(gated.subscription)
        gated.database.lend.set()
        outcome = await claim

    assert gated.database.statements == []
    assert outcome.claimed is None and outcome.error is None


@pytest.mark.asyncio
@pytest.mark.parametrize("domain", DOMAINS)
async def test_a_deadlock_resend_of_a_claim_reads_the_gate_again(domain: str) -> None:
    """PostgreSQL chooses the claim as a deadlock victim, and the heartbeat connection is lost.

    The resend borrows again, reads the closed gate, and sends nothing.
    """
    async with domain_core(domain) as gated:

        def deadlock_once(_sql: str, _parameters: tuple[object, ...]) -> None:
            if len(gated.database.statements) == 1:
                gated.lose_the_heartbeat_connection()
                raise Deadlock("deadlock detected")

        gated.database.on_statement = deadlock_once
        outcome = await run_claim(gated.core)

    assert len(gated.database.statements) == 1
    assert outcome.claimed is None and outcome.error is None


@pytest.mark.asyncio
@pytest.mark.parametrize("domain", DOMAINS)
async def test_a_queued_completion_claims_nothing_with_the_gate_closed(domain: str) -> None:
    """A completion waits behind another batch, and the heartbeat connection is lost meanwhile.

    The completion still settles its task, with a claim limit of 0.
    """
    async with domain_core(domain) as gated:
        pending, key = queue_completion(gated.core)
        completion = asyncio.create_task(
            asyncio.to_thread(gated.core._send_batched_completion, pending, key)
        )
        # A checkpoint: the completion waits in the batch, behind the statement in flight.
        deadline = monotonic() + EVENT_SECONDS
        while gated.core._pending_completions[key] != [pending]:
            assert monotonic() < deadline, "the completion never queued"
            await asyncio.sleep(0.001)

        gated.lose_the_heartbeat_connection()
        hand_over_the_batch(gated.core, key)
        await completion

    (parameters,) = gated.database.sent(STATEMENTS.complete_many_and_claim)
    assert parameters[1] == ["task-1"]
    assert parameters[5] == 0
    assert pending.accepted is True and pending.claimed == []


@pytest.mark.asyncio
@pytest.mark.parametrize("domain", DOMAINS)
async def test_a_deadlock_resend_of_a_completion_claims_nothing_with_the_gate_closed(
    domain: str,
) -> None:
    """The first attempt of a fused completion asks for 2 tasks and loses a deadlock.

    The heartbeat connection is lost before the resend, so the resend asks for none.
    """
    async with domain_core(domain) as gated:

        def deadlock_once(_sql: str, _parameters: tuple[object, ...]) -> None:
            if len(gated.database.statements) == 1:
                gated.lose_the_heartbeat_connection()
                raise Deadlock("deadlock detected")

        gated.database.on_statement = deadlock_once
        pending, key = queue_completion(gated.core)
        del gated.core._pending_completions[key]
        await asyncio.to_thread(gated.core._send_batched_completion, pending, key)

    first, resend = gated.database.sent(STATEMENTS.complete_many_and_claim)
    assert first[5] == 2
    assert resend[5] == 0
    assert pending.accepted is True


@pytest.mark.asyncio
@pytest.mark.parametrize("domain", DOMAINS)
async def test_the_replacement_heartbeat_connection_wakes_dispatch(domain: str) -> None:
    async with domain_core(domain) as gated:
        gated.lose_the_heartbeat_connection()
        woken = gated.core._dispatch_wake_version
        reservation = gated.core._reservation
        assert reservation is not None

        gated.heartbeats.fail.clear()
        deadline = monotonic() + EVENT_SECONDS
        while not (gated.core._dispatch_wake_version > woken and reservation.ready()):
            assert monotonic() < deadline, "the replacement never woke dispatch"
            await asyncio.sleep(0.01)


@contextmanager
def compatible_rows() -> Iterator[None]:
    """Accept any answer to the compatibility query, so the fake pools can answer it."""
    original = compatibility_module.assert_compatible
    compatibility_module.assert_compatible = lambda _rows: None  # type: ignore[assignment]
    try:
        yield
    finally:
        compatibility_module.assert_compatible = original


@pytest.mark.asyncio
@pytest.mark.parametrize("domain", DOMAINS)
async def test_one_startup_deadline_bounds_a_late_reservation_and_a_stalled_query(
    domain: str,
) -> None:
    """The reservation arrives late, and then the compatibility query never answers.

    The whole startup still ends at max(heartbeat_ms, 5 s), not later.
    """
    async with domain_core(domain, reserved=False) as gated:
        gated.heartbeats.delay.clear()
        reservation_late = threading.Timer(1.0, gated.heartbeats.delay.set)

        def stall(sql: str, _parameters: tuple[object, ...]) -> None:
            if sql in {STATEMENTS.compatibility.psycopg, STATEMENTS.compatibility.asyncpg}:
                assert gated.database.stall.wait(60)

        gated.database.on_statement = stall
        started_at = monotonic()
        reservation_late.start()
        with pytest.raises(TimeoutError) as refused:
            await asyncio.to_thread(gated.core._start_connections)
        elapsed = monotonic() - started_at
        reservation_late.cancel()

    assert gated.core._connection_budget_seconds == 5
    assert 4.9 < elapsed < 5.6, elapsed
    assert "compatibility check" in str(refused.value)
    assert "5000 ms" in str(refused.value)
    assert str(refused.value).endswith(
        "Grow the pool, or check that the database accepts connections."
    )
    assert "shared_heartbeats" not in str(refused.value)


@pytest.mark.asyncio
@pytest.mark.parametrize("domain", DOMAINS)
async def test_every_startup_borrows_a_connection_for_the_compatibility_query(
    domain: str,
) -> None:
    """A second run checks the headroom of the pool again, and refuses when none is left."""
    with compatible_rows():
        async with domain_core(domain, reserved=False) as gated:
            for _ in range(2):
                _hub, detach, subscription = await asyncio.to_thread(gated.core._start_connections)
                gated.core._end_connections(subscription)
                detach()
            assert len(gated.database.sent(STATEMENTS.compatibility)) == 2

            # Another user of the pool takes the last ordinary connection.
            gated.database.lend.clear()
            with pytest.raises(TimeoutError, match="compatibility check"):
                await asyncio.to_thread(gated.core._start_connections)


@pytest.mark.asyncio
@pytest.mark.parametrize("domain", DOMAINS)
async def test_a_stop_ends_a_stalled_registration_by_its_deadline(domain: str) -> None:
    """The registration statement of a starting run stalls, and then the run is stopped.

    The run ends by the stop deadline and the cleanup window. It does not wait for the
    statement, which still runs and holds its own connection.
    """
    with compatible_rows():
        async with domain_core(domain, reserved=False, registry_interval_ms=5_000) as gated:
            core = gated.core
            core._listens = False
            registering = threading.Event()

            def stall(sql: str, _parameters: tuple[object, ...]) -> None:
                if sql in {STATEMENTS.register_worker.psycopg, STATEMENTS.register_worker.asyncpg}:
                    registering.set()
                    assert gated.database.stall.wait(60)

            gated.database.on_statement = stall
            run = asyncio.create_task(asyncio.to_thread(core.run))
            await wait_for(registering, "the run never sent its registration")
            stopped_at = monotonic()
            core.stop()
            done, _pending = await asyncio.wait({run}, timeout=EVENT_SECONDS)
            elapsed = monotonic() - stopped_at
            assert done == {run}, "the run waited for the stalled registration"
            run.result()

    # The stop budget is max(heartbeat_ms, 5 s), and the cleanup window after the drain is 1 s.
    assert elapsed < core._connection_budget_seconds + 1 + 0.5, elapsed
