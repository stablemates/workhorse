"""A task's lease keeps renewing until its final transition is written (SM-1084)."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable, Sequence
from threading import Event, Lock, Thread
from time import monotonic, sleep
from typing import Any

import psycopg
import pytest
from psycopg_pool import ConnectionPool
from test_worker_dispatch import FullTierRejection, task_row

from workhorse import AsyncWorker, EnqueueOptions, Queue, Worker
from workhorse._drivers import SyncExecutor
from workhorse._statements import STATEMENTS, DriverStatement

TASK = "final.transition"
# The scripted executor accepts every round, so only a starved host could let the lease lapse. The
# worker's watchdog then ends the attempt before its final write. This lease is longer than any wait
# of the tests, so the tests do not depend on how fast the host schedules the heartbeat rounds.
LEASE_MS = 10_000
HEARTBEAT_MS = 100
# The rounds that must renew the lease while the final write is held. A worker that stopped
# renewing at handler return sends none.
RENEWALS_WHILE_HELD = 3
# The refusal test lets the watchdog lapse after the refusal, so its lease ends during the test. It
# is long enough that the attempt reaches its final write within it under load.
REFUSAL_LEASE_MS = 1_000
# The longest wait for an event of the attempt.
EVENT_SECONDS = 10


class HeldSettlement:
    """Accept every heartbeat and hold the attempt's final write until the test releases it."""

    def __init__(self, *, fast: bool, verdict: str = "accepted") -> None:
        self._lock = Lock()
        # The heartbeat status PostgreSQL reports once the final write is in flight.
        self.verdict = verdict
        self.acknowledged_cancels = 0
        self._backlog = [{**task_row(1, TASK), "result_max_bytes": 64, "max_attempts": 1}]
        self.fast = fast
        self.held = Event()
        self.release = Event()
        self.heartbeat_rounds = 0
        self.settlements: list[tuple[str, object]] = []
        self.expirations: list[str] = []
        self.fast_completions = 0

    def rows(self, statement: DriverStatement, parameters: Sequence[object] = ()) -> list[Any]:
        if statement is STATEMENTS.claim_many:
            return self._take()
        if statement is STATEMENTS.heartbeat_many:
            with self._lock:
                self.heartbeat_rounds += 1
            status = self.verdict if self.held.is_set() else "accepted"
            return [{"task_id": task_row(1, TASK)["task_id"], "status": status}]
        if statement is STATEMENTS.acknowledge_cancel:
            with self._lock:
                self.acknowledged_cancels += 1
            return [{"accepted": self.verdict == "cancel_requested"}]
        if statement is STATEMENTS.complete_many_and_claim:
            if not self.fast:
                raise FullTierRejection
            task_ids = parameters[1]
            assert isinstance(task_ids, list)
            if not task_ids:
                # A fast claim is this statement with no completions.
                return self._take() or [dict.fromkeys(task_row(0, TASK))]
            results = parameters[3]
            assert isinstance(results, list)
            self._hold("completed", results[0])
            self.fast_completions += 1
            row: dict[str, object] = dict.fromkeys(task_row(0, TASK))
            # A fast completion refuses a due boundary the same way a full-tier one does.
            row["accepted"] = task_ids if self.verdict == "accepted" else []
            return [row]
        if statement is STATEMENTS.complete:
            self._hold("completed", parameters[3])
            # A fenced write meets the same verdict the heartbeat reported.
            return [{"accepted": self.verdict == "accepted"}]
        if statement is STATEMENTS.fail:
            self._hold("failed", parameters[3])
            return [{"state": "failed"}]
        if statement is STATEMENTS.expire_owned:
            # Like expire_owned_v1, report the verdict and write a due boundary's transition.
            status = (
                self.verdict if self.held.is_set() and self.verdict != "accepted" else "not_due"
            )
            with self._lock:
                self.expirations.append(status)
            return [{"status": status, "retry_state": None}]
        return []

    def _take(self) -> list[dict[str, object]]:
        with self._lock:
            claimed, self._backlog = self._backlog, []
        return claimed

    def rounds(self) -> int:
        with self._lock:
            return self.heartbeat_rounds

    def _hold(self, transition: str, value: object) -> None:
        self.held.set()
        assert self.release.wait(EVENT_SECONDS), "the test never released the final write"
        with self._lock:
            self.settlements.append((transition, value))


class AsyncHeldSettlement:
    """Present a HeldSettlement to AsyncWorker without blocking its event loop."""

    def __init__(self, inner: HeldSettlement) -> None:
        self._inner = inner

    async def rows(self, statement: DriverStatement, parameters: Sequence[object] = ()) -> Any:
        return await asyncio.to_thread(self._inner.rows, statement, parameters)


def handler_for(outcome: str) -> Callable[[object, object], object]:
    def handle(_payload: object, _context: object) -> object:
        if outcome == "failure":
            raise RuntimeError("handler failed")
        if outcome == "oversized":
            return "x" * 64
        return {"ok": True}

    return handle


def scripted(worker: Worker) -> Worker:
    worker._compatibility.assert_compatible = lambda: None  # type: ignore[method-assign]
    worker._listens = False
    return worker


def sync_worker(executor: HeldSettlement, lease_ms: int = LEASE_MS) -> Worker:
    return scripted(
        Worker(
            object(),  # type: ignore[arg-type]
            queue="dispatch",
            worker_id="python-final-transition",
            concurrency=1,
            lease_ms=lease_ms,
            heartbeat_ms=HEARTBEAT_MS,
            registry_interval_ms=0,
            shared_heartbeats=True,
            _executor=executor,
        )
    )


def assert_renews_while_held(core: Worker, executor: HeldSettlement) -> None:
    assert executor.held.wait(EVENT_SECONDS), "the attempt never reached its final write"
    task_id = str(task_row(1, TASK)["task_id"])
    rounds_before = executor.rounds()
    deadline = monotonic() + EVENT_SECONDS
    # Renewal outlives the handler: rounds keep renewing the lease while the final write waits.
    while executor.rounds() - rounds_before < RENEWALS_WHILE_HELD:
        with core._heartbeat_lock:
            assert task_id in core._heartbeat_members, "supervision ended before the final write"
        assert monotonic() < deadline, "no heartbeat round renewed the lease of the held write"
        sleep(HEARTBEAT_MS / 4000)
    executor.release.set()


def expected_settlement(outcome: str) -> tuple[str, str]:
    if outcome == "completion":
        return ("completed", '{"ok":true}')
    name = "RuntimeError" if outcome == "failure" else "TaskValueSizeLimitError"
    return ("failed", name)


def settled(executor: HeldSettlement) -> list[tuple[str, str]]:
    return [
        (transition, str(value) if transition == "completed" else json.loads(str(value))["name"])
        for transition, value in executor.settlements
    ]


OUTCOMES = ["completion", "failure", "oversized"]


@pytest.mark.parametrize("outcome", OUTCOMES)
@pytest.mark.parametrize("fast", [False, True], ids=["full-tier", "fast-tier"])
def test_worker_renews_the_lease_until_the_final_write_returns(outcome: str, fast: bool) -> None:
    executor = HeldSettlement(fast=fast)
    worker = sync_worker(executor).handle(TASK, handler_for(outcome))
    run = Thread(target=worker.run_once)
    run.start()
    try:
        assert_renews_while_held(worker, executor)
    finally:
        executor.release.set()
        run.join(10)

    assert not run.is_alive()
    assert settled(executor) == [expected_settlement(outcome)]
    assert executor.fast_completions == (1 if fast and outcome == "completion" else 0)
    with worker._heartbeat_lock:
        assert worker._heartbeat_members == {}


@pytest.mark.asyncio
@pytest.mark.parametrize("outcome", OUTCOMES)
@pytest.mark.parametrize("fast", [False, True], ids=["full-tier", "fast-tier"])
async def test_async_worker_renews_the_lease_until_the_final_write_returns(
    outcome: str, fast: bool
) -> None:
    executor = HeldSettlement(fast=fast)
    worker = AsyncWorker(
        AsyncHeldSettlement(executor),  # type: ignore[arg-type]
        object(),
        "asyncpg",
        shared_heartbeats=True,
        queue="dispatch",
        worker_id="python-final-transition-async",
        concurrency=1,
        lease_ms=LEASE_MS,
        heartbeat_ms=HEARTBEAT_MS,
        registry_interval_ms=0,
    )
    scripted(worker._inner)
    handle = handler_for(outcome)

    async def handle_async(payload: object, context: object) -> object:
        return handle(payload, context)

    worker.handle(TASK, handle_async)
    run = asyncio.create_task(worker.run_once())
    try:
        await asyncio.to_thread(assert_renews_while_held, worker._inner, executor)
    finally:
        executor.release.set()
        await asyncio.wait_for(run, 10)

    assert settled(executor) == [expected_settlement(outcome)]
    assert executor.fast_completions == (1 if fast and outcome == "completion" else 0)
    with worker._inner._heartbeat_lock:
        assert worker._inner._heartbeat_members == {}


def task_is_renewing(core: Worker) -> bool:
    with core._heartbeat_lock:
        return str(task_row(1, TASK)["task_id"]) in core._heartbeat_members


@pytest.mark.parametrize("verdict", ["stale", "cancel_requested"])
def test_a_refused_renewal_after_the_handler_returns_only_stops_renewing(verdict: str) -> None:
    executor = HeldSettlement(fast=False, verdict=verdict)
    handled = Event()

    def handle(_payload: object, _context: object) -> object:
        handled.set()
        return {"ok": True}

    worker = sync_worker(executor, REFUSAL_LEASE_MS).handle(TASK, handle)
    run = Thread(target=worker.run_once)
    run.start()
    try:
        assert executor.held.wait(EVENT_SECONDS), "the attempt never reached its final write"
        deadline = monotonic() + EVENT_SECONDS
        while task_is_renewing(worker) and monotonic() < deadline:
            sleep(HEARTBEAT_MS / 4000)
        assert not task_is_renewing(worker), "a refused renewal did not stop renewing"
        # The refusal neither cancels the finished attempt nor writes a second transition, also
        # after the watchdog finds the lease lapsed.
        sleep(REFUSAL_LEASE_MS * 2 / 1000)
        assert executor.settlements == []
    finally:
        executor.release.set()
        run.join(10)

    assert not run.is_alive()
    assert handled.is_set()
    # The fenced completion is refused, and the worker reconciles that refusal once.
    assert [transition for transition, _value in executor.settlements] == ["completed"]
    assert executor.expirations == [verdict]
    assert executor.acknowledged_cancels == (1 if verdict == "cancel_requested" else 0)


def record_attempt_outcomes(core: Worker) -> list[object]:
    """Record the outcome of each attempt that `core` runs, once the attempt has ended."""
    outcomes: list[object] = []
    execute = core._execute_claimed_task_within_span

    def recording(task: Any, claim_sent_at: float, arbiter: Any, *rest: Any) -> None:
        try:
            execute(task, claim_sent_at, arbiter, *rest)
        finally:
            outcomes.append(arbiter.outcome)

    core._execute_claimed_task_within_span = recording  # type: ignore[method-assign]
    return outcomes


# The outcome an attempt reports once PostgreSQL accepts its held final write.
WRITTEN_OUTCOMES = {"completion": "completed", "failure": "failed", "oversized": "failed"}


@pytest.mark.parametrize("outcome", OUTCOMES)
@pytest.mark.parametrize("fast", [False, True], ids=["full-tier", "fast-tier"])
def test_a_lease_that_lapses_after_the_handler_returns_only_stops_renewing(
    outcome: str, fast: bool
) -> None:
    executor = HeldSettlement(fast=fast)
    contexts: list[Any] = []
    handle = handler_for(outcome)

    def handle_and_keep_context(payload: object, context: object) -> object:
        contexts.append(context)
        return handle(payload, context)

    worker = sync_worker(executor).handle(TASK, handle_and_keep_context)
    outcomes = record_attempt_outcomes(worker)
    run = Thread(target=worker.run_once)
    run.start()
    try:
        assert executor.held.wait(EVENT_SECONDS), "the attempt never reached its final write"
        with worker._heartbeat_lock:
            heartbeats = worker._heartbeat_thread
        assert heartbeats is not None
        # With no lease left, the next accepted answer or the watchdog finds the local lease window
        # ended. Either one causes the lapse at once, so the test does not wait for a time.
        worker.lease_ms = 0
        deadline = monotonic() + EVENT_SECONDS
        while task_is_renewing(worker) and monotonic() < deadline:
            sleep(HEARTBEAT_MS / 4000)
        assert not task_is_renewing(worker), "the lapsed lease did not stop renewing"
        assert executor.settlements == []
    finally:
        executor.release.set()
        run.join(10)

    assert not run.is_alive()
    # The attempt joins its watchdog. The heartbeat thread ends once no lease is left, so after it
    # ends, each path that handled the lapse has returned.
    heartbeats.join(EVENT_SECONDS)
    assert not heartbeats.is_alive()
    # The lapse neither cancels the finished attempt nor ends it with lease loss.
    assert not contexts[0].cancellation.cancelled
    # PostgreSQL accepts the fenced final write, so the attempt reports it.
    assert settled(executor) == [expected_settlement(outcome)]
    assert outcomes == [WRITTEN_OUTCOMES[outcome]]


def release_after_renewal_is_refused(core: Worker, executor: HeldSettlement) -> None:
    assert executor.held.wait(EVENT_SECONDS), "the attempt never reached its final write"
    deadline = monotonic() + EVENT_SECONDS
    while task_is_renewing(core) and monotonic() < deadline:
        sleep(HEARTBEAT_MS / 4000)
    # A refused renewal after the handler returns only stops renewing; it settles nothing.
    assert not task_is_renewing(core), "a refused renewal did not stop renewing"
    assert executor.expirations == []
    executor.release.set()


# The expiration status a held completion meets, and the outcome the attempt must report.
BOUNDARIES = [("deadline_exceeded", "deadline_exceeded"), ("timeout_exceeded", "attempt_timeout")]


@pytest.mark.parametrize(("verdict", "want_outcome"), BOUNDARIES, ids=["deadline", "timeout"])
@pytest.mark.parametrize("fast", [False, True], ids=["full-tier", "fast-tier"])
def test_a_boundary_due_during_the_final_write_is_settled_by_the_attempt(
    verdict: str, want_outcome: str, fast: bool
) -> None:
    executor = HeldSettlement(fast=fast, verdict=verdict)
    worker = sync_worker(executor).handle(TASK, handler_for("completion"))
    outcomes: list[object] = []
    reconcile = worker._reconcile_rejected_completion

    def recording(task: Any, arbiter: Any) -> None:
        try:
            reconcile(task, arbiter)
        finally:
            outcomes.append(arbiter.outcome)

    worker._reconcile_rejected_completion = recording  # type: ignore[method-assign]
    run = Thread(target=worker.run_once)
    run.start()
    try:
        release_after_renewal_is_refused(worker, executor)
    finally:
        executor.release.set()
        run.join(10)

    assert not run.is_alive()
    # The completion is refused, and the attempt writes the boundary under its own fence.
    assert [transition for transition, _value in executor.settlements] == ["completed"]
    assert executor.expirations == [verdict]
    assert outcomes == [want_outcome]
    with worker._heartbeat_lock:
        assert worker._heartbeat_members == {}


@pytest.mark.asyncio
@pytest.mark.parametrize(("verdict", "want_outcome"), BOUNDARIES, ids=["deadline", "timeout"])
@pytest.mark.parametrize("fast", [False, True], ids=["full-tier", "fast-tier"])
async def test_async_worker_settles_a_boundary_due_during_the_final_write(
    verdict: str, want_outcome: str, fast: bool
) -> None:
    executor = HeldSettlement(fast=fast, verdict=verdict)
    worker = AsyncWorker(
        AsyncHeldSettlement(executor),  # type: ignore[arg-type]
        object(),
        "asyncpg",
        shared_heartbeats=True,
        queue="dispatch",
        worker_id="python-final-transition-async",
        concurrency=1,
        lease_ms=LEASE_MS,
        heartbeat_ms=HEARTBEAT_MS,
        registry_interval_ms=0,
    )
    core = scripted(worker._inner)
    outcomes: list[object] = []
    reconcile = core._reconcile_rejected_completion

    def recording(task: Any, arbiter: Any) -> None:
        try:
            reconcile(task, arbiter)
        finally:
            outcomes.append(arbiter.outcome)

    core._reconcile_rejected_completion = recording  # type: ignore[method-assign]
    handle = handler_for("completion")

    async def handle_async(payload: object, context: object) -> object:
        return handle(payload, context)

    worker.handle(TASK, handle_async)
    run = asyncio.create_task(worker.run_once())
    try:
        await asyncio.to_thread(release_after_renewal_is_refused, core, executor)
    finally:
        executor.release.set()
        await asyncio.wait_for(run, 10)

    assert [transition for transition, _value in executor.settlements] == ["completed"]
    assert executor.expirations == [verdict]
    assert outcomes == [want_outcome]
    with core._heartbeat_lock:
        assert core._heartbeat_members == {}


class Exit(BaseException):
    """A BaseException the worker must let through after it leaves supervision."""


def test_a_base_exception_from_the_handler_still_ends_supervision() -> None:
    executor = HeldSettlement(fast=False)

    def handle(_payload: object, _context: object) -> object:
        raise Exit

    worker = sync_worker(executor).handle(TASK, handle)
    with pytest.raises(Exit):
        worker.run_once()

    assert executor.settlements == []
    with worker._heartbeat_lock:
        assert worker._heartbeat_members == {}


# Under load, a round can pass its bound and renew nothing. A lease of four intervals still renews
# when some rounds fail, and a lease that stopped renewing at handler return still lapses during the
# delay.
INTEGRATION_LEASE_MS = 2_000
INTEGRATION_HEARTBEAT_MS = 500
FINAL_WRITES = (STATEMENTS.complete, STATEMENTS.fail, STATEMENTS.acknowledge_cancel)


class DelayedFinalWrite:
    """Send every statement to PostgreSQL, but hold the final write for two leases.

    While it waits, the test runs lease recovery. A lease that stopped renewing at handler return
    would lapse and hand the task to recovery before the completion arrives.
    """

    def __init__(self, inner: SyncExecutor, during_delay: Callable[[], None]) -> None:
        self._inner = inner
        self._during_delay = during_delay
        self.delayed = 0

    def rows(self, statement: DriverStatement, parameters: Sequence[object] = ()) -> list[Any]:
        if statement in FINAL_WRITES and self.delayed == 0:
            self.delayed += 1
            self._during_delay()
        return self._inner.rows(statement, parameters)


@pytest.mark.parametrize(
    ("cancel", "want_state"),
    [(False, "succeeded"), (True, "canceled")],
    ids=["completes-under-the-claimed-fence", "settles-a-cancellation-requested-meanwhile"],
)
def test_a_delayed_completion_keeps_the_claimed_lease(
    database_url: str, worker_pool: ConnectionPool, cancel: bool, want_state: str
) -> None:
    queue_name = "python-final-transition-lease"
    with psycopg.connect(database_url, autocommit=True) as operator:
        task_id = Queue(operator, default_queue=queue_name).enqueue(
            TASK, {}, EnqueueOptions(max_attempts=1)
        )
    claimed_fence: list[int] = []

    def during_delay() -> None:
        with psycopg.connect(database_url, autocommit=True) as operator:
            row = operator.execute(
                "SELECT fence_token FROM workhorse.task_runtime WHERE task_id = %s", (task_id,)
            ).fetchone()
            assert row is not None
            claimed_fence.append(int(row[0]))
            if cancel:
                assert Queue(operator).cancel(task_id).status == "cancel_requested"
            deadline = monotonic() + 2 * INTEGRATION_LEASE_MS / 1000
            while monotonic() < deadline:
                operator.execute("SELECT * FROM workhorse.recover_expired_telemetry_v1(100, 0)")
                sleep(INTEGRATION_LEASE_MS / 4000)

    def handle(_payload: object, _context: object) -> object:
        return {"settled": True}

    with psycopg.connect(database_url, autocommit=True) as connection:
        executor = DelayedFinalWrite(SyncExecutor(connection), during_delay)
        worker = Worker(
            worker_pool,
            queue=queue_name,
            worker_id="python-final-transition-lease",
            lease_ms=INTEGRATION_LEASE_MS,
            heartbeat_ms=INTEGRATION_HEARTBEAT_MS,
            registry_interval_ms=0,
            _executor=executor,  # type: ignore[arg-type]
        ).handle(TASK, handle)
        assert worker.run_once() is True

    assert executor.delayed == 1
    with psycopg.connect(database_url, autocommit=True) as observer:
        if cancel:
            # Cancellation refuses renewal, so recovery settles the requested cancellation.
            observer.execute("SELECT * FROM workhorse.recover_expired_telemetry_v1(100, 0)")
        outcome = observer.execute(
            "SELECT state, fence_token, current_attempt FROM workhorse.task_outcome "
            "WHERE task_id = %s",
            (task_id,),
        ).fetchone()
    assert outcome == (want_state, claimed_fence[0], 1)
