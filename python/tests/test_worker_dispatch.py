"""Dispatch loop behavior over a scripted executor: slot refill, cohorts, and claim backoff."""

from __future__ import annotations

from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from threading import Event, Lock, Thread
from time import monotonic, sleep
from typing import Any

import pytest

from workhorse import ClaimedTask, Worker
from workhorse._statements import STATEMENTS, DriverStatement
from workhorse.worker import _dispatch_cohorts

HANDLED = "dispatch.handled"
UNHANDLED = "dispatch.unhandled"


def task_row(sequence: int, task_type: str) -> dict[str, object]:
    return {
        "task_id": f"00000000-0000-0000-0000-{sequence:012d}",
        "task_type": task_type,
        "priority": 0,
        "payload": {"sequence": sequence},
        "contract_version": None,
        "result_max_bytes": 1_048_576,
        "redact_error_details": False,
        "trace_context": None,
        "attempt": 1,
        "max_attempts": 3,
        "retry_policy": None,
        "deadline_at": None,
        "execution_timeout_ms": None,
        "attempt_timeout_at": None,
        "fence_token": 1,
        "lease_expires_at": None,
    }


class FullTierRejection(Exception):
    """The error a full-tier queue raises for a fast claim, as a driver reports it."""

    sqlstate = "P1007"
    detail = '{"queue": "default", "feature": "batched completion"}'


class ScriptedClaims:
    """Answer claim_many from a backlog, record each limit, and optionally hold claims open."""

    def __init__(self, rows: Sequence[dict[str, object]] = ()) -> None:
        self._lock = Lock()
        self._backlog = list(rows)
        self._held: list[Event] = []
        self.limits: list[int] = []
        self.claimed_at: list[float] = []
        self.in_flight = 0
        self.maximum_in_flight = 0
        self.holding = False

    def rows(self, statement: DriverStatement, parameters: Sequence[object] = ()) -> list[Any]:
        if statement is STATEMENTS.complete_many_and_claim:
            raise FullTierRejection
        if statement is not STATEMENTS.claim_many:
            return []
        release = Event()
        limit = parameters[2]
        assert isinstance(limit, int)
        with self._lock:
            self.limits.append(limit)
            self.claimed_at.append(monotonic())
            self.in_flight += 1
            self.maximum_in_flight = max(self.maximum_in_flight, self.in_flight)
            if self.holding:
                self._held.append(release)
            else:
                release.set()
        try:
            assert release.wait(timeout=5), "held claim was never released"
            with self._lock:
                claimed, self._backlog = self._backlog[:limit], self._backlog[limit:]
            return claimed
        finally:
            with self._lock:
                self.in_flight -= 1

    def give_back(self, row: dict[str, object]) -> None:
        with self._lock:
            self._backlog.append(row)

    def release_held(self) -> None:
        with self._lock:
            self.holding = False
            held, self._held = self._held, []
        for release in held:
            release.set()

    def claims(self) -> int:
        with self._lock:
            return len(self.limits)


class Executions:
    """Stand in for task execution: each handled task blocks until finished in start order."""

    def __init__(self, claims: ScriptedClaims) -> None:
        self._claims = claims
        self._lock = Lock()
        self._waiting: list[Event] = []
        self.open = False
        self.started: list[str] = []
        self.released: list[str] = []

    def execute(self, task: ClaimedTask, _claim_sent_at: float) -> None:
        if task.type != HANDLED:
            # The worker releases a task it has no handler for, and the task returns to its queue.
            with self._lock:
                self.released.append(task.id)
            self._claims.give_back(task_row(len(self.released), task.type))
            return
        finished = Event()
        with self._lock:
            self.started.append(task.id)
            if self.open:
                return
            self._waiting.append(finished)
        assert finished.wait(timeout=5)

    def finish_first(self) -> None:
        with self._lock:
            finished = self._waiting.pop(0)
        finished.set()

    def open_all(self) -> None:
        with self._lock:
            self.open = True
            waiting, self._waiting = self._waiting, []
        for finished in waiting:
            finished.set()

    def running(self) -> int:
        with self._lock:
            return len(self._waiting)


class FastClaims:
    """Answer complete_many_and_claim from a backlog as a fast-tier queue does.

    Each call records its completion count and claim limit, and calls can be held open. With
    full_tier set, the queue rejects the batched statement and answers claim_many and complete.
    """

    def __init__(self, rows: Sequence[dict[str, object]] = ()) -> None:
        self._lock = Lock()
        self._backlog = list(rows)
        self._held: list[Event] = []
        self.calls: list[tuple[int, int]] = []
        self.plain_claims: list[int] = []
        self.single_completions: list[str] = []
        self.in_flight = 0
        self.maximum_in_flight = 0
        self.holding = False
        self.full_tier = False

    def rows(self, statement: DriverStatement, parameters: Sequence[object] = ()) -> list[Any]:
        if statement is STATEMENTS.complete:
            with self._lock:
                self.single_completions.append(str(parameters[0]))
            return [{"accepted": True}]
        if statement is STATEMENTS.claim_many:
            limit = parameters[2]
            assert isinstance(limit, int)
            with self._lock:
                self.plain_claims.append(limit)
                claimed, self._backlog = self._backlog[:limit], self._backlog[limit:]
            return claimed
        if statement is not STATEMENTS.complete_many_and_claim:
            return []
        if self.full_tier:
            raise FullTierRejection
        task_ids, limit = parameters[1], parameters[5]
        assert isinstance(task_ids, list)
        assert isinstance(limit, int)
        release = Event()
        with self._lock:
            self.calls.append((len(task_ids), limit))
            self.in_flight += 1
            self.maximum_in_flight = max(self.maximum_in_flight, self.in_flight)
            if self.holding:
                self._held.append(release)
            else:
                release.set()
        try:
            assert release.wait(timeout=5), "held statement was never released"
            with self._lock:
                claimed, self._backlog = self._backlog[:limit], self._backlog[limit:]
        finally:
            with self._lock:
                self.in_flight -= 1
        # Only the first row carries the accepted completions, and a statement that claims
        # nothing still returns it.
        rows: list[dict[str, object]] = [dict(row) for row in claimed] or [
            dict.fromkeys(task_row(0, HANDLED))
        ]
        rows[0]["accepted"] = list(task_ids)
        return rows

    def release_held(self) -> None:
        with self._lock:
            self.holding = False
            held, self._held = self._held, []
        for release in held:
            release.set()

    def claim_limits(self) -> list[int]:
        with self._lock:
            return [limit for completions, limit in self.calls if completions == 0]

    def fused(self) -> list[tuple[int, int]]:
        with self._lock:
            return [call for call in self.calls if call[0] > 0]


class FastExecutions:
    """Stand in for fast-tier handlers: each task blocks until finished, then completes batched."""

    def __init__(self, worker: Worker) -> None:
        self._worker = worker
        self._lock = Lock()
        self._waiting: dict[str, Event] = {}
        self.open = False
        self.started: list[str] = []
        self.accepted: list[str] = []
        self.running_now = 0
        self.maximum_running = 0

    def execute(self, task: ClaimedTask, _claim_sent_at: float) -> None:
        finished = Event()
        with self._lock:
            self.started.append(task.id)
            self.running_now += 1
            self.maximum_running = max(self.maximum_running, self.running_now)
            if self.open:
                finished.set()
            else:
                self._waiting[task.id] = finished
        assert finished.wait(timeout=5)
        with self._lock:
            self.running_now -= 1
        worker = self._worker
        with worker._state_lock:
            fast_tier = task.id in worker._fast_task_ids
            worker._fast_task_ids.discard(task.id)
        assert fast_tier
        if worker._complete_fast_task(task, '"ok"'):
            with self._lock:
                self.accepted.append(task.id)

    def finish(self, task_id: str) -> None:
        with self._lock:
            finished = self._waiting.pop(task_id)
        finished.set()

    def open_all(self) -> None:
        with self._lock:
            self.open = True
            waiting, self._waiting = list(self._waiting.values()), {}
        for finished in waiting:
            finished.set()

    def running(self) -> int:
        with self._lock:
            return len(self._waiting)


def scripted_worker(
    claims: ScriptedClaims | FastClaims,
    *,
    concurrency: int,
    poll_ms: int = 5_000,
    cohorts: int | None = None,
) -> Worker:
    worker = Worker(
        object(),  # type: ignore[arg-type]
        queue="dispatch",
        worker_id="python-dispatch",
        concurrency=concurrency,
        cohorts=cohorts,
        poll_ms=poll_ms,
        registry_interval_ms=0,
        shared_heartbeats=True,
        _executor=claims,
    )
    worker._compatibility.assert_compatible = lambda: None  # type: ignore[method-assign]
    # No listener, so the empty-claim wait follows the poll interval.
    worker._notification_connection_factory = None  # type: ignore[assignment]
    return worker.handle(HANDLED, lambda _payload, _context: None)


@contextmanager
def running(
    worker: Worker, executions: Executions | FastExecutions
) -> Iterator[list[BaseException]]:
    worker._execute_claimed_task = executions.execute  # type: ignore[method-assign]
    errors: list[BaseException] = []

    def run() -> None:
        try:
            worker.run()
        except BaseException as error:
            errors.append(error)

    thread = Thread(target=run)
    thread.start()
    try:
        yield errors
    finally:
        executions.open_all()
        worker.stop()
        thread.join(timeout=5)
        assert not thread.is_alive()


def wait_for(condition: Callable[[], bool], message: str) -> None:
    deadline = monotonic() + 5
    while not condition():
        assert monotonic() < deadline, message
        sleep(0.002)


def test_busy_worker_refills_slots_with_overlapping_batched_claims() -> None:
    claims = ScriptedClaims([task_row(sequence, HANDLED) for sequence in range(24)])
    executions = Executions(claims)
    worker = scripted_worker(claims, concurrency=8)
    with running(worker, executions) as errors:
        wait_for(lambda: executions.running() == 8, "the worker did not fill its slots")
        claims.holding = True
        executions.finish_first()
        wait_for(lambda: claims.claims() == 2, "one free slot did not start a claim")
        executions.finish_first()
        # One more free slot is below the refill batch of two while the first refill is held.
        sleep(0.05)
        assert claims.claims() == 2
        executions.finish_first()
        wait_for(lambda: claims.claims() == 3, "the refill batch did not start a claim")
        assert claims.limits == [8, 1, 2]
        assert claims.maximum_in_flight == 2

        claims.release_held()
        executions.open_all()
        wait_for(lambda: len(executions.started) == 24, "the worker did not run every task")
    assert errors == []


def test_stop_launches_the_tasks_an_in_flight_claim_returns() -> None:
    claims = ScriptedClaims([task_row(sequence, HANDLED) for sequence in range(4)])
    executions = Executions(claims)
    worker = scripted_worker(claims, concurrency=2)
    with running(worker, executions) as errors:
        wait_for(lambda: executions.running() == 2, "the worker did not fill its slots")
        claims.holding = True
        executions.finish_first()
        wait_for(lambda: claims.claims() == 2, "the free slot did not start a claim")
        worker.stop()
        sleep(0.02)
        assert len(executions.started) == 2
        claims.release_held()
        wait_for(lambda: len(executions.started) == 3, "the held claim's task did not run")
        executions.open_all()
    assert errors == []
    # The stop started no claim after the held one.
    assert claims.limits == [2, 1]


def test_paused_worker_starts_no_claim() -> None:
    claims = ScriptedClaims([task_row(0, HANDLED)])
    executions = Executions(claims)
    worker = scripted_worker(claims, concurrency=2, poll_ms=10)
    worker.pause()
    with running(worker, executions) as errors:
        sleep(0.1)
        assert claims.claims() == 0
        worker.resume()
        wait_for(lambda: len(executions.started) == 1, "a resumed worker did not claim")
    assert errors == []


def test_empty_claim_waits_for_the_poll_interval() -> None:
    claims = ScriptedClaims()
    executions = Executions(claims)
    worker = scripted_worker(claims, concurrency=4, poll_ms=200)
    with running(worker, executions) as errors:
        wait_for(lambda: claims.claims() == 2, "the worker did not poll again")
    assert errors == []
    # The poll interval carries up to ten percent jitter either way.
    assert claims.claimed_at[1] - claims.claimed_at[0] >= 0.18


def test_claim_of_only_unhandled_tasks_backs_off_like_an_empty_claim() -> None:
    claims = ScriptedClaims([task_row(0, UNHANDLED)])
    executions = Executions(claims)
    worker = scripted_worker(claims, concurrency=4, poll_ms=300)
    with running(worker, executions) as errors:
        wait_for(lambda: len(executions.released) == 1, "the worker did not release the task")
        # The released task is claimable again at once, but the worker waits out the interval.
        sleep(0.15)
        assert claims.claims() == 1
        assert len(executions.released) == 1
    assert errors == []


def handled_rows(count: int) -> list[dict[str, object]]:
    return [task_row(sequence, HANDLED) for sequence in range(count)]


def test_default_cohorts_follow_concurrency_and_spare_connections() -> None:
    assert [_dispatch_cohorts(c) for c in (1, 7, 8, 16, 17, 64, 65, 200)] == [
        1,
        1,
        2,
        2,
        3,
        8,
        8,
        8,
    ]
    assert _dispatch_cohorts(64, spare_connections=3) == 3
    assert _dispatch_cohorts(64, spare_connections=0) == 1

    class SizedPool:
        max_size = 5

    # The listener and the heartbeat connection leave three pooled connections for cohorts.
    capped = Worker(SizedPool(), queue="dispatch", concurrency=64)  # type: ignore[arg-type]
    assert capped.cohorts == 3
    explicit = Worker(SizedPool(), queue="dispatch", concurrency=64, cohorts=6)  # type: ignore[arg-type]
    assert explicit.cohorts == 6
    for invalid in (0, 65, True):
        with pytest.raises(ValueError, match="cohorts must be an integer"):
            Worker(
                object(), queue="dispatch", concurrency=64, cohorts=invalid, shared_heartbeats=True
            )  # type: ignore[arg-type]


def test_cohort_shares_give_the_remainder_to_the_first_cohorts() -> None:
    claims = FastClaims()
    worker = scripted_worker(claims, concurrency=10, cohorts=3)
    executions = FastExecutions(worker)
    with running(worker, executions) as errors:
        wait_for(lambda: worker._dispatch_slots is not None, "the worker did not start")
        slots = worker._dispatch_slots
        assert slots is not None
        assert slots.cohort_capacity == [4, 3, 3]
    assert errors == []


def test_fused_claims_stay_within_their_cohort() -> None:
    claims = FastClaims(handled_rows(30))
    worker = scripted_worker(claims, concurrency=8, cohorts=2)
    executions = FastExecutions(worker)
    with running(worker, executions) as errors:
        wait_for(lambda: executions.running() == 8, "the worker did not fill its slots")
        # A claim before the tier is known reserves every free slot but asks for one cohort's.
        assert claims.claim_limits() == [4, 4]
        claims.holding = True
        first_cohort, second_cohort = executions.started[0], executions.started[4]
        executions.finish(first_cohort)
        wait_for(lambda: len(claims.fused()) == 1, "the completion did not send a statement")
        executions.finish(second_cohort)
        wait_for(lambda: len(claims.fused()) == 2, "the second cohort waited on the first")
        # Each full cohort refills only the slot its task leaves.
        assert claims.fused() == [(1, 1), (1, 1)]
        assert claims.maximum_in_flight == 2

        claims.release_held()
        executions.open_all()
        wait_for(lambda: len(executions.accepted) == 30, "the worker did not complete every task")
    assert errors == []
    assert sorted(executions.accepted) == sorted(str(row["task_id"]) for row in handled_rows(30))
    assert executions.maximum_running <= 8
    assert all(limit <= 4 for _completions, limit in claims.calls)
    assert claims.plain_claims == []


def test_queue_that_leaves_the_fast_tier_completes_through_complete() -> None:
    claims = FastClaims(handled_rows(2))
    worker = scripted_worker(claims, concurrency=2)
    executions = FastExecutions(worker)
    with running(worker, executions) as errors:
        wait_for(lambda: executions.running() == 2, "the worker did not fill its slots")
        claims.full_tier = True
        executions.open_all()
        wait_for(lambda: len(executions.accepted) == 2, "the fallback did not complete the tasks")
        assert sorted(claims.single_completions) == sorted(executions.accepted)
        # The worker claims the full-tier queue through claim_many from then on.
        wait_for(
            lambda: len(claims.plain_claims) >= 1, "the worker did not claim through claim_many"
        )
    assert errors == []


def test_paused_worker_completes_without_a_fused_claim() -> None:
    claims = FastClaims(handled_rows(4))
    worker = scripted_worker(claims, concurrency=2)
    executions = FastExecutions(worker)
    with running(worker, executions) as errors:
        wait_for(lambda: executions.running() == 2, "the worker did not fill its slots")
        worker.pause()
        executions.finish(executions.started[0])
        wait_for(lambda: len(executions.accepted) == 1, "the paused worker did not complete")
        assert claims.fused() == [(1, 0)]
        sleep(0.05)
        assert len(executions.started) == 2
        worker.resume()
        wait_for(lambda: len(executions.started) == 3, "a resumed worker did not claim")
    assert errors == []


def test_stop_runs_the_tasks_an_in_flight_fused_claim_returns() -> None:
    claims = FastClaims(handled_rows(4))
    worker = scripted_worker(claims, concurrency=2)
    executions = FastExecutions(worker)
    with running(worker, executions) as errors:
        wait_for(lambda: executions.running() == 2, "the worker did not fill its slots")
        claims.holding = True
        executions.finish(executions.started[0])
        wait_for(lambda: len(claims.fused()) == 1, "the completion did not send a statement")
        worker.stop()
        claims.release_held()
        wait_for(lambda: len(executions.started) == 3, "the fused claim's task did not run")
        executions.open_all()
        wait_for(lambda: len(executions.accepted) == 3, "the drain did not complete the tasks")
    assert errors == []
    # The stop started no claim after the held one, so later completions claim nothing.
    fused = claims.fused()
    assert fused[0] == (1, 1)
    assert all(limit == 0 for _completions, limit in fused[1:])
    assert sum(completions for completions, _limit in fused) == 3
    assert claims.claim_limits() == [2]
