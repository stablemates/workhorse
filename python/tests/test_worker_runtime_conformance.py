from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from datetime import UTC, datetime, timedelta
from pathlib import Path
from queue import Empty, SimpleQueue
from threading import Event, Lock, Thread
from time import monotonic, sleep
from typing import Any

import psycopg
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from workhorse import (
    ChildJobRequest,
    EnqueueOptions,
    HandlerContext,
    LifecycleError,
    Queue,
    StaleLeaseError,
    Worker,
)
from workhorse._statements import STATEMENTS, DriverStatement

REPOSITORY = Path(__file__).parents[2]


def test_python_worker_satisfies_every_shared_runtime_fixture(database_url: str) -> None:
    manifest = read_json("protocol/v1/manifest.json")
    fixtures = read_json("protocol/v1/runtime.json")
    coverage: set[str] = set()

    with psycopg.connect(database_url, autocommit=True) as connection:
        for fixture in fixtures:
            execute_runtime_fixture(connection, fixture, database_url)
            coverage.update(fixture["covers"])

    assert coverage == set(manifest["runtimeCoverage"])


def execute_runtime_fixture(
    connection: psycopg.Connection[Any], fixture: Mapping[str, Any], database_url: str
) -> None:
    executors: dict[str, Callable[[psycopg.Connection[Any], Mapping[str, Any]], None]] = {
        "batch": execute_batch_fixture,
        "suspension-replay": execute_suspension_replay_fixture,
        "cooperative-cancellation": execute_cancellation_fixture,
        "expiration": execute_expiration_fixture,
        "lease-loss": execute_lease_loss_fixture,
        "heartbeat-cadence": execute_heartbeat_fixture,
        # The held poll owns the worker's connection, so the enqueue needs its own.
        "poll-cadence": lambda enqueue_connection, poll_fixture: execute_poll_cadence_fixture(
            enqueue_connection, poll_fixture, database_url
        ),
        "graceful-drain": execute_graceful_drain_fixture,
        "trace-propagation": execute_trace_propagation_fixture,
    }
    assert fixture["kind"] in executors, f"Unsupported runtime fixture kind: {fixture['kind']}"
    executors[fixture["kind"]](connection, fixture)


def execute_trace_propagation_fixture(
    connection: psycopg.Connection[Any], fixture: Mapping[str, Any]
) -> None:
    exporter = InMemorySpanExporter()
    provider = trace.get_tracer_provider()
    if not isinstance(provider, TracerProvider):
        provider = TracerProvider()
        trace.set_tracer_provider(provider)
    provider.add_span_processor(SimpleSpanProcessor(exporter))

    queue_name = runtime_queue(fixture)
    queue = Queue(connection, queue_name)
    with trace.get_tracer("runtime-fixture").start_as_current_span("caller") as caller:
        caller_context = caller.get_span_context()
        job_id = queue.enqueue(fixture["jobType"], {})

    row = connection.execute(
        "SELECT trace_context FROM workhorse.job WHERE id = %s::uuid", (job_id,)
    ).fetchone()
    assert row is not None
    stored = row[0]
    assert isinstance(stored, dict)
    traceparent = stored["traceparent"]

    worker = Worker(connection, queue=queue_name, worker_id=f"python-{fixture['id']}")
    worker.handle(fixture["jobType"], lambda _payload, _context: None)
    assert worker.run_once() is True

    handler = next(
        span for span in exporter.get_finished_spans() if span.name == "workhorse.handler"
    )
    assert handler.context is not None
    assert handler.context.trace_id == caller_context.trace_id
    assert handler.parent is not None
    assert format(handler.parent.span_id, "016x") == traceparent.split("-")[2]


def execute_batch_fixture(connection: psycopg.Connection[Any], fixture: Mapping[str, Any]) -> None:
    queue_name = runtime_queue(fixture)
    queue = Queue(connection)
    job_ids = {
        job["key"]: queue.enqueue(
            fixture["jobType"],
            {"key": job["key"], "outcome": job["outcome"]},
            EnqueueOptions(
                queue=queue_name,
                priority=job["priority"],
                max_attempts=job["maxAttempts"],
                retry_policy={"type": "fixed", "delayMs": 0},
            ),
        )
        for job in fixture["jobs"]
    }
    seen: list[str] = []
    worker: Worker

    def handle_batch(items: Any) -> list[dict[str, object]]:
        seen.extend(item.payload["key"] for item in items)
        worker.pause()
        return [
            (
                {
                    "status": "succeeded",
                    "result": {"attempt": item.context.job.attempt},
                }
                if item.payload["outcome"] == "succeed" or item.context.job.attempt > 1
                else {
                    "status": "failed",
                    "error": RuntimeError(
                        f"{item.payload['outcome']} on attempt {item.context.job.attempt}"
                    ),
                }
            )
            for item in items
        ]

    worker = Worker(
        connection,
        queue=queue_name,
        worker_id=f"python-{fixture['id']}",
        concurrency=fixture["concurrency"],
    ).handle_batch(
        fixture["jobType"],
        handle_batch,
        max_size=fixture["batchMaxSize"],
        linger_ms=100,
    )

    assert worker.run_once() is True
    assert seen == fixture["expectedHandlerOrder"]
    assert_job_states(connection, job_ids, fixture["expectedAfterFirstRun"])
    worker.resume()
    assert worker.run_once() is True
    assert_job_states(connection, job_ids, fixture["expectedAfterSecondRun"])


def execute_suspension_replay_fixture(
    connection: psycopg.Connection[Any], fixture: Mapping[str, Any]
) -> None:
    queue_name = runtime_queue(fixture)
    queue = Queue(connection)
    job_ids = {
        "suspension": queue.enqueue(fixture["jobType"], {}, EnqueueOptions(queue=queue_name)),
        "following": queue.enqueue(
            fixture["followingJobType"], {}, EnqueueOptions(queue=queue_name)
        ),
    }
    seen: list[str] = []
    handler_runs = 0
    checkpoint_operations = 0
    worker: Worker

    def suspension(_payload: object, context: HandlerContext) -> dict[str, object]:
        nonlocal handler_runs, checkpoint_operations
        handler_runs += 1
        seen.append(f"suspension:{context.job.attempt}")

        def prepare() -> dict[str, int]:
            nonlocal checkpoint_operations
            checkpoint_operations += 1
            return {"operation": checkpoint_operations}

        prepared = context.checkpoint(fixture["checkpointName"], prepare)
        if handler_runs == 1:
            worker.pause()
        context.sleep(fixture["waitName"], fixture["waitMs"])
        return {"prepared": prepared, "handlerRuns": handler_runs}

    def following(_payload: object, context: HandlerContext) -> dict[str, bool]:
        seen.append(f"following:{context.job.attempt}")
        return {"handled": True}

    worker = (
        Worker(
            connection,
            queue=queue_name,
            worker_id=f"python-{fixture['id']}",
            maintenance_interval_ms=100,
        )
        .handle(fixture["jobType"], suspension)
        .handle(fixture["followingJobType"], following)
    )

    assert worker.run_once() is True
    assert_job_states(connection, job_ids, fixture["expectedAfterSuspension"])
    assert_attempt_count(
        connection, job_ids["suspension"], fixture["expectedAttemptsAfterSuspension"]
    )

    worker.resume()
    assert worker.run_once() is True
    assert_job_states(connection, job_ids, fixture["expectedAfterSlotRelease"])

    # The wait is long enough that it cannot elapse between the suspension and the slot
    # release check on a slow runner. Rewind it, as the Go fixture does, instead of
    # sleeping through it, and promote it explicitly rather than waiting for the worker's
    # maintenance interval.
    connection.execute(
        "UPDATE workhorse.job_runtime SET run_at = clock_timestamp() - interval '1 millisecond'"
        " WHERE job_id = %s",
        (job_ids["suspension"],),
    )
    connection.execute("SELECT * FROM workhorse.tick_v1(100, 100)").fetchall()
    assert worker.run_once() is True
    assert_job_states(connection, job_ids, fixture["expectedAfterReplay"])
    assert_attempt_count(connection, job_ids["suspension"], fixture["expectedAttemptsAfterReplay"])
    assert seen == fixture["expectedHandlerOrder"]
    assert handler_runs == fixture["expectedHandlerRuns"]
    assert checkpoint_operations == fixture["expectedCheckpointOperations"]


def execute_cancellation_fixture(
    connection: psycopg.Connection[Any], fixture: Mapping[str, Any]
) -> None:
    queue_name = runtime_queue(fixture)
    job_id = Queue(connection).enqueue(fixture["jobType"], {}, EnqueueOptions(queue=queue_name))
    started = Event()
    abort_reasons: list[str] = []
    errors: list[BaseException] = []

    def handler(_payload: object, context: HandlerContext) -> None:
        started.set()
        assert context.cancellation.wait(timeout=5)
        reason = context.cancellation.reason
        abort_reasons.append(type(reason).__name__)
        raise reason

    worker = Worker(
        connection,
        queue=queue_name,
        worker_id=f"python-{fixture['id']}",
        lease_ms=fixture["leaseMs"],
        heartbeat_ms=fixture["heartbeatMs"],
    ).handle(fixture["jobType"], handler)
    thread = run_in_thread(worker.run_once, errors)
    assert started.wait(timeout=5)
    cancellation = Queue(connection).cancel(
        job_id,
        requested_by="runtime-fixture",
        reason=fixture["cancelReason"],
    )
    assert cancellation.status == "cancel_requested"
    assert cancellation.requested_by == "runtime-fixture"
    join(thread)
    assert errors == []
    assert abort_reasons == [fixture["expectedAbortReason"]]
    assert_job_states(connection, {"job": job_id}, {"job": fixture["expectedState"]})
    assert_attempt_outcomes(connection, job_id, [fixture["expectedAttemptOutcome"]])


def execute_expiration_fixture(
    connection: psycopg.Connection[Any], fixture: Mapping[str, Any]
) -> None:
    queue_name = runtime_queue(fixture)
    expiration = datetime.now(UTC) + timedelta(milliseconds=fixture["durationMs"])
    options = (
        EnqueueOptions(
            queue=queue_name,
            deadline=expiration,
            max_attempts=fixture["maxAttempts"],
            retry_policy={"type": "fixed", "delayMs": 0},
        )
        if fixture["mode"] == "deadline"
        else EnqueueOptions(
            queue=queue_name,
            execution_timeout_ms=fixture["durationMs"],
            max_attempts=fixture["maxAttempts"],
            retry_policy={"type": "fixed", "delayMs": 0},
        )
    )
    job_id = Queue(connection).enqueue(fixture["jobType"], {}, options)
    abort_reasons: list[str] = []
    worker: Worker

    def handler(_payload: object, context: HandlerContext) -> None:
        assert context.cancellation.wait(timeout=5)
        reason = context.cancellation.reason
        abort_reasons.append(type(reason).__name__)
        worker.pause()
        raise reason

    worker = Worker(
        connection,
        queue=queue_name,
        worker_id=f"python-{fixture['id']}",
        lease_ms=fixture["leaseMs"],
        heartbeat_ms=fixture["heartbeatMs"],
    ).handle(fixture["jobType"], handler)
    original_rows = worker._executor.rows

    def early_claim(statement: DriverStatement, parameters: Any = ()) -> list[Mapping[str, object]]:
        rows = original_rows(statement, parameters)
        if statement is STATEMENTS.claim_many and rows:
            claimed = dict(rows[0])
            field = "deadline_at" if fixture["mode"] == "deadline" else "attempt_timeout_at"
            value = claimed[field]
            assert isinstance(value, datetime)
            claimed[field] = value - timedelta(milliseconds=fixture["localClockLeadMs"])
            return [claimed]
        return rows

    worker._executor.rows = early_claim  # type: ignore[method-assign]
    for expected in fixture["expectedAfterRuns"]:
        worker.resume()
        assert worker.run_once() is True
        assert_job_states(connection, {"job": job_id}, {"job": expected})
    assert abort_reasons == fixture["expectedAbortReasons"]
    assert_attempt_outcomes(connection, job_id, fixture["expectedAttemptOutcomes"])


def execute_lease_loss_fixture(
    connection: psycopg.Connection[Any], fixture: Mapping[str, Any]
) -> None:
    queue_name = runtime_queue(fixture)
    job_id = Queue(connection).enqueue(
        fixture["jobType"],
        {},
        EnqueueOptions(
            queue=queue_name,
            max_attempts=fixture["maxAttempts"],
            retry_policy={"type": "fixed", "delayMs": 0},
        ),
    )
    started = Event()
    abort_messages: list[str] = []
    rejected_writes: dict[str, str] = {}
    errors: list[BaseException] = []

    def handler(_payload: object, context: HandlerContext) -> dict[str, bool]:
        started.set()
        assert context.cancellation.wait(timeout=5)
        reason = context.cancellation.reason
        assert isinstance(reason, StaleLeaseError)
        abort_messages.append(str(reason))
        writes: list[tuple[str, Callable[[], object]]] = [
            ("checkpoint", lambda: context.checkpoint("too-late", lambda: {"late": True})),
            ("sleep", lambda: context.sleep("too-late", 1)),
            (
                "sleepUntil",
                lambda: context.sleep_until("too-late-until", datetime.now(UTC)),
            ),
            ("waitForSignal", lambda: context.wait_for_signal("too-late")),
            ("waitForHuman", lambda: context.wait_for_human("too-late", {"late": True})),
            ("runChild", lambda: context.run_child("too-late", "protocol.child", {})),
            (
                "runChildren",
                lambda: context.run_children([ChildJobRequest("too-late", "protocol.child", {})]),
            ),
        ]
        for name, write in writes:
            try:
                write()
            except BaseException as error:
                assert isinstance(error, LifecycleError)
                rejected_writes[name] = str(error)
        return {"late": True}

    worker = Worker(
        connection,
        queue=queue_name,
        worker_id=f"python-{fixture['id']}",
        lease_ms=fixture["leaseMs"],
        heartbeat_ms=fixture["heartbeatMs"],
    ).handle(fixture["jobType"], handler)
    thread = run_in_thread(worker.run_once, errors)
    assert started.wait(timeout=5)
    connection.execute(
        "UPDATE workhorse.job_runtime SET expires_at = clock_timestamp() - interval '1 ms' "
        "WHERE job_id = %s",
        (job_id,),
    )
    recovered = connection.execute(
        "SELECT rows_affected FROM workhorse.recover_expired_telemetry_v1(%s, %s)",
        (100, 0),
    ).fetchone()
    assert recovered == (1,)
    join(thread)
    assert len(errors) == 1 and isinstance(errors[0], StaleLeaseError)
    assert abort_messages == [fixture["expectedAbortMessage"]]
    assert set(fixture["portableRejectedWrites"]) <= set(fixture["expectedRejectedWrites"])
    assert list(rejected_writes) == fixture["portableRejectedWrites"]
    assert set(rejected_writes.values()) == {fixture["expectedRejectedWriteError"]}
    assert_job_states(connection, {"job": job_id}, {"job": fixture["expectedState"]})
    assert_attempt_outcomes(connection, job_id, [fixture["expectedAttemptOutcome"]])


def execute_heartbeat_fixture(
    connection: psycopg.Connection[Any], fixture: Mapping[str, Any]
) -> None:
    queue_name = runtime_queue(fixture)
    Queue(connection).enqueue(fixture["jobType"], {}, EnqueueOptions(queue=queue_name))
    handler_started = Event()
    release_handler = Event()
    first_heartbeat_started = Event()
    release_first_heartbeat = Event()
    counter_lock = Lock()
    heartbeat_calls = 0
    active_heartbeats = 0
    maximum_overlap = 0
    errors: list[BaseException] = []

    def handler(_payload: object, _context: HandlerContext) -> None:
        handler_started.set()
        assert release_handler.wait(timeout=5)

    worker = Worker(
        connection,
        queue=queue_name,
        worker_id=f"python-{fixture['id']}",
        lease_ms=fixture["leaseMs"],
        heartbeat_ms=fixture["heartbeatMs"],
    ).handle(fixture["jobType"], handler)
    original_rows = worker._executor.rows

    def delayed_heartbeat(
        statement: DriverStatement, parameters: Any = ()
    ) -> list[Mapping[str, object]]:
        nonlocal heartbeat_calls, active_heartbeats, maximum_overlap
        if statement is not STATEMENTS.heartbeat_many:
            return original_rows(statement, parameters)
        with counter_lock:
            heartbeat_calls += 1
            call = heartbeat_calls
            active_heartbeats += 1
            maximum_overlap = max(maximum_overlap, active_heartbeats)
        try:
            if call == 1:
                first_heartbeat_started.set()
                assert release_first_heartbeat.wait(timeout=5)
            return original_rows(statement, parameters)
        finally:
            with counter_lock:
                active_heartbeats -= 1

    worker._executor.rows = delayed_heartbeat  # type: ignore[method-assign]
    thread = run_in_thread(worker.run_once, errors)
    assert handler_started.wait(timeout=5)
    assert first_heartbeat_started.wait(timeout=5)
    sleep(fixture["heartbeatMs"] * 3 / 1000)
    assert heartbeat_calls == fixture["expectedCallsWhileBlocked"]
    release_first_heartbeat.set()
    wait_for(
        lambda: heartbeat_calls >= fixture["expectedMinimumCallsBeforeSettlement"],
        f"{fixture['id']} did not schedule another heartbeat",
    )
    assert maximum_overlap == fixture["expectedMaximumOverlap"]
    release_handler.set()
    join(thread)
    assert errors == []
    calls_at_settlement = heartbeat_calls
    sleep(fixture["heartbeatMs"] * 3 / 1000)
    assert heartbeat_calls == calls_at_settlement


class HeldPollConnection:
    """Holds the worker at the end of each empty claim until the test releases it.

    Counting empty polls is not enough: an uncounted poll between the count and the enqueue
    advances the backoff step, and the delay is then measured against the wrong one.
    """

    def __init__(self, connection: psycopg.Connection[Any]) -> None:
        self._connection = connection
        self.holding = True
        self.reached: SimpleQueue[None] = SimpleQueue()
        self.released: SimpleQueue[None] = SimpleQueue()

    @property
    def autocommit(self) -> bool:
        return self._connection.autocommit

    def cursor(self) -> Any:
        return HeldPollCursor(self, self._connection.cursor())

    def release(self) -> None:
        self.released.put(None)


class HeldPollCursor:
    def __init__(self, gate: HeldPollConnection, cursor: Any) -> None:
        self._gate = gate
        self._cursor = cursor
        self._holds = False

    def __enter__(self) -> HeldPollCursor:
        self._cursor.__enter__()
        return self

    def __exit__(self, *args: object) -> object:
        return self._cursor.__exit__(*args)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._cursor, name)

    def execute(self, sql: str, parameters: Any = ()) -> object:
        self._holds = self._gate.holding and "claim_many_v1" in sql
        return self._cursor.execute(sql, parameters)

    def fetchall(self) -> Any:
        rows = self._cursor.fetchall()
        if self._holds:
            self._holds = False
            self._gate.reached.put(None)
            self._gate.released.get(timeout=5)
        return rows


def execute_poll_cadence_fixture(
    connection: psycopg.Connection[Any], fixture: Mapping[str, Any], database_url: str
) -> None:
    queue_name = runtime_queue(fixture)
    handled = Event()
    handled_at = 0.0
    with psycopg.connect(database_url, autocommit=True) as worker_connection:
        gate = HeldPollConnection(worker_connection)
        worker = Worker(
            gate,
            queue=queue_name,
            worker_id=f"python-{fixture['id']}",
            poll_ms=fixture["pollMs"],
            registry_interval_ms=0,
        )

        def handle(_payload: object, _context: HandlerContext) -> None:
            nonlocal handled_at
            handled_at = monotonic()
            handled.set()

        worker.handle(fixture["jobType"], handle)
        running = Thread(target=worker.run)
        running.start()
        try:
            enqueued_at = 0.0
            for poll in range(1, fixture["emptyPollsBeforeEnqueue"] + 1):
                try:
                    gate.reached.get(timeout=fixture["expectedMaximumDelayMs"] / 1_000 + 1)
                except Empty:
                    raise AssertionError(
                        f"worker did not complete empty poll {poll} before the backoff check"
                    ) from None
                if poll == fixture["emptyPollsBeforeEnqueue"]:
                    # A stall longer than one backoff step. A held worker cannot advance past
                    # the pinned step, so this changes nothing; an unheld one fails every run.
                    sleep(fixture["enqueueStallMs"] / 1_000)
                    Queue(connection).enqueue(
                        fixture["jobType"], {}, EnqueueOptions(queue=queue_name)
                    )
                    enqueued_at = monotonic()
                    gate.holding = False
                gate.release()
            assert handled.wait(fixture["expectedMaximumDelayMs"] / 1_000 + 1)
            delay_ms = (handled_at - enqueued_at) * 1_000
            assert delay_ms >= fixture["expectedMinimumDelayMs"]
            assert delay_ms <= fixture["expectedMaximumDelayMs"]
        finally:
            gate.holding = False
            gate.release()
            worker.stop()
            running.join(timeout=2)
            assert not running.is_alive()


def execute_graceful_drain_fixture(
    connection: psycopg.Connection[Any], fixture: Mapping[str, Any]
) -> None:
    queue_name = runtime_queue(fixture)
    queue = Queue(connection)
    job_ids = [
        queue.enqueue(fixture["jobType"], {"sequence": sequence}, EnqueueOptions(queue=queue_name))
        for sequence in range(fixture["jobCount"])
    ]
    release_handlers = Event()
    errors: list[BaseException] = []

    def handler(_payload: object, _context: HandlerContext) -> None:
        assert release_handlers.wait(timeout=5)

    worker = Worker(
        connection,
        queue=queue_name,
        worker_id=f"python-{fixture['id']}",
        concurrency=fixture["concurrency"],
        poll_ms=5_000,
    ).handle(fixture["jobType"], handler)
    thread = run_in_thread(worker.run, errors)
    wait_for(
        lambda: active_slots(worker) == fixture["expectedActiveAtStop"],
        f"{fixture['id']} did not fill its active slots",
    )
    worker.stop()
    assert active_slots(worker) == fixture["expectedActiveAtStop"]
    sleep(fixture["settleCheckMs"] / 1000)
    assert thread.is_alive()
    release_handlers.set()
    join(thread)
    assert errors == []
    assert active_slots(worker) == 0
    states = [job_state(connection, job_id)["state"] for job_id in job_ids]
    assert states.count("succeeded") == fixture["expectedSucceeded"]
    assert states.count("ready") == fixture["expectedReady"]


def assert_job_states(
    connection: psycopg.Connection[Any],
    job_ids: Mapping[str, str],
    expected: Mapping[str, Mapping[str, Any]],
) -> None:
    for key, expected_state in expected.items():
        actual = job_state(connection, job_ids[key])
        assert actual["state"] == expected_state["state"], key
        assert actual["attempt"] == expected_state["attempt"], key
        if "errorName" in expected_state:
            assert actual["error_name"] == expected_state["errorName"], key


def job_state(connection: psycopg.Connection[Any], job_id: str) -> dict[str, object]:
    row = connection.execute(
        "SELECT state, current_attempt, error->>'name' FROM workhorse.job_runtime "
        "WHERE job_id = %s UNION ALL "
        "SELECT state, current_attempt, error->>'name' FROM workhorse.job_outcome "
        "WHERE job_id = %s",
        (job_id, job_id),
    ).fetchone()
    assert row is not None, job_id
    return {"state": row[0], "attempt": row[1], "error_name": row[2]}


def assert_attempt_count(connection: psycopg.Connection[Any], job_id: str, expected: int) -> None:
    row = connection.execute(
        "SELECT count(*) FROM workhorse.attempt_history WHERE job_id = %s", (job_id,)
    ).fetchone()
    assert row == (expected,)


def assert_attempt_outcomes(
    connection: psycopg.Connection[Any], job_id: str, expected: list[str]
) -> None:
    rows = connection.execute(
        "SELECT outcome FROM workhorse.attempt_history WHERE job_id = %s ORDER BY attempt",
        (job_id,),
    ).fetchall()
    assert [row[0] for row in rows] == expected


def run_in_thread(operation: Callable[[], object], errors: list[BaseException]) -> Thread:
    def run() -> None:
        try:
            operation()
        except BaseException as error:
            errors.append(error)

    thread = Thread(target=run)
    thread.start()
    return thread


def join(thread: Thread) -> None:
    thread.join(timeout=5)
    assert not thread.is_alive()


def wait_for(condition: Callable[[], bool], message: str) -> None:
    deadline = monotonic() + 5
    while not condition():
        assert monotonic() < deadline, message
        sleep(0.005)


def active_slots(worker: Worker) -> int:
    with worker._state_lock:
        return len(worker._active_threads)


def runtime_queue(fixture: Mapping[str, Any]) -> str:
    return f"runtime-{fixture['id']}"


def read_json(relative: str) -> Any:
    return json.loads((REPOSITORY / relative).read_text())
