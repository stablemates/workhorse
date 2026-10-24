"""The runtime defaults ``docs/parity.md`` publishes for a Python worker.

The document states one value per setting for the three SDKs. These tests assert what a worker
resolves when the caller configures nothing, so a published value cannot outlive its behaviour.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any, cast

import pytest

from workhorse import worker as worker_module
from workhorse.worker import ClaimedTask, Worker


class _Pool:
    """A pool the worker never draws a connection from. Resolving defaults reads options only."""

    max_size = 5


def _worker(**options: Any) -> Worker:
    return Worker(_Pool(), queue="defaults", worker_id="defaults-worker", **options)


def _task(attempt: int = 2) -> ClaimedTask:
    return ClaimedTask(
        id="task",
        queue="defaults",
        type="defaults.task",
        priority=0,
        payload=None,
        contract_version=None,
        result_max_bytes=0,
        redact_error_details=False,
        trace_context=None,
        attempt=attempt,
        max_attempts=3,
        retry_policy={},
        deadline_at=None,
        execution_timeout_ms=0,
        attempt_timeout_at=None,
        fence_token=1,
        lease_expires_at=None,
    )


def test_a_worker_resolves_the_published_defaults() -> None:
    worker = _worker()
    assert worker.concurrency == 1
    assert worker.lease_ms == 30_000
    assert worker.heartbeat_ms == 10_000
    assert worker.maintenance_interval_ms == 1_000
    assert worker.maintenance_routine_poll_ms == 60_000
    assert worker.registry_interval_ms == 5_000
    assert worker.schedule_catchup_limit == 100
    assert worker.retry_delay_ms is None


def test_a_worker_offers_maintenance_routines_on_their_own_cadence() -> None:
    # The tick runs every second to bound dispatch latency. ADR 0011 puts the slow retention
    # routines on a minute, because PostgreSQL owns the global due decision.
    worker = _worker()
    assert worker._due_for_maintenance_routines(100.0) is True
    assert worker._due_for_maintenance_routines(130.0) is False
    assert worker._due_for_maintenance_routines(161.0) is True


def test_a_worker_rejects_an_unusable_routine_interval() -> None:
    with pytest.raises(ValueError, match="maintenance_routine_poll_ms"):
        _worker(maintenance_routine_poll_ms=50)


_INTERVALS = ("maintenance_interval_ms", "maintenance_routine_poll_ms", "registry_interval_ms")


# SM-1668 PAR-09 (ADR 0112): register_worker_v1 takes each interval as a PostgreSQL integer, so
# every SDK accepts 100 through 2,147,483,647 ms and refuses other values at construction.
@pytest.mark.parametrize("option", _INTERVALS)
@pytest.mark.parametrize("value", [100, 2_147_483_647])
def test_a_worker_accepts_an_interval_from_100_through_the_sql_integer_limit(
    option: str, value: int
) -> None:
    assert getattr(_worker(**{option: value}), option) == value


@pytest.mark.parametrize("option", _INTERVALS)
@pytest.mark.parametrize("value", [99, 2_147_483_648, -1, 1.5, True, None])
def test_a_worker_refuses_an_interval_outside_the_range(option: str, value: object) -> None:
    with pytest.raises(ValueError, match=option):
        _worker(**{option: value})


def test_a_zero_registry_interval_turns_off_registration_and_other_zeros_are_refused() -> None:
    worker = _worker(registry_interval_ms=0)
    assert worker.registry_interval_ms == 0
    # The stand-in pool lends no connection, so a refresh that reached the registry would raise.
    worker._refresh_registration(force=True)
    worker._refresh_registration(force=True, draining=True)
    for option in ("maintenance_interval_ms", "maintenance_routine_poll_ms"):
        with pytest.raises(ValueError, match=option):
            _worker(**{option: 0})


def test_a_worker_without_the_option_sends_no_retry_delay() -> None:
    assert _worker()._retry_delay_override(_task()) is None


def test_a_worker_sends_the_retry_delay_it_was_given() -> None:
    assert _worker(retry_delay_ms=1_500)._retry_delay_override(_task()) == 1_500


def test_a_callable_retry_delay_reads_the_attempt() -> None:
    observed: list[int] = []

    def delay(attempt: int, _task: ClaimedTask) -> int | None:
        observed.append(attempt)
        return attempt * 1_000

    assert _worker(retry_delay_ms=delay)._retry_delay_override(_task(attempt=3)) == 3_000
    assert observed == [3]


def test_a_callable_retry_delay_may_decline() -> None:
    worker = _worker(retry_delay_ms=lambda _attempt, _task: None)
    assert worker._retry_delay_override(_task()) is None


def test_a_retry_delay_that_is_not_milliseconds_is_rejected() -> None:
    worker = _worker(retry_delay_ms=lambda _attempt, _task: -1)
    with pytest.raises(ValueError, match="retry_delay_ms"):
        worker._retry_delay_override(_task())


_LIMIT = 2_147_483_647


@pytest.mark.parametrize("delay", [_LIMIT, 0, 1])
def test_a_retry_delay_inside_the_sql_integer_range_is_sent(delay: int) -> None:
    assert _worker(retry_delay_ms=delay)._retry_delay_override(_task()) == delay
    callable_worker = _worker(retry_delay_ms=lambda _attempt, _task: delay)
    assert callable_worker._retry_delay_override(_task()) == delay


@pytest.mark.parametrize("delay", [_LIMIT + 1, -1, 1.5, 2.0, True])
def test_a_fixed_retry_delay_outside_the_range_is_refused_at_construction(delay: object) -> None:
    with pytest.raises(ValueError, match="retry_delay_ms must be an integer"):
        _worker(retry_delay_ms=delay)


@pytest.mark.parametrize("delay", [_LIMIT + 1, -1, 1.5, True])
def test_a_callable_retry_delay_outside_the_range_is_refused_before_fail(delay: object) -> None:
    worker = _worker(retry_delay_ms=lambda _attempt, _task: delay)
    with pytest.raises(ValueError, match="retry_delay_ms must return an integer"):
        worker._retry_delay_override(_task())


class _Listener:
    def __init__(self, listening: bool) -> None:
        self._listening = listening

    def is_listening(self) -> bool:
        return self._listening


def _wait_ms(worker: Worker, *, listening: bool, empty_claims: int, jitter: float) -> int:
    slots = SimpleNamespace(
        listener=_Listener(listening),
        consecutive_empty_claims=empty_claims,
        listened_at_last_wait=listening,
    )
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(worker_module.random, "uniform", lambda _low, _high: jitter)
        return round(worker._dispatch_wait_seconds(cast(Any, slots)) * 1000)


# SM-1668 PAR-09 (ADR 0112): with a live subscription, an explicit poll_ms is the fallback interval,
# so the 5,000 ms cap does not apply. Without one, the cap applies before the jitter. A worker that
# registers then cuts the wait to registry_interval_ms, because it refreshes from the dispatch loop.
def test_an_explicit_poll_is_capped_only_while_the_worker_polls() -> None:
    worker = _worker(poll_ms=30_000, registry_interval_ms=0)
    assert _wait_ms(worker, listening=True, empty_claims=4, jitter=0.9) == 27_000
    assert _wait_ms(worker, listening=True, empty_claims=4, jitter=1.1) == 33_000
    assert _wait_ms(worker, listening=False, empty_claims=4, jitter=0.9) == 4_500
    assert _wait_ms(worker, listening=False, empty_claims=4, jitter=1.1) == 5_500


def test_a_registered_worker_cuts_the_jittered_wait_to_the_registry_interval() -> None:
    worker = _worker(poll_ms=30_000, registry_interval_ms=5_000)
    assert _wait_ms(worker, listening=True, empty_claims=4, jitter=0.9) == 5_000
    assert _wait_ms(worker, listening=False, empty_claims=4, jitter=1.1) == 5_000
