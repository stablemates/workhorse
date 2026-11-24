from __future__ import annotations
# ruff: noqa


import asyncio
import contextvars
import io
import json
import subprocess
import sys
import textwrap
import threading
from collections.abc import Iterable, Mapping
from contextlib import suppress
from datetime import UTC, datetime, timedelta
from pathlib import Path
from time import monotonic
from typing import Any
from uuid import uuid4

import psycopg
import pytest
import workhorse._telemetry
import workhorse.worker
from opentelemetry import metrics, trace
from opentelemetry._logs import set_logger_provider
from opentelemetry.sdk._logs import LoggerProvider
from opentelemetry.sdk._logs.export import InMemoryLogRecordExporter, SimpleLogRecordProcessor
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader, Metric
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import StatusCode

from eventual_conditions import eventually
from reservations import ScriptedHeartbeats, ScriptedPool
from workhorse import (
    Admin,
    AdminAudit,
    AsyncAdmin,
    AsyncHandlerContext,
    AsyncQueue,
    AsyncWorker,
    BulkRedriveOptions,
    DeadLetterFilter,
    Debounce,
    EnqueueOptions,
    EnqueueRequest,
    HandlerContext,
    Idempotency,
    Json,
    Queue,
    ScheduleDefinition,
    ScheduledTask,
    Throttle,
    Worker,
)
from workhorse._telemetry import (
    record_batch,
    record_failure,
    record_heartbeat_failure,
    record_heartbeat_round_failure,
    record_recovery,
)

SPAN_EXPORTER = InMemorySpanExporter()
TRACE_PROVIDER = TracerProvider()
TRACE_PROVIDER.add_span_processor(SimpleSpanProcessor(SPAN_EXPORTER))
trace.set_tracer_provider(TRACE_PROVIDER)

METRIC_READER = InMemoryMetricReader()
metrics.set_meter_provider(MeterProvider(metric_readers=(METRIC_READER,)))

LOG_EXPORTER = InMemoryLogRecordExporter()
LOG_PROVIDER = LoggerProvider()
LOG_PROVIDER.add_log_record_processor(SimpleLogRecordProcessor(LOG_EXPORTER))
set_logger_provider(LOG_PROVIDER)


def _metrics() -> Iterable[Metric]:
    data = METRIC_READER.get_metrics_data()
    assert data is not None
    for resource in data.resource_metrics:
        for scope in resource.scope_metrics:
            yield from scope.metrics


def _metric_attributes(metric: Metric) -> list[Mapping[str, Any]]:
    return [point.attributes for point in metric.data.data_points]


def _typescript_worker_metric_catalog() -> dict[str, dict[str, object]]:
    repository_root = Path(__file__).parents[2]
    result = subprocess.run(
        (
            "pnpm",
            "exec",
            "tsx",
            "--conditions=workhorse-source",
            "typescript/core/test/worker-telemetry-catalog.ts",
        ),
        cwd=repository_root,
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def _contract_instruments() -> dict[str, tuple[str, str]]:
    """The unit and description of each instrument in api/telemetry.txt."""
    contract = (Path(__file__).parents[2] / "api" / "telemetry.txt").read_text(encoding="utf-8")
    instruments = contract.split("## Instruments", 1)[1].split("## Spans", 1)[0]
    rows = (line.split(maxsplit=3) for line in instruments.splitlines())
    return {row[0]: (row[2], row[3]) for row in rows if len(row) == 4 and row[0] != "#"}


def test_worker_telemetry_matches_the_typescript_contract(database_url: str) -> None:
    SPAN_EXPORTER.clear()
    LOG_EXPORTER.clear()
    trace_context = {"traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"}

    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
    ):
        task_id = Queue(enqueue_connection, "mail").enqueue("mail.send", {"secret": "payload"})
        enqueue_connection.execute(
            "UPDATE workhorse.task SET trace_context = %s::jsonb WHERE id = %s",
            (json.dumps(trace_context), task_id),
        )
        enqueue_connection.commit()

        observed_contexts: list[HandlerContext] = []

        def handle(_payload: object, context: HandlerContext) -> dict[str, bool]:
            observed_contexts.append(context)
            return {"sent": True}

        worker = Worker(worker_pool, queue="mail", worker_id="python-telemetry-worker")
        worker.handle("mail.send", handle)
        assert worker.run_once() is True

    assert len(observed_contexts) == 1
    spans = list(SPAN_EXPORTER.get_finished_spans())
    handler_span = next(span for span in spans if span.name == "workhorse.handler")
    completion_span = next(span for span in spans if span.name == "workhorse.complete")
    maintenance_recovery_span = next(
        span
        for span in spans
        if span.name == "workhorse.recovery" and "workhorse.recovery.skipped" in span.attributes
    )
    assert handler_span.parent is not None
    assert format(handler_span.parent.span_id, "016x") == "00f067aa0ba902b7"
    assert handler_span.attributes == {
        "workhorse.queue.name": "mail",
        "workhorse.task.id": task_id,
        "workhorse.task.type": "mail.send",
        "workhorse.task.attempt": 1,
        "workhorse.handler.outcome": "succeeded",
    }
    assert completion_span.parent is not None
    assert completion_span.parent.span_id == handler_span.context.span_id
    assert maintenance_recovery_span.attributes["workhorse.recovery.skipped"] is False
    assert "workhorse.recovery.rows_affected" in maintenance_recovery_span.attributes
    assert "workhorse.recovery.expired_leases" in maintenance_recovery_span.attributes
    assert "workhorse.recovery.retried" in maintenance_recovery_span.attributes

    catalog_task = observed_contexts[0].task
    record_failure(catalog_task, "scheduled")
    record_recovery(1, 0, [])
    record_batch(catalog_task.queue, catalog_task.type, 1, 0, True)
    record_heartbeat_failure("stale")
    record_heartbeat_round_failure(ConnectionResetError("reset"))

    expected_metrics = _typescript_worker_metric_catalog()
    # The queue records workhorse.tasks.cancellation and the admin records workhorse.tasks.redrive,
    # not the worker, and other tests of this process can record them before this test reads the
    # shared reader.
    exported_metrics = {
        metric.name: metric
        for metric in _metrics()
        if not metric.name.startswith(("workhorse.maintenance.", "workhorse.schedule."))
        and metric.name not in {"workhorse.tasks.cancellation", "workhorse.tasks.redrive"}
    }
    observed_catalog = {
        name: {
            "unit": metric.unit,
            "attributes": sorted(
                {key for attributes in _metric_attributes(metric) for key in attributes}
            ),
        }
        for name, metric in exported_metrics.items()
    }
    assert observed_catalog == expected_metrics
    contract = _contract_instruments()
    for metric in _metrics():
        assert (metric.unit, metric.description) == contract[metric.name], metric.name
    assert len(exported_metrics) == len(expected_metrics)
    expected_task_attributes = {
        "workhorse.queue.name": "mail",
        "workhorse.task.type": "mail.send",
    }
    assert expected_task_attributes in _metric_attributes(
        exported_metrics["workhorse.tasks.claimed"]
    )
    assert expected_task_attributes in _metric_attributes(
        exported_metrics["workhorse.tasks.completed"]
    )
    for metric in exported_metrics.values():
        for attributes in _metric_attributes(metric):
            assert "workhorse.task.id" not in attributes

    events = {record.log_record.event_name for record in LOG_EXPORTER.get_finished_logs()}
    assert {
        "workhorse.handler.registered",
        "workhorse.task.claimed",
        "workhorse.handler.started",
        "workhorse.task.completed",
        "workhorse.task.execution_finished",
        "workhorse.handler.finished",
    } <= events
    # A one-pass call is not a run, so it writes no start and no stop record, as in TypeScript.
    assert not {"workhorse.worker.started", "workhorse.worker.stopped"} & events


class _ContextThread(threading.Thread):
    """Run in the starting thread's context, as OpenTelemetry's threading instrumentation does."""

    def start(self) -> None:
        self._started_context = contextvars.copy_context()
        super().start()

    def run(self) -> None:
        self._started_context.run(super().run)


def test_a_handler_span_descends_only_from_the_task_trace_context(
    database_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    SPAN_EXPORTER.clear()
    monkeypatch.setattr(workhorse.worker, "Thread", _ContextThread)
    stored = {"traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"}
    with psycopg.connect(database_url) as connection:
        queue = Queue(connection, "trace-parent")
        untraced_id = queue.enqueue("trace.parent", {})
        traced_id = queue.enqueue("trace.parent", {})
        connection.execute(
            "UPDATE workhorse.task SET trace_context = %s::jsonb WHERE id = %s",
            (json.dumps(stored), traced_id),
        )
        connection.commit()

    worker = Worker(worker_pool, queue="trace-parent", worker_id="python-trace-parent")
    worker.handle("trace.parent", lambda _payload, _context: None)
    with trace.get_tracer("unrelated").start_as_current_span("unrelated") as unrelated:
        assert worker.run_once() is True
        while worker.run_once():
            pass

    handler_spans = {
        span.attributes["workhorse.task.id"]: span
        for span in SPAN_EXPORTER.get_finished_spans()
        if span.name == "workhorse.handler"
    }
    untraced = handler_spans[untraced_id]
    assert untraced.parent is None
    assert untraced.context.trace_id != unrelated.get_span_context().trace_id
    traced = handler_spans[traced_id]
    assert traced.parent is not None
    assert format(traced.parent.trace_id, "032x") == "4bf92f3577b34da6a3ce929d0e0e4736"
    assert format(traced.parent.span_id, "016x") == "00f067aa0ba902b7"


@pytest.mark.asyncio
async def test_an_async_checkpoint_operation_traces_inside_the_handler_span(
    database_url: str, asyncpg_pool: Any
) -> None:
    SPAN_EXPORTER.clear()
    with psycopg.connect(database_url) as connection:
        Queue(connection).enqueue("async.traced", {}, EnqueueOptions(queue="async-traced"))
    tracer = trace.get_tracer("checkpoint-operation")

    async def operation() -> Json:
        with tracer.start_as_current_span("checkpoint.operation"):
            await asyncio.sleep(0)
        return "traced"

    async def handle(_payload: Json, context: AsyncHandlerContext) -> Json:
        return await context.checkpoint("traced", operation)

    worker = AsyncWorker.from_asyncpg(asyncpg_pool, queue="async-traced", worker_id="py-traced")
    worker.handle("async.traced", handle)
    assert await worker.run_once() is True

    spans = SPAN_EXPORTER.get_finished_spans()
    handler_span = next(span for span in spans if span.name == "workhorse.handler")
    operation_span = next(span for span in spans if span.name == "checkpoint.operation")
    assert operation_span.parent is not None
    assert operation_span.parent.span_id == handler_span.context.span_id


def test_worker_telemetry_never_exports_payloads_or_error_values(database_url: str) -> None:
    SPAN_EXPORTER.clear()
    LOG_EXPORTER.clear()
    secret = "provider-secret-value"

    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
    ):
        Queue(enqueue_connection, "mail").enqueue(
            "mail.fail",
            {"secret": secret},
            EnqueueOptions(max_attempts=2),
        )
        enqueue_connection.commit()

        def fail(_payload: object, _context: HandlerContext) -> dict[str, bool]:
            raise RuntimeError(f"provider rejected {secret}")

        worker = Worker(worker_pool, queue="mail", worker_id="python-telemetry-redaction")
        worker.handle("mail.fail", fail)
        assert worker.run_once() is True

    exported = json.dumps(
        {
            "spans": [
                {
                    "attributes": dict(span.attributes or {}),
                    "events": [
                        {"name": event.name, "attributes": dict(event.attributes or {})}
                        for event in span.events
                    ],
                }
                for span in SPAN_EXPORTER.get_finished_spans()
            ],
            "logs": [
                {
                    "event_name": record.log_record.event_name,
                    "body": record.log_record.body,
                    "attributes": dict(record.log_record.attributes or {}),
                }
                for record in LOG_EXPORTER.get_finished_logs()
            ],
        },
        default=str,
    )
    assert secret not in exported
    assert "RuntimeError" in exported
    handler_span = next(
        span for span in SPAN_EXPORTER.get_finished_spans() if span.name == "workhorse.handler"
    )
    retry_span = next(
        span for span in SPAN_EXPORTER.get_finished_spans() if span.name == "workhorse.retry"
    )
    assert handler_span.attributes["workhorse.handler.outcome"] == "scheduled"
    assert handler_span.status.status_code is StatusCode.ERROR
    assert retry_span.status.status_code is StatusCode.UNSET


def test_worker_warns_when_a_handler_swallows_a_suspension_signal(database_url: str) -> None:
    SPAN_EXPORTER.clear()
    LOG_EXPORTER.clear()

    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
    ):
        task_id = Queue(enqueue_connection).enqueue("approval", {})
        enqueue_connection.commit()

        def swallow(_payload: object, context: HandlerContext) -> dict[str, bool]:
            with suppress(BaseException):
                context.wait_for_signal("approval")
            return {"incorrectlyCompleted": True}

        worker = Worker(worker_pool, worker_id="python-swallowed-signal")
        worker.handle("approval", swallow)
        assert worker.run_once() is True
        assert worker_connection.execute(
            "SELECT state FROM workhorse.task_runtime WHERE task_id = %s", (task_id,)
        ).fetchone() == ("scheduled",)

    # SM-2016: exactly one warning, as in the other six SDKs.
    (warning,) = [
        record.log_record
        for record in LOG_EXPORTER.get_finished_logs()
        if record.log_record.event_name == "workhorse.handler.signal_swallowed"
    ]
    assert warning.severity_text == "WARN"
    assert warning.body == "Task handler swallowed its abort signal"
    assert warning.attributes["workhorse.handler.outcome"] == "suspended"
    assert not any(
        record.log_record.event_name == "workhorse.task.completed"
        for record in LOG_EXPORTER.get_finished_logs()
    )


def test_worker_warns_when_a_handler_raises_after_it_swallows_a_suspension(
    database_url: str,
) -> None:
    LOG_EXPORTER.clear()

    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
    ):
        task_id = Queue(enqueue_connection).enqueue("approval-raises", {})
        enqueue_connection.commit()

        def swallow_and_raise(_payload: object, context: HandlerContext) -> None:
            try:
                context.wait_for_signal("approval")
            except BaseException as error:
                raise RuntimeError("replacement handler error") from error

        worker = Worker(worker_pool, worker_id="python-swallowed-signal-raises")
        worker.handle("approval-raises", swallow_and_raise)
        assert worker.run_once() is True
        assert worker_connection.execute(
            "SELECT state FROM workhorse.task_runtime WHERE task_id = %s", (task_id,)
        ).fetchone() == ("scheduled",)

    # SM-2066: a raised error also swallows the suspension, so the worker warns, as in the other
    # five SDKs. The record holds no part of the raised error.
    (warning,) = _log_records("workhorse.handler.signal_swallowed")
    assert warning.severity_text == "WARN"
    assert warning.body == "Task handler swallowed its abort signal"
    assert dict(warning.attributes or {}) == {
        "workhorse.task.id": task_id,
        "workhorse.task.type": "approval-raises",
        "workhorse.task.attempt": 1,
        "workhorse.queue.name": "default",
        "workhorse.worker.id": "python-swallowed-signal-raises",
        "workhorse.handler.outcome": "suspended",
    }
    assert "replacement handler error" not in str(LOG_EXPORTER.get_finished_logs())


def _counter_values(name: str) -> dict[tuple[tuple[str, Any], ...], float]:
    """The cumulative value of each attribute set of the counter `name`. Empty before any data."""
    if METRIC_READER.get_metrics_data() is None:
        return {}
    return {
        tuple(sorted(point.attributes.items())): point.value
        for metric in _metrics()
        if metric.name == name
        for point in metric.data.data_points
    }


def _histogram_counts(name: str) -> dict[tuple[tuple[str, Any], ...], int]:
    """The cumulative count of each attribute set of the histogram `name`. Empty before any data."""
    if METRIC_READER.get_metrics_data() is None:
        return {}
    return {
        tuple(sorted(point.attributes.items())): point.count
        for metric in _metrics()
        if metric.name == name
        for point in metric.data.data_points
    }


def _added_by_outcome(
    before: Mapping[tuple[tuple[str, Any], ...], float],
    after: Mapping[tuple[tuple[str, Any], ...], float],
    task_type: str,
) -> dict[str, float]:
    """The increase of each `workhorse.handler.outcome` of `task_type` from `before` to `after`."""
    return {
        dict(attributes)["workhorse.handler.outcome"]: value - before.get(attributes, 0)
        for attributes, value in after.items()
        if dict(attributes).get("workhorse.task.type") == task_type
        and value != before.get(attributes, 0)
    }


def test_a_failed_heartbeat_round_counts_by_reason_and_the_task_completes(
    database_url: str,
) -> None:
    """A round that fails before PostgreSQL gives a verdict counts once in round_failure.

    The task keeps running, and the next rounds renew its lease. The failed round gives no
    ownership verdict, so `workhorse.worker.heartbeat.failure` does not count it.

    SM-1817: a 100 ms heartbeat gives each round a 75 ms bound and a server budget of about
    18 ms. On a loaded host, a later round can reach that bound and count once as `timeout`.
    That is a second failed round, so the test accepts it. The injected failure is an
    `OperationalError` without a SQLSTATE or a timeout in its chain, so it can only count as
    `connection`.
    """
    with psycopg.connect(database_url) as connection:
        task_id = Queue(connection, "round-failure").enqueue("round.failure", {})
        connection.commit()
    round_failures_before = _counter_values("workhorse.worker.heartbeat.round_failure")
    heartbeat_failures_before = _counter_values("workhorse.worker.heartbeat.failure")

    worker = Worker(
        worker_pool,
        queue="round-failure",
        worker_id="python-round-failure",
        lease_ms=3_000,
        heartbeat_ms=100,
    )
    send_round = worker._heartbeat_rows
    rounds: list[str] = []

    def heartbeat_rows(*args: Any, **kwargs: Any) -> Any:
        rounds.append("sent")
        if len(rounds) == 1:
            raise psycopg.OperationalError("consuming input failed: server closed the connection")
        return send_round(*args, **kwargs)

    worker._heartbeat_rows = heartbeat_rows  # type: ignore[method-assign]

    def handle(_payload: object, context: HandlerContext) -> None:
        # A round after the failed one commits a renewal in PostgreSQL before the handler
        # returns. Only a committed renewal ends this wait (SM-1817).
        with psycopg.connect(database_url, autocommit=True) as connection:
            eventually(
                lambda: _renewed(connection, task_id),
                "a heartbeat round after the failed one renewed the lease",
                timeout_s=10,
            )
        assert not context.cancellation.cancelled

    worker.handle("round.failure", handle)
    assert worker.run_once() is True

    with psycopg.connect(database_url) as connection:
        row = connection.execute(
            "SELECT state FROM workhorse.task_outcome WHERE task_id = %s", (task_id,)
        ).fetchone()
    assert row == ("succeeded",)

    round_failure = next(
        (
            metric
            for metric in _metrics()
            if metric.name == "workhorse.worker.heartbeat.round_failure"
        ),
        None,
    )
    assert round_failure is not None, "the failed round was not counted"
    assert round_failure.unit == "{round}"
    round_failures = _counter_values("workhorse.worker.heartbeat.round_failure")
    added = {
        attributes: value - round_failures_before.get(attributes, 0)
        for attributes, value in round_failures.items()
        if value != round_failures_before.get(attributes, 0)
    }
    connection_reason = (("workhorse.heartbeat.failure_reason", "connection"),)
    timeout_reason = (("workhorse.heartbeat.failure_reason", "timeout"),)
    assert added.get(connection_reason) == 1, added
    # A later round that reaches its deadline is a second failed round (SM-1817).
    assert set(added) <= {connection_reason, timeout_reason}, added
    assert _counter_values("workhorse.worker.heartbeat.failure") == heartbeat_failures_before


def _renewed(connection: psycopg.Connection[Any], task_id: str) -> bool:
    """Whether a heartbeat has renewed the lease of `task_id` since its claim.

    The claim sets `heartbeat_at` to `acquired_at`, and only a committed renewal moves it later.
    """
    row = connection.execute(
        "SELECT heartbeat_at > acquired_at FROM workhorse.task_runtime WHERE task_id = %s",
        (task_id,),
    ).fetchone()
    return row is not None and row[0] is True


def _move_fence(database_url: str, task_id: str) -> None:
    """Move the fence of `task_id`, so PostgreSQL answers stale to the next fenced write."""
    with psycopg.connect(database_url, autocommit=True) as connection:
        connection.execute(
            "UPDATE workhorse.task_runtime SET fence_token = fence_token + 1 WHERE task_id = %s",
            (task_id,),
        )


def _exception_types(span: Any) -> list[object]:
    return [
        (event.attributes or {}).get("exception.type")
        for event in span.events
        if event.name == "exception"
    ]


@pytest.mark.parametrize(
    "settlement",
    ["fail", "release", "unacknowledged-cancel", "heartbeat", "unacknowledged-release"],
)
def test_a_stale_settlement_reports_a_lost_lease_as_the_handler_outcome(
    database_url: str, monkeypatch: pytest.MonkeyPatch, settlement: str
) -> None:
    """A stale answer from fail_v1 or release_owned_v1 reports lease_lost, not unknown (SM-1863).

    The fence moves before the write or while the heartbeat renews, or fail_v1 or release_owned_v1
    answers cancel_requested and the acknowledgement is refused. The worker settles nothing, and
    lease recovery owns the task. The span, the executions metric, and the execution_finished log
    state that lost lease. As in TypeScript, a lost lease does not give the span the error status.
    Only a handler error does, and the span keeps that error also when the lease is lost after it.
    """
    SPAN_EXPORTER.clear()
    LOG_EXPORTER.clear()
    queue_name = f"stale-{settlement}"
    task_type = f"stale.{settlement}"
    with psycopg.connect(database_url) as connection:
        task_id = Queue(connection, queue_name).enqueue(task_type, {})
        connection.commit()
    executions_before = _counter_values("workhorse.handler.executions")

    worker = Worker(worker_pool, queue=queue_name, worker_id=f"python-stale-{settlement}")
    if settlement == "fail":

        def fail(_payload: object, _context: HandlerContext) -> None:
            _move_fence(database_url, task_id)
            raise RuntimeError("the handler failed")

        worker.handle(task_type, fail)
    elif settlement == "unacknowledged-cancel":

        def cancel_then_fail(_payload: object, _context: HandlerContext) -> None:
            with psycopg.connect(database_url) as connection:
                assert Queue(connection, queue_name).cancel(task_id).status == "cancel_requested"
                connection.commit()
            raise RuntimeError("the handler failed")

        worker.handle(task_type, cancel_then_fail)
        monkeypatch.setattr(worker, "_acknowledge_cancel", lambda _task: False)
    elif settlement == "heartbeat":
        worker = Worker(
            worker_pool,
            queue=queue_name,
            worker_id=f"python-stale-{settlement}",
            lease_ms=3_000,
            heartbeat_ms=100,
        )

        def lose_lease(_payload: object, context: HandlerContext) -> None:
            _move_fence(database_url, task_id)
            eventually(
                lambda: context.cancellation.cancelled,
                "the heartbeat never reported the lost lease",
                timeout_s=10,
            )

        worker.handle(task_type, lose_lease)
    elif settlement == "unacknowledged-release":
        # No handler is registered. release_owned_v1 answers cancel_requested, and PostgreSQL
        # refuses the acknowledgement.
        send_release = workhorse.worker._fenced_write_rows

        def release_rows(executor: Any, statement: Any, parameters: Any) -> Any:
            if statement is workhorse.worker._STATEMENTS.release_owned:
                return [{"status": "cancel_requested"}]
            return send_release(executor, statement, parameters)

        monkeypatch.setattr(workhorse.worker, "_fenced_write_rows", release_rows)
        monkeypatch.setattr(worker, "_acknowledge_cancel", lambda _task: False)
    else:
        # No handler is registered, so the worker releases the claim through release_owned_v1.
        send = workhorse.worker._fenced_write_rows

        def fenced_write_rows(executor: Any, statement: Any, parameters: Any) -> Any:
            if statement is workhorse.worker._STATEMENTS.release_owned:
                _move_fence(database_url, task_id)
            return send(executor, statement, parameters)

        monkeypatch.setattr(workhorse.worker, "_fenced_write_rows", fenced_write_rows)
    worker.run_once()

    handler_span = next(
        span
        for span in SPAN_EXPORTER.get_finished_spans()
        if span.name == "workhorse.handler" and span.attributes["workhorse.task.id"] == task_id
    )
    assert handler_span.attributes["workhorse.handler.outcome"] == "stale"
    if settlement in {"fail", "unacknowledged-cancel"}:
        assert handler_span.status.status_code is StatusCode.ERROR
        assert _exception_types(handler_span) == ["RuntimeError"]
    else:
        assert handler_span.status.status_code is StatusCode.UNSET
        assert _exception_types(handler_span) == []
    executions = _counter_values("workhorse.handler.executions")
    added = {
        dict(attributes)["workhorse.handler.outcome"]: value - executions_before.get(attributes, 0)
        for attributes, value in executions.items()
        if dict(attributes).get("workhorse.task.type") == task_type
        and value != executions_before.get(attributes, 0)
    }
    assert added == {"lease_lost": 1}
    finished = [
        record.log_record.attributes["workhorse.handler.outcome"]
        for record in LOG_EXPORTER.get_finished_logs()
        if record.log_record.event_name == "workhorse.task.execution_finished"
        and record.log_record.attributes["workhorse.task.id"] == task_id
    ]
    assert finished == ["lease_lost"]


def test_a_failed_failure_write_records_the_handler_error_first(
    database_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """TypeScript records the handler error before fail_v1, and then the error of the statement."""
    SPAN_EXPORTER.clear()
    queue_name = _queue_name("failed-failure-write")
    with psycopg.connect(database_url) as connection:
        task_id = Queue(connection, queue_name).enqueue("failure.write", {})
        connection.commit()
    send = workhorse.worker._fenced_write_rows

    def fenced_write_rows(executor: Any, statement: Any, parameters: Any) -> Any:
        if statement is workhorse.worker._STATEMENTS.fail:
            raise psycopg.OperationalError("the failure write failed")
        return send(executor, statement, parameters)

    monkeypatch.setattr(workhorse.worker, "_fenced_write_rows", fenced_write_rows)

    def fail(_payload: object, _context: HandlerContext) -> None:
        raise RuntimeError("the handler failed")

    worker = Worker(worker_pool, queue=queue_name, worker_id="python-failed-failure-write")
    worker.handle("failure.write", fail)
    with suppress(psycopg.OperationalError):
        worker.run_once()

    [handler_span] = [
        span
        for span in SPAN_EXPORTER.get_finished_spans()
        if span.name == "workhorse.handler" and span.attributes["workhorse.task.id"] == task_id
    ]
    assert handler_span.status.status_code is StatusCode.ERROR
    assert _exception_types(handler_span) == ["RuntimeError", "OperationalError"]


# The lapsed-lease cases of the Go test worker_refused_completion_outcome_test.go: the boundary that
# comes due with the lapsed lease, the state when run_once returns, and the span and metric outcomes.
_LAPSED_LEASE_CASES = [
    ("deadline_at", "failed", "deadline_exceeded", "deadline_exceeded"),
    ("attempt_timeout_at", "failed", "timeout_exceeded", "timeout"),
    (None, "active", "stale", "lease_lost"),
]


def _lapse(database_url: str, task_id: str, boundary: str | None) -> None:
    """Let the lease of `task_id` lapse under an unchanged fence, and make `boundary` due."""
    past = "clock_timestamp() - interval '1 second'"
    change = f"expires_at = {past}" + (f", {boundary} = {past}" if boundary else "")
    with psycopg.connect(database_url, autocommit=True) as connection:
        connection.execute(
            f"UPDATE workhorse.task_runtime SET {change} WHERE task_id = %s",  # type: ignore[arg-type]
            (task_id,),
        )


@pytest.mark.parametrize("settlement", ["fail", "release"])
@pytest.mark.parametrize(
    ("boundary", "state", "span_outcome", "metric_outcome"), _LAPSED_LEASE_CASES
)
def test_a_stale_settlement_after_a_lapsed_lease_reports_the_settled_cause(
    database_url: str,
    monkeypatch: pytest.MonkeyPatch,
    settlement: str,
    boundary: str | None,
    state: str,
    span_outcome: str,
    metric_outcome: str,
) -> None:
    """A stale fail_v1 or release_owned_v1 answer after a lapsed lease settles its cause (SM-1884).

    The lease lapses under an unchanged fence. expire_owned_v1 does not read expires_at, so a due
    deadline or attempt timeout still settles, and the worker reports that cause. Only a lapsed lease
    with no due boundary reports a lost lease. The boundaries are an hour away, so the worker's own
    timers cannot reach them.
    """
    SPAN_EXPORTER.clear()
    queue_name = f"lapsed-{settlement}-{boundary or 'lease'}"
    task_type = f"lapsed.{settlement}.{boundary or 'lease'}"
    with psycopg.connect(database_url) as connection:
        task_id = Queue(connection, queue_name).enqueue(
            task_type,
            {},
            EnqueueOptions(
                max_attempts=1,
                deadline=datetime.now(UTC) + timedelta(hours=1),
                execution_timeout_ms=3_600_000,
            ),
        )
        connection.commit()
    executions_before = _counter_values("workhorse.handler.executions")

    worker = Worker(
        worker_pool,
        queue=queue_name,
        worker_id=f"python-{queue_name}",
        lease_ms=60_000,
        heartbeat_ms=30_000,
        maintenance_interval_ms=3_600_000,
    )
    if settlement == "fail":

        def fail(_payload: object, _context: HandlerContext) -> None:
            _lapse(database_url, task_id, boundary)
            raise RuntimeError("the handler failed")

        worker.handle(task_type, fail)
    else:
        # No handler is registered, so the worker releases the claim through release_owned_v1.
        send = workhorse.worker._fenced_write_rows

        def fenced_write_rows(executor: Any, statement: Any, parameters: Any) -> Any:
            if statement is workhorse.worker._STATEMENTS.release_owned:
                _lapse(database_url, task_id, boundary)
            return send(executor, statement, parameters)

        monkeypatch.setattr(workhorse.worker, "_fenced_write_rows", fenced_write_rows)
    worker.run_once()

    with psycopg.connect(database_url) as connection:
        row = connection.execute(
            "SELECT COALESCE(outcome.state, runtime.state) FROM workhorse.task task"
            " LEFT JOIN workhorse.task_runtime runtime ON runtime.task_id = task.id"
            " LEFT JOIN workhorse.task_outcome outcome ON outcome.task_id = task.id"
            " WHERE task.id = %s",
            (task_id,),
        ).fetchone()
    assert row is not None and row[0] == state
    handler_span = next(
        span
        for span in SPAN_EXPORTER.get_finished_spans()
        if span.name == "workhorse.handler" and span.attributes["workhorse.task.id"] == task_id
    )
    assert handler_span.attributes["workhorse.handler.outcome"] == span_outcome
    executions = _counter_values("workhorse.handler.executions")
    added = {
        dict(attributes)["workhorse.handler.outcome"]: value - executions_before.get(attributes, 0)
        for attributes, value in executions.items()
        if dict(attributes).get("workhorse.task.type") == task_type
        and value != executions_before.get(attributes, 0)
    }
    assert added == {metric_outcome: 1}


# The worker log events of the TypeScript union `WorkhorseLogEvent` (typescript/core/src/telemetry.ts).
# Each test checks the name, the severity, the body, and the attributes that TypeScript writes.


def _log_records(event_name: str) -> list[Any]:
    return [
        record.log_record
        for record in LOG_EXPORTER.get_finished_logs()
        if record.log_record.event_name == event_name
    ]


def _log_record(event_name: str) -> tuple[str | None, Any, dict[str, Any]]:
    records = _log_records(event_name)
    assert len(records) == 1, f"{event_name}: {len(records)} records"
    return records[0].severity_text, records[0].body, dict(records[0].attributes or {})


def _queue_name(label: str) -> str:
    return f"logs-{label}-{uuid4().hex[:8]}"


def test_enqueue_logs_each_enqueue_outcome(database_url: str) -> None:
    LOG_EXPORTER.clear()
    queue_name = _queue_name("enqueue")
    with psycopg.connect(database_url, autocommit=True) as connection:
        queue = Queue(connection, queue_name)
        accepted = queue.enqueue_with_result(
            "mail.send", {"secret": "payload"}, EnqueueOptions(idempotency=Idempotency("one"))
        )
        replayed = queue.enqueue_with_result(
            "mail.send", {"secret": "payload"}, EnqueueOptions(idempotency=Idempotency("one"))
        )
        debounce = Debounce("digest", 60_000, "reset")
        queue.enqueue_with_result("mail.digest", {"revision": 1}, EnqueueOptions(debounce=debounce))
        replaced = queue.enqueue_with_result(
            "mail.digest", {"revision": 2}, EnqueueOptions(debounce=debounce)
        )
        rejected = queue.enqueue_with_result(
            "mail.send",
            {"revision": 3},
            EnqueueOptions(debounce=Debounce("one", 60_000, "reset")),
        )
        throttle = Throttle("account-42", 60_000)
        queue.enqueue_with_result(
            "mail.throttled", {"account": 42}, EnqueueOptions(throttle=throttle)
        )
        coalesced = queue.enqueue_with_result(
            "mail.throttled", {"account": 42}, EnqueueOptions(throttle=throttle)
        )

    assert (accepted.outcome, replayed.outcome, replaced.outcome) == (
        "accepted",
        "replayed",
        "replaced",
    )
    assert (rejected.outcome, coalesced.outcome) == ("non_replaceable", "coalesced")
    expected = {
        "workhorse.task.enqueue_replayed": ("Idempotent enqueue replayed", replayed, "mail.send"),
        "workhorse.task.debounced": ("Pending task replaced", replaced, "mail.digest"),
        "workhorse.task.debounce_rejected": (
            "Debounced task not replaceable",
            rejected,
            "mail.send",
        ),
        "workhorse.task.throttled": ("Throttled enqueue coalesced", coalesced, "mail.throttled"),
    }
    for event_name, (body, result, task_type) in expected.items():
        assert _log_record(event_name) == (
            "DEBUG",
            body,
            {
                "workhorse.task.id": result.task_id,
                "workhorse.task.type": task_type,
                "workhorse.queue.name": queue_name,
            },
        )
    enqueued = [
        (record.severity_text, record.body, dict(record.attributes or {}))
        for record in _log_records("workhorse.task.enqueued")
    ]
    assert (
        "DEBUG",
        "Task enqueued",
        {
            "workhorse.task.id": accepted.task_id,
            "workhorse.task.type": "mail.send",
            "workhorse.queue.name": queue_name,
        },
    ) in enqueued
    assert len(enqueued) == 3


def test_a_task_group_logs_the_enqueue_of_its_members_only(database_url: str) -> None:
    LOG_EXPORTER.clear()
    queue_name = _queue_name("group")
    with psycopg.connect(database_url, autocommit=True) as connection:
        queue = Queue(connection, queue_name)
        with queue.task_group(on_finish=EnqueueRequest("group.finished", {})) as group:
            group.add([EnqueueRequest("group.member", {"index": 1})])

    tasks = group.result.tasks
    assert [
        dict(record.attributes or {}) for record in _log_records("workhorse.task.enqueued")
    ] == [
        {
            "workhorse.task.id": tasks[0].task_id,
            "workhorse.task.type": "group.member",
            "workhorse.queue.name": queue_name,
        }
    ]


def test_cancel_signal_and_human_wait_log_their_processing(database_url: str) -> None:
    LOG_EXPORTER.clear()
    missing = str(uuid4())
    with psycopg.connect(database_url, autocommit=True) as connection:
        queue = Queue(connection, _queue_name("cancel"))
        canceled = queue.cancel(missing, requested_by="api", reason="secret reason")
        signal = queue.send_signal(
            missing, "approval", {"secret": True}, idempotency_key="key", requested_by="api"
        )
        human = queue.complete_human_wait(
            missing, "review", {"secret": True}, idempotency_key="key", requested_by="api"
        )

    assert _log_record("workhorse.task.cancellation_processed") == (
        "INFO",
        "Task cancellation processed",
        {
            "workhorse.task.id": missing,
            "workhorse.task.state": "not_found",
            "workhorse.operation.status": canceled.status,
        },
    )
    assert _log_record("workhorse.task.signal_processed") == (
        "INFO",
        "Task signal processed",
        {
            "workhorse.task.id": missing,
            "workhorse.signal.name": "approval",
            "workhorse.signal.status": signal.status,
        },
    )
    assert _log_record("workhorse.task.human_wait_processed") == (
        "INFO",
        "Human wait completion processed",
        {
            "workhorse.task.id": missing,
            "workhorse.human_wait.name": "review",
            "workhorse.human_wait.status": human.status,
        },
    )


def _dashboard_post(host: Any, procedure: str, input_value: object) -> int:
    payload = json.dumps({"json": input_value}).encode()
    environ: dict[str, object] = {
        "REQUEST_METHOD": "POST",
        "PATH_INFO": f"/workhorse/rpc/dashboard/{procedure}",
        "wsgi.url_scheme": "https",
        "HTTP_HOST": "example.test",
        "HTTP_ORIGIN": "https://example.test",
        "CONTENT_LENGTH": str(len(payload)),
        "CONTENT_TYPE": "application/json",
        "wsgi.input": io.BytesIO(payload),
    }
    captured: dict[str, int] = {}

    def start_response(status: str, _headers: list[tuple[str, str]]) -> None:
        captured["status"] = int(status.split(maxsplit=1)[0])

    b"".join(host(environ, start_response))
    return captured["status"]


def test_dashboard_cancel_signal_and_human_wait_log_their_processing(database_url: str) -> None:
    from workhorse.dashboard import DashboardHost, DashboardPrincipal

    missing = str(uuid4())
    audit = {"actor": "operator", "reason": "test", "requestId": "request-1"}
    LOG_EXPORTER.clear()
    with psycopg.connect(database_url, autocommit=True) as connection:
        host = DashboardHost(connection, authorize=lambda _: DashboardPrincipal("operator"))
        assert _dashboard_post(host, "cancelTask", {"id": missing, "audit": audit}) == 404
        signal = {"id": missing, "name": "approval", "payload": {"secret": "never-log-this"}}
        assert (
            _dashboard_post(host, "signalTask", {**signal, "idempotencyKey": "k1", "audit": audit})
            == 404
        )
        human = {"id": missing, "name": "review", "result": {"secret": "never-log-this"}}
        assert (
            _dashboard_post(
                host, "completeHumanWait", {**human, "idempotencyKey": "k2", "audit": audit}
            )
            == 404
        )

    assert _log_record("workhorse.task.cancellation_processed") == (
        "INFO",
        "Task cancellation processed",
        {
            "workhorse.task.id": missing,
            "workhorse.task.state": "not_found",
            "workhorse.operation.status": "not_found",
        },
    )
    assert _log_record("workhorse.task.signal_processed") == (
        "INFO",
        "Task signal processed",
        {
            "workhorse.task.id": missing,
            "workhorse.signal.name": "approval",
            "workhorse.signal.status": "not_found",
        },
    )
    assert _log_record("workhorse.task.human_wait_processed") == (
        "INFO",
        "Human wait completion processed",
        {
            "workhorse.task.id": missing,
            "workhorse.human_wait.name": "review",
            "workhorse.human_wait.status": "not_found",
        },
    )
    assert "never-log-this" not in str(LOG_EXPORTER.get_finished_logs())


def _cancellation_counts() -> dict[str, int]:
    """The value of workhorse.tasks.cancellation for each workhorse.cancellation.status."""
    counts: dict[str, int] = {}
    # The reader returns no data before the first record of the process.
    if METRIC_READER.get_metrics_data() is None:
        return counts
    for metric in _metrics():
        if metric.name != "workhorse.tasks.cancellation":
            continue
        assert (metric.unit, metric.description) == _contract_instruments()[metric.name]
        for point in metric.data.data_points:
            status = str(point.attributes["workhorse.cancellation.status"])
            assert set(point.attributes) == {"workhorse.cancellation.status"}
            counts[status] = counts.get(status, 0) + int(point.value)
    return counts


def _counted_since(before: dict[str, int]) -> dict[str, int]:
    after = _cancellation_counts()
    return {
        status: after[status] - before.get(status, 0)
        for status in after
        if after[status] != before.get(status, 0)
    }


def test_queue_cancel_counts_each_durable_result(database_url: str) -> None:
    before = _cancellation_counts()
    with psycopg.connect(database_url, autocommit=True) as connection:
        queue = Queue(connection, _queue_name("cancel-metric"))
        task_id = queue.enqueue("mail.send", {})
        assert queue.cancel(task_id).status == "canceled"
        assert queue.cancel(task_id).status == "canceled"
        assert queue.cancel(str(uuid4())).status == "not_found"

    assert _counted_since(before) == {"canceled": 2, "not_found": 1}


@pytest.mark.asyncio
async def test_async_queue_cancel_counts_each_durable_result(database_url: str) -> None:
    before = _cancellation_counts()
    async with await psycopg.AsyncConnection.connect(database_url, autocommit=True) as connection:
        queue = AsyncQueue.from_psycopg(connection, _queue_name("cancel-metric"))
        task_id = await queue.enqueue("mail.send", {})
        assert (await queue.cancel(task_id)).status == "canceled"
        assert (await queue.cancel(str(uuid4()))).status == "not_found"

    assert _counted_since(before) == {"canceled": 1, "not_found": 1}


def test_dashboard_cancel_counts_each_durable_result(database_url: str) -> None:
    from workhorse.dashboard import DashboardHost, DashboardPrincipal

    audit = {"actor": "operator", "reason": "test", "requestId": "request-1"}
    before = _cancellation_counts()
    with psycopg.connect(database_url, autocommit=True) as connection:
        task_id = Queue(connection, _queue_name("cancel-metric")).enqueue("mail.send", {})
        host = DashboardHost(connection, authorize=lambda _: DashboardPrincipal("operator"))
        assert _dashboard_post(host, "cancelTask", {"id": task_id, "audit": audit}) == 200
        assert _dashboard_post(host, "cancelTask", {"id": str(uuid4()), "audit": audit}) == 404

    assert _counted_since(before) == {"canceled": 1, "not_found": 1}


def test_a_failed_cancellation_count_does_not_change_the_cancel_result(
    database_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    class FailingCounter:
        def add(self, amount: int | float, attributes: Any = None) -> None:
            raise RuntimeError("metric backend failed")

    monkeypatch.setattr(workhorse._telemetry, "_cancellations", FailingCounter())
    with psycopg.connect(database_url, autocommit=True) as connection:
        result = Queue(connection, _queue_name("cancel-metric")).cancel(str(uuid4()))

    assert result.status == "not_found"


def test_a_meter_that_rejects_the_cancellation_counter_does_not_stop_the_import() -> None:
    """A meter can refuse to create the counter. The SDK creates it on its first count, inside the
    guard, so the import of the SDK does not fail and the count is lost. A fresh interpreter is
    necessary, because the import of this process already happened."""
    script = textwrap.dedent(
        """
        from opentelemetry import metrics
        from opentelemetry.sdk.metrics import MeterProvider

        class RejectingProvider(MeterProvider):
            def get_meter(self, *args, **kwargs):
                meter = super().get_meter(*args, **kwargs)
                create_counter = meter.create_counter

                def rejecting(name, *counter_args, **counter_kwargs):
                    if name == "workhorse.tasks.cancellation":
                        raise RuntimeError("create_counter failed")
                    return create_counter(name, *counter_args, **counter_kwargs)

                meter.create_counter = rejecting
                return meter

        metrics.set_meter_provider(RejectingProvider())
        import workhorse._telemetry as telemetry

        telemetry.record_cancellation("canceled")
        print("contained")
        """
    )
    completed = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True, timeout=60, check=False
    )

    assert completed.returncode == 0, completed.stderr
    assert completed.stdout.strip() == "contained"


def _redrive_counts() -> dict[str, int]:
    """The value of workhorse.tasks.redrive for each workhorse.redrive.status."""
    counts: dict[str, int] = {}
    # The reader returns no data before the first record of the process.
    if METRIC_READER.get_metrics_data() is None:
        return counts
    for metric in _metrics():
        if metric.name != "workhorse.tasks.redrive":
            continue
        assert (metric.unit, metric.description) == _contract_instruments()[metric.name]
        for point in metric.data.data_points:
            status = str(point.attributes["workhorse.redrive.status"])
            assert set(point.attributes) == {"workhorse.redrive.status"}
            counts[status] = counts.get(status, 0) + int(point.value)
    return counts


def _redriven_since(before: dict[str, int]) -> dict[str, int]:
    after = _redrive_counts()
    return {
        status: after[status] - before.get(status, 0)
        for status in after
        if after[status] != before.get(status, 0)
    }


# redrive_many_v1 answers three rows: two of a known status and one of a status of a newer protocol.
# Only a test of a failed task gives real rows, so the function is replaced in the test database.
_SCRIPTED_REDRIVE_MANY = """
CREATE OR REPLACE FUNCTION workhorse.redrive_many_v1(
  p_filter jsonb, p_limit integer, p_dry_run boolean, p_requested_by text, p_reason text,
  p_request_id text, p_cursor_finished_at timestamptz DEFAULT NULL,
  p_cursor_task_id uuid DEFAULT NULL
) RETURNS TABLE (
  ordinal integer, status text, source_task_id uuid, target_task_id uuid, source_state text,
  target_state text, requested_at timestamptz, source_finished_at_cursor text, has_more boolean
) LANGUAGE sql AS $body$
  SELECT row.ordinal, row.status, gen_random_uuid(), NULL::uuid, NULL::text, NULL::text,
         NULL::timestamptz, NULL::text, false
  FROM (VALUES (1, 'redriven'), (2, 'future_status'), (3, 'redriven')) AS row(ordinal, status)
$body$
"""

# redrive_v1 answers a status of a newer protocol.
_FUTURE_REDRIVE = """
CREATE OR REPLACE FUNCTION workhorse.redrive_v1(
  p_source_task_id uuid, p_requested_by text, p_reason text, p_request_id text
) RETURNS TABLE (
  status text, source_task_id uuid, target_task_id uuid, source_state text, target_state text,
  requested_at timestamptz
) LANGUAGE sql AS $body$
  SELECT 'future_status'::text, p_source_task_id, NULL::uuid, NULL::text, NULL::text,
         NULL::timestamptz
$body$
"""


def _redrive_audit() -> AdminAudit:
    return AdminAudit("python-test", "redrive metric", f"request-{uuid4()}")


def test_admin_redrive_counts_each_durable_result(database_url: str) -> None:
    before = _redrive_counts()
    with psycopg.connect(database_url, autocommit=True) as connection:
        task_id = Queue(connection, _queue_name("redrive-metric")).enqueue("mail.send", {})
        admin = Admin(connection)
        assert admin.redrive(str(uuid4()), _redrive_audit()).status == "not_found"
        assert admin.redrive(task_id, _redrive_audit()).status == "not_failed"
        # A page without a failed task counts nothing.
        empty = admin.redrive_many(
            DeadLetterFilter(queue=_queue_name("redrive-metric")), _redrive_audit()
        )
        assert empty.results == ()

    assert _redriven_since(before) == {"not_found": 1, "not_failed": 1}


def test_admin_redrive_many_counts_each_result_by_its_status(database_url: str) -> None:
    """As TypeScript does, the bulk redrive counts each status once with the number of its rows,
    and counts the raw status, also the status of a newer protocol."""
    before = _redrive_counts()
    with psycopg.connect(database_url, autocommit=True) as connection:
        connection.execute(_SCRIPTED_REDRIVE_MANY)
        connection.execute(_FUTURE_REDRIVE)
        admin = Admin(connection)
        page = admin.redrive_many(
            DeadLetterFilter(queue="any"), _redrive_audit(), BulkRedriveOptions(dry_run=True)
        )
        assert len(page.results) == 3
        admin.redrive(str(uuid4()), _redrive_audit())

    assert _redriven_since(before) == {"redriven": 2, "future_status": 2}


@pytest.mark.asyncio
async def test_async_admin_redrive_counts_each_durable_result(database_url: str) -> None:
    before = _redrive_counts()
    async with await psycopg.AsyncConnection.connect(database_url, autocommit=True) as connection:
        await connection.execute(_SCRIPTED_REDRIVE_MANY)
        admin = AsyncAdmin.from_psycopg(connection)
        assert (await admin.redrive(str(uuid4()), _redrive_audit())).status == "not_found"
        await admin.redrive_many(DeadLetterFilter(queue="any"), _redrive_audit())

    assert _redriven_since(before) == {"not_found": 1, "redriven": 2, "future_status": 1}


def test_dashboard_redrive_counts_each_durable_result(database_url: str) -> None:
    """The TypeScript dashboard calls the admin, which counts each result. The Python dashboard
    calls its admin too, so a dashboard redrive counts once."""
    from workhorse.dashboard import DashboardHost, DashboardPrincipal

    audit = {"actor": "operator", "reason": "test", "requestId": "request-1"}
    before = _redrive_counts()
    with psycopg.connect(database_url, autocommit=True) as connection:
        connection.execute(_SCRIPTED_REDRIVE_MANY)
        host = DashboardHost(connection, authorize=lambda _: DashboardPrincipal("operator"))
        assert _dashboard_post(host, "redriveTask", {"id": str(uuid4()), "audit": audit}) == 404
        assert _dashboard_post(host, "redriveDeadLetters", {"audit": audit}) == 200

    assert _redriven_since(before) == {"not_found": 1, "redriven": 2, "future_status": 1}


def test_a_failed_redrive_count_does_not_change_the_redrive_result(
    database_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    class FailingCounter:
        def add(self, amount: int | float, attributes: Any = None) -> None:
            raise RuntimeError("metric backend failed")

    monkeypatch.setattr(workhorse._telemetry, "_redrives", FailingCounter())
    with psycopg.connect(database_url, autocommit=True) as connection:
        connection.execute(_SCRIPTED_REDRIVE_MANY)
        admin = Admin(connection)
        assert admin.redrive(str(uuid4()), _redrive_audit()).status == "not_found"
        assert len(admin.redrive_many(DeadLetterFilter(queue="any"), _redrive_audit()).results) == 3


def test_a_meter_that_rejects_the_redrive_counter_does_not_stop_the_import() -> None:
    """A meter can refuse to create the counter. The SDK creates it on its first count, inside the
    guard, so the import of the SDK does not fail and the count is lost."""
    script = textwrap.dedent(
        """
        from opentelemetry import metrics
        from opentelemetry.sdk.metrics import MeterProvider

        class RejectingProvider(MeterProvider):
            def get_meter(self, *args, **kwargs):
                meter = super().get_meter(*args, **kwargs)
                create_counter = meter.create_counter

                def rejecting(name, *counter_args, **counter_kwargs):
                    if name == "workhorse.tasks.redrive":
                        raise RuntimeError("create_counter failed")
                    return create_counter(name, *counter_args, **counter_kwargs)

                meter.create_counter = rejecting
                return meter

        metrics.set_meter_provider(RejectingProvider())
        import workhorse._telemetry as telemetry

        telemetry.record_redrive("redriven")
        print("contained")
        """
    )
    completed = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True, timeout=60, check=False
    )

    assert completed.returncode == 0, completed.stderr
    assert completed.stdout.strip() == "contained"


@pytest.mark.asyncio
async def test_the_async_queue_logs_the_same_events(database_url: str) -> None:
    LOG_EXPORTER.clear()
    queue_name = _queue_name("async")
    missing = str(uuid4())
    async with await psycopg.AsyncConnection.connect(database_url, autocommit=True) as connection:
        queue = AsyncQueue.from_psycopg(connection, queue_name)
        accepted = await queue.enqueue_with_result("mail.send", {})
        canceled = await queue.cancel(missing)
        await queue.sync_schedules(
            queue_name,
            [ScheduleDefinition("nightly", "0 2 * * *", ScheduledTask("mail.send", {}))],
        )
        await queue.send_signal(missing, "approval", {}, idempotency_key="k", requested_by="api")
        await queue.complete_human_wait(
            missing, "review", {}, idempotency_key="k", requested_by="api"
        )

    assert _log_record("workhorse.task.enqueued")[2]["workhorse.task.id"] == accepted.task_id
    assert _log_record("workhorse.task.cancellation_processed")[2] == {
        "workhorse.task.id": missing,
        "workhorse.task.state": "not_found",
        "workhorse.operation.status": canceled.status,
    }
    assert _log_record("workhorse.schedules.synchronized")[2] == {
        "workhorse.schedule.namespace": queue_name,
        "workhorse.schedule.count": 1,
    }
    assert _log_records("workhorse.task.signal_processed")
    assert _log_records("workhorse.task.human_wait_processed")


def test_sync_schedules_logs_the_synchronization(database_url: str) -> None:
    LOG_EXPORTER.clear()
    namespace = _queue_name("schedules")
    with psycopg.connect(database_url, autocommit=True) as connection:
        Queue(connection, namespace).sync_schedules(
            namespace,
            [
                ScheduleDefinition("nightly", "0 2 * * *", ScheduledTask("mail.send", {})),
                ScheduleDefinition("hourly", "0 * * * *", ScheduledTask("mail.send", {})),
            ],
        )

    assert _log_record("workhorse.schedules.synchronized") == (
        "INFO",
        "Recurring schedules synchronized",
        {"workhorse.schedule.namespace": namespace, "workhorse.schedule.count": 2},
    )


def test_admin_logs_each_queue_and_redrive_operation(database_url: str) -> None:
    LOG_EXPORTER.clear()
    queue_name = _queue_name("admin")
    missing = str(uuid4())
    audit = AdminAudit("python-test", "secret audit reason", f"request-{uuid4()}")
    with psycopg.connect(database_url, autocommit=True) as connection:
        Queue(connection, queue_name).enqueue("mail.send", {})
        admin = Admin(connection)
        admin.pause_queue(queue_name, audit)
        admin.resume_queue(queue_name, AdminAudit("python-test", "resume", f"request-{uuid4()}"))
        tier = admin.set_queue_tier(queue_name, "full", audit)
        purged = admin.purge_queue(queue_name, AdminAudit("python-test", "purge", f"r-{uuid4()}"))
        redrive = admin.redrive(missing, audit)
        bulk = admin.redrive_many(
            DeadLetterFilter(queue=queue_name), audit, BulkRedriveOptions(dry_run=True)
        )
        worker_pause = admin.set_worker_paused(f"missing-{uuid4()}", True, audit)

    assert worker_pause is None
    assert purged == 1
    queue_attributes = {"workhorse.queue.name": queue_name}
    assert _log_record("workhorse.queue.paused") == ("INFO", "Queue paused", queue_attributes)
    assert _log_record("workhorse.queue.resumed") == ("INFO", "Queue resumed", queue_attributes)
    assert _log_record("workhorse.queue.tier_set") == (
        "INFO",
        "Queue tier set",
        {**queue_attributes, "workhorse.queue.tier": tier},
    )
    assert _log_record("workhorse.queue.purged") == (
        "INFO",
        "Queue purged",
        {**queue_attributes, "workhorse.task.count": 1},
    )
    assert _log_record("workhorse.task.redrive_processed") == (
        "INFO",
        "Dead-letter task redrive processed",
        {
            "workhorse.task.id": missing,
            "workhorse.redrive.target_task_id": "none",
            "workhorse.operation.status": redrive.status,
        },
    )
    assert _log_record("workhorse.tasks.redrive_processed") == (
        "INFO",
        "Dead-letter task redrive batch processed",
        {"workhorse.task.count": len(bulk.results), "workhorse.redrive.dry_run": True},
    )
    # A pause request that finds no worker row writes no record, as in TypeScript.
    assert _log_records("workhorse.worker.paused") == []


def test_admin_logs_a_remote_worker_pause_and_resume(database_url: str) -> None:
    worker_id = f"python-admin-pause-{uuid4().hex[:8]}"
    errors: list[BaseException] = []
    worker = Worker(
        worker_pool,
        queue=_queue_name("pause"),
        worker_id=worker_id,
        on_registration_error=errors.append,
    )
    # A run gives each registration its instance ID. This test registers outside a run.
    worker._instance_id = str(uuid4())
    worker._refresh_registration(force=True)
    assert worker._registered, repr(errors)
    LOG_EXPORTER.clear()
    with psycopg.connect(database_url, autocommit=True) as connection:
        admin = Admin(connection)
        admin.set_worker_paused(worker_id, True, AdminAudit("python-test", "pause", "pause-1"))
        admin.set_worker_paused(worker_id, False, AdminAudit("python-test", "resume", "resume-1"))
    worker._deregister(deadline=monotonic() + 5)

    assert _log_record("workhorse.worker.paused") == (
        "INFO",
        "Worker paused",
        {"workhorse.worker.id": worker_id},
    )
    assert _log_record("workhorse.worker.resumed") == (
        "INFO",
        "Worker resumed",
        {"workhorse.worker.id": worker_id},
    )


@pytest.mark.asyncio
async def test_the_async_admin_logs_the_same_events(database_url: str) -> None:
    LOG_EXPORTER.clear()
    queue_name = _queue_name("async-admin")
    missing = str(uuid4())
    audit = AdminAudit("python-test", "async audit", f"request-{uuid4()}")
    async with await psycopg.AsyncConnection.connect(database_url, autocommit=True) as connection:
        admin = AsyncAdmin.from_psycopg(connection)
        await admin.pause_queue(queue_name, audit)
        await admin.resume_queue(queue_name, AdminAudit("python-test", "r", f"r-{uuid4()}"))
        await admin.set_queue_tier(queue_name, "full", audit)
        await admin.purge_queue(queue_name, AdminAudit("python-test", "p", f"p-{uuid4()}"))
        await admin.redrive(missing, audit)
        await admin.redrive_many(DeadLetterFilter(queue=queue_name), audit)

    for event_name in (
        "workhorse.queue.paused",
        "workhorse.queue.resumed",
        "workhorse.queue.tier_set",
        "workhorse.queue.purged",
        "workhorse.task.redrive_processed",
        "workhorse.tasks.redrive_processed",
    ):
        assert _log_record(event_name)[0] == "INFO"
    assert _log_record("workhorse.tasks.redrive_processed")[2] == {
        "workhorse.task.count": 0,
        "workhorse.redrive.dry_run": False,
    }


class _RegistryExecutor:
    """Answer the registration and the deregistration statements, with a pause flag to change."""

    def __init__(self) -> None:
        self.paused = False
        self.fail = False
        self.registrations = 0
        self.routines: list[dict[str, object]] = []

    def rows(self, statement: Any, _parameters: Any = ()) -> list[dict[str, object]]:
        if statement is workhorse.worker._STATEMENTS.register_worker:
            self.registrations += 1
            if self.fail:
                raise RuntimeError("never-log-this")
            return [{"paused": self.paused}]
        if statement is workhorse.worker._STATEMENTS.run_maintenance:
            return self.routines
        if statement is workhorse.worker._STATEMENTS.deregister_worker:
            return [{"deregistered": True}]
        raise AssertionError(f"unexpected statement {statement}")


def _registry_worker(executor: _RegistryExecutor) -> Worker:
    return Worker(
        ScriptedPool(),  # type: ignore[arg-type]
        queues=["mail", "billing"],
        worker_id="python-registration-log",
        concurrency=3,
        registry_interval_ms=100,
        _executor=executor,  # type: ignore[arg-type]
    )


def test_an_unchanged_worker_registration_does_not_log_at_every_refresh() -> None:
    LOG_EXPORTER.clear()
    executor = _RegistryExecutor()
    worker = _registry_worker(executor)

    for _ in range(3):
        worker._refresh_registration(force=True)
    assert executor.registrations == 3
    executor.paused = True
    worker._refresh_registration(force=True)
    worker._refresh_registration(force=True)
    worker._refresh_registration(force=True, draining=True)

    base = {
        "workhorse.worker.queues": ("mail", "billing"),
        "workhorse.worker.id": "python-registration-log",
        "workhorse.worker.concurrency": 3,
        "workhorse.worker.active_slots": 0,
    }
    assert [
        (record.severity_text, record.body, dict(record.attributes or {}))
        for record in _log_records("workhorse.worker.registered")
    ] == [
        (
            "DEBUG",
            "Worker registration changed",
            {**base, "workhorse.worker.draining": False, "workhorse.worker.paused": False},
        ),
        (
            "DEBUG",
            "Worker registration changed",
            {**base, "workhorse.worker.draining": False, "workhorse.worker.paused": True},
        ),
        (
            "DEBUG",
            "Worker registration changed",
            {**base, "workhorse.worker.draining": True, "workhorse.worker.paused": True},
        ),
    ]


def test_a_failed_worker_registration_logs_the_queues_and_the_error_type() -> None:
    executor = _RegistryExecutor()
    executor.fail = True
    worker = _registry_worker(executor)
    LOG_EXPORTER.clear()

    worker._refresh_registration(force=True)

    assert _log_record("workhorse.worker.registration_failed") == (
        "INFO",
        "Worker registration failed",
        {
            "workhorse.worker.queues": ("mail", "billing"),
            "workhorse.worker.id": "python-registration-log",
            "error.type": "RuntimeError",
        },
    )
    assert "never-log-this" not in str(LOG_EXPORTER.get_finished_logs())


def test_a_remote_pause_and_resume_log_the_worker_queues() -> None:
    executor = _RegistryExecutor()
    worker = _registry_worker(executor)
    worker._refresh_registration(force=True)
    LOG_EXPORTER.clear()

    executor.paused = True
    worker._refresh_registration(force=True)
    executor.paused = False
    worker._refresh_registration(force=True)

    attributes = {
        "workhorse.worker.id": "python-registration-log",
        "workhorse.worker.queues": ("mail", "billing"),
    }
    assert _log_record("workhorse.worker.paused") == ("INFO", "Worker paused remotely", attributes)
    assert _log_record("workhorse.worker.resumed") == (
        "INFO",
        "Worker resumed remotely",
        attributes,
    )


def test_the_background_routines_log_each_phase_that_changed_rows() -> None:
    executor = _RegistryExecutor()
    executor.routines = [
        {
            "phase": "history_retention",
            "rows_affected": 4,
            "duration_ms": 1,
            "skipped_lock": False,
            "error": None,
        },
        {
            "phase": "stat_rollup",
            "rows_affected": 0,
            "duration_ms": 1,
            "skipped_lock": False,
            "error": None,
        },
        {
            "phase": "terminal_storage",
            "rows_affected": 0,
            "duration_ms": 1,
            "skipped_lock": False,
            "error": "never-log-this",
        },
    ]
    worker = _registry_worker(executor)
    LOG_EXPORTER.clear()

    worker._run_due_maintenance(monotonic(), tick_due=False, routines_due=True)

    assert [
        (record.severity_text, record.body, dict(record.attributes or {}))
        for record in _log_records("workhorse.maintenance.completed")
    ] == [
        (
            "INFO",
            "Maintenance phase completed",
            {
                "workhorse.maintenance.operation": "background_routines",
                "workhorse.maintenance.phase": phase,
                "workhorse.maintenance.rows_affected": rows,
                "workhorse.maintenance.skipped_lock": False,
            },
        )
        for phase, rows in (("history_retention", 4), ("terminal_storage", 0))
    ]
    assert "never-log-this" not in str(LOG_EXPORTER.get_finished_logs())


def test_a_worker_logs_its_deregistration() -> None:
    executor = _RegistryExecutor()
    worker = _registry_worker(executor)
    worker._refresh_registration(force=True)
    LOG_EXPORTER.clear()

    worker._deregister(deadline=monotonic() + 5)

    assert _log_record("workhorse.worker.deregistered") == (
        "DEBUG",
        "Worker deregistered",
        {"workhorse.worker.id": "python-registration-log", "workhorse.worker.deregistered": True},
    )


def test_a_worker_without_a_notification_listener_warns_that_it_polls(database_url: str) -> None:
    LOG_EXPORTER.clear()
    worker = Worker(
        worker_pool,
        queue=_queue_name("polling"),
        worker_id="python-polling-only",
        poll_ms=10,
        _heartbeat_executor_factory=ScriptedHeartbeats().open,
    )
    worker._hub_source = lambda: (None, lambda: None)
    running = threading.Thread(target=worker.run, daemon=True)
    running.start()
    try:
        eventually(
            lambda: bool(_log_records("workhorse.worker.polling_only")),
            "the worker never logged that it polls",
        )
    finally:
        worker.stop()
        running.join(10)
    assert not running.is_alive()

    assert _log_record("workhorse.worker.polling_only") == (
        "WARN",
        "Worker has no notification listener and dispatches by polling",
        {
            "workhorse.worker.queues": (worker.queues[0],),
            "workhorse.worker.id": "python-polling-only",
            "workhorse.worker.pool_max_size": 3,
        },
    )


@pytest.mark.asyncio
async def test_an_async_worker_without_a_listener_subscription_warns_that_it_polls() -> None:
    LOG_EXPORTER.clear()
    worker = AsyncWorker.from_psycopg(ScriptedPool(), queue="async-polling", worker_id="async-poll")  # type: ignore[arg-type]
    worker._start_run()
    try:
        worker._wants_listener = True
        # A run with no hub, or whose subscription does not finish in time, has no listener.
        await asyncio.to_thread(worker._subscribe_listener)
    finally:
        worker._threads.close()
        worker._running = False

    assert _log_record("workhorse.worker.polling_only") == (
        "WARN",
        "Worker has no notification listener and dispatches by polling",
        {
            "workhorse.worker.queues": ("async-polling",),
            "workhorse.worker.id": "async-poll",
            "workhorse.worker.pool_max_size": 10,
        },
    )


def test_a_failed_run_writes_no_stop_record(database_url: str) -> None:
    """As in TypeScript, a run that ends with an error writes no workhorse.worker.stopped."""
    LOG_EXPORTER.clear()
    worker = Worker(
        worker_pool,
        queue=_queue_name("failed-run"),
        worker_id="python-failed-run",
        poll_ms=10,
        _heartbeat_executor_factory=ScriptedHeartbeats().open,
    )
    worker._hub_source = lambda: (None, lambda: None)

    def fail(_slots: object) -> float:
        raise RuntimeError("loop failure")

    worker._dispatch_wait_seconds = fail  # type: ignore[method-assign]
    with pytest.raises(RuntimeError, match="loop failure"):
        worker.run()
    assert _log_records("workhorse.worker.started")
    assert not _log_records("workhorse.worker.stopped")


def test_only_a_run_writes_the_start_and_stop_records(database_url: str) -> None:
    LOG_EXPORTER.clear()
    worker = Worker(
        worker_pool,
        queue=_queue_name("lifecycle"),
        worker_id="python-lifecycle",
        poll_ms=10,
        _heartbeat_executor_factory=ScriptedHeartbeats().open,
    )
    worker._hub_source = lambda: (None, lambda: None)
    assert worker.run_once() is False
    assert not _log_records("workhorse.worker.started")
    assert not _log_records("workhorse.worker.stopped")

    running = threading.Thread(target=worker.run, daemon=True)
    running.start()
    try:
        eventually(
            lambda: bool(_log_records("workhorse.worker.started")),
            "the run never logged its start",
        )
    finally:
        worker.stop()
        running.join(10)
    assert not running.is_alive()

    assert _log_record("workhorse.worker.started") == (
        "INFO",
        "Worker started",
        {
            "workhorse.worker.id": "python-lifecycle",
            "workhorse.worker.concurrency": worker.concurrency,
            "workhorse.worker.queues": (worker.queues[0],),
        },
    )
    assert _log_record("workhorse.worker.stopped") == (
        "INFO",
        "Worker stopped",
        {
            "workhorse.worker.id": "python-lifecycle",
            "workhorse.worker.active_slots": 0,
            "workhorse.worker.queues": (worker.queues[0],),
        },
    )


def test_a_failed_settlement_writes_no_execution_record(
    database_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """TypeScript writes task.execution_finished only for a known outcome, so no SDK writes unknown.

    The attempt has no outcome, so workhorse.handler.executions does not count it. Its duration
    has the outcome unknown, as in TypeScript.
    """
    LOG_EXPORTER.clear()
    executions_before = _counter_values("workhorse.handler.executions")
    durations_before = _histogram_counts("workhorse.handler.duration")
    queue_name = _queue_name("settlement")
    with psycopg.connect(database_url) as connection:
        task_id = Queue(connection, queue_name).enqueue("settlement.fails", {})
        connection.commit()
    send = workhorse.worker._fenced_write_rows

    def fenced_write_rows(executor: Any, statement: Any, parameters: Any) -> Any:
        if statement is workhorse.worker._STATEMENTS.fail:
            raise psycopg.OperationalError("the settlement failed")
        return send(executor, statement, parameters)

    monkeypatch.setattr(workhorse.worker, "_fenced_write_rows", fenced_write_rows)

    def fail(_payload: object, _context: HandlerContext) -> None:
        raise RuntimeError("the handler failed")

    worker = Worker(worker_pool, queue=queue_name, worker_id="python-failed-settlement")
    worker.handle("settlement.fails", fail)
    with suppress(Exception):
        worker.run_once()

    finished = [
        record
        for record in _log_records("workhorse.handler.finished")
        if record.attributes["workhorse.task.id"] == task_id
    ]
    assert len(finished) == 1
    assert not [
        record
        for record in _log_records("workhorse.task.execution_finished")
        if record.attributes["workhorse.task.id"] == task_id
    ]
    executions = _counter_values("workhorse.handler.executions")
    assert _added_by_outcome(executions_before, executions, "settlement.fails") == {}
    durations = _histogram_counts("workhorse.handler.duration")
    assert _added_by_outcome(durations_before, durations, "settlement.fails") == {"unknown": 1}


@pytest.mark.parametrize("acknowledgement", ["fails", "refused"])
def test_an_unacknowledged_cancellation_writes_no_execution_record(
    database_url: str, monkeypatch: pytest.MonkeyPatch, acknowledgement: str
) -> None:
    """TypeScript writes the canceled outcome only after PostgreSQL accepts the acknowledgement.

    The heartbeat submits the cancellation first. If acknowledge_cancel_v1 then fails or refuses,
    the worker settled nothing, so it writes no task.execution_finished record, and
    workhorse.handler.executions does not count the attempt. The handler span gets the outcome
    canceled only after PostgreSQL accepts the acknowledgement. A failed acknowledgement gives it
    the outcome unknown and the error status. A refused one gives it the outcome stale and, as in
    TypeScript, no error status, because the handler stopped for the cancellation.
    """
    LOG_EXPORTER.clear()
    SPAN_EXPORTER.clear()
    executions_before = _counter_values("workhorse.handler.executions")
    durations_before = _histogram_counts("workhorse.handler.duration")
    queue_name = _queue_name(f"cancel-{acknowledgement}")
    with psycopg.connect(database_url) as connection:
        task_id = Queue(connection, queue_name).enqueue("cancel.unacknowledged", {})
        connection.commit()
    send = workhorse.worker._fenced_write_rows

    def fenced_write_rows(executor: Any, statement: Any, parameters: Any) -> Any:
        if statement is workhorse.worker._STATEMENTS.acknowledge_cancel:
            if acknowledgement == "fails":
                raise psycopg.OperationalError("the acknowledgement failed")
            return [{"accepted": False}]
        return send(executor, statement, parameters)

    monkeypatch.setattr(workhorse.worker, "_fenced_write_rows", fenced_write_rows)

    def handle(_payload: object, context: HandlerContext) -> None:
        with psycopg.connect(database_url, autocommit=True) as connection:
            Queue(connection, queue_name).cancel(task_id, requested_by="api")
        eventually(
            lambda: context.cancellation.cancelled,
            "the heartbeat never delivered the cancellation",
            timeout_s=10,
        )
        raise RuntimeError("the handler stopped for the cancellation")

    worker = Worker(
        worker_pool,
        queue=queue_name,
        worker_id=f"python-cancel-{acknowledgement}",
        lease_ms=3_000,
        heartbeat_ms=100,
    )
    worker.handle("cancel.unacknowledged", handle)
    with suppress(Exception):
        worker.run_once()

    assert [
        record
        for record in _log_records("workhorse.handler.finished")
        if record.attributes["workhorse.task.id"] == task_id
    ]
    assert not [
        record
        for record in _log_records("workhorse.task.execution_finished")
        if record.attributes["workhorse.task.id"] == task_id
    ]
    executions = _counter_values("workhorse.handler.executions")
    assert _added_by_outcome(executions_before, executions, "cancel.unacknowledged") == {}
    durations = _histogram_counts("workhorse.handler.duration")
    assert _added_by_outcome(durations_before, durations, "cancel.unacknowledged") == {"unknown": 1}
    [handler_span] = [
        span
        for span in SPAN_EXPORTER.get_finished_spans()
        if span.name == "workhorse.handler" and span.attributes["workhorse.task.id"] == task_id
    ]
    if acknowledgement == "fails":
        assert handler_span.attributes["workhorse.handler.outcome"] == "unknown"
        assert handler_span.status.status_code is StatusCode.ERROR
    else:
        assert handler_span.attributes["workhorse.handler.outcome"] == "stale"
        assert handler_span.status.status_code is StatusCode.UNSET
        assert _exception_types(handler_span) == []


def test_the_execution_record_comes_before_the_handler_record(database_url: str) -> None:
    """TypeScript writes task.execution_finished at the settlement, before handler.finished."""
    LOG_EXPORTER.clear()
    queue_name = _queue_name("record-order")
    with psycopg.connect(database_url) as connection:
        queue = Queue(connection, queue_name)
        succeeds = queue.enqueue("order.succeeds", {})
        fails = queue.enqueue("order.fails", {})
        connection.commit()

    def fail(_payload: object, _context: HandlerContext) -> None:
        raise RuntimeError("the handler failed")

    worker = Worker(worker_pool, queue=queue_name, worker_id="python-record-order")
    worker.handle("order.succeeds", lambda _payload, _context: None)
    worker.handle("order.fails", fail)
    # One pass can claim both tasks.
    assert worker.run_once() is True
    while worker.run_once():
        pass

    for task_id in (succeeds, fails):
        events = [
            record.log_record.event_name
            for record in LOG_EXPORTER.get_finished_logs()
            if record.log_record.event_name
            in {"workhorse.task.execution_finished", "workhorse.handler.finished"}
            and record.log_record.attributes["workhorse.task.id"] == task_id
        ]
        assert events == ["workhorse.task.execution_finished", "workhorse.handler.finished"]


def test_a_run_writes_its_start_record_before_readiness_and_registration(
    database_url: str,
) -> None:
    """As in TypeScript, run() writes workhorse.worker.started first.

    A failed readiness check thus still has a start record, and the first registration record
    comes after the start record.
    """
    LOG_EXPORTER.clear()
    failing = Worker(
        worker_pool,
        queue=_queue_name("readiness"),
        worker_id="python-readiness-fails",
        poll_ms=10,
        _heartbeat_executor_factory=ScriptedHeartbeats().open,
    )

    def refuse() -> Any:
        raise TimeoutError("the worker could not reserve its heartbeat connection")

    failing._start_connections = refuse  # type: ignore[method-assign]
    with pytest.raises(TimeoutError):
        failing.run()
    assert [
        record.attributes["workhorse.worker.id"]
        for record in _log_records("workhorse.worker.started")
    ] == ["python-readiness-fails"]
    assert not _log_records("workhorse.worker.stopped")

    LOG_EXPORTER.clear()
    worker = Worker(
        worker_pool,
        queue=_queue_name("start-order"),
        worker_id="python-start-order",
        poll_ms=10,
        _heartbeat_executor_factory=ScriptedHeartbeats().open,
    )
    worker._hub_source = lambda: (None, lambda: None)
    running = threading.Thread(target=worker.run, daemon=True)
    running.start()
    try:
        eventually(
            lambda: bool(_log_records("workhorse.worker.registered")),
            "the run never logged its registration",
        )
    finally:
        worker.stop()
        running.join(10)
    assert not running.is_alive()
    names = [
        record.log_record.event_name
        for record in LOG_EXPORTER.get_finished_logs()
        if record.log_record.event_name
        in {"workhorse.worker.started", "workhorse.worker.registered"}
    ]
    assert names[:2] == ["workhorse.worker.started", "workhorse.worker.registered"]


class _FailingLogger:
    """An OpenTelemetry logger that is enabled and raises for each record."""

    def __init__(self) -> None:
        self.calls = 0

    def enabled(self, **_kwargs: object) -> bool:
        return True

    def emit(self, *_args: object, **_kwargs: object) -> None:
        self.calls += 1
        raise RuntimeError("the logger failed")


class _DisabledLogger:
    """An OpenTelemetry logger that is disabled and counts each record that it gets."""

    def __init__(self) -> None:
        self.calls = 0

    def enabled(self, **_kwargs: object) -> bool:
        return False

    def emit(self, *_args: object, **_kwargs: object) -> None:
        self.calls += 1


def test_a_failing_logger_does_not_change_a_queue_or_worker_result(
    database_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    logger = _FailingLogger()
    monkeypatch.setattr(workhorse._telemetry, "_LOGGER", logger)
    queue_name = _queue_name("failing-logger")
    with psycopg.connect(database_url) as connection:
        queue = Queue(connection, queue_name)
        canceled = queue.enqueue("logger.fails", {})
        assert queue.cancel(canceled).status == "canceled"
        handled = queue.enqueue("logger.fails", {})
        connection.commit()

    ran: list[str] = []
    worker = Worker(worker_pool, queue=queue_name, worker_id="python-failing-logger")
    worker.handle("logger.fails", lambda _payload, context: ran.append(context.task.id))
    assert worker.run_once() is True

    assert ran == [handled]
    assert logger.calls > 0


def test_a_disabled_logger_gets_no_record_from_the_queue(
    database_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    logger = _DisabledLogger()
    monkeypatch.setattr(workhorse._telemetry, "_LOGGER", logger)
    with psycopg.connect(database_url) as connection:
        queue = Queue(connection, _queue_name("disabled-logger"))
        task_id = queue.enqueue("logger.disabled", {})
        assert queue.cancel(task_id).status == "canceled"
        queue.sync_schedules("disabled-logger", [])
        connection.commit()

    assert logger.calls == 0


# SM-2074: a release after the shutdown abort that finds the lease lost is not a failed write. The
# worker logs workhorse.worker.shutdown_settlement_failed only for a release that fails for another
# reason. A lost lease ends the attempt only, and the attempt reports lease_expired.

_SHUTDOWN_TASK = workhorse.ClaimedTask(
    id="00000000-0000-0000-0000-000000002074",
    queue="billing",
    type="send-invoice",
    priority=0,
    payload=None,
    contract_version=None,
    result_max_bytes=1_048_576,
    redact_error_details=False,
    trace_context=None,
    attempt=2,
    max_attempts=3,
    retry_policy=None,
    deadline_at=None,
    execution_timeout_ms=None,
    attempt_timeout_at=None,
    fence_token=7,
    lease_expires_at=datetime.fromtimestamp(0, UTC),
)


class _ScriptedSettlementExecutor:
    """Answer the release and the statements that settle its answer from a script."""

    def __init__(self, answers: dict[object, list[dict[str, object]] | Exception]) -> None:
        self._answers = answers

    def rows(self, statement: Any, _parameters: Any = ()) -> list[dict[str, object]]:
        answer = self._answers.get(statement)
        if answer is None:
            raise AssertionError(f"unexpected statement {statement}")
        if isinstance(answer, Exception):
            raise answer
        return answer


def _shutdown_settlement_worker(answers: dict[object, Any]) -> Worker:
    return Worker(
        ScriptedPool(),  # type: ignore[arg-type]
        queues=["billing"],
        worker_id="python-shutdown-settlement",
        _executor=_ScriptedSettlementExecutor(answers),  # type: ignore[arg-type]
    )


@pytest.mark.parametrize(
    "answers",
    [
        pytest.param(
            {
                workhorse.worker._STATEMENTS.release_owned: [{"status": "cancel_requested"}],
                workhorse.worker._STATEMENTS.acknowledge_cancel: [{"accepted": False}],
            },
            id="refused-acknowledgement",
        ),
        pytest.param(
            {
                workhorse.worker._STATEMENTS.release_owned: [{"status": "stale"}],
                workhorse.worker._STATEMENTS.expire_owned: [
                    {"status": "stale", "retry_state": None}
                ],
            },
            id="stale-release",
        ),
    ],
)
def test_a_lost_lease_after_the_shutdown_abort_writes_no_settlement_failure(
    answers: dict[object, Any],
) -> None:
    worker = _shutdown_settlement_worker(answers)
    arbiter = workhorse.worker._AttemptOutcomeArbiter()
    LOG_EXPORTER.clear()

    with pytest.raises(workhorse.StaleLeaseError):
        worker._release_after_shutdown(_SHUTDOWN_TASK, arbiter, {})

    assert arbiter.outcome == "lease_expired"
    # The release record proves that the exporter receives the records of this worker.
    assert len(_log_records("workhorse.task.release_processed")) == 1
    assert _log_records("workhorse.worker.shutdown_settlement_failed") == []


def test_a_failed_release_after_the_shutdown_abort_logs_once() -> None:
    worker = _shutdown_settlement_worker(
        {workhorse.worker._STATEMENTS.release_owned: RuntimeError("never-log-this")}
    )
    LOG_EXPORTER.clear()

    with pytest.raises(RuntimeError, match="never-log-this"):
        worker._release_after_shutdown(
            _SHUTDOWN_TASK, workhorse.worker._AttemptOutcomeArbiter(), {}
        )

    severity, body, attributes = _log_record("workhorse.worker.shutdown_settlement_failed")
    assert (severity, body) == ("WARN", "Worker could not settle a task after the shutdown abort")
    assert attributes["workhorse.worker.id"] == "python-shutdown-settlement"
    assert attributes["error.type"] == "RuntimeError"
    assert "never-log-this" not in str(LOG_EXPORTER.get_finished_logs())
