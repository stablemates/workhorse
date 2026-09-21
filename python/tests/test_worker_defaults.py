"""The runtime defaults ``docs/parity.md`` publishes for a Python worker.

The document states one value per setting for the three SDKs. These tests assert what a worker
resolves when the caller configures nothing, so a published value cannot outlive its behaviour.
"""

from __future__ import annotations

from typing import Any

import pytest

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
