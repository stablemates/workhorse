from __future__ import annotations

import json
import subprocess
from collections.abc import Iterable, Mapping
from contextlib import suppress
from pathlib import Path
from typing import Any

import psycopg
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

from workhorse import EnqueueOptions, HandlerContext, Queue, Worker
from workhorse._telemetry import (
    record_batch,
    record_failure,
    record_heartbeat_failure,
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


def test_worker_telemetry_matches_the_typescript_contract(database_url: str) -> None:
    SPAN_EXPORTER.clear()
    LOG_EXPORTER.clear()
    trace_context = {"traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"}

    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
    ):
        job_id = Queue(enqueue_connection, "mail").enqueue("mail.send", {"secret": "payload"})
        enqueue_connection.execute(
            "UPDATE workhorse.job SET trace_context = %s::jsonb WHERE id = %s",
            (json.dumps(trace_context), job_id),
        )
        enqueue_connection.commit()

        observed_contexts: list[HandlerContext] = []

        def handle(_payload: object, context: HandlerContext) -> dict[str, bool]:
            observed_contexts.append(context)
            return {"sent": True}

        worker = Worker(worker_connection, queue="mail", worker_id="python-telemetry-worker")
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
        "workhorse.job.id": job_id,
        "workhorse.job.type": "mail.send",
        "workhorse.job.attempt": 1,
        "workhorse.handler.outcome": "succeeded",
    }
    assert completion_span.parent is not None
    assert completion_span.parent.span_id == handler_span.context.span_id
    assert maintenance_recovery_span.attributes["workhorse.recovery.skipped"] is False
    assert "workhorse.recovery.rows_affected" in maintenance_recovery_span.attributes
    assert "workhorse.recovery.expired_leases" in maintenance_recovery_span.attributes
    assert "workhorse.recovery.retried" in maintenance_recovery_span.attributes

    catalog_job = observed_contexts[0].job
    record_failure(catalog_job, "scheduled")
    record_recovery(1, 0, [])
    record_batch(catalog_job.queue, catalog_job.type, 1, 0, True)
    record_heartbeat_failure("stale")

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
    assert len(exported_metrics) == len(expected_metrics)
    expected_job_attributes = {
        "workhorse.queue.name": "mail",
        "workhorse.job.type": "mail.send",
    }
    assert expected_job_attributes in _metric_attributes(exported_metrics["workhorse.jobs.claimed"])
    assert expected_job_attributes in _metric_attributes(
        exported_metrics["workhorse.jobs.completed"]
    )
    for metric in exported_metrics.values():
        for attributes in _metric_attributes(metric):
            assert "workhorse.job.id" not in attributes

    events = {record.log_record.event_name for record in LOG_EXPORTER.get_finished_logs()}
    assert {
        "workhorse.handler.registered",
        "workhorse.worker.started",
        "workhorse.job.claimed",
        "workhorse.handler.started",
        "workhorse.job.completed",
        "workhorse.job.execution_finished",
        "workhorse.handler.finished",
        "workhorse.worker.stopped",
    } <= events
    stopped = next(
        record.log_record
        for record in LOG_EXPORTER.get_finished_logs()
        if record.log_record.event_name == "workhorse.worker.stopped"
    )
    assert stopped.attributes["workhorse.worker.active_slots"] == 0


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

        worker = Worker(worker_connection, queue="mail", worker_id="python-telemetry-redaction")
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
        job_id = Queue(enqueue_connection).enqueue("approval", {})
        enqueue_connection.commit()

        def swallow(_payload: object, context: HandlerContext) -> dict[str, bool]:
            with suppress(BaseException):
                context.wait_for_signal("approval")
            return {"incorrectlyCompleted": True}

        worker = Worker(worker_connection, worker_id="python-swallowed-signal")
        worker.handle("approval", swallow)
        assert worker.run_once() is True
        assert worker_connection.execute(
            "SELECT state FROM workhorse.job_runtime WHERE job_id = %s", (job_id,)
        ).fetchone() == ("scheduled",)

    warning = next(
        record.log_record
        for record in LOG_EXPORTER.get_finished_logs()
        if record.log_record.event_name == "workhorse.handler.signal_swallowed"
    )
    assert warning.severity_text == "WARN"
    assert warning.attributes["workhorse.handler.outcome"] == "suspended"
    assert not any(
        record.log_record.event_name == "workhorse.job.completed"
        for record in LOG_EXPORTER.get_finished_logs()
    )
