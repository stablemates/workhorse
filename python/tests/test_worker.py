from __future__ import annotations

from threading import Event, Thread
from time import sleep
from typing import Any

import psycopg
import pytest

from workhorse import EnqueueOptions, Queue, StaleLeaseError, Worker


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


def test_stale_fence_is_a_typed_lifecycle_error(database_url: str) -> None:
    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
    ):
        job_id = Queue(enqueue_connection).enqueue("lease.expires", {})
        enqueue_connection.commit()

        def outlive_lease(_payload: object, _context: object) -> None:
            sleep(0.2)

        worker = Worker(
            worker_connection,
            worker_id="python-stale-worker",
            lease_ms=100,
        ).handle("lease.expires", outlive_lease)

        with pytest.raises(StaleLeaseError) as raised:
            worker.run_once()

        assert raised.value.job_id == job_id


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
