from __future__ import annotations

from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from typing import Literal, Protocol, cast

AttributeValue = (
    str | bool | int | float | Sequence[str] | Sequence[bool] | Sequence[int] | Sequence[float]
)
Attributes = Mapping[str, AttributeValue]
JobExecutionOutcome = Literal[
    "canceled",
    "deadline_exceeded",
    "failed",
    "lease_lost",
    "retry",
    "succeeded",
    "suspended",
    "timeout",
    "unknown",
]
WorkhorseLogEvent = Literal[
    "workhorse.handler.batch_dispatched",
    "workhorse.handler.batch_evidence_failed",
    "workhorse.handler.finished",
    "workhorse.handler.registered",
    "workhorse.handler.signal_swallowed",
    "workhorse.handler.started",
    "workhorse.job.cancellation_acknowledged",
    "workhorse.job.checkpoint_saved",
    "workhorse.job.child_processed",
    "workhorse.job.claimed",
    "workhorse.job.completed",
    "workhorse.job.completion_rejected",
    "workhorse.job.execution_finished",
    "workhorse.job.failure_processed",
    "workhorse.job.heartbeat_accepted",
    "workhorse.job.heartbeat_rejected",
    "workhorse.job.ownership_expired",
    "workhorse.job.wait_processed",
    "workhorse.leases.recovered",
    "workhorse.maintenance.completed",
    "workhorse.schedule.fire_replayed",
    "workhorse.schedule.fired",
    "workhorse.worker.paused",
    "workhorse.worker.resumed",
    "workhorse.worker.started",
    "workhorse.worker.stop_requested",
    "workhorse.worker.stopped",
]

INSTRUMENTATION_NAME = "workhorse-pg"
TRACE_ATTRIBUTE_COUNT_LIMIT = 8
METRIC_ATTRIBUTE_CARDINALITY_LIMIT = 2_000


class Span(Protocol):
    def set_attribute(self, key: str, value: AttributeValue) -> None: ...

    def set_status(self, status: object, description: str | None = None) -> None: ...

    def add_event(self, name: str, attributes: Attributes | None = None) -> None: ...


class Job(Protocol):
    @property
    def id(self) -> str: ...

    @property
    def queue(self) -> str: ...

    @property
    def type(self) -> str: ...

    @property
    def attempt(self) -> int: ...


class _Counter(Protocol):
    def add(self, amount: int | float, attributes: Attributes | None = None) -> None: ...


class _Histogram(Protocol):
    def record(self, amount: int | float, attributes: Attributes | None = None) -> None: ...


class _NoOpSpan:
    def set_attribute(self, key: str, value: AttributeValue) -> None:
        pass

    def set_status(self, status: object, description: str | None = None) -> None:
        pass

    def add_event(self, name: str, attributes: Attributes | None = None) -> None:
        pass


class _NoOpInstrument:
    def add(self, amount: int | float, attributes: Attributes | None = None) -> None:
        pass

    def record(self, amount: int | float, attributes: Attributes | None = None) -> None:
        pass


try:
    from opentelemetry import context as otel_context
    from opentelemetry import metrics, trace
    from opentelemetry._logs import SeverityNumber, get_logger
    from opentelemetry.context import Context
    from opentelemetry.trace import SpanKind, StatusCode
    from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator
except ModuleNotFoundError as error:
    if error.name is None or not error.name.startswith("opentelemetry"):
        raise
    _OTEL_AVAILABLE = False
else:
    _OTEL_AVAILABLE = True


def _counter(name: str, description: str, unit: str) -> _Counter:
    if not _OTEL_AVAILABLE:
        return _NoOpInstrument()
    return cast(
        _Counter,
        metrics.get_meter(INSTRUMENTATION_NAME).create_counter(
            name,
            description=description,
            unit=unit,
        ),
    )


def _histogram(name: str, description: str, unit: str) -> _Histogram:
    if not _OTEL_AVAILABLE:
        return _NoOpInstrument()
    return cast(
        _Histogram,
        metrics.get_meter(INSTRUMENTATION_NAME).create_histogram(
            name,
            description=description,
            unit=unit,
        ),
    )


_claimed = _counter("workhorse.jobs.claimed", "Jobs claimed for handler execution", "{job}")
_completed = _counter("workhorse.jobs.completed", "Jobs completed under a valid lease", "{job}")
_failed = _counter("workhorse.jobs.failed", "Handler failures submitted to PostgreSQL", "{job}")
_retried = _counter("workhorse.jobs.retried", "Failed jobs returned to live work", "{job}")
_expired_leases = _counter(
    "workhorse.leases.expired", "Expired leases recovered by maintenance", "{lease}"
)
_handler_runtime = _counter("workhorse.handler.runtime", "Cumulative handler execution time", "ms")
_handler_executions = _counter(
    "workhorse.handler.executions", "Worker handler activations by outcome", "{execution}"
)
_heartbeat_failures = _counter(
    "workhorse.worker.heartbeat.failure",
    "Worker heartbeats rejected by PostgreSQL ownership or timing checks",
    "{heartbeat}",
)
_schedules_fired = _counter(
    "workhorse.schedule.fired", "Recurring schedule occurrences durably fired", "{occurrence}"
)
_maintenance_runs = _counter(
    "workhorse.maintenance.runs", "Workhorse maintenance phase executions", "{run}"
)
_maintenance_rows = _counter(
    "workhorse.maintenance.rows", "Rows affected by Workhorse maintenance phases", "{row}"
)
_maintenance_errors = _counter(
    "workhorse.maintenance.errors", "Workhorse maintenance phase failures", "{error}"
)
_claim_duration = _histogram("workhorse.claim.duration", "PostgreSQL claim operation latency", "ms")
_handler_duration = _histogram("workhorse.handler.duration", "Handler execution latency", "ms")
_handler_batch_size = _histogram(
    "workhorse.handler.batch.size", "Jobs delivered in one batch handler invocation", "{job}"
)
_handler_batch_linger = _histogram(
    "workhorse.handler.batch.linger",
    "Time from the first batch member arriving until dispatch",
    "ms",
)
_schedule_lag = _histogram(
    "workhorse.schedule.lag", "Delay between a scheduled occurrence and its durable firing", "s"
)
_maintenance_duration = _histogram(
    "workhorse.maintenance.duration", "Workhorse maintenance phase duration", "ms"
)


def job_span_attributes(job: Job) -> dict[str, AttributeValue]:
    return {
        "workhorse.job.id": job.id,
        "workhorse.job.type": job.type,
        "workhorse.job.attempt": job.attempt,
    }


def job_metric_attributes(job: Job) -> dict[str, AttributeValue]:
    return {
        "workhorse.queue.name": job.queue,
        "workhorse.job.type": job.type,
    }


@contextmanager
def start_span(
    name: str,
    attributes: Attributes,
    *,
    trace_context: object | None = None,
    parent_context: object | None = None,
    consumer: bool = False,
) -> Iterator[Span]:
    if not _OTEL_AVAILABLE:
        yield _NoOpSpan()
        return
    parent = cast(Context | None, parent_context)
    if isinstance(trace_context, Mapping):
        carrier = {
            key.lower(): value
            for key, value in trace_context.items()
            if isinstance(key, str) and isinstance(value, str)
        }
        parent = TraceContextTextMapPropagator().extract(carrier=carrier)
    with trace.get_tracer(INSTRUMENTATION_NAME).start_as_current_span(
        name,
        context=parent,
        kind=SpanKind.CONSUMER if consumer else SpanKind.INTERNAL,
        attributes=attributes,
        record_exception=False,
        set_status_on_exception=False,
    ) as active_span:
        yield cast(Span, active_span)


def current_context() -> object | None:
    return otel_context.get_current() if _OTEL_AVAILABLE else None


def record_span_error(span: Span, error_type: str) -> None:
    if not _OTEL_AVAILABLE:
        return
    span.set_status(StatusCode.ERROR)
    span.add_event("exception", {"exception.type": error_type, "exception.escaped": False})


def emit_log(
    severity: Literal["DEBUG", "INFO", "WARN"],
    event_name: WorkhorseLogEvent,
    body: str,
    attributes: Attributes | None = None,
) -> None:
    if not _OTEL_AVAILABLE:
        return
    severity_number = {
        "DEBUG": SeverityNumber.DEBUG,
        "INFO": SeverityNumber.INFO,
        "WARN": SeverityNumber.WARN,
    }[severity]
    get_logger(INSTRUMENTATION_NAME).emit(
        severity_number=severity_number,
        severity_text=severity,
        event_name=event_name,
        body=body,
        attributes=attributes,
    )


def record_claim(queue: str, duration_ms: float, job: Job | None) -> None:
    _claim_duration.record(
        duration_ms,
        {
            "workhorse.queue.name": queue,
            "workhorse.claim.result": "empty" if job is None else "claimed",
        },
    )
    if job is not None:
        _claimed.add(1, job_metric_attributes(job))


def record_completion(job: Job) -> None:
    _completed.add(1, job_metric_attributes(job))


def record_failure(job: Job, outcome: str) -> None:
    attributes = {**job_metric_attributes(job), "workhorse.attempt.outcome": outcome}
    _failed.add(1, attributes)
    if outcome in {"ready", "scheduled"}:
        _retried.add(1, job_metric_attributes(job))


def record_retry(job: Job) -> None:
    _retried.add(1, job_metric_attributes(job))


def record_heartbeat_failure(status: str) -> None:
    _heartbeat_failures.add(1, {"workhorse.heartbeat.status": status})


def record_handler_execution(
    job: Job,
    outcome: JobExecutionOutcome,
    duration_ms: float,
) -> None:
    attributes = job_metric_attributes(job)
    _handler_duration.record(
        duration_ms,
        {**attributes, "workhorse.handler.outcome": outcome},
    )
    _handler_runtime.add(duration_ms, attributes)
    _handler_executions.add(
        1,
        {**attributes, "workhorse.handler.outcome": outcome},
    )


def record_batch(
    queue: str,
    job_type: str,
    size: int,
    linger_ms: float,
    full: bool,
) -> None:
    attributes: dict[str, AttributeValue] = {
        "workhorse.queue.name": queue,
        "workhorse.job.type": job_type,
        "workhorse.handler.batch.full": full,
    }
    _handler_batch_size.record(size, attributes)
    _handler_batch_linger.record(linger_ms, attributes)


def record_recovery(expired_leases: int, retried: int, retry_dimensions: object) -> None:
    if expired_leases > 0:
        _expired_leases.add(expired_leases)
    if not isinstance(retry_dimensions, Sequence) or isinstance(retry_dimensions, (str, bytes)):
        if retried > 0:
            _retried.add(
                retried,
                {"workhorse.queue.name": "unknown", "workhorse.job.type": "unknown"},
            )
        return
    retries_by_job: dict[tuple[str, str], int] = {}
    for dimension in retry_dimensions:
        if not isinstance(dimension, Mapping):
            continue
        queue = dimension.get("queue")
        job_type = dimension.get("type")
        if isinstance(queue, str) and isinstance(job_type, str):
            key = (queue, job_type)
            retries_by_job[key] = retries_by_job.get(key, 0) + 1
    attributed_retries = 0
    for (queue, job_type), count in retries_by_job.items():
        attributed_retries += count
        _retried.add(
            count,
            {"workhorse.queue.name": queue, "workhorse.job.type": job_type},
        )
    if attributed_retries < retried:
        _retried.add(
            retried - attributed_retries,
            {"workhorse.queue.name": "unknown", "workhorse.job.type": "unknown"},
        )


def record_maintenance(
    phase: str,
    rows_affected: int,
    duration_ms: float,
    skipped_lock: bool,
    has_error: bool,
) -> None:
    attributes: dict[str, AttributeValue] = {
        "workhorse.maintenance.loop": "tick",
        "workhorse.maintenance.phase": phase,
        "workhorse.maintenance.skipped_lock": skipped_lock,
    }
    _maintenance_runs.add(1, attributes)
    _maintenance_rows.add(rows_affected, attributes)
    _maintenance_duration.record(duration_ms, attributes)
    if has_error:
        _maintenance_errors.add(1, attributes)


def record_schedule_fired(namespace: str, name: str, lag_seconds: float) -> None:
    attributes = {
        "workhorse.schedule.namespace": namespace,
        "workhorse.schedule.name": name,
    }
    _schedules_fired.add(1, attributes)
    _schedule_lag.record(max(0.0, lag_seconds), attributes)
