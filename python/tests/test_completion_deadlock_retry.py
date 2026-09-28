"""Fused fast-tier completion over a scripted executor: task ID order and the deadlock retry."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime
from threading import Event
from typing import Any

import psycopg.errors

from workhorse import ClaimedTask, Worker
from workhorse._fenced_write import FENCED_WRITE_DEADLOCK_ATTEMPTS
from workhorse._statements import STATEMENTS, DriverStatement
from workhorse.worker import _PendingCompletion


def claimed(sequence: int) -> ClaimedTask:
    return ClaimedTask(
        id=f"00000000-0000-0000-0000-{sequence:012d}",
        queue="fast",
        type="noop",
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
        fence_token=sequence,
        lease_expires_at=datetime.fromtimestamp(0, UTC),
    )


class ScriptedCompletions:
    """Answer complete_many_and_claim_v1 with the given failures first, then accept every task."""

    dialect = "psycopg"

    def __init__(self, failures: Sequence[Exception]) -> None:
        self._failures = list(failures)
        self.sent: list[list[object]] = []

    def rows(self, statement: DriverStatement, parameters: Sequence[object] = ()) -> list[Any]:
        assert statement is STATEMENTS.complete_many_and_claim
        task_ids = parameters[1]
        assert isinstance(task_ids, list)
        self.sent.append(list(task_ids))
        if len(self.sent) <= len(self._failures):
            raise self._failures[len(self.sent) - 1]
        return [{"accepted": task_ids, "task_id": None}]


def complete(executor: ScriptedCompletions, *sequences: int) -> list[_PendingCompletion]:
    worker = Worker(
        object(),  # type: ignore[arg-type]
        queue="fast",
        worker_id="python-completion",
        registry_interval_ms=0,
        shared_heartbeats=True,
        _executor=executor,
    )
    batch = [_PendingCompletion(claimed(sequence), '"ok"', 0, Event()) for sequence in sequences]
    worker._flush_completions("fast", batch)
    return batch


def deadlock() -> Exception:
    return psycopg.errors.DeadlockDetected("deadlock detected")


def test_sends_the_statement_again_after_postgresql_chooses_it_as_a_deadlock_victim() -> None:
    executor = ScriptedCompletions([deadlock()] * (FENCED_WRITE_DEADLOCK_ATTEMPTS - 1))
    batch = complete(executor, 3, 1, 2)

    assert len(executor.sent) == FENCED_WRITE_DEADLOCK_ATTEMPTS
    # Every attempt names the tasks in task ID order, as a heartbeat names its leases.
    assert all(sent == [claimed(n).id for n in (1, 2, 3)] for sent in executor.sent)
    assert all(p.done.is_set() and p.error is None and p.accepted for p in batch)


def test_fails_the_chunk_after_three_deadlocks() -> None:
    executor = ScriptedCompletions([deadlock()] * FENCED_WRITE_DEADLOCK_ATTEMPTS)
    batch = complete(executor, 1)

    assert FENCED_WRITE_DEADLOCK_ATTEMPTS == 3
    assert len(executor.sent) == 3
    error = batch[0].error
    assert isinstance(error, psycopg.errors.DeadlockDetected)
    assert not batch[0].accepted


def test_does_not_send_the_statement_again_after_another_error() -> None:
    failure = psycopg.errors.SerializationFailure("serialization failure")
    executor = ScriptedCompletions([failure])
    batch = complete(executor, 1)

    assert len(executor.sent) == 1
    assert batch[0].error is failure
