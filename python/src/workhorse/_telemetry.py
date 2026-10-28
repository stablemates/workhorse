from __future__ import annotations

import json
import re
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from typing import Literal, Protocol, cast

import psycopg

from ._heartbeat_round import HeartbeatRoundExpired

AttributeValue = (
    str | bool | int | float | Sequence[str] | Sequence[bool] | Sequence[int] | Sequence[float]
)
Attributes = Mapping[str, AttributeValue]
TaskExecutionOutcome = Literal[
    "canceled",
    "deadline_exceeded",
    "failed",
    "lease_lost",
    "released",
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
    "workhorse.handler.missing",
    "workhorse.handler.registered",
    "workhorse.handler.signal_swallowed",
    "workhorse.handler.started",
    "workhorse.task.cancellation_acknowledged",
    "workhorse.task.checkpoint_saved",
    "workhorse.task.child_processed",
    "workhorse.task.claimed",
    "workhorse.task.completed",
    "workhorse.task.completion_rejected",
    "workhorse.task.execution_finished",
    "workhorse.task.failure_processed",
    "workhorse.task.heartbeat_accepted",
    "workhorse.task.heartbeat_rejected",
    "workhorse.task.ownership_expired",
    "workhorse.task.progress_updated",
    "workhorse.task.release_processed",
    "workhorse.task.wait_processed",
    "workhorse.leases.recovered",
    "workhorse.maintenance.completed",
    "workhorse.schedule.fire_replayed",
    "workhorse.schedule.fired",
    "workhorse.worker.paused",
    "workhorse.worker.registered",
    "workhorse.worker.registration_failed",
    "workhorse.worker.reporter_failed",
    "workhorse.worker.resumed",
    "workhorse.worker.started",
    "workhorse.worker.statement_slow",
    "workhorse.worker.stop_requested",
    "workhorse.worker.stopped",
]

INSTRUMENTATION_NAME = "workhorse"
TRACE_ATTRIBUTE_COUNT_LIMIT = 8
METRIC_ATTRIBUTE_CARDINALITY_LIMIT = 2_000
MAX_TRACE_CONTEXT_BYTES = 1_024


class Span(Protocol):
    def set_attribute(self, key: str, value: AttributeValue) -> None: ...

    def set_status(self, status: object, description: str | None = None) -> None: ...

    def add_event(self, name: str, attributes: Attributes | None = None) -> None: ...


class TaskRecord(Protocol):
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
    from opentelemetry import context as otel_context, metrics, trace
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
    _PROPAGATOR = TraceContextTextMapPropagator()
    # The API returns proxies that follow a provider installed later, so resolving them once at
    # import time is safe and saves a lookup per span and per log record.
    _TRACER = trace.get_tracer(INSTRUMENTATION_NAME)
    _LOGGER = get_logger(INSTRUMENTATION_NAME)
    _SEVERITY_NUMBERS = {
        "DEBUG": SeverityNumber.DEBUG,
        "INFO": SeverityNumber.INFO,
        "WARN": SeverityNumber.WARN,
    }


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


_claimed = _counter("workhorse.tasks.claimed", "Tasks claimed for handler execution", "{task}")
_completed = _counter("workhorse.tasks.completed", "Tasks completed under a valid lease", "{task}")
_failed = _counter("workhorse.tasks.failed", "Handler failures submitted to PostgreSQL", "{task}")
_retried = _counter(
    "workhorse.tasks.retried", "Failed or expired tasks returned to live work", "{task}"
)
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
_heartbeat_round_failures = _counter(
    "workhorse.worker.heartbeat.round_failure",
    "Worker heartbeat rounds that failed before PostgreSQL gave a verdict",
    "{round}",
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
    "workhorse.handler.batch.size", "Tasks delivered in one batch handler invocation", "{task}"
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


def task_span_attributes(task: TaskRecord) -> dict[str, AttributeValue]:
    return {
        "workhorse.task.id": task.id,
        "workhorse.task.type": task.type,
        "workhorse.task.attempt": task.attempt,
    }


def task_metric_attributes(task: TaskRecord) -> dict[str, AttributeValue]:
    return {
        "workhorse.queue.name": task.queue,
        "workhorse.task.type": task.type,
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
    # A consumer span runs a claimed task, which descends only from the trace its enqueue stored.
    # A span active where the worker runs is unrelated to the task, so both start from an empty
    # context, and a task without a stored context starts a new trace.
    if consumer:
        parent = Context()
    if isinstance(trace_context, Mapping):
        carrier = {
            key.lower(): value
            for key, value in trace_context.items()
            if isinstance(key, str) and isinstance(value, str)
        }
        parent = _PROPAGATOR.extract(carrier=carrier, context=Context())
    with _TRACER.start_as_current_span(
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


def inject_trace_context() -> dict[str, str] | None:
    if not _OTEL_AVAILABLE:
        return None
    carrier: dict[str, str] = {}
    _PROPAGATOR.inject(carrier)
    if "traceparent" not in carrier:
        return None
    encoded = json.dumps(carrier, separators=(",", ":"), ensure_ascii=False).encode()
    return carrier if len(encoded) <= MAX_TRACE_CONTEXT_BYTES else None


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
    _LOGGER.emit(
        severity_number=_SEVERITY_NUMBERS[severity],
        severity_text=severity,
        event_name=event_name,
        body=body,
        attributes=attributes,
    )


def record_claim(queue: str, duration_ms: float, tasks: Sequence[TaskRecord]) -> None:
    _claim_duration.record(
        duration_ms,
        {
            "workhorse.queue.name": queue,
            "workhorse.claim.result": "empty" if not tasks else "claimed",
        },
    )
    # Every task in one claim shares the queue, so one add per task type is enough.
    counts: dict[str, int] = {}
    for task in tasks:
        counts[task.type] = counts.get(task.type, 0) + 1
    for task_type, count in counts.items():
        _claimed.add(count, {"workhorse.queue.name": queue, "workhorse.task.type": task_type})


def record_completion(task: TaskRecord) -> None:
    _completed.add(1, task_metric_attributes(task))


def record_failure(task: TaskRecord, outcome: str) -> None:
    attributes = {**task_metric_attributes(task), "workhorse.attempt.outcome": outcome}
    _failed.add(1, attributes)
    if outcome in {"ready", "scheduled"}:
        _retried.add(1, task_metric_attributes(task))


def record_retry(task: TaskRecord) -> None:
    _retried.add(1, task_metric_attributes(task))


def record_heartbeat_failure(status: str) -> None:
    _heartbeat_failures.add(1, {"workhorse.heartbeat.status": status})


HeartbeatRoundFailureReason = Literal["timeout", "connection", "database", "other"]

# The SQLSTATE values that end a round on a server timeout: statement_timeout and
# idle_in_transaction_session_timeout.
_TIMEOUT_SQLSTATES = frozenset({"57014", "25P03"})
# The SQLSTATE values of a server shutdown. Class 08 is a connection exception too.
_SHUTDOWN_SQLSTATES = frozenset({"57P01", "57P02", "57P03"})
_SQLSTATE_PATTERN = re.compile(r"[0-9A-Z]{5}")
# The most errors that the classifier reads in one chain.
_ERROR_CHAIN_LIMIT = 16


def _error_chain(error: BaseException) -> list[BaseException]:
    """The error, the members of an exception group, `__cause__`, and `__context__`.

    The outermost error comes first. Each error counts once, so a cycle ends the walk, and the walk
    stops after `_ERROR_CHAIN_LIMIT` errors.
    """
    chain: list[BaseException] = []
    seen: set[int] = set()
    pending: list[BaseException] = [error]
    while pending and len(chain) < _ERROR_CHAIN_LIMIT:
        entry = pending.pop(0)
        if id(entry) in seen:
            continue
        seen.add(id(entry))
        chain.append(entry)
        if isinstance(entry, BaseExceptionGroup):
            pending.extend(entry.exceptions)
        pending.extend(
            nested for nested in (entry.__cause__, entry.__context__) if nested is not None
        )
    return chain


def _sqlstate(error: BaseException) -> str | None:
    """The SQLSTATE of a server error: `sqlstate` of psycopg and asyncpg, else `code`."""
    for name in ("sqlstate", "code"):
        value = getattr(error, name, None)
        if isinstance(value, str) and _SQLSTATE_PATTERN.fullmatch(value):
            return value
    return None


def _is_connection_error(error: BaseException) -> bool:
    """True for a client error that shows the round did not reach PostgreSQL or lost it."""
    # OSError covers ConnectionError (ConnectionResetError, BrokenPipeError, and others),
    # socket.gaierror for DNS, and a socket TimeoutError.
    if isinstance(error, OSError):
        return True
    # psycopg raises OperationalError without a SQLSTATE when it cannot connect, when the
    # connection is closed or lost, and when psycopg_pool.PoolTimeout gives no connection.
    if isinstance(error, psycopg.OperationalError) and _sqlstate(error) is None:
        return True
    # asyncpg raises InterfaceError for an operation on a closed connection, and
    # ConnectionDoesNotExistError (SQLSTATE 08003) when it lost the connection during one. asyncpg
    # is an optional dependency, so the class is matched by its name and module.
    return "connection is closed" in str(error) and any(
        cls.__name__ == "InterfaceError" and cls.__module__.startswith("asyncpg")
        for cls in type(error).__mro__
    )


def heartbeat_round_failure_reason(error: BaseException) -> HeartbeatRoundFailureReason:
    """The category of a heartbeat round that failed before PostgreSQL gave a verdict.

    The classifier reads the error and its chain (`_error_chain`), in this order:

    1. `timeout`: the round deadline error `HeartbeatRoundExpired` (also when the round expired
       cleanly), or SQLSTATE `57014` (statement_timeout) or `25P03`
       (idle_in_transaction_session_timeout).
    2. `connection`: a built-in `OSError` (a socket, DNS, or socket timeout error), a psycopg
       `OperationalError` without a SQLSTATE (also `psycopg_pool.PoolTimeout`), an asyncpg
       `InterfaceError` for a closed connection, a SQLSTATE of class `08`, or `57P01` to `57P03`.
    3. `database`: any other SQLSTATE.
    4. `other`: everything else.
    """
    chain = _error_chain(error)
    if any(isinstance(entry, HeartbeatRoundExpired) for entry in chain):
        return "timeout"
    sqlstate = next(
        (state for state in (_sqlstate(entry) for entry in chain) if state is not None), None
    )
    if sqlstate in _TIMEOUT_SQLSTATES:
        return "timeout"
    if (
        sqlstate is not None and (sqlstate.startswith("08") or sqlstate in _SHUTDOWN_SQLSTATES)
    ) or any(_is_connection_error(entry) for entry in chain):
        return "connection"
    return "other" if sqlstate is None else "database"


def record_heartbeat_round_failure(error: BaseException) -> None:
    """Count one heartbeat round that failed before PostgreSQL returned a status for its leases.

    The round gives no ownership verdict, so `workhorse.worker.heartbeat.failure` does not count
    it. The worker records one value for each failed round, so the rate stays bounded by the
    heartbeat interval and its busy retries.
    """
    _heartbeat_round_failures.add(
        1, {"workhorse.heartbeat.failure_reason": heartbeat_round_failure_reason(error)}
    )


def record_handler_execution(
    task: TaskRecord,
    outcome: TaskExecutionOutcome,
    duration_ms: float,
) -> None:
    attributes = task_metric_attributes(task)
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
    task_type: str,
    size: int,
    linger_ms: float,
    full: bool,
) -> None:
    attributes: dict[str, AttributeValue] = {
        "workhorse.queue.name": queue,
        "workhorse.task.type": task_type,
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
                {"workhorse.queue.name": "unknown", "workhorse.task.type": "unknown"},
            )
        return
    retries_by_task: dict[tuple[str, str], int] = {}
    for dimension in retry_dimensions:
        if not isinstance(dimension, Mapping):
            continue
        queue = dimension.get("queue")
        task_type = dimension.get("type")
        if isinstance(queue, str) and isinstance(task_type, str):
            key = (queue, task_type)
            retries_by_task[key] = retries_by_task.get(key, 0) + 1
    attributed_retries = 0
    for (queue, task_type), count in retries_by_task.items():
        attributed_retries += count
        _retried.add(
            count,
            {"workhorse.queue.name": queue, "workhorse.task.type": task_type},
        )
    if attributed_retries < retried:
        _retried.add(
            retried - attributed_retries,
            {"workhorse.queue.name": "unknown", "workhorse.task.type": "unknown"},
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
