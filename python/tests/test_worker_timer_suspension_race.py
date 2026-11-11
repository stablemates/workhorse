"""SM-1929: a scheduled timer wait stops the handler whatever outcome won while it was in flight."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any

import pytest

from workhorse import CancellationToken, ClaimedTask, DeadlineExceededError, StaleLeaseError
from workhorse._statements import STATEMENTS, DriverStatement
from workhorse.worker import _AttemptOutcomeArbiter, _DurableWaitSuspension, _HandlerDurability

TASK = ClaimedTask(
    id="00000000-0000-0000-0000-000000001929",
    queue="timers",
    type="cooling-off",
    priority=0,
    payload=None,
    contract_version=None,
    result_max_bytes=1_048_576,
    redact_error_details=False,
    trace_context=None,
    attempt=1,
    max_attempts=1,
    retry_policy=None,
    deadline_at=None,
    execution_timeout_ms=None,
    attempt_timeout_at=None,
    fence_token=7,
    lease_expires_at=datetime.fromtimestamp(0, UTC),
)


class ScheduledAfterAnotherOutcome:
    """Answer schedule_wait_v1 with `scheduled` after another outcome won during the request.

    The heartbeat thread, the expiry watch, and the lease watchdog end an attempt the same way:
    they submit the outcome to the arbiter and cancel the handler.
    """

    dialect = "psycopg"

    def __init__(
        self,
        arbiter: _AttemptOutcomeArbiter,
        cancellation: CancellationToken,
        outcome: Any,
        reason: BaseException,
    ) -> None:
        self.arbiter = arbiter
        self.cancellation = cancellation
        self.outcome = outcome
        self.reason = reason

    def rows(self, statement: DriverStatement, parameters: Sequence[object] = ()) -> list[Any]:
        assert statement is STATEMENTS.schedule_wait
        assert self.arbiter.submit(self.outcome)
        self.cancellation._cancel(self.reason)
        return [
            {
                "status": "scheduled",
                "wait_name": parameters[3],
                "mode": "relative",
                "duration_ms": parameters[4],
                "requested_wake_at": None,
                "wake_at": datetime.now(UTC),
                "attempt": TASK.attempt,
                "fence_token": TASK.fence_token,
                "worker_id": parameters[1],
                "created_at": datetime.now(UTC),
            }
        ]


@pytest.mark.parametrize(
    ("winner", "outcome", "reason"),
    [
        # A stale heartbeat, a stale expiry answer, and the lease watchdog all submit lease_expired
        # and cancel with StaleLeaseError.
        ("a lost lease", "lease_expired", StaleLeaseError(TASK.id)),
        ("a confirmed deadline", "deadline_exceeded", DeadlineExceededError(TASK.id)),
    ],
)
def test_a_scheduled_wait_suspends_after_another_outcome_won(
    winner: str, outcome: str, reason: BaseException
) -> None:
    arbiter = _AttemptOutcomeArbiter()
    cancellation = CancellationToken()
    durability = _HandlerDurability(
        ScheduledAfterAnotherOutcome(arbiter, cancellation, outcome, reason),
        TASK,
        "python-timer-race",
        cancellation,
        arbiter,
    )
    ran_after_sleep = False

    def handler() -> None:
        nonlocal ran_after_sleep
        durability.context().sleep("cooling-off", 60_000)
        ran_after_sleep = True

    with pytest.raises(_DurableWaitSuspension):
        handler()
    assert not ran_after_sleep, f"the code after the sleep ran after {winner}"
    # The suspension does not replace the outcome that won first, nor its cancellation reason.
    assert arbiter.outcome == outcome
    assert cancellation.reason is reason
