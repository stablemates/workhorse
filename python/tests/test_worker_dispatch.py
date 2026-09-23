"""Dispatch loop behavior over a scripted executor: batched slot refill and claim backoff."""

from __future__ import annotations

from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from threading import Event, Lock, Thread
from time import monotonic, sleep
from typing import Any

from workhorse import ClaimedTask, Worker
from workhorse._statements import STATEMENTS, DriverStatement

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


def scripted_worker(claims: ScriptedClaims, *, concurrency: int, poll_ms: int = 5_000) -> Worker:
    worker = Worker(
        object(),  # type: ignore[arg-type]
        queue="dispatch",
        worker_id="python-dispatch",
        concurrency=concurrency,
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
def running(worker: Worker, executions: Executions) -> Iterator[list[BaseException]]:
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
