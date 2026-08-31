from __future__ import annotations

from contextlib import suppress
from datetime import UTC, datetime, timedelta
from threading import Event, Thread
from time import monotonic, sleep
from typing import Any

import psycopg
import pytest

import workhorse.worker as worker_module
from workhorse import (
    CancellationRequestedError,
    CheckpointConflictError,
    CheckpointLeaseLostError,
    DeadlineExceededError,
    EnqueueOptions,
    ExecutionTimeoutError,
    HandlerContext,
    JobContractValidationError,
    JobContractVersion,
    JobTypeContracts,
    ProgressLeaseLostError,
    ProgressRateLimitError,
    Queue,
    StaleLeaseError,
    WaitConflictError,
    Worker,
)


def test_contract_sync_validates_payload_and_worker_result(database_url: str) -> None:
    contracts = {
        "contract.python": JobTypeContracts(
            current_version="current",
            versions={
                "current": JobContractVersion(
                    payload_schema={
                        "type": "object",
                        "required": ["name"],
                        "properties": {"name": {"type": "string"}},
                    },
                    result_schema={
                        "type": "object",
                        "required": ["ok"],
                        "properties": {"ok": {"const": True}},
                    },
                )
            },
        )
    }
    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
    ):
        queue = Queue(enqueue_connection)
        queue.sync_contracts(contracts)
        with pytest.raises(JobContractValidationError):
            queue.enqueue("contract.python", {"name": 42})
        job_id = queue.enqueue(
            "contract.python",
            {"name": "accepted"},
            EnqueueOptions(max_attempts=1),
        )
        enqueue_connection.commit()

        worker = Worker(worker_connection, worker_id="python-contract-worker").handle(
            "contract.python", lambda _payload, _context: {"ok": False}
        )
        assert worker.run_once() is True
        outcome = worker_connection.execute(
            "SELECT state FROM workhorse.job_outcome WHERE job_id = %s", (job_id,)
        ).fetchone()
        assert outcome == ("failed",)


def test_worker_participates_in_slow_maintenance(database_url: str) -> None:
    with psycopg.connect(database_url, autocommit=True) as connection:
        connection.execute(
            "UPDATE workhorse.maintenance_state SET last_completed_at = NULL "
            "WHERE task_name = 'terminal_storage'"
        )
        worker = Worker(connection, worker_id="python-slow-maintenance-worker")

        assert worker.run_once() is False
        completed_at = connection.execute(
            "SELECT last_completed_at FROM workhorse.maintenance_state "
            "WHERE task_name = 'terminal_storage'"
        ).fetchone()
        assert completed_at is not None
        assert completed_at[0] is not None


def test_checkpoint_replays_the_saved_value_without_repeating_the_operation(
    database_url: str,
) -> None:
    operation_calls = 0
    handler_calls = 0

    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
    ):
        job_id = Queue(enqueue_connection).enqueue(
            "checkpoint.replay",
            {},
            EnqueueOptions(max_attempts=2, retry_policy={"type": "fixed", "delayMs": 1}),
        )
        enqueue_connection.commit()

        def handle(_payload: object, context: HandlerContext) -> dict[str, object]:
            nonlocal handler_calls, operation_calls
            handler_calls += 1

            def prepare() -> dict[str, int]:
                nonlocal operation_calls
                operation_calls += 1
                return {"prepared": operation_calls}

            prepared = context.checkpoint("prepare", prepare)
            if handler_calls == 1:
                raise RuntimeError("retry after the durable boundary")
            return {"prepared": prepared}

        worker = Worker(worker_connection, worker_id="python-checkpoint-worker").handle(
            "checkpoint.replay", handle
        )

        assert worker.run_once() is True

        outcome = worker_connection.execute(
            "SELECT state, current_attempt, result FROM workhorse.job_outcome WHERE job_id = %s",
            (job_id,),
        ).fetchone()
        assert outcome == ("succeeded", 2, {"prepared": {"prepared": 1}})
        assert handler_calls == 2
        assert operation_calls == 1


def test_durable_sleeps_release_ownership_and_survive_a_swallowed_sentinel(
    database_url: str,
) -> None:
    handler_calls = 0
    conflicts: list[WaitConflictError] = []

    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
    ):
        job_id = Queue(enqueue_connection).enqueue("wait.replay", {})
        enqueue_connection.commit()

        def handle(_payload: object, context: HandlerContext) -> dict[str, int]:
            nonlocal handler_calls
            handler_calls += 1
            with suppress(BaseException):
                context.sleep("relative", 30_000)
            if handler_calls >= 2:
                try:
                    context.sleep_until("relative", datetime.now(UTC) - timedelta(seconds=1))
                except WaitConflictError as error:
                    conflicts.append(error)
                context.sleep_until("absolute", datetime.now(UTC) - timedelta(seconds=1))
            return {"handlerCalls": handler_calls}

        worker = Worker(worker_connection, worker_id="python-wait-worker").handle(
            "wait.replay", handle
        )

        assert worker.run_once() is True
        suspended = worker_connection.execute(
            "SELECT state, current_attempt, worker_id, fence_token FROM workhorse.job_runtime "
            "WHERE job_id = %s",
            (job_id,),
        ).fetchone()
        assert suspended == ("scheduled", 1, None, 0)
        assert worker_connection.execute(
            "SELECT count(*) FROM workhorse.attempt_history WHERE job_id = %s", (job_id,)
        ).fetchone() == (0,)

        worker_connection.execute(
            "UPDATE workhorse.job_wait SET wake_at = clock_timestamp() - interval '1 millisecond' "
            "WHERE job_id = %s AND wait_name = 'relative'",
            (job_id,),
        )
        worker_connection.execute(
            "UPDATE workhorse.job_runtime "
            "SET run_at = clock_timestamp() - interval '1 millisecond' "
            "WHERE job_id = %s",
            (job_id,),
        )
        assert worker.run_once() is True
        outcome = worker_connection.execute(
            "SELECT state, current_attempt, result FROM workhorse.job_outcome WHERE job_id = %s",
            (job_id,),
        ).fetchone()
        assert outcome == ("succeeded", 1, {"handlerCalls": 2})
        assert len(conflicts) == 1
        assert conflicts[0].job_id == job_id


def test_checkpoint_conflict_is_typed_at_the_handler_context(database_url: str) -> None:
    conflicts: list[CheckpointConflictError] = []

    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
        psycopg.connect(database_url, autocommit=True) as competing_connection,
    ):
        job_id = Queue(enqueue_connection).enqueue("checkpoint.conflict", {})
        enqueue_connection.commit()

        def handle(_payload: object, context: HandlerContext) -> dict[str, bool]:
            assert context.get_checkpoint("prepare") is None
            saved = competing_connection.execute(
                "SELECT status FROM workhorse.save_checkpoint_v1(%s, %s, %s, %s, %s)",
                (job_id, "python-conflict-worker", context.job.fence_token, "prepare", '{"v":1}'),
            ).fetchone()
            assert saved == ("saved",)
            try:
                context.checkpoint("prepare", lambda: {"v": 2})
            except CheckpointConflictError as error:
                conflicts.append(error)
            return {"conflict": True}

        worker = Worker(worker_connection, worker_id="python-conflict-worker").handle(
            "checkpoint.conflict", handle
        )
        assert worker.run_once() is True
        assert len(conflicts) == 1
        assert conflicts[0].job_id == job_id
        assert conflicts[0].checkpoint_name == "prepare"


def test_concurrent_same_name_checkpoints_share_one_operation(database_url: str) -> None:
    operation_started = Event()
    release_operation = Event()
    operation_calls = 0

    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
    ):
        job_id = Queue(enqueue_connection).enqueue("checkpoint.concurrent", {})
        enqueue_connection.commit()

        def handle(_payload: object, context: HandlerContext) -> dict[str, object]:
            nonlocal operation_calls
            values: list[object] = []
            errors: list[BaseException] = []

            def operation() -> dict[str, int]:
                nonlocal operation_calls
                operation_calls += 1
                operation_started.set()
                assert release_operation.wait(timeout=5)
                return {"call": operation_calls}

            def run_checkpoint() -> None:
                try:
                    values.append(context.checkpoint("shared", operation))
                except BaseException as error:
                    errors.append(error)

            first = Thread(target=run_checkpoint)
            second = Thread(target=run_checkpoint)
            first.start()
            assert operation_started.wait(timeout=5)
            second.start()
            sleep(0.02)
            release_operation.set()
            first.join(timeout=5)
            second.join(timeout=5)
            assert errors == []
            return {"values": values}

        worker = Worker(worker_connection, worker_id="python-coalesce-worker").handle(
            "checkpoint.concurrent", handle
        )
        assert worker.run_once() is True
        assert operation_calls == 1
        outcome = worker_connection.execute(
            "SELECT result FROM workhorse.job_outcome WHERE job_id = %s", (job_id,)
        ).fetchone()
        assert outcome == ({"values": [{"call": 1}, {"call": 1}]},)


def test_checkpoint_rejects_a_stale_fence_with_its_specific_error(database_url: str) -> None:
    observed: list[CheckpointLeaseLostError] = []

    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
        psycopg.connect(database_url, autocommit=True) as competing_connection,
    ):
        job_id = Queue(enqueue_connection).enqueue("checkpoint.stale", {})
        enqueue_connection.commit()

        def handle(_payload: object, context: HandlerContext) -> dict[str, bool]:
            completed = competing_connection.execute(
                "SELECT workhorse.complete_v1(%s, %s, %s, %s)",
                (job_id, "python-stale-checkpoint-worker", context.job.fence_token, "{}"),
            ).fetchone()
            assert completed == (True,)
            try:
                context.checkpoint("too-late", lambda: {"saved": False})
            except CheckpointLeaseLostError as error:
                observed.append(error)
            return {"ignored": True}

        worker = Worker(worker_connection, worker_id="python-stale-checkpoint-worker").handle(
            "checkpoint.stale", handle
        )
        with pytest.raises(StaleLeaseError):
            worker.run_once()
        assert len(observed) == 1
        assert observed[0].job_id == job_id
        assert observed[0].checkpoint_name == "too-late"


def test_handler_context_reports_and_reads_latest_progress(database_url: str) -> None:
    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
    ):
        job_id = Queue(enqueue_connection).enqueue("progress.report", {})
        enqueue_connection.commit()

        def handle(_payload: object, context: HandlerContext) -> object:
            assert context.get_progress() is None
            updated = context.set_progress({"stage": "reading"})
            observed = context.get_progress()
            assert observed is updated
            assert observed.job_id == job_id
            assert observed.revision == 1
            return observed.value

        worker = Worker(worker_connection, worker_id="python-progress-worker").handle(
            "progress.report", handle
        )
        assert worker.run_once() is True
        assert worker_connection.execute(
            "SELECT progress_value, revision FROM workhorse.job_progress WHERE job_id = %s",
            (job_id,),
        ).fetchone() == ({"stage": "reading"}, 1)


def test_handler_context_returns_typed_progress_errors(database_url: str) -> None:
    observed_rate_limits: list[ProgressRateLimitError] = []
    observed_lease_losses: list[ProgressLeaseLostError] = []

    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
        psycopg.connect(database_url, autocommit=True) as competing_connection,
    ):
        job_id = Queue(enqueue_connection).enqueue("progress.errors", {})
        enqueue_connection.commit()

        def handle(_payload: object, context: HandlerContext) -> None:
            context.set_progress({"step": 1})
            competing_connection.execute(
                "UPDATE workhorse.job_progress "
                "SET updated_at = clock_timestamp() + interval '1 second' WHERE job_id = %s",
                (job_id,),
            )
            try:
                context.set_progress({"step": 2})
            except ProgressRateLimitError as error:
                observed_rate_limits.append(error)
            completed = competing_connection.execute(
                "SELECT workhorse.complete_v1(%s, %s, %s, %s)",
                (job_id, "python-progress-errors", context.job.fence_token, "{}"),
            ).fetchone()
            assert completed == (True,)
            try:
                context.set_progress({"step": 3})
            except ProgressLeaseLostError as error:
                observed_lease_losses.append(error)

        worker = Worker(worker_connection, worker_id="python-progress-errors").handle(
            "progress.errors", handle
        )
        with pytest.raises(StaleLeaseError):
            worker.run_once()

    assert len(observed_rate_limits) == 1
    assert observed_rate_limits[0].job_id == job_id
    assert observed_rate_limits[0].retry_after_ms > 0
    assert len(observed_lease_losses) == 1
    assert observed_lease_losses[0].job_id == job_id


def test_registered_handler_claims_exclusively_and_records_its_result(database_url: str) -> None:
    handler_started = Event()
    release_handler = Event()
    worker_error: list[BaseException] = []

    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as first_connection,
        psycopg.connect(database_url, autocommit=True) as second_connection,
    ):
        job_id = Queue(enqueue_connection).enqueue("email.send", {"to": "reader@example.com"})
        enqueue_connection.commit()

        first_worker = Worker(first_connection, worker_id="python-worker-one")

        def handle(payload: Any, _context: object) -> dict[str, object]:
            handler_started.set()
            assert release_handler.wait(timeout=5)
            return {"deliveredTo": payload["to"]}

        first_worker.handle("email.send", handle)

        def run_first_worker() -> None:
            try:
                assert first_worker.run_once() is True
            except BaseException as error:
                worker_error.append(error)

        thread = Thread(target=run_first_worker)
        thread.start()
        assert handler_started.wait(timeout=5)

        second_called = False

        def handle_second(_payload: object, _context: object) -> None:
            nonlocal second_called
            second_called = True

        second_worker = Worker(second_connection, worker_id="python-worker-two").handle(
            "email.send", handle_second
        )
        assert second_worker.run_once() is False

        release_handler.set()
        thread.join(timeout=5)
        assert not thread.is_alive()
        assert worker_error == []
        assert second_called is False

        outcome = second_connection.execute(
            "SELECT state, result FROM workhorse.job_outcome WHERE job_id = %s", (job_id,)
        ).fetchone()
        assert outcome == ("succeeded", {"deliveredTo": "reader@example.com"})


def test_run_once_refills_a_bounded_concurrency_slot(database_url: str) -> None:
    started: list[int] = []
    releases = [Event(), Event(), Event()]
    two_started = Event()
    third_started = Event()
    worker_error: list[BaseException] = []

    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
    ):
        queue = Queue(enqueue_connection)
        job_ids = [queue.enqueue("bounded", {"sequence": sequence}) for sequence in range(3)]
        enqueue_connection.commit()

        def handle(payload: Any, _context: object) -> dict[str, int]:
            sequence = int(payload["sequence"])
            started.append(sequence)
            if len(started) == 2:
                two_started.set()
            if len(started) == 3:
                third_started.set()
            assert releases[sequence].wait(timeout=5)
            return {"sequence": sequence}

        worker = Worker(
            worker_connection,
            worker_id="python-bounded-worker",
            concurrency=2,
        ).handle("bounded", handle)

        def run_worker() -> None:
            try:
                assert worker.run_once() is True
            except BaseException as error:
                worker_error.append(error)

        thread = Thread(target=run_worker)
        thread.start()
        assert two_started.wait(timeout=5)
        assert len(started) == 2

        releases[started[0]].set()
        assert third_started.wait(timeout=5)
        assert len(started) == 3

        for release in releases:
            release.set()
        thread.join(timeout=5)
        assert not thread.is_alive()
        assert worker_error == []

        outcomes = worker_connection.execute(
            "SELECT job_id::text, state FROM workhorse.job_outcome "
            "WHERE job_id = ANY(%s::uuid[]) ORDER BY job_id",
            (job_ids,),
        ).fetchall()
        assert outcomes == sorted((job_id, "succeeded") for job_id in job_ids)


def test_batch_handler_orders_members_and_settles_each_outcome(database_url: str) -> None:
    delivered: list[tuple[int, str]] = []

    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
    ):
        queue = Queue(enqueue_connection)
        jobs = [
            queue.enqueue(
                "email.batch",
                {"priority": priority},
                EnqueueOptions(priority=priority, max_attempts=1),
            )
            for priority in (10, 90, 50)
        ]
        enqueue_connection.commit()

        def handle_batch(items: Any) -> list[dict[str, object]]:
            delivered.extend((item.payload["priority"], item.context.job.queue) for item in items)
            assert all(not hasattr(item.context, "sleep") for item in items)
            return [
                {"status": "succeeded", "result": {"position": 0}},
                {"status": "failed", "error": RuntimeError("provider rejected member")},
                {"status": "succeeded", "result": {"position": 2}},
            ]

        worker = Worker(
            worker_connection,
            worker_id="python-batch-worker",
            concurrency=3,
        ).handle_batch("email.batch", max_size=3, linger_ms=100, handler=handle_batch)

        assert worker.run_once() is True
        assert delivered == [(90, "default"), (50, "default"), (10, "default")]

        outcomes = worker_connection.execute(
            "SELECT job_id::text, state, result, error->>'message' "
            "FROM workhorse.job_outcome WHERE job_id = ANY(%s::uuid[])",
            (jobs,),
        ).fetchall()
        by_job = {row[0]: row[1:] for row in outcomes}
        assert by_job[jobs[1]] == ("succeeded", {"position": 0}, None)
        assert by_job[jobs[2]] == ("failed", None, "provider rejected member")
        assert by_job[jobs[0]] == ("succeeded", {"position": 2}, None)

        evidence = worker_connection.execute(
            "SELECT event_type, count(*) FROM workhorse.job_event "
            "WHERE job_id = ANY(%s::uuid[]) AND event_type = 'batch_dispatched' "
            "GROUP BY event_type",
            (jobs,),
        ).fetchall()
        assert evidence == [("batch_dispatched", 3)]


def test_batch_handler_keeps_queues_separate_until_linger_expires(database_url: str) -> None:
    batches: list[list[tuple[str, int]]] = []

    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
    ):
        queue = Queue(enqueue_connection)
        for queue_name, value in (("email", 1), ("billing", 2)):
            queue.enqueue(
                "provider.batch",
                {"value": value},
                EnqueueOptions(queue=queue_name),
            )
        enqueue_connection.commit()

        started_at = monotonic()

        def handle_batch(items: Any) -> list[dict[str, object]]:
            assert monotonic() - started_at >= 0.05
            batches.append([(item.context.job.queue, item.payload["value"]) for item in items])
            return [{"status": "succeeded", "result": None} for _item in items]

        worker = Worker(
            worker_connection,
            queues=("email", "billing"),
            worker_id="python-partial-batch-worker",
            concurrency=2,
        ).handle_batch("provider.batch", max_size=2, linger_ms=80, handler=handle_batch)

        assert worker.run_once() is True
        assert sorted(batches) == [[("billing", 2)], [("email", 1)]]


def test_batch_handler_failure_shapes_fail_every_member(database_url: str) -> None:
    class BatchAbort(BaseException):
        pass

    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
    ):
        queue = Queue(enqueue_connection)
        jobs_by_type = {
            job_type: [
                queue.enqueue(job_type, {"value": value}, EnqueueOptions(max_attempts=1))
                for value in (1, 2)
            ]
            for job_type in ("batch.thrown", "batch.arity", "batch.invalid", "batch.abort")
        }
        enqueue_connection.commit()

        def thrown(_items: Any) -> list[dict[str, object]]:
            raise RuntimeError("provider batch failed")

        def aborted(_items: Any) -> list[dict[str, object]]:
            raise BatchAbort("provider aborted batch")

        worker = Worker(
            worker_connection,
            worker_id="python-invalid-batch-worker",
            concurrency=6,
        )
        worker.handle_batch("batch.thrown", max_size=2, linger_ms=100, handler=thrown)
        worker.handle_batch(
            "batch.arity",
            max_size=2,
            linger_ms=100,
            handler=lambda _items: [{"status": "succeeded", "result": None}],
        )
        worker.handle_batch(
            "batch.invalid",
            max_size=2,
            linger_ms=100,
            handler=lambda _items: [
                {"status": "unknown", "result": None},
                {"status": "succeeded", "result": None},
            ],
        )
        worker.handle_batch("batch.abort", max_size=2, linger_ms=100, handler=aborted)

        assert worker.run_once() is True
        all_jobs = [job_id for jobs in jobs_by_type.values() for job_id in jobs]
        outcomes = worker_connection.execute(
            "SELECT job_id::text, state, error->>'message' FROM workhorse.job_outcome "
            "WHERE job_id = ANY(%s::uuid[])",
            (all_jobs,),
        ).fetchall()
        assert {row[1] for row in outcomes} == {"failed"}
        messages = {row[0]: row[2] for row in outcomes}
        assert {messages[job_id] for job_id in jobs_by_type["batch.thrown"]} == {
            "provider batch failed"
        }
        assert all(
            "returned 1 outcomes for 2 jobs" in messages[job_id]
            for job_id in jobs_by_type["batch.arity"]
        )
        assert all(
            "invalid outcome at index 0" in messages[job_id]
            for job_id in jobs_by_type["batch.invalid"]
        )
        assert all(
            "raised BatchAbort: provider aborted batch" in messages[job_id]
            for job_id in jobs_by_type["batch.abort"]
        )

        evidence_count = worker_connection.execute(
            "SELECT count(*) FROM workhorse.job_event "
            "WHERE job_id = ANY(%s::uuid[]) AND event_type = 'batch_failed'",
            (all_jobs,),
        ).fetchone()
        assert evidence_count == (8,)


def test_batch_evidence_failure_does_not_change_settlement(database_url: str) -> None:
    class EvidenceFailingCursor:
        def __init__(self, cursor: object) -> None:
            self.cursor = cursor

        @property
        def description(self) -> object:
            return self.cursor.description  # type: ignore[union-attr]

        def __enter__(self) -> EvidenceFailingCursor:
            self.cursor.__enter__()  # type: ignore[union-attr]
            return self

        def __exit__(self, *args: object) -> object:
            return self.cursor.__exit__(*args)  # type: ignore[union-attr]

        def execute(self, query: str, parameters: object = ()) -> object:
            if "record_batch_dispatch_v1" in query:
                raise RuntimeError("evidence store unavailable")
            return self.cursor.execute(query, parameters)  # type: ignore[union-attr]

        def fetchall(self) -> object:
            return self.cursor.fetchall()  # type: ignore[union-attr]

    class EvidenceFailingConnection:
        autocommit = True

        def __init__(self, connection: object) -> None:
            self.connection = connection

        def cursor(self) -> EvidenceFailingCursor:
            return EvidenceFailingCursor(self.connection.cursor())  # type: ignore[union-attr]

    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
    ):
        queue = Queue(enqueue_connection)
        jobs = [queue.enqueue("batch.no-evidence", {"value": value}) for value in (1, 2)]
        enqueue_connection.commit()

        worker = Worker(
            EvidenceFailingConnection(worker_connection),  # type: ignore[arg-type]
            worker_id="python-evidence-failure-worker",
            concurrency=2,
        ).handle_batch(
            "batch.no-evidence",
            max_size=2,
            linger_ms=100,
            handler=lambda items: [
                {"status": "succeeded", "result": item.payload} for item in items
            ],
        )

        assert worker.run_once() is True
        outcomes = worker_connection.execute(
            "SELECT state, result FROM workhorse.job_outcome "
            "WHERE job_id = ANY(%s::uuid[]) ORDER BY result->>'value'",
            (jobs,),
        ).fetchall()
        assert outcomes == [("succeeded", {"value": 1}), ("succeeded", {"value": 2})]


def test_batch_member_cancellation_does_not_disturb_its_peer(database_url: str) -> None:
    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
        psycopg.connect(database_url, autocommit=True) as operator_connection,
    ):
        queue = Queue(enqueue_connection)
        canceled_job = queue.enqueue("batch.cancel", {"cancel": True})
        completed_job = queue.enqueue("batch.cancel", {"cancel": False})
        enqueue_connection.commit()

        def handle_batch(items: Any) -> list[dict[str, object]]:
            canceled = next(item for item in items if item.payload["cancel"] is True)
            status = operator_connection.execute(
                "SELECT status FROM workhorse.cancel_v1(%s::uuid, %s::text, %s::text)",
                (canceled.context.job.id, "batch-test", "member canceled"),
            ).fetchone()
            assert status == ("cancel_requested",)
            assert canceled.context.cancellation.wait(timeout=5)
            return [
                {"status": "succeeded", "result": {"cancel": item.payload["cancel"]}}
                for item in items
            ]

        worker = Worker(
            worker_connection,
            worker_id="python-batch-cancellation-worker",
            concurrency=2,
            lease_ms=500,
            heartbeat_ms=40,
        ).handle_batch("batch.cancel", max_size=2, linger_ms=100, handler=handle_batch)

        assert worker.run_once() is True
        outcomes = worker_connection.execute(
            "SELECT job_id::text, state, result, error->>'reason' "
            "FROM workhorse.job_outcome WHERE job_id = ANY(%s::uuid[])",
            ([canceled_job, completed_job],),
        ).fetchall()
        by_job = {row[0]: row[1:] for row in outcomes}
        assert by_job[canceled_job] == ("canceled", None, "member canceled")
        assert by_job[completed_job] == ("succeeded", {"cancel": False}, None)


def test_batch_member_timeout_does_not_disturb_its_peer(database_url: str) -> None:
    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
    ):
        queue = Queue(enqueue_connection)
        timed_job = queue.enqueue(
            "batch.timeout",
            {"timed": True},
            EnqueueOptions(execution_timeout_ms=180, max_attempts=1),
        )
        completed_job = queue.enqueue(
            "batch.timeout",
            {"timed": False},
            EnqueueOptions(max_attempts=1),
        )
        enqueue_connection.commit()

        def handle_batch(items: Any) -> list[dict[str, object]]:
            timed = next(item for item in items if item.payload["timed"] is True)
            assert timed.context.cancellation.wait(timeout=5)
            assert isinstance(timed.context.cancellation.reason, ExecutionTimeoutError)
            return [
                {"status": "succeeded", "result": {"timed": item.payload["timed"]}}
                for item in items
            ]

        worker = Worker(
            worker_connection,
            worker_id="python-batch-timeout-worker",
            concurrency=2,
            lease_ms=500,
            heartbeat_ms=400,
        ).handle_batch("batch.timeout", max_size=2, linger_ms=100, handler=handle_batch)

        assert worker.run_once() is True
        outcomes = worker_connection.execute(
            "SELECT job_id::text, state, result, error->>'name' "
            "FROM workhorse.job_outcome WHERE job_id = ANY(%s::uuid[])",
            ([timed_job, completed_job],),
        ).fetchall()
        by_job = {row[0]: row[1:] for row in outcomes}
        assert by_job[timed_job] == ("failed", None, "ExecutionTimeout")
        assert by_job[completed_job] == ("succeeded", {"timed": False}, None)


def test_batch_registration_validates_capacity_and_linger(database_url: str) -> None:
    with psycopg.connect(database_url, autocommit=True) as worker_connection:
        worker = Worker(worker_connection, concurrency=2)

        def handler(_items: object) -> list[object]:
            return []

        with pytest.raises(ValueError, match="max_size must be an integer"):
            worker.handle_batch("invalid", handler, max_size=0, linger_ms=1)
        with pytest.raises(ValueError, match="must not exceed worker concurrency"):
            worker.handle_batch("invalid", handler, max_size=3, linger_ms=1)
        with pytest.raises(ValueError, match="linger_ms must be an integer"):
            worker.handle_batch("invalid", handler, max_size=2, linger_ms=-1)


def test_run_once_rotates_claims_across_queues(database_url: str) -> None:
    handled_queues: list[str] = []

    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
    ):
        queue = Queue(enqueue_connection)
        for sequence in range(3):
            queue.enqueue("rotated", {"sequence": sequence}, EnqueueOptions(queue="busy"))
        queue.enqueue("rotated", {"sequence": 3}, EnqueueOptions(queue="quiet"))
        enqueue_connection.commit()

        def handle(_payload: object, context: HandlerContext) -> None:
            handled_queues.append(context.job.queue)

        worker = Worker(
            worker_connection,
            queues=("busy", "quiet"),
            worker_id="python-rotation-worker",
        ).handle("rotated", handle)

        assert worker.run_once() is True
        assert worker.run_once() is False

        assert handled_queues == ["busy", "quiet", "busy", "busy"]


def test_run_pauses_resumes_and_drains_active_slots(database_url: str) -> None:
    started: list[int] = []
    releases = [Event(), Event(), Event()]
    two_started = Event()
    third_started = Event()
    run_finished = Event()
    worker_error: list[BaseException] = []

    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
    ):
        queue = Queue(enqueue_connection)
        job_ids = [queue.enqueue("controlled", {"sequence": sequence}) for sequence in range(3)]
        enqueue_connection.commit()

        def handle(payload: Any, _context: object) -> None:
            sequence = int(payload["sequence"])
            started.append(sequence)
            if len(started) == 2:
                two_started.set()
            if len(started) == 3:
                third_started.set()
            assert releases[sequence].wait(timeout=5)

        worker = Worker(
            worker_connection,
            worker_id="python-controlled-worker",
            concurrency=2,
            poll_ms=5_000,
        ).handle("controlled", handle)

        def run_worker() -> None:
            try:
                worker.run()
            except BaseException as error:
                worker_error.append(error)
            finally:
                run_finished.set()

        thread = Thread(target=run_worker)
        thread.start()
        assert two_started.wait(timeout=5)

        worker.pause()
        assert worker.is_paused() is True
        for sequence in started:
            releases[sequence].set()
        assert not third_started.wait(timeout=0.2)

        worker.resume()
        assert worker.is_paused() is False
        assert third_started.wait(timeout=1)

        worker.stop()
        assert not run_finished.wait(timeout=0.2)
        releases[started[2]].set()
        assert run_finished.wait(timeout=5)
        thread.join(timeout=5)
        assert not thread.is_alive()
        assert worker_error == []

        outcomes = worker_connection.execute(
            "SELECT job_id::text, state FROM workhorse.job_outcome "
            "WHERE job_id = ANY(%s::uuid[]) ORDER BY job_id",
            (job_ids,),
        ).fetchall()
        assert outcomes == sorted((job_id, "succeeded") for job_id in job_ids)


def test_worker_registry_delivers_remote_pause_and_deregisters(database_url: str) -> None:
    handled = Event()
    stopped = Event()
    errors: list[BaseException] = []

    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
        psycopg.connect(database_url, autocommit=True) as operator_connection,
    ):
        worker = Worker(
            worker_connection,
            queue="python-registry",
            worker_id="python-registry-worker",
            poll_ms=10,
            registry_interval_ms=100,
            schedule_namespaces=("python-schedules",),
        ).handle("registered", lambda _payload, _context: handled.set())

        def run_worker() -> None:
            try:
                worker.run()
            except BaseException as error:
                errors.append(error)
            finally:
                stopped.set()

        thread = Thread(target=run_worker)
        thread.start()
        deadline = monotonic() + 5
        while monotonic() < deadline:
            row = operator_connection.execute(
                "SELECT instance_id::text, queue_names, schedule_namespaces "
                "FROM workhorse.worker_registry WHERE worker_id = 'python-registry-worker'"
            ).fetchone()
            if row is not None:
                break
            sleep(0.01)
        assert row is not None
        first_instance_id = row[0]
        assert row[1] == ["python-registry"]
        assert row[2] == ["python-schedules"]

        operator_connection.execute(
            "SELECT * FROM workhorse.set_worker_paused_v1(%s, true, %s, %s, %s)",
            ("python-registry-worker", "test", "remote pause", "pause-request"),
        )
        deadline = monotonic() + 5
        while monotonic() < deadline:
            refreshed = operator_connection.execute(
                "SELECT last_heartbeat_at > paused_at FROM workhorse.worker_registry "
                "WHERE worker_id = 'python-registry-worker'"
            ).fetchone()
            if refreshed == (True,):
                break
            sleep(0.01)
        assert refreshed == (True,)

        Queue(enqueue_connection, "python-registry").enqueue("registered", {})
        enqueue_connection.commit()
        assert not handled.wait(timeout=0.25)

        operator_connection.execute(
            "SELECT * FROM workhorse.set_worker_paused_v1(%s, false, %s, %s, %s)",
            ("python-registry-worker", "test", "remote resume", "resume-request"),
        )
        assert handled.wait(timeout=5)

        worker.stop()
        assert stopped.wait(timeout=5)
        thread.join(timeout=5)
        assert not thread.is_alive()
        assert errors == []
        assert operator_connection.execute(
            "SELECT count(*) FROM workhorse.worker_registry "
            "WHERE worker_id = 'python-registry-worker'"
        ).fetchone() == (0,)

        stopped.clear()
        thread = Thread(target=run_worker)
        thread.start()
        deadline = monotonic() + 5
        while monotonic() < deadline:
            restarted = operator_connection.execute(
                "SELECT instance_id::text FROM workhorse.worker_registry "
                "WHERE worker_id = 'python-registry-worker'"
            ).fetchone()
            if restarted is not None:
                break
            sleep(0.01)
        assert restarted is not None
        assert restarted[0] != first_instance_id
        worker.stop()
        assert stopped.wait(timeout=5)
        thread.join(timeout=5)
        assert not thread.is_alive()
        assert errors == []


def test_stop_reaches_a_run_waiting_behind_an_active_pass(database_url: str) -> None:
    handler_started = Event()
    release_handler = Event()
    queued_run_started = Event()
    queued_run_finished = Event()
    worker_error: list[BaseException] = []

    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
    ):
        Queue(enqueue_connection).enqueue("queued.stop", {})
        enqueue_connection.commit()

        def handle(_payload: object, _context: object) -> None:
            handler_started.set()
            assert release_handler.wait(timeout=5)

        worker = Worker(
            worker_connection,
            worker_id="python-queued-stop-worker",
            poll_ms=5_000,
        ).handle("queued.stop", handle)

        first_pass = Thread(target=worker.run_once)
        first_pass.start()
        assert handler_started.wait(timeout=5)

        def run_worker() -> None:
            queued_run_started.set()
            try:
                worker.run()
            except BaseException as error:
                worker_error.append(error)
            finally:
                queued_run_finished.set()

        queued_run = Thread(target=run_worker)
        queued_run.start()
        assert queued_run_started.wait(timeout=5)
        sleep(0.05)

        worker.stop()
        release_handler.set()

        first_pass.join(timeout=5)
        assert not first_pass.is_alive()
        assert queued_run_finished.wait(timeout=1)
        queued_run.join(timeout=5)
        assert not queued_run.is_alive()
        assert worker_error == []


def test_run_wakes_from_a_dedicated_notification_connection(database_url: str) -> None:
    listener_ready = Event()
    empty_claim_finished = Event()
    release_empty_claim = Event()
    handled = Event()
    worker_errors: list[BaseException] = []

    class DelayedCursor:
        def __init__(self, cursor: object) -> None:
            self.cursor = cursor

        @property
        def description(self) -> object:
            return self.cursor.description  # type: ignore[union-attr]

        def __enter__(self) -> DelayedCursor:
            self.cursor.__enter__()  # type: ignore[union-attr]
            return self

        def __exit__(self, *args: object) -> object:
            return self.cursor.__exit__(*args)  # type: ignore[union-attr]

        def execute(self, query: str, parameters: object = ()) -> object:
            result = self.cursor.execute(query, parameters)  # type: ignore[union-attr]
            if "workhorse.claim_many_v1" in query and not empty_claim_finished.is_set():
                empty_claim_finished.set()
                assert release_empty_claim.wait(timeout=5)
            return result

        def fetchall(self) -> object:
            return self.cursor.fetchall()  # type: ignore[union-attr]

    class DelayedConnection:
        autocommit = True

        def __init__(self, connection: object) -> None:
            self.connection = connection

        def cursor(self) -> DelayedCursor:
            return DelayedCursor(self.connection.cursor())  # type: ignore[union-attr]

    class ListeningConnection:
        autocommit = True

        def __init__(self) -> None:
            self.connection = psycopg.connect(database_url, autocommit=True)

        def execute(self, query: str) -> object:
            result = self.connection.execute(query)
            listener_ready.set()
            return result

        def notifies(self, *, timeout: float, stop_after: int | None = None) -> object:
            return self.connection.notifies(timeout=timeout, stop_after=stop_after)

        def close(self) -> None:
            self.connection.close()

    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
    ):
        worker = Worker(
            DelayedConnection(worker_connection),  # type: ignore[arg-type]
            queue="notification-target",
            poll_ms=5_000,
            notification_connection_factory=ListeningConnection,
        ).handle("notification.wake", lambda _payload, _context: handled.set())

        def run_worker() -> None:
            try:
                worker.run()
            except BaseException as error:
                worker_errors.append(error)

        thread = Thread(target=run_worker)
        thread.start()
        assert listener_ready.wait(timeout=5)
        assert empty_claim_finished.wait(timeout=5)

        Queue(enqueue_connection, default_queue="notification-target").enqueue(
            "notification.wake", {}
        )
        enqueue_connection.commit()
        release_empty_claim.set()

        assert handled.wait(timeout=1)
        worker.stop()
        thread.join(timeout=5)
        assert not thread.is_alive()
        assert worker_errors == []


def test_run_keeps_polling_when_notification_connections_fail(database_url: str) -> None:
    handled = Event()
    notification_error = Event()
    worker_errors: list[BaseException] = []

    def unavailable_listener() -> object:
        raise RuntimeError("listener capacity unavailable")

    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
    ):
        worker = Worker(
            worker_connection,
            notification_connection_factory=unavailable_listener,
            on_notification_error=lambda _error: notification_error.set(),
        ).handle("notification.fallback", lambda _payload, _context: handled.set())

        def run_worker() -> None:
            try:
                worker.run()
            except BaseException as error:
                worker_errors.append(error)

        thread = Thread(target=run_worker)
        thread.start()
        assert notification_error.wait(timeout=1)

        Queue(enqueue_connection).enqueue("notification.fallback", {})
        enqueue_connection.commit()

        assert handled.wait(timeout=1)
        worker.stop()
        thread.join(timeout=5)
        assert not thread.is_alive()
        assert worker_errors == []


def test_worker_renews_ownership_while_handler_runs(database_url: str) -> None:
    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
    ):
        job_id = Queue(enqueue_connection).enqueue("lease.renewed", {})
        enqueue_connection.commit()

        def outlive_original_lease(_payload: object, _context: object) -> dict[str, bool]:
            sleep(0.35)
            return {"renewed": True}

        worker = Worker(
            worker_connection,
            worker_id="python-heartbeat-worker",
            lease_ms=150,
            heartbeat_ms=40,
        ).handle("lease.renewed", outlive_original_lease)

        assert worker.run_once() is True
        outcome = worker_connection.execute(
            "SELECT state, result FROM workhorse.job_outcome WHERE job_id = %s", (job_id,)
        ).fetchone()
        assert outcome == ("succeeded", {"renewed": True})


def test_worker_delivers_and_acknowledges_cancellation(database_url: str) -> None:
    handler_started = Event()
    observed_reason: list[BaseException] = []
    worker_error: list[BaseException] = []

    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
        psycopg.connect(database_url, autocommit=True) as operator_connection,
    ):
        job_id = Queue(enqueue_connection).enqueue("cancel.active", {})
        enqueue_connection.commit()

        def wait_for_cancellation(_payload: object, context: HandlerContext) -> dict[str, bool]:
            handler_started.set()
            assert context.cancellation.wait(timeout=5)
            observed_reason.append(context.cancellation.reason)
            return {"ignoredCancellation": True}

        worker = Worker(
            worker_connection,
            worker_id="python-cancellation-worker",
            lease_ms=500,
            heartbeat_ms=40,
        ).handle("cancel.active", wait_for_cancellation)

        def run_worker() -> None:
            try:
                assert worker.run_once() is True
            except BaseException as error:
                worker_error.append(error)

        thread = Thread(target=run_worker)
        thread.start()
        assert handler_started.wait(timeout=5)

        cancellation = operator_connection.execute(
            "SELECT status FROM workhorse.cancel_v1(%s::uuid, %s::text, %s::text)",
            (job_id, "operator", "deployment stopped"),
        ).fetchone()
        assert cancellation == ("cancel_requested",)

        thread.join(timeout=5)
        assert not thread.is_alive()
        assert worker_error == []
        assert len(observed_reason) == 1
        assert isinstance(observed_reason[0], CancellationRequestedError)

        outcome = operator_connection.execute(
            "SELECT state, error->>'reason' FROM workhorse.job_outcome WHERE job_id = %s",
            (job_id,),
        ).fetchone()
        assert outcome == ("canceled", "deployment stopped")
        attempt_count = operator_connection.execute(
            "SELECT count(*) FROM workhorse.attempt_history WHERE job_id = %s", (job_id,)
        ).fetchone()
        assert attempt_count == (1,)


def test_worker_classifies_an_absolute_deadline(
    database_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    observed_reason: list[BaseException] = []
    expiration_due = Event()

    def release_expiration(_expiration_at: datetime | None, _retry_at: float | None) -> float:
        assert expiration_due.wait(timeout=5)
        return 0

    monkeypatch.setattr(worker_module, "_expiration_delay", release_expiration)

    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
        psycopg.connect(database_url, autocommit=True) as deadline_connection,
    ):
        job_id = Queue(enqueue_connection).enqueue(
            "deadline.active",
            {},
            EnqueueOptions(deadline=datetime.now(UTC) + timedelta(seconds=30)),
        )
        enqueue_connection.commit()

        def wait_for_deadline(_payload: object, context: HandlerContext) -> None:
            deadline_connection.execute(
                "UPDATE workhorse.job_runtime "
                "SET deadline_at = clock_timestamp() - interval '1 millisecond' "
                "WHERE job_id = %s",
                (job_id,),
            )
            expiration_due.set()
            assert context.cancellation.wait(timeout=5)
            observed_reason.append(context.cancellation.reason)
            context.cancellation.raise_if_cancelled()

        worker = Worker(
            worker_connection,
            worker_id="python-deadline-worker",
            lease_ms=500,
            heartbeat_ms=400,
        ).handle("deadline.active", wait_for_deadline)

        assert worker.run_once() is True
        assert len(observed_reason) == 1
        assert isinstance(observed_reason[0], DeadlineExceededError)
        outcome = worker_connection.execute(
            "SELECT state, error->>'name' FROM workhorse.job_outcome WHERE job_id = %s",
            (job_id,),
        ).fetchone()
        assert outcome == ("failed", "DeadlineExceeded")


def test_worker_classifies_an_execution_timeout(database_url: str) -> None:
    observed_reason: list[BaseException] = []

    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
    ):
        job_id = Queue(enqueue_connection).enqueue(
            "timeout.active",
            {},
            EnqueueOptions(execution_timeout_ms=180, max_attempts=1),
        )
        enqueue_connection.commit()

        def wait_for_timeout(_payload: object, context: HandlerContext) -> None:
            assert context.cancellation.wait(timeout=5)
            observed_reason.append(context.cancellation.reason)
            context.cancellation.raise_if_cancelled()

        worker = Worker(
            worker_connection,
            worker_id="python-timeout-worker",
            lease_ms=500,
            heartbeat_ms=400,
        ).handle("timeout.active", wait_for_timeout)

        assert worker.run_once() is True
        assert len(observed_reason) == 1
        assert isinstance(observed_reason[0], ExecutionTimeoutError)
        outcome = worker_connection.execute(
            "SELECT state, error->>'name' FROM workhorse.job_outcome WHERE job_id = %s",
            (job_id,),
        ).fetchone()
        assert outcome == ("failed", "ExecutionTimeout")


def test_stale_fence_is_a_typed_lifecycle_error(database_url: str) -> None:
    handler_started = Event()
    worker_error: list[BaseException] = []

    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
        psycopg.connect(database_url) as blocking_connection,
    ):
        job_id = Queue(enqueue_connection).enqueue("lease.expires", {})
        enqueue_connection.commit()

        def wait_for_lease_loss(_payload: object, context: HandlerContext) -> None:
            handler_started.set()
            assert context.cancellation.wait(timeout=5)
            context.cancellation.raise_if_cancelled()

        worker = Worker(
            worker_connection,
            worker_id="python-stale-worker",
            lease_ms=150,
            heartbeat_ms=40,
        ).handle("lease.expires", wait_for_lease_loss)

        def run_worker() -> None:
            try:
                worker.run_once()
            except BaseException as error:
                worker_error.append(error)

        thread = Thread(target=run_worker)
        thread.start()
        assert handler_started.wait(timeout=5)

        blocking_connection.execute(
            "SELECT job_id FROM workhorse.job_runtime WHERE job_id = %s FOR UPDATE", (job_id,)
        ).fetchone()
        sleep(0.2)
        blocking_connection.commit()

        thread.join(timeout=5)
        assert not thread.is_alive()
        assert len(worker_error) == 1
        assert isinstance(worker_error[0], StaleLeaseError)

        assert worker_error[0].job_id == job_id


def test_worker_recovers_an_expired_claim_before_dispatch(database_url: str) -> None:
    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
    ):
        job_id = Queue(enqueue_connection).enqueue("lease.recovered", {})
        enqueue_connection.commit()
        abandoned = worker_connection.execute(
            "SELECT job_id FROM workhorse.claim_v1(%s::text, %s::text, %s::integer)",
            ("default", "abandoned-python-worker", 100),
        ).fetchone()
        assert abandoned is not None
        assert str(abandoned[0]) == job_id
        sleep(0.12)

        worker = Worker(
            worker_connection,
            worker_id="python-recovery-worker",
        ).handle("lease.recovered", lambda _payload, _context: {"recovered": True})

        assert worker.run_once() is True
        outcome = worker_connection.execute(
            "SELECT state, current_attempt, result FROM workhorse.job_outcome WHERE job_id = %s",
            (job_id,),
        ).fetchone()
        assert outcome == ("succeeded", 2, {"recovered": True})


def test_handler_failure_retries_on_the_database_schedule(database_url: str) -> None:
    attempts = 0

    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
    ):
        job_id = Queue(enqueue_connection).enqueue(
            "email.retry",
            {},
            EnqueueOptions(
                max_attempts=2,
                retry_policy={"type": "fixed", "delayMs": 500},
            ),
        )
        enqueue_connection.commit()

        def handle(_payload: object, _context: object) -> dict[str, bool]:
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise RuntimeError("provider unavailable")
            return {"delivered": True}

        worker = Worker(worker_connection, worker_id="python-retry-worker").handle(
            "email.retry", handle
        )

        assert worker.run_once() is True
        assert worker.run_once() is False

        scheduled = worker_connection.execute(
            "SELECT state, current_attempt, error->>'name', error->>'message', "
            "run_at > clock_timestamp() "
            "FROM workhorse.job_runtime WHERE job_id = %s",
            (job_id,),
        ).fetchone()
        assert scheduled == (
            "scheduled",
            2,
            "RuntimeError",
            "provider unavailable",
            True,
        )
        failed_attempt = worker_connection.execute(
            "SELECT outcome, error->>'name', error->>'message' "
            "FROM workhorse.attempt_history WHERE job_id = %s AND attempt = 1",
            (job_id,),
        ).fetchone()
        assert failed_attempt == ("retry", "RuntimeError", "provider unavailable")

        sleep(0.55)
        promoted = worker_connection.execute("SELECT workhorse.promote_v1(100)").fetchone()
        assert promoted == (1,)
        assert worker.run_once() is True
        assert attempts == 2

        outcome = worker_connection.execute(
            "SELECT state, current_attempt, result FROM workhorse.job_outcome WHERE job_id = %s",
            (job_id,),
        ).fetchone()
        assert outcome == ("succeeded", 2, {"delivered": True})
