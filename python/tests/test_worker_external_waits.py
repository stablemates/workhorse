from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from threading import Event, Thread
from time import sleep

import psycopg
import pytest

from workhorse import (
    EnqueueOptions,
    HandlerContext,
    HumanWaitConflictError,
    HumanWaitIdempotencyConflictError,
    Queue,
    SignalIdempotencyConflictError,
    SignalWaitLeaseLostError,
    StaleLeaseError,
    Worker,
)


def test_signal_wait_suspends_and_replays_the_delivered_payload(database_url: str) -> None:
    handler_calls = 0

    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
    ):
        queue = Queue(enqueue_connection)
        job_id = queue.enqueue("signal.approval", {})
        enqueue_connection.commit()

        def handle(_payload: object, context: HandlerContext) -> dict[str, object]:
            nonlocal handler_calls
            handler_calls += 1
            approval = context.wait_for_signal("approval")
            return {"approval": approval}

        worker = Worker(worker_connection, worker_id="python-signal-worker").handle(
            "signal.approval", handle
        )

        assert worker.run_once() is True
        assert worker_connection.execute(
            "SELECT state, current_attempt, worker_id FROM workhorse.job_runtime WHERE job_id = %s",
            (job_id,),
        ).fetchone() == ("scheduled", 1, None)

        delivered = queue.send_signal(
            job_id,
            "approval",
            {"approved": True},
            idempotency_key="approval-delivery",
            requested_by="billing-service",
        )
        enqueue_connection.commit()
        assert delivered.status == "delivered"
        assert delivered.payload == {"approved": True}
        with pytest.raises(SignalIdempotencyConflictError):
            queue.send_signal(
                job_id,
                "approval",
                {"approved": False},
                idempotency_key="approval-delivery",
                requested_by="billing-service",
            )
        enqueue_connection.rollback()

        assert worker.run_once() is True
        assert handler_calls == 2
        assert worker_connection.execute(
            "SELECT state, current_attempt, result FROM workhorse.job_outcome WHERE job_id = %s",
            (job_id,),
        ).fetchone() == ("succeeded", 1, {"approval": {"approved": True}})


def test_human_wait_replays_only_for_equal_context(database_url: str) -> None:
    handler_calls = 0

    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
    ):
        queue = Queue(enqueue_connection)
        job_id = queue.enqueue("account.review", {"accountId": "account-42"})
        enqueue_connection.commit()

        def handle(payload: object, context: HandlerContext) -> dict[str, object]:
            nonlocal handler_calls
            handler_calls += 1
            decision = context.wait_for_human(
                "review",
                {"accountId": payload["accountId"], "prompt": "Approve this account?"},  # type: ignore[index]
            )
            return {"decision": decision}

        worker = Worker(worker_connection, worker_id="python-human-worker").handle(
            "account.review", handle
        )

        assert worker.run_once() is True
        completed = queue.complete_human_wait(
            job_id,
            "review",
            {"approved": True},
            idempotency_key="review-completion",
            requested_by="reviewer-42",
        )
        enqueue_connection.commit()
        assert completed.status == "completed"
        assert completed.payload == {"approved": True}
        with pytest.raises(HumanWaitIdempotencyConflictError):
            queue.complete_human_wait(
                job_id,
                "review",
                {"approved": False},
                idempotency_key="review-completion",
                requested_by="reviewer-42",
            )
        enqueue_connection.rollback()

        assert worker.run_once() is True
        assert handler_calls == 2
        assert worker_connection.execute(
            "SELECT state, current_attempt, result FROM workhorse.job_outcome WHERE job_id = %s",
            (job_id,),
        ).fetchone() == ("succeeded", 1, {"decision": {"approved": True}})


def test_human_wait_rejects_changed_context_on_replay(database_url: str) -> None:
    prompt = "Approve?"
    conflicts: list[HumanWaitConflictError] = []

    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
    ):
        queue = Queue(enqueue_connection)
        job_id = queue.enqueue("human.conflict", {})
        enqueue_connection.commit()

        def handle(_payload: object, context: HandlerContext) -> object:
            try:
                return context.wait_for_human("review", {"prompt": prompt})
            except HumanWaitConflictError as error:
                conflicts.append(error)
                return {"conflict": True}

        worker = Worker(worker_connection, worker_id="python-human-conflict-worker").handle(
            "human.conflict", handle
        )
        assert worker.run_once() is True
        queue.complete_human_wait(
            job_id,
            "review",
            {"approved": True},
            idempotency_key="human-conflict-completion",
            requested_by="reviewer",
        )
        enqueue_connection.commit()

        prompt = "Reject?"
        assert worker.run_once() is True
        assert len(conflicts) == 1
        assert conflicts[0].job_id == job_id


def test_signal_wait_uses_the_shorter_caller_timeout(database_url: str) -> None:
    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
    ):
        job_id = Queue(enqueue_connection).enqueue("signal.timeout", {})
        enqueue_connection.commit()
        worker = Worker(worker_connection, worker_id="python-signal-timeout-worker").handle(
            "signal.timeout",
            lambda _payload, context: context.wait_for_signal("approval", timeout_ms=40),
        )

        assert worker.run_once() is True
        timeout_ms = worker_connection.execute(
            "SELECT extract(epoch FROM timeout_at - created_at) * 1000 "
            "FROM workhorse.job_signal_wait WHERE job_id = %s AND signal_name = 'approval'",
            (job_id,),
        ).fetchone()
        assert timeout_ms is not None
        assert float(timeout_ms[0]) == pytest.approx(40, abs=5)

        sleep(0.06)
        assert worker.run_once() is False
        assert worker_connection.execute(
            "SELECT state, error->>'name' FROM workhorse.job_outcome WHERE job_id = %s",
            (job_id,),
        ).fetchone() == ("failed", "DeadlineExceeded")


def test_signal_wait_uses_an_earlier_job_deadline(database_url: str) -> None:
    deadline = datetime.now(UTC) + timedelta(seconds=1)

    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
    ):
        job_id = Queue(enqueue_connection).enqueue(
            "signal.deadline",
            {},
            EnqueueOptions(deadline=deadline),
        )
        enqueue_connection.commit()
        worker = Worker(worker_connection, worker_id="python-signal-deadline-worker").handle(
            "signal.deadline",
            lambda _payload, context: context.wait_for_signal("approval", timeout_ms=5_000),
        )

        assert worker.run_once() is True
        assert worker_connection.execute(
            "SELECT signal.timeout_at = runtime.deadline_at "
            "FROM workhorse.job_signal_wait signal "
            "JOIN workhorse.job_runtime runtime ON runtime.job_id = signal.job_id "
            "WHERE signal.job_id = %s AND signal.signal_name = 'approval'",
            (job_id,),
        ).fetchone() == (True,)


def test_signal_payload_limit_counts_utf8_json_bytes(database_url: str) -> None:
    payload = {"text": "🙂" * 6_000}

    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
    ):
        queue = Queue(enqueue_connection)
        job_id = queue.enqueue("signal.unicode", {})
        enqueue_connection.commit()
        worker = Worker(worker_connection, worker_id="python-signal-unicode-worker").handle(
            "signal.unicode", lambda _payload, context: context.wait_for_signal("content")
        )

        assert worker.run_once() is True
        delivered = queue.send_signal(
            job_id,
            "content",
            payload,
            idempotency_key="unicode-content",
            requested_by="content-service",
        )
        assert delivered.status == "delivered"
        assert delivered.payload == payload


def test_signal_wait_rejects_a_stale_fence_with_its_specific_error(database_url: str) -> None:
    observed: list[SignalWaitLeaseLostError] = []

    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
        psycopg.connect(database_url, autocommit=True) as competing_connection,
    ):
        job_id = Queue(enqueue_connection).enqueue("signal.stale", {})
        enqueue_connection.commit()

        def handle(_payload: object, context: HandlerContext) -> dict[str, bool]:
            assert competing_connection.execute(
                "SELECT workhorse.complete_v1(%s, %s, %s, %s)",
                (job_id, "python-signal-stale-worker", context.job.fence_token, "{}"),
            ).fetchone() == (True,)
            try:
                context.wait_for_signal("too-late")
            except SignalWaitLeaseLostError as error:
                observed.append(error)
            return {"ignored": True}

        worker = Worker(worker_connection, worker_id="python-signal-stale-worker").handle(
            "signal.stale", handle
        )
        with pytest.raises(StaleLeaseError):
            worker.run_once()
        assert len(observed) == 1
        assert observed[0].job_id == job_id


class _BlockingWaitCursor:
    def __init__(self, cursor: object, reached: Event, release: Event) -> None:
        self._cursor = cursor
        self._reached = reached
        self._release = release

    @property
    def description(self) -> object:
        return self._cursor.description  # type: ignore[union-attr]

    def __enter__(self) -> _BlockingWaitCursor:
        self._cursor.__enter__()  # type: ignore[union-attr]
        return self

    def __exit__(self, *args: object) -> object:
        return self._cursor.__exit__(*args)  # type: ignore[union-attr]

    def execute(self, query: str, parameters: Sequence[object] = ()) -> object:
        result = self._cursor.execute(query, parameters)  # type: ignore[union-attr]
        if "wait_for_signal_v1" in query:
            self._reached.set()
            assert self._release.wait(timeout=5)
        return result

    def fetchall(self) -> object:
        return self._cursor.fetchall()  # type: ignore[union-attr]


class _BlockingWaitConnection:
    autocommit = True

    def __init__(self, connection: object, reached: Event, release: Event) -> None:
        self._connection = connection
        self._reached = reached
        self._release = release

    def cursor(self) -> _BlockingWaitCursor:
        return _BlockingWaitCursor(
            self._connection.cursor(),  # type: ignore[union-attr]
            self._reached,
            self._release,
        )


def test_concurrent_same_name_signal_waits_coalesce(database_url: str) -> None:
    wait_query_reached = Event()
    release_wait_query = Event()

    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
    ):
        job_id = Queue(enqueue_connection).enqueue("signal.concurrent", {})
        enqueue_connection.commit()

        def handle(_payload: object, context: HandlerContext) -> None:
            errors: list[BaseException] = []

            def wait() -> None:
                try:
                    context.wait_for_signal("approval")
                except BaseException as error:
                    errors.append(error)

            first = Thread(target=wait)
            second = Thread(target=wait)
            first.start()
            assert wait_query_reached.wait(timeout=5)
            second.start()
            sleep(0.02)
            release_wait_query.set()
            first.join(timeout=5)
            second.join(timeout=5)
            assert len(errors) == 2

        worker = Worker(
            _BlockingWaitConnection(worker_connection, wait_query_reached, release_wait_query),  # type: ignore[arg-type]
            worker_id="python-signal-coalesce-worker",
        ).handle("signal.concurrent", handle)

        assert worker.run_once() is True
        assert worker_connection.execute(
            "SELECT count(*) FROM workhorse.job_event "
            "WHERE job_id = %s AND event_type = 'signal_rejected'",
            (job_id,),
        ).fetchone() == (0,)
