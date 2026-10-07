"""Fused fast-tier completion: task ID order and the deadlock retry, scripted and real."""

from __future__ import annotations

from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import replace
from datetime import UTC, datetime
from threading import Event
from typing import Any
from uuid import uuid4

import psycopg
import psycopg.errors
from psycopg_pool import ConnectionPool

from workhorse import Admin, AdminAudit, ClaimedTask, EnqueueOptions, Queue, Worker
from workhorse._drivers import SyncExecutor
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


# The tests above script the errors. The tests below make PostgreSQL itself abort the fused
# completion after it has deleted the runtime row and written the outcome, so they show the abort
# rolls those writes back and the resend settles the task once.


@contextmanager
def injected_deadlocks(database_url: str, queue_name: str, count: int) -> Iterator[list[int]]:
    """Fail the next ``count`` outcome inserts for ``queue_name`` with SQLSTATE 40P01.

    A sequence counts the failures because a sequence advance survives the rollback the failure
    causes. On exit the yielded list holds how many outcome inserts the trigger saw.
    """
    suffix = uuid4().hex
    sequence = f"public.injected_deadlock_{suffix}"
    function = f"public.inject_deadlock_{suffix}"
    trigger = f"inject_deadlock_{suffix}"
    seen: list[int] = []
    with psycopg.connect(database_url, autocommit=True) as connection:
        connection.execute(f"CREATE SEQUENCE {sequence}")
        connection.execute(
            f"""CREATE FUNCTION {function}() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
              IF nextval('{sequence}') <= {count} THEN
                RAISE EXCEPTION USING ERRCODE = '40P01', MESSAGE = 'deadlock detected (injected)';
              END IF;
              RETURN NEW;
            END;
            $$"""
        )
        connection.execute(
            f"CREATE TRIGGER {trigger} AFTER INSERT ON workhorse.fast_task_outcome "
            f"FOR EACH ROW WHEN (NEW.queue_name = '{queue_name}') EXECUTE FUNCTION {function}()"
        )
        try:
            yield seen
        finally:
            row = connection.execute(
                f"SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM {sequence}"
            ).fetchone()
            assert row is not None
            seen.append(int(row[0]))
            connection.execute(f"DROP TRIGGER {trigger} ON workhorse.fast_task_outcome")
            connection.execute(f"DROP FUNCTION {function}()")
            connection.execute(f"DROP SEQUENCE {sequence}")


def fast_queue(database_url: str, prefix: str) -> tuple[str, str]:
    """Enqueue one task on a new fast-tier queue that records attempts."""
    queue_name = f"{prefix}-{uuid4()}"
    audit = AdminAudit(
        actor="python-deadlock-test", reason="inject a deadlock", request_id=str(uuid4())
    )
    with psycopg.connect(database_url, autocommit=True) as connection:
        admin = Admin(connection)
        assert admin.set_queue_tier(queue_name, "fast", audit) == "fast"
        admin.set_queue_history(queue_name, record_attempts=True)
        task_id = Queue(connection).enqueue("settle", {}, EnqueueOptions(queue=queue_name))
    return queue_name, task_id


def claim_fast(database_url: str, queue_name: str, task_id: str) -> ClaimedTask:
    with psycopg.connect(database_url, autocommit=True) as connection:
        row = connection.execute(
            "SELECT task_id::text, fence_token FROM workhorse.complete_many_and_claim_v1("
            "'python-deadlock', '{}'::uuid[], '{}'::bigint[], '{}'::jsonb[], %s, 1, 30000)",
            (queue_name,),
        ).fetchone()
    assert row is not None and row[0] == task_id
    return replace(claimed(0), id=task_id, queue=queue_name, fence_token=int(row[1]))


def persisted(database_url: str, task_id: str) -> dict[str, list[tuple[object, ...]]]:
    with psycopg.connect(database_url, autocommit=True) as connection:
        return {
            "runtime": connection.execute(
                "SELECT state, fence_token FROM workhorse.fast_task_runtime WHERE task_id = %s",
                (task_id,),
            ).fetchall(),
            "outcomes": connection.execute(
                "SELECT state, attempt FROM workhorse.fast_task_outcome WHERE task_id = %s",
                (task_id,),
            ).fetchall(),
            "attempts": connection.execute(
                "SELECT attempt, outcome FROM workhorse.attempt_history WHERE task_id = %s",
                (task_id,),
            ).fetchall(),
        }


def connection_worker(connection: psycopg.Connection, queue_name: str) -> Worker:
    return Worker(
        object(),  # type: ignore[arg-type]
        queue=queue_name,
        worker_id="python-deadlock",
        registry_interval_ms=0,
        shared_heartbeats=True,
        _executor=SyncExecutor(connection),
    )


def test_a_worker_resends_a_completion_postgresql_aborted_and_settles_it_once(
    database_url: str, worker_pool: ConnectionPool
) -> None:
    queue_name, task_id = fast_queue(database_url, "python-deadlock-resend")
    runs: list[str] = []
    worker = Worker(worker_pool, queue=queue_name, worker_id="python-deadlock-worker")
    worker.handle("settle", lambda _payload, context: runs.append(context.task.id) or {"ok": True})
    with injected_deadlocks(database_url, queue_name, 2) as seen:
        assert worker.run_once()
    # Each insert the trigger saw is one statement PostgreSQL ran.
    assert seen == [3]
    assert runs == [task_id]
    assert persisted(database_url, task_id) == {
        "runtime": [],
        "outcomes": [("succeeded", 1)],
        "attempts": [(1, "succeeded")],
    }


def test_the_attempt_stays_active_after_the_last_resend_is_aborted(database_url: str) -> None:
    queue_name, task_id = fast_queue(database_url, "python-deadlock-exhausted")
    task = claim_fast(database_url, queue_name, task_id)
    with (
        psycopg.connect(database_url, autocommit=True) as connection,
        injected_deadlocks(database_url, queue_name, FENCED_WRITE_DEADLOCK_ATTEMPTS) as seen,
    ):
        pending = _PendingCompletion(task, '"ok"', 0, Event())
        connection_worker(connection, queue_name)._flush_completions(queue_name, [pending])
    assert seen == [FENCED_WRITE_DEADLOCK_ATTEMPTS]
    assert isinstance(pending.error, psycopg.errors.DeadlockDetected)
    assert persisted(database_url, task_id) == {
        "runtime": [("active", task.fence_token)],
        "outcomes": [],
        "attempts": [],
    }


def test_a_caller_owned_transaction_sees_the_deadlock_and_keeps_nothing(database_url: str) -> None:
    queue_name, task_id = fast_queue(database_url, "python-deadlock-caller")
    task = claim_fast(database_url, queue_name, task_id)
    with (
        psycopg.connect(database_url) as connection,
        injected_deadlocks(database_url, queue_name, 1) as seen,
    ):
        caller_task_id = Queue(connection).enqueue(
            "caller-write", {}, EnqueueOptions(queue=f"{queue_name}-full")
        )
        assert connection.execute(
            "SELECT 1 FROM workhorse.task WHERE id = %s", (caller_task_id,)
        ).fetchone()
        pending = _PendingCompletion(task, '"ok"', 0, Event())
        connection_worker(connection, queue_name)._flush_completions(queue_name, [pending])
        connection.rollback()
    # The abort dooms the caller's transaction, so the resend fails with 25P02 and the caller sees
    # the original deadlock instead.
    assert seen == [1]
    assert isinstance(pending.error, psycopg.errors.DeadlockDetected)
    with psycopg.connect(database_url, autocommit=True) as connection:
        assert Admin(connection).get_task(caller_task_id) is None
    assert persisted(database_url, task_id) == {
        "runtime": [("active", task.fence_token)],
        "outcomes": [],
        "attempts": [],
    }
