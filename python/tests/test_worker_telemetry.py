from __future__ import annotations
# ruff: noqa


import asyncio
import contextvars
import json
import subprocess
import threading
from collections.abc import Iterable, Mapping
from contextlib import suppress
from pathlib import Path
from typing import Any

import psycopg
import pytest
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

from workhorse import (
    AsyncHandlerContext,
    AsyncWorker,
    EnqueueOptions,
    HandlerContext,
    Json,
    Queue,
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
    exported_metrics = {
        metric.name: metric
        for metric in _metrics()
        if not metric.name.startswith(("workhorse.maintenance.", "workhorse.schedule."))
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
        "workhorse.worker.started",
        "workhorse.task.claimed",
        "workhorse.handler.started",
        "workhorse.task.completed",
        "workhorse.task.execution_finished",
        "workhorse.handler.finished",
        "workhorse.worker.stopped",
    } <= events
    stopped = next(
        record.log_record
        for record in LOG_EXPORTER.get_finished_logs()
        if record.log_record.event_name == "workhorse.worker.stopped"
    )
    assert stopped.attributes["workhorse.worker.active_slots"] == 0


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

    warning = next(
        record.log_record
        for record in LOG_EXPORTER.get_finished_logs()
        if record.log_record.event_name == "workhorse.handler.signal_swallowed"
    )
    assert warning.severity_text == "WARN"
    assert warning.attributes["workhorse.handler.outcome"] == "suspended"
    assert not any(
        record.log_record.event_name == "workhorse.task.completed"
        for record in LOG_EXPORTER.get_finished_logs()
    )


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


def test_a_failed_heartbeat_round_counts_by_reason_and_the_task_completes(
    database_url: str,
) -> None:
    """A round that fails before PostgreSQL gives a verdict counts once in round_failure.

    The task keeps running, and the next rounds renew its lease. The failed round gives no
    ownership verdict, so `workhorse.worker.heartbeat.failure` does not count it.
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
    later_rounds = threading.Event()

    def heartbeat_rows(*args: Any, **kwargs: Any) -> Any:
        rounds.append("sent")
        if len(rounds) == 1:
            raise psycopg.OperationalError("consuming input failed: server closed the connection")
        rows = send_round(*args, **kwargs)
        if len(rounds) >= 3:
            later_rounds.set()
        return rows

    worker._heartbeat_rows = heartbeat_rows  # type: ignore[method-assign]

    def handle(_payload: object, context: HandlerContext) -> None:
        assert later_rounds.wait(10), "the rounds after the failed round did not run"
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
    assert added == {(("workhorse.heartbeat.failure_reason", "connection"),): 1}
    assert _counter_values("workhorse.worker.heartbeat.failure") == heartbeat_failures_before
