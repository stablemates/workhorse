"""The heartbeat scheduler's busy retry (SM-1443), with a fake round instead of PostgreSQL.

A round can report a lease `busy`: another transaction held the task's row, so the round renewed
nothing and gave no ownership verdict. The scheduler then retries only the busy leases soon, and
keeps the regular schedule.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from itertools import pairwise
from threading import Lock
from time import monotonic, sleep

from eventual_conditions import eventually

from workhorse import CancellationToken
from workhorse._heartbeat_round import BUSY_RETRY_BASE_MS, busy_retry_delay_ms
from workhorse.worker import ClaimedTask, Worker

HEARTBEAT_MS = 200
INTERVAL = HEARTBEAT_MS / 1000
# The longest busy retry delay at this interval: 2 * min(100, 200 / 8) ms.
LONGEST_RETRY_DELAY = 2 * min(BUSY_RETRY_BASE_MS, HEARTBEAT_MS / 8) / 1000
# Scheduling slack for a loaded host.
SLACK = 0.08


class _Pool:
    """A pool the worker never draws a connection from. The fake round replaces every statement."""

    max_size = 5


def _task(task_id: str) -> ClaimedTask:
    return ClaimedTask(
        id=task_id,
        queue="busy-retry",
        type="busy.retry",
        priority=0,
        payload=None,
        contract_version=None,
        result_max_bytes=0,
        redact_error_details=False,
        trace_context=None,
        attempt=1,
        max_attempts=3,
        retry_policy={},
        deadline_at=None,
        execution_timeout_ms=0,
        attempt_timeout_at=None,
        fence_token=1,
        lease_expires_at=None,
    )


@dataclass
class Round:
    started_at: float
    task_ids: list[str]
    deadline: float


@dataclass
class Lease:
    """One registered lease and what the scheduler delivered to it."""

    task_id: str
    ends_at: float = field(default_factory=lambda: monotonic() + 60)
    statuses: list[object] = field(default_factory=list)
    renewals: list[float] = field(default_factory=list)
    unregister: Callable[[], None] = lambda: None

    def lease_ends_at(self) -> float:
        return self.ends_at


Respond = Callable[[int, list[str]], Mapping[str, str]]


class FakeRounds:
    """Replace the worker's heartbeat round. `respond` gives the statuses of each round in turn."""

    def __init__(self, worker: Worker, respond: Respond, round_seconds: float = 0.0) -> None:
        self.rounds: list[Round] = []
        self.in_flight = 0
        self.most_in_flight = 0
        self._lock = Lock()
        self._respond = respond
        self._round_seconds = round_seconds
        self._worker = worker
        worker._heartbeat_rows = self.heartbeat_rows  # type: ignore[method-assign]

    def heartbeat_rows(
        self, parameters: Sequence[object], deadline: float
    ) -> list[Mapping[str, object]]:
        task_ids = [lease["taskId"] for lease in json.loads(str(parameters[1]))]
        with self._lock:
            index = len(self.rounds)
            self.rounds.append(Round(monotonic(), task_ids, deadline))
            self.in_flight += 1
            self.most_in_flight = max(self.most_in_flight, self.in_flight)
        try:
            if self._round_seconds:
                sleep(self._round_seconds)
            statuses = self._respond(index, task_ids)
            return [{"task_id": task_id, "status": statuses[task_id]} for task_id in task_ids]
        finally:
            with self._lock:
                self.in_flight -= 1

    def snapshot(self) -> list[Round]:
        with self._lock:
            return list(self.rounds)


def _worker() -> Worker:
    return Worker(
        _Pool(),
        queue="busy-retry",
        worker_id="busy-retry-worker",
        lease_ms=60_000,
        heartbeat_ms=HEARTBEAT_MS,
        shared_heartbeats=True,
    )


def _register(worker: Worker, lease: Lease) -> Lease:
    def renew(sent_at: float) -> bool:
        lease.renewals.append(sent_at)
        return True

    lease.unregister = worker._register_heartbeat(
        _task(lease.task_id),
        lease.statuses.append,
        renew,
        lease.lease_ends_at,
        CancellationToken(),
        [],
    )
    return lease


def _stop(worker: Worker, *leases: Lease) -> None:
    for lease in leases:
        lease.unregister()
    thread = worker._heartbeat_thread
    if thread is not None:
        thread.join(5)
        assert not thread.is_alive()


def test_a_busy_retry_waits_base_times_one_plus_random() -> None:
    assert busy_retry_delay_ms(200, lambda: 0.0) == 25
    assert busy_retry_delay_ms(200, lambda: 0.5) == 37.5
    assert busy_retry_delay_ms(10_000, lambda: 0.0) == BUSY_RETRY_BASE_MS
    assert busy_retry_delay_ms(10_000, lambda: 0.999) < 2 * BUSY_RETRY_BASE_MS
    assert busy_retry_delay_ms(80, lambda: 0.0) == 10


def test_a_busy_lease_is_retried_alone_before_the_next_regular_round() -> None:
    worker = _worker()

    def respond(index: int, task_ids: list[str]) -> Mapping[str, str]:
        # The first round finds the row of `held` locked.
        return {
            task_id: "busy" if index == 0 and task_id == "held" else "accepted"
            for task_id in task_ids
        }

    rounds = FakeRounds(worker, respond)
    held = _register(worker, Lease("held"))
    free = _register(worker, Lease("free"))
    try:
        eventually(lambda: len(rounds.snapshot()) >= 2, "no busy retry ran")
        first, retry = rounds.snapshot()[:2]
    finally:
        _stop(worker, held, free)

    assert sorted(first.task_ids) == ["free", "held"]
    assert retry.task_ids == ["held"]
    assert retry.started_at - first.started_at < LONGEST_RETRY_DELAY + SLACK
    # Busy is no verdict: it renewed nothing, and the attempt never heard of it.
    assert held.statuses[0] == "accepted"
    assert held.renewals and held.renewals[0] > first.started_at
    assert "busy" not in held.statuses
    assert free.statuses[0] == "accepted"


def test_retries_do_not_move_the_regular_slots_and_one_round_runs_at_a_time() -> None:
    worker = _worker()

    def respond(_index: int, task_ids: list[str]) -> Mapping[str, str]:
        return {task_id: "busy" if task_id == "held" else "accepted" for task_id in task_ids}

    # Each round takes 10 ms, so overlapping rounds would show in `most_in_flight`.
    rounds = FakeRounds(worker, respond, round_seconds=0.01)
    held = _register(worker, Lease("held"))
    free = _register(worker, Lease("free"))
    try:
        eventually(
            lambda: sum(len(r.task_ids) == 2 for r in rounds.snapshot()) >= 4,
            "four regular rounds never ran",
        )
    finally:
        _stop(worker, held, free)

    recorded = rounds.snapshot()
    regular = [r.started_at for r in recorded if len(r.task_ids) == 2]
    retries = [r for r in recorded if len(r.task_ids) == 1]
    assert all(r.task_ids == ["held"] for r in retries)
    # Several retries run between two regular slots.
    assert len(retries) >= 2 * (len(regular) - 1)
    for earlier, later in pairwise(regular):
        assert INTERVAL - 0.01 <= later - earlier < INTERVAL + SLACK
    # A retry ends by the next regular slot.
    for retry in retries:
        assert all(retry.deadline <= slot + 0.001 for slot in regular if slot > retry.started_at)
    assert rounds.most_in_flight == 1
    assert held.renewals == []
    assert held.statuses == []


def test_a_retry_ends_by_the_earliest_local_lease_window() -> None:
    worker = _worker()
    held = Lease("held")

    def respond(index: int, task_ids: list[str]) -> Mapping[str, str]:
        if index == 0:
            # The local window ends before the next regular slot and after the retry starts.
            held.ends_at = monotonic() + LONGEST_RETRY_DELAY + 0.03
        return dict.fromkeys(task_ids, "busy" if index == 0 else "accepted")

    rounds = FakeRounds(worker, respond)
    _register(worker, held)
    try:
        eventually(lambda: len(rounds.snapshot()) >= 2, "no busy retry ran")
        retry = rounds.snapshot()[1]
    finally:
        _stop(worker, held)

    assert retry.task_ids == ["held"]
    assert retry.deadline == held.ends_at


def test_a_lease_whose_window_ended_waits_for_the_regular_round() -> None:
    worker = _worker()
    held = Lease("held")

    def respond(index: int, task_ids: list[str]) -> Mapping[str, str]:
        if index == 0:
            # The local window ends before the retry falls due.
            held.ends_at = monotonic()
        return dict.fromkeys(task_ids, "busy" if index == 0 else "accepted")

    rounds = FakeRounds(worker, respond)
    _register(worker, held)
    try:
        eventually(lambda: len(rounds.snapshot()) >= 2, "no second round ran")
        first, second = rounds.snapshot()[:2]
    finally:
        _stop(worker, held)

    # No early round ran. The second round is the regular one.
    assert second.started_at - first.started_at >= INTERVAL - 0.01


def test_a_failed_retry_schedules_no_other_retry() -> None:
    worker = _worker()

    def respond(index: int, task_ids: list[str]) -> Mapping[str, str]:
        if index == 1:
            raise RuntimeError("retry round failed")
        return dict.fromkeys(task_ids, "busy" if index == 0 else "accepted")

    rounds = FakeRounds(worker, respond)
    held = _register(worker, Lease("held"))
    try:
        eventually(lambda: len(rounds.snapshot()) >= 3, "the regular round never ran")
        first, retry, regular = rounds.snapshot()[:3]
    finally:
        _stop(worker, held)

    assert retry.started_at - first.started_at < LONGEST_RETRY_DELAY + SLACK
    # The round after the failed retry is the next regular round.
    assert regular.started_at - first.started_at >= INTERVAL - 0.01
    assert held.statuses[0] == "accepted"


def test_a_result_for_a_lease_that_was_replaced_or_left_is_ignored() -> None:
    worker = _worker()
    replaced = Lease("replaced")
    left = Lease("left")
    replacement = Lease("replaced")
    swapped: list[bool] = []

    def respond(index: int, task_ids: list[str]) -> Mapping[str, str]:
        if index == 0:
            # While the round runs, one attempt leaves and a new attempt of the other task arrives.
            left.unregister()
            _register(worker, replacement)
            swapped.append(True)
            return {"replaced": "busy", "left": "accepted"}
        return dict.fromkeys(task_ids, "accepted")

    rounds = FakeRounds(worker, respond)
    _register(worker, replaced)
    _register(worker, left)
    try:
        eventually(lambda: len(rounds.snapshot()) >= 2, "no second round ran")
        first, second = rounds.snapshot()[:2]
        eventually(lambda: replacement.statuses != [], "the replacement got no result")
    finally:
        _stop(worker, replacement, replaced)

    assert swapped == [True]
    assert replaced.statuses == [] and replaced.renewals == []
    assert left.statuses == [] and left.renewals == []
    # The busy result belonged to the replaced lease, so no retry ran. The regular round renews the
    # replacement.
    assert second.started_at - first.started_at >= INTERVAL - 0.01
    assert second.task_ids == ["replaced"]
    assert replacement.statuses == ["accepted"]
