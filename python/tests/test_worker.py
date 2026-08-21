from __future__ import annotations

from datetime import datetime, timedelta, timezone
from threading import Event, Thread
from time import monotonic, sleep
from typing import Any

import psycopg

from workhorse import (
    CancellationRequestedError,
    DeadlineExceededError,
    EnqueueOptions,
    ExecutionTimeoutError,
    HandlerContext,
    Queue,
    StaleLeaseError,
    Worker,
)


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


def test_worker_classifies_an_absolute_deadline(database_url: str) -> None:
    observed_reason: list[BaseException] = []

    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
    ):
        job_id = Queue(enqueue_connection).enqueue(
            "deadline.active",
            {},
            EnqueueOptions(deadline=datetime.now(timezone.utc) + timedelta(milliseconds=180)),
        )
        enqueue_connection.commit()

        def wait_for_deadline(_payload: object, context: HandlerContext) -> None:
            assert context.cancellation.wait(timeout=5)
            observed_reason.append(context.cancellation.reason)
            context.cancellation.raise_if_cancelled()

        worker = Worker(
            worker_connection,
            worker_id="python-deadline-worker",
            lease_ms=500,
            heartbeat_ms=400,
        ).handle("deadline.active", wait_for_deadline)

        started_at = monotonic()
        assert worker.run_once() is True
        assert monotonic() - started_at < 0.32
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
            "SELECT job_id FROM workhorse.claim_v3(%s::text, %s::text, %s::integer)",
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
