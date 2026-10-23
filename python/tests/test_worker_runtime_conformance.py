from __future__ import annotations
# ruff: noqa


import asyncio
import json
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator, Mapping
from contextlib import AbstractContextManager, asynccontextmanager, contextmanager, suppress
from datetime import UTC, datetime, timedelta
from pathlib import Path
from queue import Empty, SimpleQueue
from threading import Event, Lock, Thread
from time import monotonic, sleep
from typing import Any

import asyncpg
import psycopg
import pytest
from psycopg_pool import AsyncConnectionPool, ConnectionPool
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from workhorse import (
    Admin,
    AdminAudit,
    AsyncHandlerContext,
    AsyncWorker,
    BudgetDefinition,
    ChildTaskRequest,
    EnqueueOptions,
    HandlerContext,
    LifecycleError,
    Queue,
    RateLimit,
    RateLimitPolicyDefinition,
    StaleLeaseError,
    Worker,
)
import workhorse.worker as worker_module
from workhorse._statements import SQL_STATEMENTS, STATEMENTS, DriverStatement
from workhorse._drivers import PooledSyncExecutor, SyncExecutor

REPOSITORY = Path(__file__).parents[2]


# Fixture kinds AsyncWorker drives through its own bridge. AsyncWorker wraps the same worker core,
# so what the async flavour proves is that the bridge preserves the core's behavior: handler
# invocation, the durable context, and the heartbeat executor it opens for itself. The remaining
# kinds monkeypatch the sync worker's executor or drive raw sessions, so they pin SQL protocol
# rather than bridge behavior, and the sync flavour owns them.
ASYNC_RUNTIME_FIXTURE_KINDS = frozenset(
    {
        "cooperative-cancellation",
        "graceful-drain",
        "heartbeat-busy",
        "heartbeat-failure",
        "json-round-trip",
        "maintenance-phase-error",
        "missing-handler",
        "release-wait",
        "subscription-recovery",
    }
)
SYNC_ONLY_RUNTIME_FIXTURE_KINDS = frozenset(
    {
        "batch",
        "budget-admission-race",
        "expiration",
        "heartbeat-cadence",
        "lease-loss",
        "oversized-result",
        "poll-cadence",
        "slot-refill",
        "suspension-replay",
        "replay-conflict",
        "shutdown-cancellation",
        "trace-propagation",
    }
)


@pytest.mark.parametrize("worker_flavour", ["sync", "async"])
def test_python_worker_satisfies_every_shared_runtime_fixture(
    database_url: str, worker_flavour: str
) -> None:
    manifest = read_json("protocol/v1/manifest.json")
    fixtures = read_json("protocol/v1/runtime.json")
    kinds = {fixture["kind"] for fixture in fixtures}
    # A new fixture kind belongs to one flavour or the other, deliberately.
    assert kinds <= ASYNC_RUNTIME_FIXTURE_KINDS | SYNC_ONLY_RUNTIME_FIXTURE_KINDS
    coverage: set[str] = set()

    with psycopg.connect(database_url, autocommit=True) as connection:
        for fixture in fixtures:
            if worker_flavour == "async":
                if fixture["kind"] not in ASYNC_RUNTIME_FIXTURE_KINDS:
                    continue
                asyncio.run(execute_async_runtime_fixture(connection, fixture, database_url))
            else:
                execute_runtime_fixture(connection, fixture, database_url)
            coverage.update(fixture["covers"])

    if worker_flavour == "async":
        assert coverage == {
            capability
            for fixture in fixtures
            if fixture["kind"] in ASYNC_RUNTIME_FIXTURE_KINDS
            for capability in fixture["covers"]
        }
        return
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
        "slot-refill": execute_slot_refill_fixture,
        # The worker runs on a pool of its own, so the runner can hold its LISTEN.
        "subscription-recovery": lambda enqueue_connection, recovery_fixture: (
            execute_subscription_recovery_fixture(
                enqueue_connection, recovery_fixture, database_url
            )
        ),
        "trace-propagation": execute_trace_propagation_fixture,
        # The race holds three sessions of its own besides the setup connection.
        "budget-admission-race": lambda setup_connection, race_fixture: (
            execute_budget_admission_race_fixture(setup_connection, race_fixture, database_url)
        ),
        "missing-handler": execute_missing_handler_fixture,
        "release-wait": execute_release_wait_fixture,
        "replay-conflict": execute_replay_conflict_fixture,
        "json-round-trip": execute_json_round_trip_fixture,
        "oversized-result": execute_oversized_result_fixture,
        "shutdown-cancellation": execute_shutdown_cancellation_fixture,
        "heartbeat-failure": execute_heartbeat_failure_fixture,
        "heartbeat-busy": execute_heartbeat_busy_fixture,
        "maintenance-phase-error": execute_maintenance_phase_error_fixture,
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
        task_id = queue.enqueue(fixture["taskType"], {})

    row = connection.execute(
        "SELECT trace_context FROM workhorse.task WHERE id = %s::uuid", (task_id,)
    ).fetchone()
    assert row is not None
    stored = row[0]
    assert isinstance(stored, dict)
    traceparent = stored["traceparent"]

    worker = Worker(worker_pool, queue=queue_name, worker_id=f"python-{fixture['id']}")
    worker.handle(fixture["taskType"], lambda _payload, _context: None)
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
    task_ids = {
        task["key"]: queue.enqueue(
            fixture["taskType"],
            {"key": task["key"], "outcome": task["outcome"]},
            EnqueueOptions(
                queue=queue_name,
                priority=task["priority"],
                max_attempts=task["maxAttempts"],
                retry_policy={"type": "fixed", "delayMs": 0},
            ),
        )
        for task in fixture["tasks"]
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
                    "result": {"attempt": item.context.task.attempt},
                }
                if item.payload["outcome"] == "succeed" or item.context.task.attempt > 1
                else {
                    "status": "failed",
                    "error": RuntimeError(
                        f"{item.payload['outcome']} on attempt {item.context.task.attempt}"
                    ),
                }
            )
            for item in items
        ]

    worker = Worker(
        worker_pool,
        queue=queue_name,
        worker_id=f"python-{fixture['id']}",
        concurrency=fixture["concurrency"],
    ).handle_batch(
        fixture["taskType"],
        handle_batch,
        max_size=fixture["batchMaxSize"],
        # SM-1538: a full batch dispatches at once. A short linger split the batch when one member
        # thread started late under host load, which changed the handler order.
        linger_ms=1_000,
    )

    assert worker.run_once() is True
    assert seen == fixture["expectedHandlerOrder"]
    assert_task_states(connection, task_ids, fixture["expectedAfterFirstRun"])
    worker.resume()
    assert worker.run_once() is True
    assert_task_states(connection, task_ids, fixture["expectedAfterSecondRun"])


def execute_suspension_replay_fixture(
    connection: psycopg.Connection[Any], fixture: Mapping[str, Any]
) -> None:
    queue_name = runtime_queue(fixture)
    queue = Queue(connection)
    task_ids = {
        "suspension": queue.enqueue(fixture["taskType"], {}, EnqueueOptions(queue=queue_name)),
        "following": queue.enqueue(
            fixture["followingTaskType"], {}, EnqueueOptions(queue=queue_name)
        ),
    }
    seen: list[str] = []
    handler_runs = 0
    checkpoint_operations = 0
    worker: Worker

    def suspension(_payload: object, context: HandlerContext) -> dict[str, object]:
        nonlocal handler_runs, checkpoint_operations
        handler_runs += 1
        seen.append(f"suspension:{context.task.attempt}")

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
        seen.append(f"following:{context.task.attempt}")
        return {"handled": True}

    worker = (
        Worker(
            worker_pool,
            queue=queue_name,
            worker_id=f"python-{fixture['id']}",
            maintenance_interval_ms=100,
        )
        .handle(fixture["taskType"], suspension)
        .handle(fixture["followingTaskType"], following)
    )

    assert worker.run_once() is True
    assert_task_states(connection, task_ids, fixture["expectedAfterSuspension"])
    assert_attempt_count(
        connection, task_ids["suspension"], fixture["expectedAttemptsAfterSuspension"]
    )

    worker.resume()
    assert worker.run_once() is True
    assert_task_states(connection, task_ids, fixture["expectedAfterSlotRelease"])

    # The wait is long enough that it cannot elapse between the suspension and the slot
    # release check on a slow runner. Rewind it, as the Go fixture does, instead of
    # sleeping through it, and promote it explicitly rather than waiting for the worker's
    # maintenance interval.
    connection.execute(
        "UPDATE workhorse.task_runtime SET run_at = clock_timestamp() - interval '1 millisecond'"
        " WHERE task_id = %s",
        (task_ids["suspension"],),
    )
    connection.execute("SELECT * FROM workhorse.tick_v1(100, 100)").fetchall()
    assert worker.run_once() is True
    assert_task_states(connection, task_ids, fixture["expectedAfterReplay"])
    assert_attempt_count(connection, task_ids["suspension"], fixture["expectedAttemptsAfterReplay"])
    assert seen == fixture["expectedHandlerOrder"]
    assert handler_runs == fixture["expectedHandlerRuns"]
    assert checkpoint_operations == fixture["expectedCheckpointOperations"]


def execute_cancellation_fixture(
    connection: psycopg.Connection[Any], fixture: Mapping[str, Any]
) -> None:
    queue_name = runtime_queue(fixture)
    task_id = Queue(connection).enqueue(fixture["taskType"], {}, EnqueueOptions(queue=queue_name))
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
        worker_pool,
        queue=queue_name,
        worker_id=f"python-{fixture['id']}",
        lease_ms=fixture["leaseMs"],
        heartbeat_ms=fixture["heartbeatMs"],
        shared_heartbeats=True,
    ).handle(fixture["taskType"], handler)
    thread = run_in_thread(worker.run_once, errors)
    assert started.wait(timeout=5)
    cancellation = Queue(connection).cancel(
        task_id,
        requested_by="runtime-fixture",
        reason=fixture["cancelReason"],
    )
    assert cancellation.status == "cancel_requested"
    assert cancellation.requested_by == "runtime-fixture"
    join(thread)
    assert errors == []
    assert abort_reasons == [fixture["expectedAbortReason"]]
    assert_task_states(connection, {"task": task_id}, {"task": fixture["expectedState"]})
    assert_attempt_outcomes(connection, task_id, [fixture["expectedAttemptOutcome"]])


def execute_expiration_fixture(
    connection: psycopg.Connection[Any], fixture: Mapping[str, Any]
) -> None:
    queue_name = runtime_queue(fixture)
    # The deadline budget starts after the claim, inside early_claim. This value only has to be
    # far enough away that the claim never skips the task.
    placeholder = datetime.now(UTC) + timedelta(hours=1)
    options = (
        EnqueueOptions(
            queue=queue_name,
            deadline=placeholder,
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
    task_id = Queue(connection).enqueue(fixture["taskType"], {}, options)
    abort_reasons: list[str] = []
    # The expiry PostgreSQL holds for each attempt, and its clock when the handler saw cancellation.
    database_expiries: list[datetime] = []
    cancelled_at: list[datetime] = []
    worker: Worker

    def handler(_payload: object, context: HandlerContext) -> None:
        assert context.cancellation.wait(timeout=5)
        now = connection.execute("SELECT clock_timestamp()").fetchone()
        assert now is not None
        cancelled_at.append(now[0])
        reason = context.cancellation.reason
        abort_reasons.append(type(reason).__name__)
        worker.pause()
        raise reason

    worker = Worker(
        worker_pool,
        queue=queue_name,
        worker_id=f"python-{fixture['id']}",
        lease_ms=fixture["leaseMs"],
        heartbeat_ms=fixture["heartbeatMs"],
        shared_heartbeats=True,
    ).handle(fixture["taskType"], handler)
    original_rows = worker._executor.rows

    def early_claim(statement: DriverStatement, parameters: Any = ()) -> list[Mapping[str, object]]:
        rows = original_rows(statement, parameters)
        if statement is STATEMENTS.claim_many and rows:
            claimed = dict(rows[0])
            if fixture["mode"] == "deadline":
                field = "deadline_at"
                anchored = connection.execute(
                    "UPDATE workhorse.task_runtime "
                    "SET deadline_at = clock_timestamp() + (%s * interval '1 millisecond') "
                    "WHERE task_id = %s RETURNING deadline_at",
                    (fixture["durationMs"], task_id),
                ).fetchone()
                assert anchored is not None
                value = anchored[0]
            else:
                field = "attempt_timeout_at"
                value = claimed[field]
            assert isinstance(value, datetime)
            database_expiries.append(value)
            claimed[field] = value - timedelta(milliseconds=fixture["localClockLeadMs"])
            return [claimed]
        return rows

    worker._executor.rows = early_claim  # type: ignore[method-assign]
    for expected in fixture["expectedAfterRuns"]:
        worker.resume()
        assert worker.run_once() is True
        assert_task_states(connection, {"task": task_id}, {"task": expected})
    assert abort_reasons == fixture["expectedAbortReasons"]
    # Both times come from the database clock, so the worker clock cannot move either one.
    assert len(database_expiries) == len(cancelled_at)
    assert [at >= expiry for at, expiry in zip(cancelled_at, database_expiries, strict=True)] == [
        fixture["expectedCancelledAfterDatabaseExpiry"]
    ] * len(cancelled_at)
    assert_attempt_outcomes(connection, task_id, fixture["expectedAttemptOutcomes"])


def execute_lease_loss_fixture(
    connection: psycopg.Connection[Any], fixture: Mapping[str, Any]
) -> None:
    queue_name = runtime_queue(fixture)
    task_id = Queue(connection).enqueue(
        fixture["taskType"],
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
                lambda: context.run_children([ChildTaskRequest("too-late", "protocol.child", {})]),
            ),
        ]
        for name, write in writes:
            try:
                write()
            except BaseException as error:
                assert isinstance(error, LifecycleError)
                rejected_writes[name] = str(error)
        # The worker survives the loss and would claim the retried attempt next. run_once drains
        # until an empty sweep, so pause claims to keep the fixture's ready state observable.
        worker.pause()
        return {"late": True}

    worker = Worker(
        worker_pool,
        queue=queue_name,
        worker_id=f"python-{fixture['id']}",
        lease_ms=fixture["leaseMs"],
        heartbeat_ms=fixture["heartbeatMs"],
    ).handle(fixture["taskType"], handler)
    # A heartbeat locks the task's runtime row, and recovery skips a locked row. A heartbeat that
    # started just after the expiry would make the recovery below find no lease. Hold every
    # heartbeat until the recovery ends, as the Go fixture does. The first heartbeat after that
    # finds the recovered task and reports the lease as stale. If a full lease passes first, the
    # worker's lease watchdog ends the attempt with the same error and writes nothing.
    recovery_ended = Event()
    open_heartbeat_executor = worker_module._psycopg_pool_heartbeat_executor_factory(worker_pool)

    def open_held_heartbeat_executor() -> tuple[Any, Callable[[], None]]:
        executor, close = open_heartbeat_executor()
        return HeldHeartbeats(executor, recovery_ended), close

    worker._heartbeat_executor_factory = open_held_heartbeat_executor
    run_results: list[bool] = []
    thread = run_in_thread(lambda: run_results.append(worker.run_once()), errors)
    try:
        assert started.wait(timeout=5)
        connection.execute(
            "UPDATE workhorse.task_runtime SET expires_at = clock_timestamp() - interval '1 ms' "
            "WHERE task_id = %s",
            (task_id,),
        )
        recovered = connection.execute(
            "SELECT rows_affected FROM workhorse.recover_expired_telemetry_v1(%s, %s)",
            (100, 0),
        ).fetchone()
        assert recovered == (1,)
    finally:
        recovery_ended.set()
    join(thread)
    assert errors == []
    assert fixture["expectedRunOutcome"] == "processed"
    assert run_results == [True]
    assert abort_messages == [fixture["expectedAbortMessage"]]
    assert set(fixture["portableRejectedWrites"]) <= set(fixture["expectedRejectedWrites"])
    assert list(rejected_writes) == fixture["portableRejectedWrites"]
    assert set(rejected_writes.values()) == {fixture["expectedRejectedWriteError"]}
    assert_task_states(connection, {"task": task_id}, {"task": fixture["expectedState"]})
    assert_attempt_outcomes(connection, task_id, [fixture["expectedAttemptOutcome"]])


class HeldHeartbeats:
    """Send each heartbeat on the worker's own heartbeat executor after the test releases it.

    The heartbeat waits before it reaches PostgreSQL, so it holds no row lock while it waits.
    """

    def __init__(self, executor: Any, released: Event) -> None:
        self._executor = executor
        self._released = released

    def rows(self, statement: DriverStatement, parameters: Any = ()) -> list[Mapping[str, object]]:
        if statement is STATEMENTS.heartbeat_many:
            assert self._released.wait(timeout=5), "held heartbeat was never released"
        return self._executor.rows(statement, parameters)


def execute_heartbeat_fixture(
    connection: psycopg.Connection[Any], fixture: Mapping[str, Any]
) -> None:
    queue_name = runtime_queue(fixture)
    Queue(connection).enqueue(fixture["taskType"], {}, EnqueueOptions(queue=queue_name))
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
        worker_pool,
        queue=queue_name,
        worker_id=f"python-{fixture['id']}",
        lease_ms=fixture["leaseMs"],
        heartbeat_ms=fixture["heartbeatMs"],
        shared_heartbeats=True,
    ).handle(fixture["taskType"], handler)
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
        # Each claim_many_v1 call's start, its return to the worker, and whether it found a task.
        self.claims: list[tuple[float, float, bool]] = []

    @property
    def autocommit(self) -> bool:
        return self._connection.autocommit

    def cursor(self, *, row_factory: Any = None) -> Any:
        return HeldPollCursor(self, self._connection.cursor(row_factory=row_factory))

    def release(self) -> None:
        self.released.put(None)


class HeldPollCursor:
    def __init__(self, gate: HeldPollConnection, cursor: Any) -> None:
        self._gate = gate
        self._cursor = cursor
        self._claim_started: float | None = None

    def __enter__(self) -> HeldPollCursor:
        self._cursor.__enter__()
        return self

    def __exit__(self, *args: object) -> object:
        return self._cursor.__exit__(*args)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._cursor, name)

    def execute(self, sql: str, parameters: Any = ()) -> object:
        self._claim_started = monotonic() if "claim_many_v1" in sql else None
        return self._cursor.execute(sql, parameters)

    def fetchall(self) -> Any:
        rows = self._cursor.fetchall()
        started, self._claim_started = self._claim_started, None
        if started is not None:
            if not rows and self._gate.holding:
                self._gate.reached.put(None)
                self._gate.released.get(timeout=5)
            self._gate.claims.append((started, monotonic(), bool(rows)))
        return rows


def execute_poll_cadence_fixture(
    connection: psycopg.Connection[Any], fixture: Mapping[str, Any], database_url: str
) -> None:
    """Measures the worker's backoff after the last empty claim.

    The delay runs from the moment the last empty claim returns to the worker to the start of the
    next claim. That span is the worker's own cadence. It leaves out the claim that finds the task
    and the dispatch to the handler, so a slow runner cannot charge them to the backoff.
    """
    queue_name = runtime_queue(fixture)
    handled = Event()
    with psycopg.connect(database_url, autocommit=True) as worker_connection:
        gate = HeldPollConnection(worker_connection)
        worker = Worker(
            worker_pool,
            queue=queue_name,
            worker_id=f"python-{fixture['id']}",
            poll_ms=fixture["pollMs"],
            registry_interval_ms=0,
            _executor=SyncExecutor(gate),
        )
        # A listening worker waits the poll interval without doubling, because a notification
        # wakes it for new work. The fixture pins the polling backoff, so the worker polls only.
        worker._listens = False
        worker.handle(fixture["taskType"], lambda _payload, _context: handled.set())
        running = Thread(target=worker.run)
        running.start()
        try:
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
                        fixture["taskType"], {}, EnqueueOptions(queue=queue_name)
                    )
                    gate.holding = False
                gate.release()
            assert handled.wait(fixture["expectedMaximumDelayMs"] / 1_000 + 1)
        finally:
            gate.holding = False
            gate.release()
            worker.stop()
            running.join(timeout=2)
            assert not running.is_alive()
    claims = sorted(gate.claims)
    found = next((index for index, claim in enumerate(claims) if claim[2]), None)
    assert found, "no claim_many_v1 call after an empty poll returned the enqueued task"
    empty = sum(1 for claim in claims[:found] if not claim[2])
    assert empty == fixture["emptyPollsBeforeEnqueue"], (
        f"the worker claimed the task after {empty} empty polls, "
        f"want {fixture['emptyPollsBeforeEnqueue']}"
    )
    delay_ms = (claims[found][0] - claims[found - 1][1]) * 1_000
    assert fixture["expectedMinimumDelayMs"] <= delay_ms <= fixture["expectedMaximumDelayMs"], (
        f"the claim after {empty} empty polls waited {delay_ms:.0f} ms, want "
        f"{fixture['expectedMinimumDelayMs']} to {fixture['expectedMaximumDelayMs']} ms"
    )


class HeldListenPool(ConnectionPool):
    """A psycopg pool that holds each ``LISTEN`` until the test releases it.

    The pool lends the shared listener its connection, so a held ``LISTEN`` keeps the worker
    without a live subscription. Every other statement runs at once. The test can arm the hold
    again for the next ``LISTEN``. The pool records the backend pid of the connection that runs
    ``LISTEN``.
    """

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self.listen_released = Event()
        self.listener_pid: int | None = None
        super().__init__(*args, **kwargs)

    def hold_listen(self) -> None:
        """Holds the next ``LISTEN`` until the test releases it."""
        self.listen_released = Event()

    @contextmanager
    def connection(self, timeout: float | None = None) -> Iterator[Any]:
        with super().connection(timeout=timeout) as connection:
            yield HeldListenConnection(self, connection)


class HeldListenConnection:
    def __init__(self, pool: HeldListenPool, connection: psycopg.Connection[Any]) -> None:
        self._pool = pool
        self._connection = connection

    def __getattr__(self, name: str) -> Any:
        return getattr(self._connection, name)

    def execute(self, query: Any, *args: Any, **kwargs: Any) -> Any:
        if isinstance(query, str) and query.startswith("LISTEN"):
            released = self._pool.listen_released
            assert released.wait(timeout=15), "held LISTEN was never released"
            self._pool.listener_pid = self._connection.info.backend_pid
        return self._connection.execute(query, *args, **kwargs)


class ClaimTimingExecutor:
    """Records each dispatch claim's start, its return to the worker, and whether it found a task.

    The runner can hold the first empty claim that starts at or after ``hold_from``. The recorder
    records that claim, sets ``reached``, and returns it to the worker only after ``released``.
    """

    def __init__(self, executor: PooledSyncExecutor) -> None:
        self._executor = executor
        self._lock = Lock()
        self.recording = True
        self.claims: list[tuple[float, float, bool]] = []
        self.hold_from: float | None = None
        self.reached = Event()
        self.released = Event()

    def rows(self, statement: DriverStatement, parameters: Any = ()) -> Any:
        if statement is not STATEMENTS.claim_many:
            return self._executor.rows(statement, parameters)
        started = monotonic()
        rows = self._executor.rows(statement, parameters)
        with self._lock:
            if self.recording:
                self.claims.append((started, monotonic(), bool(rows)))
            hold = self.hold_from is not None and started >= self.hold_from and not rows
            if hold:
                self.hold_from = None
        if hold:
            self.reached.set()
            assert self.released.wait(timeout=15), "the held claim was never released"
        return rows

    def recorded(self) -> list[tuple[float, float, bool]]:
        with self._lock:
            return list(self.claims)


class EmptyClaimWait:
    """Reads the wait that the worker installs after a claim that found no task.

    The worker installs this wait only when it settles an empty claim. The wait keeps the wake
    version of that claim, so a wake after the claim ends the wait. The worker starts no claim
    while the wait is in place, unless a wake ends it.
    """

    def __init__(self, worker: Worker) -> None:
        self._choose = worker._dispatch_wait_seconds
        self._slots: Any = None
        worker._dispatch_wait_seconds = self._capture  # type: ignore[method-assign]

    def _capture(self, slots: Any) -> float:
        self._slots = slots
        return self._choose(slots)

    def deadline(self) -> float | None:
        """The end of the installed wait that a wake can end, or ``None`` without one."""
        slots = self._slots
        wait = None if slots is None else slots.empty_wait
        return None if wait is None or wait[1] is None else float(wait[0])

    def installed_after(self, moment: float, minimum_ms: float) -> bool:
        """Whether the installed wait ends at least ``minimum_ms`` after ``moment``."""
        deadline = self.deadline()
        return deadline is not None and deadline >= moment + minimum_ms / 1_000


def notification_wait_ms(worker: Worker) -> float:
    """The shortest wait at the notification base: the interval less its jitter of 10 %."""
    return worker._notification_poll_ms * 0.9


def execute_subscription_recovery_fixture(
    connection: psycopg.Connection[Any], fixture: Mapping[str, Any], database_url: str
) -> None:
    """Measures the empty-claim wait without a live subscription, with one, and after its loss.

    The worker can listen, but the pool holds its LISTEN until the runner releases it. Until then
    the worker must poll at the polling-only base. After the release, it must wait the
    notification poll interval. Then the runner ends the listener session. The loss must wake the
    worker, and the worker must poll at the polling-only base again.

    The bounds after the loss start at events that the runner controls, not at the moment the
    runner sees them. A loaded runner sees an event late, and the worker's backoff grows in that
    time, so a late observation would charge the runner's delay to the worker.
    """
    queue_name = runtime_queue(fixture)
    handled: list[str] = []
    errors: list[BaseException] = []
    recovery_end = 0
    lost_at = 0.0
    wait_end: float | None = None
    enqueued_after_loss = 0.0

    def wait_long(condition: Callable[[], bool], message: str) -> None:
        # A bounded wait that is longer than the notification base.
        deadline = monotonic() + 7
        while not condition():
            assert monotonic() < deadline, message
            sleep(0.005)

    with HeldListenPool(
        database_url, min_size=1, max_size=4, kwargs={"autocommit": True}, open=True
    ) as pool:
        executor = ClaimTimingExecutor(PooledSyncExecutor(pool))
        worker = Worker(
            pool,
            queue=queue_name,
            worker_id=f"python-{fixture['id']}",
            registry_interval_ms=0,
            _executor=executor,
        ).handle(
            fixture["taskType"],
            lambda payload, _context: handled.append(payload["task"]),
        )
        empty_wait = EmptyClaimWait(worker)
        thread = run_in_thread(worker.run, errors)
        try:
            wait_for(
                lambda: any(not claim[2] for claim in executor.recorded()),
                "the worker made no empty claim before the first enqueue",
            )
            queue = Queue(connection)
            queue.enqueue(fixture["taskType"], {"task": "first"}, EnqueueOptions(queue=queue_name))
            wait_for(lambda: len(handled) == 1, "the worker did not run the first task")

            pool.listen_released.set()
            # Other test processes can listen on the same database, so the runner reads the
            # worker's own flag. The listener sets it after LISTEN returns.
            wait_for(worker._notification_listening.is_set, "the listener did not run LISTEN")
            queue.enqueue(fixture["taskType"], {"task": "second"}, EnqueueOptions(queue=queue_name))
            wait_long(lambda: len(handled) == 2, "the worker did not run the second task")
            sleep(fixture["observeAfterRecoveryMs"] / 1000)
            recovery_end = len(executor.recorded())

            # The next empty claim starts a new wait at the notification base. Then the runner
            # ends the live listener session and holds the next LISTEN, so the subscription is
            # lost. The database is shared with other test processes, so the runner ends only
            # the listener's own session. The runner first waits until the worker has installed
            # that wait. A loss before that moment gives the polling base without a wake.
            wait_long(
                lambda: any(not claim[2] for claim in executor.recorded()[recovery_end:]),
                "the worker made no empty claim after the second task",
            )
            empty_end = next(
                claim[1] for claim in executor.recorded()[recovery_end:] if not claim[2]
            )
            wait_long(
                lambda: empty_wait.installed_after(empty_end, notification_wait_ms(worker)),
                "the worker did not wait at the notification base after the second task",
            )
            pool.hold_listen()
            listener_pid = pool.listener_pid
            assert listener_pid is not None, "the runner did not see the listener's LISTEN"
            # The loss starts when the runner ends the session. The recorder holds the first
            # empty claim after that moment, which is the claim that the loss wakes. The worker
            # thus cannot advance its backoff before the runner enqueues the third task.
            wait_end = empty_wait.deadline()
            lost_at = executor.hold_from = monotonic()
            connection.execute("SELECT pg_terminate_backend(%s)", (listener_pid,))
            wait_long(
                executor.reached.is_set,
                "the worker made no claim after the subscription was lost",
            )
            enqueued_after_loss = monotonic()
            queue.enqueue(fixture["taskType"], {"task": "third"}, EnqueueOptions(queue=queue_name))
            executor.released.set()
            wait_long(lambda: len(handled) == 3, "the worker did not run the third task")
        finally:
            executor.recording = False
            executor.released.set()
            pool.listen_released.set()
            worker.stop()
            join(thread)
    assert errors == []
    assert_subscription_recovery(
        executor.recorded(),
        recovery_end,
        lost_at,
        wait_end,
        enqueued_after_loss,
        fixture,
        notification_wait_ms(worker),
    )


def assert_subscription_recovery(
    recorded: list[tuple[float, float, bool]],
    recovery_end: int,
    lost_at: float,
    wait_end: float | None,
    enqueued_after_loss: float,
    fixture: Mapping[str, Any],
    notification_wait_ms: float,
) -> None:
    """Asserts the claim timing of the three phases of a subscription-recovery run.

    ``recorded`` holds each claim's start, its return, and whether it found a task, in the order
    the claims returned. ``recovery_end`` counts the claims recorded before the loss phase.
    ``lost_at`` is the moment just before the runner ended the listener session. ``wait_end`` is
    the end of the empty-claim wait that the worker had installed at that moment.
    ``notification_wait_ms`` is the shortest wait at the notification base.
    """
    claims = sorted(recorded)
    found = [index for index, claim in enumerate(claims) if claim[2]]
    assert len(found) == 3, f"{len(found)} claims found a task, want 3"
    first, _, third = found
    assert first > 0, "no empty claim came before the first task"
    delay_ms = (claims[first][0] - claims[first - 1][1]) * 1_000
    assert delay_ms <= fixture["expectedMaximumClaimDelayMs"], (
        f"the claim that found the first task waited {delay_ms:.0f} ms without a live "
        f"subscription, want at most {fixture['expectedMaximumClaimDelayMs']} ms"
    )
    # With a live subscription, the worker waits the notification base after an empty claim.
    recovered = sorted(recorded[:recovery_end])
    second = max(index for index, claim in enumerate(recovered) if claim[2])
    empty = sum(1 for claim in recovered[second:] if not claim[2])
    assert empty <= fixture["expectedMaximumEmptyClaimsAfterRecovery"], (
        f"{empty} empty claims after the second task with a live subscription, "
        f"want at most {fixture['expectedMaximumEmptyClaimsAfterRecovery']}"
    )
    # After the loss, the worker claims at once and then polls at the polling-only base again.
    maximum_ms = fixture["expectedMaximumClaimDelayAfterLossMs"]
    woken = next(index for index, claim in enumerate(claims) if claim[0] >= lost_at)
    woken_ms = (claims[woken][0] - lost_at) * 1_000
    assert woken_ms <= maximum_ms, (
        f"the first claim after the subscription was lost waited {woken_ms:.0f} ms, "
        f"want at most {maximum_ms} ms"
    )
    # When the runner ended the session, the claim before the woken one had installed a wait at
    # the notification base. The woken claim started before that wait ended, so the loss started it.
    before = claims[woken - 1][1]
    assert wait_end is not None, "the worker had no empty-claim wait when the session ended"
    assert wait_end >= before + notification_wait_ms / 1_000, (
        "the claim before the loss did not install a wait at the notification base"
    )
    assert claims[woken][0] < wait_end, (
        "the first claim after the subscription was lost started when the wait ended, "
        "so the wait, not the loss, started it"
    )
    third_ms = (claims[third][0] - enqueued_after_loss) * 1_000
    assert third_ms <= maximum_ms, (
        f"the claim that found the third task waited {third_ms:.0f} ms after the subscription "
        f"was lost, want at most {maximum_ms} ms"
    )


def execute_graceful_drain_fixture(
    connection: psycopg.Connection[Any], fixture: Mapping[str, Any]
) -> None:
    queue_name = runtime_queue(fixture)
    queue = Queue(connection)
    task_ids = [
        queue.enqueue(fixture["taskType"], {"sequence": sequence}, EnqueueOptions(queue=queue_name))
        for sequence in range(fixture["taskCount"])
    ]
    release_handlers = Event()
    errors: list[BaseException] = []

    def handler(_payload: object, _context: HandlerContext) -> None:
        assert release_handlers.wait(timeout=5)

    worker = Worker(
        worker_pool,
        queue=queue_name,
        worker_id=f"python-{fixture['id']}",
        concurrency=fixture["concurrency"],
        poll_ms=5_000,
    ).handle(fixture["taskType"], handler)
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
    states = [task_state(connection, task_id)["state"] for task_id in task_ids]
    assert states.count("succeeded") == fixture["expectedSucceeded"]
    assert states.count("ready") == fixture["expectedReady"]


class ClaimRecordingExecutor:
    """Records every dispatch claim's limit, and can hold a claim before it reaches PostgreSQL.

    Holding a claim keeps it in flight, so the next claim is observed while the first is open.
    """

    def __init__(self, executor: PooledSyncExecutor) -> None:
        self._executor = executor
        self._lock = Lock()
        self._held: list[Event] = []
        self.limits: list[int] = []
        self.claims_with_tasks = 0
        self.in_flight = 0
        self.maximum_in_flight = 0
        self.holding = False

    def rows(self, statement: DriverStatement, parameters: Any = ()) -> Any:
        if statement is not STATEMENTS.claim_many:
            return self._executor.rows(statement, parameters)
        release = Event()
        with self._lock:
            self.limits.append(int(parameters[2]))
            self.in_flight += 1
            self.maximum_in_flight = max(self.maximum_in_flight, self.in_flight)
            if self.holding:
                self._held.append(release)
            else:
                release.set()
        try:
            assert release.wait(timeout=10), "held claim was never released"
            rows = self._executor.rows(statement, parameters)
            if rows:
                with self._lock:
                    self.claims_with_tasks += 1
            return rows
        finally:
            with self._lock:
                self.in_flight -= 1

    def release_held(self) -> None:
        with self._lock:
            self.holding = False
            held, self._held = self._held, []
        for release in held:
            release.set()

    def claims(self) -> int:
        with self._lock:
            return len(self.limits)


def execute_slot_refill_fixture(
    connection: psycopg.Connection[Any], fixture: Mapping[str, Any]
) -> None:
    queue_name = runtime_queue(fixture)
    queue = Queue(connection)
    task_ids = [
        queue.enqueue(fixture["taskType"], {"sequence": sequence}, EnqueueOptions(queue=queue_name))
        for sequence in range(fixture["taskCount"])
    ]
    executor = ClaimRecordingExecutor(PooledSyncExecutor(worker_pool))
    # Handlers block until the fixture finishes them in the order they started.
    handlers_lock = Lock()
    started: list[Event] = []
    open_handlers = False

    def handler(_payload: object, _context: HandlerContext) -> None:
        finished = Event()
        with handlers_lock:
            if open_handlers:
                return
            started.append(finished)
        assert finished.wait(timeout=10)

    def finish_first() -> None:
        with handlers_lock:
            finished = started.pop(0)
        finished.set()

    def open_all() -> None:
        nonlocal open_handlers
        with handlers_lock:
            open_handlers = True
            waiting, started[:] = list(started), []
        for finished in waiting:
            finished.set()

    def started_count() -> int:
        with handlers_lock:
            return len(started)

    errors: list[BaseException] = []
    worker = Worker(
        worker_pool,
        queue=queue_name,
        worker_id=f"python-{fixture['id']}",
        concurrency=fixture["concurrency"],
        registry_interval_ms=0,
        shared_heartbeats=True,
        _executor=executor,
    ).handle(fixture["taskType"], handler)
    thread = run_in_thread(worker.run, errors)
    try:
        wait_for(
            lambda: started_count() == fixture["concurrency"],
            f"{fixture['id']} did not fill its slots",
        )
        executor.holding = True
        for finished in range(1, 4):
            finish_first()
            if finished == 2:
                # One more free slot is below the refill batch while the first refill is held.
                sleep(fixture["settleCheckMs"] / 1000)
                assert executor.claims() == 2
            else:
                expected = 2 if finished == 1 else 3
                wait_for(
                    lambda: executor.claims() >= expected,
                    f"{fixture['id']} did not start claim {expected}",
                )
        assert executor.limits == fixture["expectedClaimLimits"]
        assert executor.maximum_in_flight == fixture["expectedOverlappingClaims"]

        executor.release_held()
        open_all()
        wait_for(
            lambda: all(
                task_state(connection, task_id)["state"] == "succeeded" for task_id in task_ids
            ),
            f"{fixture['id']} did not run every task",
        )
        assert (
            executor.claims_with_tasks / fixture["taskCount"]
            <= fixture["expectedMaximumClaimsPerTask"]
        )
    finally:
        executor.release_held()
        open_all()
        worker.stop()
        join(thread)
    assert errors == []
    assert active_slots(worker) == 0


CLAIM_V1 = SQL_STATEMENTS["claim_v1"][0]


def execute_budget_admission_race_fixture(
    connection: psycopg.Connection[Any], fixture: Mapping[str, Any], database_url: str
) -> None:
    """Commits a budgeted task on one queue while that queue's claim is already past its first read.

    A second claim of the same budget stays open on another queue until the first claim has
    admitted or started waiting. The first claim's queue carries a rate policy so a test session
    can park it on the queue's admission shards, which every claim locks after sampling its ready
    rows. Mirrors typescript/core/test/support/budget-race.ts.
    """
    name = runtime_queue(fixture)
    budget = name
    late_queue = f"{name}-late"
    holder_queue = f"{name}-holder"
    rate = fixture["queueRate"]
    queue = Queue(connection)
    queue.sync_budgets(name, [BudgetDefinition(name=budget, max_active=fixture["maxActive"])])
    queue.sync_rate_limit_policies(
        name,
        [
            RateLimitPolicyDefinition(
                queue=late_queue,
                rate=RateLimit(
                    limit=rate["limit"], interval_ms=rate["intervalMs"], burst=rate["burst"]
                ),
            )
        ],
    )
    # One unbudgeted start proves the late queue admits before the blocker parks its claim.
    queue.enqueue(fixture["taskType"], {"role": "bucket"}, EnqueueOptions(queue=late_queue))
    bucket_claim = connection.execute(
        CLAIM_V1, (late_queue, f"{name}-bucket", fixture["leaseMs"])
    ).fetchall()
    assert bucket_claim, "the late queue did not admit its unbudgeted start"
    queue.enqueue(
        fixture["taskType"], {"role": "holder"}, EnqueueOptions(queue=holder_queue, budget=budget)
    )

    with (
        psycopg.connect(database_url, autocommit=True) as blocker,
        psycopg.connect(database_url, autocommit=True) as late,
        psycopg.connect(database_url, autocommit=True) as holder,
    ):
        late_thread: Thread | None = None
        try:
            late_pid = backend_pid(late)
            blocker.execute("BEGIN")
            blocker.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended("
                "'workhorse:admission-shard:' || %s || ':' || shard, 0)) "
                "FROM generate_series(0, 7) AS shard",
                (late_queue,),
            ).fetchall()

            late_claims: list[int] = []
            errors: list[BaseException] = []

            def claim_late() -> None:
                rows = late.execute(
                    CLAIM_V1, (late_queue, f"{name}-late", fixture["leaseMs"])
                ).fetchall()
                late_claims.append(len(rows))

            late_thread = run_in_thread(claim_late, errors)
            wait_until(
                lambda: waits_on(connection, late_pid, None),
                f"{name}: the late claim never reached the admission shards",
            )

            queue.enqueue(
                fixture["taskType"],
                {"role": "late"},
                EnqueueOptions(queue=late_queue, budget=budget),
            )
            holder.execute("BEGIN")
            holder_claims = len(
                holder.execute(
                    CLAIM_V1, (holder_queue, f"{name}-holder", fixture["leaseMs"])
                ).fetchall()
            )
            blocker.execute("COMMIT")
            thread = late_thread
            wait_until(
                lambda: not thread.is_alive() or waits_on(connection, late_pid, "advisory"),
                f"{name}: the late claim neither finished nor waited for the budget",
            )
            holder.execute("COMMIT")
            join(late_thread)
            assert errors == []

            row = connection.execute(
                "SELECT count(*) FROM workhorse.task_runtime "
                "WHERE state = 'active' AND budget_name = %s",
                (budget,),
            ).fetchone()
            assert row is not None
            assert holder_claims == fixture["expectedHolderClaims"]
            assert late_claims == [fixture["expectedLateClaims"]]
            assert row[0] == fixture["expectedActive"]
        finally:
            for session in (blocker, holder):
                with suppress(psycopg.Error):
                    session.execute("ROLLBACK")
            if late_thread is not None:
                late_thread.join(timeout=10)


def injected_function_failure(
    connection: psycopg.Connection[Any], injection: Mapping[str, Any]
) -> AbstractContextManager[Callable[[], int]]:
    """Replaces one installed function with a raising body, and restores it afterwards.

    A runner can then fail a call the SDK makes without reaching into the SDK. The exception rolls
    the call back, so only a sequence carries the count of raised calls out of it.
    """

    @contextmanager
    def replaced() -> Iterator[Callable[[], int]]:
        row = connection.execute(
            "SELECT pg_get_functiondef(%s::regprocedure)", (injection["function"],)
        ).fetchone()
        assert row is not None
        original = row[0]
        sequence = injection.get("counterSequence")
        count = ""
        if sequence is not None:
            connection.execute(f"CREATE SEQUENCE {sequence} MINVALUE 0 START 0")
            count = f"PERFORM nextval('{sequence}');"
        connection.execute(
            f"""CREATE OR REPLACE FUNCTION {injection["header"]} LANGUAGE plpgsql AS $injected$
                BEGIN
                  {count}
                  RAISE EXCEPTION '{injection["message"]}'
                    USING ERRCODE = '{injection["errorCode"]}';
                END;
                $injected$"""
        )

        def failed_calls() -> int:
            if sequence is None:
                return 0
            counted = connection.execute(f"SELECT last_value FROM {sequence}").fetchone()
            assert counted is not None
            return int(counted[0])

        try:
            yield failed_calls
        finally:
            connection.execute(original)
            if sequence is not None:
                connection.execute(f"DROP SEQUENCE IF EXISTS {sequence}")

    return replaced()


def release_evidence(connection: psycopg.Connection[Any], task_id: str) -> tuple[int, int]:
    row = connection.execute(
        "SELECT (SELECT count(*) FROM workhorse.attempt_history WHERE task_id = %s), "
        "(SELECT count(*) FROM workhorse.task_event "
        " WHERE task_id = %s AND event_type = 'released')",
        (task_id, task_id),
    ).fetchone()
    assert row is not None
    return int(row[0]), int(row[1])


def execute_missing_handler_fixture(
    connection: psycopg.Connection[Any], fixture: Mapping[str, Any]
) -> None:
    queue_name = runtime_queue(fixture)
    task_id = Queue(connection).enqueue(
        fixture["taskType"], {"index": 1}, EnqueueOptions(queue=queue_name)
    )
    older = Worker(
        worker_pool,
        queue=queue_name,
        worker_id=f"python-{fixture['id']}-older",
        lease_ms=fixture["leaseMs"],
        poll_ms=fixture["pollMs"],
    ).handle(fixture["registeredTaskType"], lambda _payload, _context: None)
    # A pass that released each task that it claimed made no progress, so it returns False.
    released_pass_progress = fixture["expectedReleasedPassOutcome"] != "unprocessed"
    assert older.run_once() is released_pass_progress
    assert_task_states(connection, {"task": task_id}, {"task": fixture["expectedAfterRelease"]})
    attempts, releases = release_evidence(connection, task_id)
    # The refusal belongs to no attempt, so the task keeps the attempt it was enqueued with.
    assert attempts == fixture["expectedAttempts"]
    assert releases == fixture["expectedReleaseEvents"]
    # The worker keeps no state between calls. The next call claims the ready task again at once,
    # inside the poll interval, releases it, and returns False again.
    assert older.run_once() is released_pass_progress
    assert release_evidence(connection, task_id) == (
        fixture["expectedAttempts"],
        fixture["expectedReleaseEventsAfterNextPass"],
    )
    assert_task_states(connection, {"task": task_id}, {"task": fixture["expectedAfterRelease"]})

    handled: list[object] = []

    def handler(payload: object, _context: HandlerContext) -> None:
        handled.append(payload)

    newer = Worker(
        worker_pool,
        queue=queue_name,
        worker_id=f"python-{fixture['id']}-newer",
        lease_ms=fixture["leaseMs"],
    ).handle(fixture["taskType"], handler)
    assert newer.run_once() is True
    assert handled == [{"index": 1}]
    assert_task_states(connection, {"task": task_id}, {"task": fixture["expectedAfterHandled"]})


def release_times_ms(connection: psycopg.Connection[Any], task_id: str) -> list[float]:
    rows = connection.execute(
        "SELECT extract(epoch FROM occurred_at) * 1000 FROM workhorse.task_event "
        "WHERE task_id = %s AND event_type = 'released' ORDER BY occurred_at",
        (task_id,),
    ).fetchall()
    return [float(row[0]) for row in rows]


def listening_sessions(connection: psycopg.Connection[Any]) -> int:
    """Counts the sessions that listen for tasks. Without one the fixture proves nothing."""
    row = connection.execute(
        "SELECT count(*) FROM pg_stat_activity "
        "WHERE datname = current_database() AND query = 'LISTEN workhorse_tasks'"
    ).fetchone()
    assert row is not None
    return int(row[0])


def release_window(
    connection: psycopg.Connection[Any], task_id: str, fixture: Mapping[str, Any]
) -> list[float]:
    """Waits for the first release, then for ``runMs``, and returns the releases in that window.

    The window starts at the first release, not at the start of the worker. A slow start thus
    cannot make the window shorter. The release times come from the database, so a slow runner
    cannot make the window longer.
    """
    deadline = monotonic() + 10
    while not release_times_ms(connection, task_id):
        assert monotonic() < deadline, "the worker released no task"
        sleep(0.02)
    sleep(fixture["runMs"] / 1000)
    times = release_times_ms(connection, task_id)
    return [time for time in times if time - times[0] <= fixture["runMs"]]


def assert_release_wait(times: list[float], fixture: Mapping[str, Any]) -> None:
    assert fixture["expectedMinimumReleases"] <= len(times) <= fixture["expectedMaximumReleases"], (
        f"{len(times)} releases while the worker ran"
    )
    gaps = [later - earlier for earlier, later in zip(times, times[1:])]
    assert min(gaps) >= fixture["expectedMinimumReleaseGapMs"], f"release gaps {gaps}"


def execute_release_wait_fixture(
    connection: psycopg.Connection[Any], fixture: Mapping[str, Any]
) -> None:
    queue_name = runtime_queue(fixture)
    task_id = Queue(connection).enqueue(fixture["taskType"], {}, EnqueueOptions(queue=queue_name))
    # The worker listens on its queue, so each release wakes it. It has no handler for the task.
    worker = Worker(
        worker_pool,
        queue=queue_name,
        worker_id=f"python-{fixture['id']}",
        lease_ms=fixture["leaseMs"],
        poll_ms=fixture["pollMs"],
    ).handle(fixture["registeredTaskType"], lambda _payload, _context: None)
    errors: list[BaseException] = []
    thread = run_in_thread(worker.run, errors)
    try:
        times = release_window(connection, task_id, fixture)
        listeners = listening_sessions(connection)
    finally:
        worker.stop()
        join(thread)
    assert errors == []
    assert listeners > 0, "no session listened while the worker ran"
    assert_release_wait(times, fixture)


def execute_json_round_trip_fixture(
    connection: psycopg.Connection[Any], fixture: Mapping[str, Any]
) -> None:
    queue_name = runtime_queue(fixture)
    payload = fixture["payload"]
    task_id = Queue(connection).enqueue(
        fixture["taskType"], payload, EnqueueOptions(queue=queue_name)
    )
    received: list[object] = []

    def handler(handled: object, _context: HandlerContext) -> object:
        received.append(handled)
        return handled

    worker = Worker(worker_pool, queue=queue_name, worker_id=f"python-{fixture['id']}").handle(
        fixture["taskType"], handler
    )
    assert worker.run_once() is True
    assert received == [payload]
    stored = connection.execute(
        "SELECT task.payload, outcome.result FROM workhorse.task task "
        "JOIN workhorse.task_outcome outcome ON outcome.task_id = task.id WHERE task.id = %s",
        (task_id,),
    ).fetchone()
    assert stored is not None
    assert stored[0] == payload
    assert stored[1] == payload
    assert_task_states(connection, {"task": task_id}, {"task": fixture["expectedState"]})
    assert_attempt_outcomes(connection, task_id, [fixture["expectedAttemptOutcome"]])


def execute_oversized_result_fixture(
    connection: psycopg.Connection[Any], fixture: Mapping[str, Any]
) -> None:
    queue_name = runtime_queue(fixture)
    admin = Admin(connection)
    if fixture["tier"] == "fast":
        audit = AdminAudit(actor="runtime-fixture", reason=fixture["id"], request_id=fixture["id"])
        admin.set_queue_tier(queue_name, "fast", audit)
    queue = Queue(connection)
    task_id = queue.enqueue(
        fixture["taskType"],
        fixture["oversizedZeros"],
        EnqueueOptions(
            queue=queue_name,
            max_attempts=fixture["maxAttempts"],
            retry_policy={"type": "fixed", "delayMs": 0},
        ),
    )
    worker = Worker(worker_pool, queue=queue_name, worker_id=f"python-{fixture['id']}").handle(
        fixture["taskType"], lambda zeros, _context: [0] * zeros
    )
    settled = fixture["expectedSettled"]
    for _ in range(fixture["maxAttempts"]):
        snapshot = admin.get_task(task_id)
        if snapshot is not None and snapshot.state == settled["state"]:
            break
        assert worker.run_once() is True
    snapshot = admin.get_task(task_id)
    assert snapshot is not None
    assert (snapshot.state, snapshot.current_attempt) == (settled["state"], settled["attempt"])
    assert isinstance(snapshot.error, dict)
    assert snapshot.error["name"] == fixture["expectedErrorNames"]["python"]
    fitting = queue.enqueue(
        fixture["taskType"], fixture["fittingZeros"], EnqueueOptions(queue=queue_name)
    )
    assert worker.run_once() is True
    snapshot = admin.get_task(fitting)
    assert snapshot is not None
    assert (snapshot.state, snapshot.current_attempt) == (
        fixture["expectedFitting"]["state"],
        fixture["expectedFitting"]["attempt"],
    )


def execute_shutdown_cancellation_fixture(
    connection: psycopg.Connection[Any], fixture: Mapping[str, Any]
) -> None:
    """The Python worker has no shutdown grace: its drain waits for every running handler.

    So the handler outlives the stop, never sees its cancellation, and completes on its only
    attempt. It returns a value whatever `handlerResult` says, because no cancellation reaches it.
    """
    assert fixture["shutdownBehavior"]["python"] == "drain"
    queue_name = runtime_queue(fixture)
    task_id = Queue(connection).enqueue(
        fixture["taskType"],
        None,
        EnqueueOptions(queue=queue_name, max_attempts=fixture["maxAttempts"]),
    )
    started = Event()
    stopped = Event()
    cancelled: list[bool] = []
    errors: list[BaseException] = []

    def handler(_payload: object, context: HandlerContext) -> None:
        started.set()
        assert stopped.wait(timeout=5)
        sleep(fixture["drainHoldMs"] / 1000)
        cancelled.append(context.cancellation.cancelled)

    worker = Worker(
        worker_pool, queue=queue_name, worker_id=f"python-{fixture['id']}", poll_ms=5_000
    ).handle(fixture["taskType"], handler)
    thread = run_in_thread(worker.run, errors)
    assert started.wait(timeout=5), f"{fixture['id']} never started its handler"
    worker.stop()
    stopped.set()
    join(thread)
    assert errors == []
    assert cancelled == [False]
    state = task_state(connection, task_id)
    expected = fixture["expectedDrained"]
    assert (state["state"], state["attempt"]) == (expected["state"], expected["attempt"])


def lease_expiry(connection: psycopg.Connection[Any], task_id: str) -> datetime:
    row = connection.execute(
        "SELECT expires_at FROM workhorse.task_runtime WHERE task_id = %s", (task_id,)
    ).fetchone()
    assert row is not None and row[0] is not None
    return row[0]


def wait_for_lease_renewal(
    connection: psycopg.Connection[Any], task_id: str, previous: datetime, timeout_ms: int
) -> datetime:
    deadline = monotonic() + timeout_ms / 1000
    while True:
        expires_at = lease_expiry(connection, task_id)
        if expires_at > previous:
            return expires_at
        assert monotonic() < deadline, f"lease was not renewed for {task_id}"
        sleep(0.005)


def execute_heartbeat_failure_fixture(
    connection: psycopg.Connection[Any], fixture: Mapping[str, Any]
) -> None:
    queue_name = runtime_queue(fixture)
    task_id = Queue(connection).enqueue(fixture["taskType"], {}, EnqueueOptions(queue=queue_name))
    started = Event()
    release = Event()
    cancellations: list[str] = []
    errors: list[BaseException] = []

    def handler(_payload: object, context: HandlerContext) -> None:
        started.set()
        assert release.wait(timeout=10)
        if context.cancellation.cancelled:
            cancellations.append(task_id)

    worker = Worker(
        worker_pool,
        queue=queue_name,
        worker_id=f"python-{fixture['id']}",
        lease_ms=fixture["leaseMs"],
        heartbeat_ms=fixture["heartbeatMs"],
    ).handle(fixture["taskType"], handler)
    results: list[bool] = []
    thread = run_in_thread(lambda: results.append(worker.run_once()), errors)
    timeout_ms = fixture["renewalTimeoutMs"]
    try:
        assert started.wait(timeout=5)
        renewed = wait_for_lease_renewal(
            connection, task_id, lease_expiry(connection, task_id), timeout_ms
        )
        with injected_function_failure(connection, fixture["injection"]) as failed_calls:
            deadline = monotonic() + timeout_ms / 1000
            while failed_calls() < fixture["expectedMinimumFailedRounds"]:
                assert monotonic() < deadline, f"only {failed_calls()} heartbeat rounds failed"
                sleep(0.005)
            renewed = lease_expiry(connection, task_id)
        # Once the rounds answer again the lease renews, so the failures cost the attempt nothing.
        wait_for_lease_renewal(connection, task_id, renewed, timeout_ms)
    finally:
        release.set()
    join(thread)
    assert errors == []
    assert results == [True]
    assert len(cancellations) == fixture["expectedCancellations"]
    assert_task_states(connection, {"task": task_id}, {"task": fixture["expectedState"]})
    assert_attempt_outcomes(connection, task_id, [fixture["expectedAttemptOutcome"]])


def injected_function_body(
    connection: psycopg.Connection[Any], injection: Mapping[str, Any]
) -> AbstractContextManager[None]:
    """Replaces one installed function with the fixture's body, and restores it afterwards.

    The setup statements run first and the teardown statements run last, whatever the body does.
    """

    @contextmanager
    def replaced() -> Iterator[None]:
        row = connection.execute(
            "SELECT pg_get_functiondef(%s::regprocedure)", (injection["function"],)
        ).fetchone()
        assert row is not None
        original = row[0]
        try:
            for statement in injection["setup"]:
                connection.execute(statement)
            connection.execute(
                f"CREATE OR REPLACE FUNCTION {injection['header']} LANGUAGE plpgsql "
                f"AS $injected$ {injection['body']} $injected$"
            )
            try:
                yield
            finally:
                connection.execute(original)
        finally:
            for statement in injection["teardown"]:
                connection.execute(statement)

    return replaced()


def busy_rounds(
    connection: psycopg.Connection[Any], fixture: Mapping[str, Any]
) -> list[tuple[float, int]]:
    rows = connection.execute(fixture["injection"]["roundsQuery"]).fetchall()
    return [(float(row[0]), int(row[1])) for row in rows]


def assert_busy_rounds(rounds: list[tuple[float, int]], fixture: Mapping[str, Any]) -> None:
    busy = rounds[: fixture["expectedBusyRounds"]]
    assert len(busy) == fixture["expectedBusyRounds"], rounds
    # Each retry sent only the busy lease, and came sooner than the next regular round.
    assert [lease_count for _, lease_count in busy] == [1] * len(busy), rounds
    gaps = [later[0] - earlier[0] for earlier, later in zip(busy, busy[1:])]
    assert all(gap < fixture["maximumRetryGapMs"] for gap in gaps), gaps


def execute_heartbeat_busy_fixture(
    connection: psycopg.Connection[Any], fixture: Mapping[str, Any]
) -> None:
    queue_name = runtime_queue(fixture)
    task_id = Queue(connection).enqueue(fixture["taskType"], {}, EnqueueOptions(queue=queue_name))
    started = Event()
    release = Event()
    cancellations: list[str] = []
    errors: list[BaseException] = []

    def handler(_payload: object, context: HandlerContext) -> None:
        started.set()
        assert release.wait(timeout=20)
        if context.cancellation.cancelled:
            cancellations.append(task_id)

    worker = Worker(
        worker_pool,
        queue=queue_name,
        worker_id=f"python-{fixture['id']}",
        lease_ms=fixture["leaseMs"],
        heartbeat_ms=fixture["heartbeatMs"],
    ).handle(fixture["taskType"], handler)
    results: list[bool] = []
    thread = run_in_thread(lambda: results.append(worker.run_once()), errors)
    timeout_ms = fixture["renewalTimeoutMs"]
    rounds: list[tuple[float, int]] = []
    try:
        assert started.wait(timeout=5)
        wait_for_lease_renewal(connection, task_id, lease_expiry(connection, task_id), timeout_ms)
        with injected_function_body(connection, fixture["injection"]):
            deadline = monotonic() + timeout_ms / 1000
            while len(rounds := busy_rounds(connection, fixture)) < fixture["expectedBusyRounds"]:
                assert monotonic() < deadline, f"only {len(rounds)} heartbeat rounds were busy"
                sleep(0.005)
            # The busy rounds renewed nothing. The next round reaches the real function and renews.
            wait_for_lease_renewal(
                connection, task_id, lease_expiry(connection, task_id), timeout_ms
            )
    finally:
        release.set()
    join(thread)
    assert errors == []
    assert results == [True]
    assert_busy_rounds(rounds, fixture)
    assert len(cancellations) == fixture["expectedCancellations"]
    assert_task_states(connection, {"task": task_id}, {"task": fixture["expectedState"]})
    assert_attempt_outcomes(connection, task_id, [fixture["expectedAttemptOutcome"]])


def execute_maintenance_phase_error_fixture(
    connection: psycopg.Connection[Any], fixture: Mapping[str, Any]
) -> None:
    queue_name = runtime_queue(fixture)
    # tick_v1 catches a phase failure and returns it as data, so a raising promote_v1 models a lock
    # timeout inside the promote phase.
    with injected_function_failure(connection, fixture["injection"]):
        phase = connection.execute(
            "SELECT phase, error FROM workhorse.tick_v1() WHERE phase = %s",
            (fixture["expectedPhase"],),
        ).fetchone()
        assert phase is not None
        assert fixture["injection"]["message"] in json.dumps(phase[1])

        task_id = Queue(connection).enqueue(
            fixture["taskType"], {}, EnqueueOptions(queue=queue_name)
        )
        worker = Worker(
            worker_pool,
            queue=queue_name,
            worker_id=f"python-{fixture['id']}",
            maintenance_interval_ms=100,
        ).handle(fixture["taskType"], lambda _payload, _context: None)
        # The failing phase runs on this pass, and the pass still claims and settles the task.
        assert worker.run_once() is True
        assert_task_states(connection, {"task": task_id}, {"task": fixture["expectedState"]})


async def execute_async_runtime_fixture(
    connection: psycopg.Connection[Any], fixture: Mapping[str, Any], database_url: str
) -> None:
    executors: dict[str, Any] = {
        "cooperative-cancellation": execute_async_cancellation_fixture,
        "graceful-drain": execute_async_graceful_drain_fixture,
        "heartbeat-busy": execute_async_heartbeat_busy_fixture,
        "heartbeat-failure": execute_async_heartbeat_failure_fixture,
        "json-round-trip": execute_async_json_round_trip_fixture,
        "maintenance-phase-error": execute_async_maintenance_phase_error_fixture,
        "missing-handler": execute_async_missing_handler_fixture,
        "release-wait": execute_async_release_wait_fixture,
        "subscription-recovery": execute_async_subscription_recovery_fixture,
    }
    await executors[fixture["kind"]](connection, fixture, database_url)


@asynccontextmanager
async def async_worker(
    database_url: str, fixture: Mapping[str, Any], suffix: str = "", **options: Any
) -> AsyncIterator[AsyncWorker]:
    """Opens an AsyncWorker over its own psycopg pool, and closes both when the fixture ends."""
    async with AsyncConnectionPool(
        database_url, min_size=3, max_size=3, kwargs={"autocommit": True}
    ) as pool:
        yield AsyncWorker.from_psycopg(
            pool,
            queue=runtime_queue(fixture),
            worker_id=f"python-async-{fixture['id']}{suffix}",
            **options,
        )


async def read(
    connection: psycopg.Connection[Any], statement: str, parameters: tuple[Any, ...]
) -> Any:
    """Reads through a thread, so a poll cannot stall the loop an async worker runs on."""
    return await asyncio.to_thread(lambda: connection.execute(statement, parameters).fetchone())


async def async_release_evidence(
    connection: psycopg.Connection[Any], task_id: str
) -> tuple[int, int]:
    row = await read(
        connection,
        "SELECT (SELECT count(*) FROM workhorse.attempt_history WHERE task_id = %s), "
        "(SELECT count(*) FROM workhorse.task_event "
        " WHERE task_id = %s AND event_type = 'released')",
        (task_id, task_id),
    )
    assert row is not None
    return int(row[0]), int(row[1])


async def wait_for_async(condition: Callable[[], Awaitable[bool]], message: str) -> None:
    deadline = monotonic() + 10
    while not await condition():
        assert monotonic() < deadline, message
        await asyncio.sleep(0.01)


async def execute_async_json_round_trip_fixture(
    connection: psycopg.Connection[Any], fixture: Mapping[str, Any], database_url: str
) -> None:
    payload = fixture["payload"]
    task_id = Queue(connection).enqueue(
        fixture["taskType"], payload, EnqueueOptions(queue=runtime_queue(fixture))
    )
    received: list[object] = []

    async def handler(handled: object, _context: AsyncHandlerContext) -> object:
        received.append(handled)
        return handled

    async with async_worker(database_url, fixture) as worker:
        worker.handle(fixture["taskType"], handler)
        assert await worker.run_once() is True
    assert received == [payload]
    stored = connection.execute(
        "SELECT task.payload, outcome.result FROM workhorse.task task "
        "JOIN workhorse.task_outcome outcome ON outcome.task_id = task.id WHERE task.id = %s",
        (task_id,),
    ).fetchone()
    assert stored is not None
    assert stored[0] == payload
    assert stored[1] == payload
    assert_task_states(connection, {"task": task_id}, {"task": fixture["expectedState"]})
    assert_attempt_outcomes(connection, task_id, [fixture["expectedAttemptOutcome"]])


async def execute_async_missing_handler_fixture(
    connection: psycopg.Connection[Any], fixture: Mapping[str, Any], database_url: str
) -> None:
    task_id = Queue(connection).enqueue(
        fixture["taskType"], {"index": 1}, EnqueueOptions(queue=runtime_queue(fixture))
    )

    async def registered(_payload: object, _context: AsyncHandlerContext) -> None:
        return None

    async with async_worker(
        database_url,
        fixture,
        suffix="-older",
        lease_ms=fixture["leaseMs"],
        poll_ms=fixture["pollMs"],
    ) as older:
        older.handle(fixture["registeredTaskType"], registered)
        # A pass that released each task that it claimed made no progress, so it returns False.
        released_pass_progress = fixture["expectedReleasedPassOutcome"] != "unprocessed"
        assert await older.run_once() is released_pass_progress
        assert_task_states(connection, {"task": task_id}, {"task": fixture["expectedAfterRelease"]})
        attempts, releases = await async_release_evidence(connection, task_id)
        # The refusal belongs to no attempt, so the task keeps the attempt it was enqueued with.
        assert attempts == fixture["expectedAttempts"]
        assert releases == fixture["expectedReleaseEvents"]
        # The worker keeps no state between calls. The next call claims the ready task again at
        # once, inside the poll interval, releases it, and returns False again.
        assert await older.run_once() is released_pass_progress
        assert await async_release_evidence(connection, task_id) == (
            fixture["expectedAttempts"],
            fixture["expectedReleaseEventsAfterNextPass"],
        )
        assert_task_states(connection, {"task": task_id}, {"task": fixture["expectedAfterRelease"]})

    handled: list[object] = []

    async def handler(payload: object, _context: AsyncHandlerContext) -> None:
        handled.append(payload)

    async with async_worker(
        database_url, fixture, suffix="-newer", lease_ms=fixture["leaseMs"]
    ) as newer:
        newer.handle(fixture["taskType"], handler)
        assert await newer.run_once() is True
    assert handled == [{"index": 1}]
    assert_task_states(connection, {"task": task_id}, {"task": fixture["expectedAfterHandled"]})


class AsyncListenHold:
    """Holds each ``LISTEN`` of the async listener until the test releases it.

    The test can arm the hold again for the next ``LISTEN``. The hold records the backend pid of
    the connection that runs ``LISTEN``.
    """

    def __init__(self) -> None:
        self.released = asyncio.Event()
        self.listener_pid: int | None = None

    def arm(self) -> None:
        self.released = asyncio.Event()

    async def wait(self, pid: int) -> None:
        released = self.released
        await asyncio.wait_for(released.wait(), timeout=15)
        self.listener_pid = pid


def held_listen_psycopg_connection(hold: AsyncListenHold) -> type[psycopg.AsyncConnection[Any]]:
    """A psycopg connection class whose ``LISTEN`` waits for ``hold`` before PostgreSQL sees it."""

    class HeldListenAsyncConnection(psycopg.AsyncConnection[Any]):
        async def execute(self, query: Any, *args: Any, **kwargs: Any) -> Any:
            if isinstance(query, str) and query.startswith("LISTEN"):
                await hold.wait(self.info.backend_pid)
            return await super().execute(query, *args, **kwargs)

    return HeldListenAsyncConnection


def held_listen_asyncpg_connection(hold: AsyncListenHold) -> type[asyncpg.Connection]:
    """An asyncpg connection class whose listener waits for ``hold`` before PostgreSQL sees it."""

    class HeldListenAsyncpgConnection(asyncpg.Connection):  # type: ignore[misc]
        async def add_listener(self, channel: str, callback: Any) -> None:
            await hold.wait(self.get_server_pid())
            await super().add_listener(channel, callback)

    return HeldListenAsyncpgConnection


class AsyncClaimTimingExecutor:
    """Records each claim of an AsyncWorker: its start, its return, and whether it found a task.

    It runs on the event loop, so it uses the same clock as the runner.
    """

    # The bridge reads these from its executor. Other names stay absent, as on the sync recorder.
    _FORWARDED = frozenset({"command", "connection", "dialect", "prepare"})

    def __init__(self, executor: Any) -> None:
        self._executor = executor
        self.recording = True
        self.claims: list[tuple[float, float, bool]] = []
        # The hold of the sync recorder, on the event loop.
        self.hold_from: float | None = None
        self.reached = asyncio.Event()
        self.released = asyncio.Event()

    def __getattr__(self, name: str) -> Any:
        if name not in self._FORWARDED:
            raise AttributeError(name)
        return getattr(self._executor, name)

    async def rows(self, statement: DriverStatement, parameters: Any = ()) -> Any:
        if statement is not STATEMENTS.claim_many:
            return await self._executor.rows(statement, parameters)
        started = monotonic()
        rows = await self._executor.rows(statement, parameters)
        if self.recording:
            self.claims.append((started, monotonic(), bool(rows)))
        if self.hold_from is not None and started >= self.hold_from and not rows:
            self.hold_from = None
            self.reached.set()
            await asyncio.wait_for(self.released.wait(), timeout=15)
        return rows


@asynccontextmanager
async def held_listen_async_worker(
    database_url: str, fixture: Mapping[str, Any], driver: str, hold: AsyncListenHold
) -> AsyncIterator[AsyncWorker]:
    """Opens an AsyncWorker over its own pool of ``driver``, whose ``LISTEN`` waits for ``hold``.

    The worker can listen and keeps the default poll interval. The registry is off, because its
    interval caps the claim wait.
    """
    options: dict[str, Any] = {
        "queue": runtime_queue(fixture),
        "worker_id": f"python-async-{driver}-{fixture['id']}",
        "registry_interval_ms": 0,
    }
    if driver == "psycopg":
        async with AsyncConnectionPool(
            database_url,
            min_size=4,
            max_size=4,
            kwargs={"autocommit": True},
            connection_class=held_listen_psycopg_connection(hold),
        ) as psycopg_pool:
            yield AsyncWorker.from_psycopg(psycopg_pool, **options)
        return
    asyncpg_pool = await asyncpg.create_pool(
        database_url,
        min_size=4,
        max_size=4,
        connection_class=held_listen_asyncpg_connection(hold),
    )
    try:
        yield AsyncWorker.from_asyncpg(asyncpg_pool, **options)
    finally:
        await asyncpg_pool.close()


async def execute_async_subscription_recovery_fixture(
    connection: psycopg.Connection[Any], fixture: Mapping[str, Any], database_url: str
) -> None:
    """Runs the subscription-recovery phases through the async listener of each driver."""
    for driver in ("psycopg", "asyncpg"):
        await execute_async_subscription_recovery_driver(connection, fixture, database_url, driver)


async def execute_async_subscription_recovery_driver(
    connection: psycopg.Connection[Any],
    fixture: Mapping[str, Any],
    database_url: str,
    driver: str,
) -> None:
    """Measures the empty-claim wait of an AsyncWorker without a live subscription, with one, and
    after its loss. The phases, the hold, and the assertions are those of the sync runner.
    """
    queue_name = runtime_queue(fixture)
    queue = Queue(connection)
    hold = AsyncListenHold()
    handled: list[str] = []
    recovery_end = 0
    lost_at = 0.0
    wait_end: float | None = None
    enqueued_after_loss = 0.0

    async def handler(payload: Any, _context: AsyncHandlerContext) -> None:
        handled.append(payload["task"])

    async def wait_long(condition: Callable[[], bool], message: str) -> None:
        # A bounded wait that is longer than the notification base.
        deadline = monotonic() + 7
        while not condition():
            assert monotonic() < deadline, f"{driver}: {message}"
            await asyncio.sleep(0.005)

    async def enqueue(task: str) -> None:
        # The enqueue runs in a thread, so it cannot stall the loop the worker runs on.
        await asyncio.to_thread(
            queue.enqueue, fixture["taskType"], {"task": task}, EnqueueOptions(queue=queue_name)
        )

    async with held_listen_async_worker(database_url, fixture, driver, hold) as worker:
        worker.handle(fixture["taskType"], handler)
        executor = AsyncClaimTimingExecutor(worker._bridge._executor)
        worker._bridge._executor = executor
        empty_wait = EmptyClaimWait(worker._inner)
        running = asyncio.create_task(worker.run())
        try:
            await wait_long(
                lambda: any(not claim[2] for claim in executor.claims),
                "the worker made no empty claim before the first enqueue",
            )
            await enqueue("first")
            await wait_long(lambda: len(handled) == 1, "the worker did not run the first task")

            hold.released.set()
            # The listener sets the worker's own flag after LISTEN returns.
            await wait_long(
                worker._inner._notification_listening.is_set, "the listener did not run LISTEN"
            )
            await enqueue("second")
            await wait_long(lambda: len(handled) == 2, "the worker did not run the second task")
            await asyncio.sleep(fixture["observeAfterRecoveryMs"] / 1000)
            recovery_end = len(executor.claims)

            # The next empty claim starts a new wait at the notification base. Then the runner
            # ends the live listener session and holds the next LISTEN, so the subscription is
            # lost. The runner ends only the listener's own session, after the worker has installed
            # that wait.
            await wait_long(
                lambda: any(not claim[2] for claim in executor.claims[recovery_end:]),
                "the worker made no empty claim after the second task",
            )
            empty_end = next(claim[1] for claim in executor.claims[recovery_end:] if not claim[2])
            await wait_long(
                lambda: empty_wait.installed_after(empty_end, notification_wait_ms(worker._inner)),
                "the worker did not wait at the notification base after the second task",
            )
            hold.arm()
            listener_pid = hold.listener_pid
            assert listener_pid is not None, f"{driver}: the runner did not see the LISTEN"
            # The recorder holds the claim that the loss wakes until the third task is in.
            wait_end = empty_wait.deadline()
            lost_at = executor.hold_from = monotonic()
            await read(connection, "SELECT pg_terminate_backend(%s)", (listener_pid,))
            await wait_long(
                executor.reached.is_set,
                "the worker made no claim after the subscription was lost",
            )
            enqueued_after_loss = monotonic()
            await enqueue("third")
            executor.released.set()
            await wait_long(lambda: len(handled) == 3, "the worker did not run the third task")
        finally:
            executor.recording = False
            executor.released.set()
            hold.released.set()
            worker.stop()
            await running
    assert_subscription_recovery(
        executor.claims,
        recovery_end,
        lost_at,
        wait_end,
        enqueued_after_loss,
        fixture,
        notification_wait_ms(worker._inner),
    )


async def execute_async_release_wait_fixture(
    connection: psycopg.Connection[Any], fixture: Mapping[str, Any], database_url: str
) -> None:
    task_id = Queue(connection).enqueue(
        fixture["taskType"], {}, EnqueueOptions(queue=runtime_queue(fixture))
    )

    async def registered(_payload: object, _context: AsyncHandlerContext) -> None:
        return None

    async with async_worker(
        database_url, fixture, lease_ms=fixture["leaseMs"], poll_ms=fixture["pollMs"]
    ) as worker:
        worker.handle(fixture["registeredTaskType"], registered)
        running = asyncio.create_task(worker.run())
        try:
            times = await asyncio.to_thread(release_window, connection, task_id, fixture)
            listeners = await asyncio.to_thread(listening_sessions, connection)
        finally:
            worker.stop()
            await running
    assert listeners > 0, "no session listened while the worker ran"
    assert_release_wait(times, fixture)


async def execute_async_maintenance_phase_error_fixture(
    connection: psycopg.Connection[Any], fixture: Mapping[str, Any], database_url: str
) -> None:
    with injected_function_failure(connection, fixture["injection"]):
        task_id = Queue(connection).enqueue(
            fixture["taskType"], {}, EnqueueOptions(queue=runtime_queue(fixture))
        )

        async def handler(_payload: object, _context: AsyncHandlerContext) -> None:
            return None

        async with async_worker(database_url, fixture, maintenance_interval_ms=100) as worker:
            worker.handle(fixture["taskType"], handler)
            # The failing phase runs on this pass, and the pass still claims and settles the task.
            assert await worker.run_once() is True
        assert_task_states(connection, {"task": task_id}, {"task": fixture["expectedState"]})


async def execute_async_cancellation_fixture(
    connection: psycopg.Connection[Any], fixture: Mapping[str, Any], database_url: str
) -> None:
    task_id = Queue(connection).enqueue(
        fixture["taskType"], {}, EnqueueOptions(queue=runtime_queue(fixture))
    )
    started = asyncio.Event()
    reasons: list[BaseException] = []

    async def handler(_payload: object, context: AsyncHandlerContext) -> None:
        started.set()
        assert await context.cancellation.wait(timeout=10)
        reasons.append(context.cancellation.reason)
        raise context.cancellation.reason

    async with async_worker(
        database_url,
        fixture,
        lease_ms=fixture["leaseMs"],
        heartbeat_ms=fixture["heartbeatMs"],
    ) as worker:
        worker.handle(fixture["taskType"], handler)
        execution = asyncio.create_task(worker.run_once())
        await asyncio.wait_for(started.wait(), timeout=10)
        cancelled = await asyncio.to_thread(
            lambda: Queue(connection).cancel(task_id, reason=fixture["cancelReason"])
        )
        assert cancelled.status == "cancel_requested"
        assert await execution is True
    assert [type(reason).__name__ for reason in reasons] == [fixture["expectedAbortReason"]]
    assert_task_states(connection, {"task": task_id}, {"task": fixture["expectedState"]})
    assert_attempt_outcomes(connection, task_id, [fixture["expectedAttemptOutcome"]])


async def execute_async_graceful_drain_fixture(
    connection: psycopg.Connection[Any], fixture: Mapping[str, Any], database_url: str
) -> None:
    queue = Queue(connection)
    task_ids = [
        queue.enqueue(
            fixture["taskType"],
            {"sequence": sequence},
            EnqueueOptions(queue=runtime_queue(fixture)),
        )
        for sequence in range(fixture["taskCount"])
    ]
    release_handlers = asyncio.Event()

    async def handler(_payload: object, _context: AsyncHandlerContext) -> None:
        await asyncio.wait_for(release_handlers.wait(), timeout=10)

    async with async_worker(
        database_url, fixture, concurrency=fixture["concurrency"], poll_ms=5_000
    ) as worker:
        worker.handle(fixture["taskType"], handler)
        running = asyncio.create_task(worker.run())
        await wait_for_async(
            lambda: _slots_filled(worker, fixture["expectedActiveAtStop"]),
            f"{fixture['id']} did not fill its active slots",
        )
        worker.stop()
        await asyncio.sleep(fixture["settleCheckMs"] / 1000)
        assert not running.done()
        release_handlers.set()
        await running
        assert active_slots(worker._inner) == 0
    states = [task_state(connection, task_id)["state"] for task_id in task_ids]
    assert states.count("succeeded") == fixture["expectedSucceeded"]
    assert states.count("ready") == fixture["expectedReady"]


async def _slots_filled(worker: AsyncWorker, expected: int) -> bool:
    return active_slots(worker._inner) == expected


async def execute_async_heartbeat_failure_fixture(
    connection: psycopg.Connection[Any], fixture: Mapping[str, Any], database_url: str
) -> None:
    task_id = Queue(connection).enqueue(
        fixture["taskType"], {}, EnqueueOptions(queue=runtime_queue(fixture))
    )
    started = asyncio.Event()
    release = asyncio.Event()
    cancellations: list[str] = []

    async def handler(_payload: object, context: AsyncHandlerContext) -> None:
        started.set()
        await asyncio.wait_for(release.wait(), timeout=20)
        if context.cancellation.cancelled:
            cancellations.append(task_id)

    timeout_ms = fixture["renewalTimeoutMs"]
    async with async_worker(
        database_url,
        fixture,
        lease_ms=fixture["leaseMs"],
        heartbeat_ms=fixture["heartbeatMs"],
    ) as worker:
        worker.handle(fixture["taskType"], handler)
        execution = asyncio.create_task(worker.run_once())
        try:
            await asyncio.wait_for(started.wait(), timeout=10)
            renewed = await async_wait_for_lease_renewal(
                connection, task_id, await async_lease_expiry(connection, task_id), timeout_ms
            )
            with injected_function_failure(connection, fixture["injection"]) as failed_calls:
                await wait_for_async(
                    lambda: asyncio.to_thread(
                        lambda: failed_calls() >= fixture["expectedMinimumFailedRounds"]
                    ),
                    f"{fixture['id']} saw too few failed heartbeat rounds",
                )
                renewed = await async_lease_expiry(connection, task_id)
            # Once the rounds answer again the lease renews, so the failures cost nothing.
            await async_wait_for_lease_renewal(connection, task_id, renewed, timeout_ms)
        finally:
            release.set()
        assert await execution is True
    assert len(cancellations) == fixture["expectedCancellations"]
    assert_task_states(connection, {"task": task_id}, {"task": fixture["expectedState"]})
    assert_attempt_outcomes(connection, task_id, [fixture["expectedAttemptOutcome"]])


async def execute_async_heartbeat_busy_fixture(
    connection: psycopg.Connection[Any], fixture: Mapping[str, Any], database_url: str
) -> None:
    task_id = Queue(connection).enqueue(
        fixture["taskType"], {}, EnqueueOptions(queue=runtime_queue(fixture))
    )
    started = asyncio.Event()
    release = asyncio.Event()
    cancellations: list[str] = []

    async def handler(_payload: object, context: AsyncHandlerContext) -> None:
        started.set()
        await asyncio.wait_for(release.wait(), timeout=20)
        if context.cancellation.cancelled:
            cancellations.append(task_id)

    timeout_ms = fixture["renewalTimeoutMs"]
    rounds: list[tuple[float, int]] = []
    async with async_worker(
        database_url,
        fixture,
        lease_ms=fixture["leaseMs"],
        heartbeat_ms=fixture["heartbeatMs"],
    ) as worker:
        worker.handle(fixture["taskType"], handler)
        execution = asyncio.create_task(worker.run_once())
        try:
            await asyncio.wait_for(started.wait(), timeout=10)
            await async_wait_for_lease_renewal(
                connection, task_id, await async_lease_expiry(connection, task_id), timeout_ms
            )
            with injected_function_body(connection, fixture["injection"]):
                deadline = monotonic() + timeout_ms / 1000
                while True:
                    rounds = await asyncio.to_thread(busy_rounds, connection, fixture)
                    if len(rounds) >= fixture["expectedBusyRounds"]:
                        break
                    assert monotonic() < deadline, f"only {len(rounds)} heartbeat rounds were busy"
                    await asyncio.sleep(0.005)
                # The busy rounds renewed nothing. The next round reaches the real function.
                await async_wait_for_lease_renewal(
                    connection, task_id, await async_lease_expiry(connection, task_id), timeout_ms
                )
        finally:
            release.set()
        assert await execution is True
    assert_busy_rounds(rounds, fixture)
    assert len(cancellations) == fixture["expectedCancellations"]
    assert_task_states(connection, {"task": task_id}, {"task": fixture["expectedState"]})
    assert_attempt_outcomes(connection, task_id, [fixture["expectedAttemptOutcome"]])


async def async_lease_expiry(connection: psycopg.Connection[Any], task_id: str) -> datetime:
    row = await read(
        connection,
        "SELECT expires_at FROM workhorse.task_runtime WHERE task_id = %s",
        (task_id,),
    )
    assert row is not None and row[0] is not None
    return row[0]


async def async_wait_for_lease_renewal(
    connection: psycopg.Connection[Any], task_id: str, previous: datetime, timeout_ms: int
) -> datetime:
    deadline = monotonic() + timeout_ms / 1000
    while True:
        expires_at = await async_lease_expiry(connection, task_id)
        if expires_at > previous:
            return expires_at
        assert monotonic() < deadline, f"lease was not renewed for {task_id}"
        await asyncio.sleep(0.005)


def backend_pid(connection: psycopg.Connection[Any]) -> int:
    row = connection.execute("SELECT pg_backend_pid()").fetchone()
    assert row is not None
    return int(row[0])


def waits_on(connection: psycopg.Connection[Any], pid: int, lock: str | None) -> bool:
    """Whether a backend waits on a heavyweight lock, optionally of one kind."""
    row = connection.execute(
        "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = %s "
        "AND wait_event_type = 'Lock' AND (%s::text IS NULL OR wait_event = %s::text))",
        (pid, lock, lock),
    ).fetchone()
    return bool(row and row[0])


def wait_until(condition: Callable[[], bool], message: str) -> None:
    deadline = monotonic() + 10
    while not condition():
        assert monotonic() < deadline, message
        sleep(0.01)


def assert_task_states(
    connection: psycopg.Connection[Any],
    task_ids: Mapping[str, str],
    expected: Mapping[str, Mapping[str, Any]],
) -> None:
    for key, expected_state in expected.items():
        actual = task_state(connection, task_ids[key])
        assert actual["state"] == expected_state["state"], key
        assert actual["attempt"] == expected_state["attempt"], key
        if "errorName" in expected_state:
            assert actual["error_name"] == expected_state["errorName"], key


def task_state(connection: psycopg.Connection[Any], task_id: str) -> dict[str, object]:
    row = connection.execute(
        "SELECT state, current_attempt, error->>'name' FROM workhorse.task_runtime "
        "WHERE task_id = %s UNION ALL "
        "SELECT state, current_attempt, error->>'name' FROM workhorse.task_outcome "
        "WHERE task_id = %s",
        (task_id, task_id),
    ).fetchone()
    assert row is not None, task_id
    return {"state": row[0], "attempt": row[1], "error_name": row[2]}


def assert_attempt_count(connection: psycopg.Connection[Any], task_id: str, expected: int) -> None:
    row = connection.execute(
        "SELECT count(*) FROM workhorse.attempt_history WHERE task_id = %s", (task_id,)
    ).fetchone()
    assert row == (expected,)


def assert_attempt_outcomes(
    connection: psycopg.Connection[Any], task_id: str, expected: list[str]
) -> None:
    rows = connection.execute(
        "SELECT outcome FROM workhorse.attempt_history WHERE task_id = %s ORDER BY attempt",
        (task_id,),
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


def execute_replay_conflict_fixture(
    connection: psycopg.Connection[Any], fixture: Mapping[str, Any]
) -> None:
    from workhorse.errors import (
        CheckpointConflictError,
        WaitConflictError,
        ChildConflictError,
        HumanWaitConflictError,
        ChildLimitExceededError,
        SignalWaitConflictError,
    )

    errors = {
        "checkpoint": CheckpointConflictError,
        "wait": WaitConflictError,
        "child": ChildConflictError,
        "child-set": ChildConflictError,
        "redacted-child": ChildConflictError,
        "human": HumanWaitConflictError,
        "signal-wait": SignalWaitConflictError,
    }
    for entry in fixture["cases"]:
        queue_name = runtime_queue(fixture) + "-" + entry["errorKind"]
        task_id = Queue(connection).enqueue(
            fixture["taskType"],
            {},
            EnqueueOptions(
                queue=queue_name,
                max_attempts=fixture["maxAttempts"],
            ),
        )
        if entry["redactErrorDetails"]:
            connection.execute(
                "UPDATE workhorse.task SET payload_redact_keys = ARRAY['secret'] WHERE id=%s",
                (task_id,),
            )
        delay_calls: list[int] = []

        def delay(attempt: int, task: object) -> int:
            delay_calls.append(attempt)
            return 60_000

        def handler(payload: object, context: HandlerContext) -> None:
            kind = entry["errorKind"]
            if kind == "child-limit":
                raise ChildLimitExceededError(task_id)
            if kind == "transient":
                raise Exception("transient")
            if kind == "wrapped-checkpoint":
                raise Exception("handler") from CheckpointConflictError(task_id, "saved")
            raise errors[kind](task_id, "child set" if kind == "child-set" else "saved")

        subject = Worker(
            worker_pool, queue=queue_name, worker_id="python-conflict", retry_delay_ms=delay
        ).handle(fixture["taskType"], handler)
        assert subject.run_once() is True
        row = connection.execute(
            "SELECT state, current_attempt, error FROM workhorse.task_runtime WHERE task_id = %s UNION ALL SELECT state, current_attempt, error FROM workhorse.task_outcome WHERE task_id = %s",
            (task_id, task_id),
        ).fetchone()
        assert row is not None
        assert row[0:2] == (entry["expectedState"], entry["expectedAttempt"])
        assert row[2]["name"] == entry["expectedErrorNames"]["python"]
        assert len(delay_calls) == (0 if entry["expectedState"] == "failed" else 1)
        outcomes = connection.execute(
            "SELECT outcome FROM workhorse.attempt_history WHERE task_id = %s", (task_id,)
        ).fetchall()
        assert outcomes == [("failed" if entry["expectedState"] == "failed" else "retry",)]


def test_replay_conflicts_fail_on_first_occurrence(database_url: str) -> None:
    fixture = next(
        f for f in read_json("protocol/v1/runtime.json") if f["kind"] == "replay-conflict"
    )
    with psycopg.connect(database_url, autocommit=True) as connection:
        execute_replay_conflict_fixture(connection, fixture)
