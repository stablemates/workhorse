from __future__ import annotations

import json
import os
import socket
import traceback
from collections.abc import Callable, Mapping, Sequence
from concurrent.futures import Future
from concurrent.futures import TimeoutError as FutureTimeoutError
from contextlib import suppress
from dataclasses import dataclass
from datetime import datetime, timezone
from threading import Event, Lock, Thread, current_thread
from time import monotonic
from typing import TYPE_CHECKING, Any, Literal, cast
from uuid import uuid4

from ._compatibility import CachedCompatibilityCheck, SyncRowExecutor
from ._contracts import compile_contract_schema
from ._drivers import PsycopgConnection, Row, SyncExecutor
from ._external_waits import encode_wait_value, validate_wait_name, validate_wait_timeout
from ._notifications import (
    JobNotificationListener,
    NotificationConnectionFactory,
)
from ._protocol import serialize_child_request
from ._statements import STATEMENTS, DriverStatement
from ._telemetry import (
    JobExecutionOutcome,
    current_context,
    emit_log,
    job_span_attributes,
    record_claim,
    record_completion,
    record_failure,
    record_handler_execution,
    record_heartbeat_failure,
    record_maintenance,
    record_recovery,
    record_retry,
    record_schedule_fired,
    record_span_error,
    start_span,
)
from ._telemetry import (
    record_batch as record_batch_metrics,
)
from .errors import (
    CancellationRequestedError,
    CheckpointConflictError,
    CheckpointLeaseLostError,
    ChildConflictError,
    ChildLeaseLostError,
    ChildLimitExceededError,
    ChildResultLimitExceededError,
    DeadlineExceededError,
    ExecutionTimeoutError,
    HumanWaitAlreadyWaitingError,
    HumanWaitConflictError,
    HumanWaitLeaseLostError,
    HumanWaitLimitExceededError,
    JobContractUnavailableError,
    JobContractValidationError,
    ProgressLeaseLostError,
    ProgressRateLimitError,
    SignalWaitConflictError,
    SignalWaitLeaseLostError,
    SignalWaitLimitExceededError,
    StaleLeaseError,
    WaitConflictError,
    WaitLeaseLostError,
    WaitLimitExceededError,
)
from .types import (
    BatchHandlerItem,
    BatchHandlerOutcome,
    CancellationToken,
    ChildJobRequest,
    ClaimedJob,
    EnqueueOptions,
    HandlerContext,
    JobCheckpoint,
    JobProgress,
    JobWait,
    Json,
)

if TYPE_CHECKING:
    import psycopg

    SyncConnection = psycopg.Connection[Any]
else:
    SyncConnection = PsycopgConnection

Handler = Callable[[Any, HandlerContext], Json]
BatchHandler = Callable[[Sequence[BatchHandlerItem]], Sequence[BatchHandlerOutcome]]


@dataclass
class _PendingBatchMember:
    arrival_order: int
    arrived_at: float
    item: BatchHandlerItem
    result: Future[Json]


_REDACTED_ERROR_NAME = "RedactedJobError"
_REDACTED_ERROR_MESSAGE = "Job handler failed; details redacted"
AttemptOutcome = Literal[
    "completed",
    "failed",
    "retry",
    "lease_expired",
    "deadline_exceeded",
    "attempt_timeout",
    "cancelled",
    "suspended_for_wait",
    "suspended_for_child",
]
_STATUS_OUTCOMES: dict[str, AttemptOutcome] = {
    "cancel_requested": "cancelled",
    "deadline_exceeded": "deadline_exceeded",
    "timeout_exceeded": "attempt_timeout",
    "stale": "lease_expired",
}


class _AttemptOutcomeArbiter:
    def __init__(self) -> None:
        self._lock = Lock()
        self._outcome: AttemptOutcome | None = None

    @property
    def outcome(self) -> AttemptOutcome | None:
        with self._lock:
            return self._outcome

    def submit(self, outcome: AttemptOutcome) -> bool:
        with self._lock:
            if self._outcome is not None:
                return False
            self._outcome = outcome
            return True


class _DurableWaitSuspension(BaseException):
    pass


_DURABLE_WAIT_SUSPENSION = _DurableWaitSuspension()
_MAX_WAIT_DURATION_MS = 31_536_000_000


class _HandlerDurability:
    def __init__(
        self,
        executor: SyncRowExecutor,
        job: ClaimedJob,
        worker_id: str,
        cancellation: CancellationToken,
        arbiter: _AttemptOutcomeArbiter,
    ) -> None:
        self._executor = executor
        self._job = job
        self._worker_id = worker_id
        self._cancellation = cancellation
        self._arbiter = arbiter
        self._lock = Lock()
        self._checkpoints: dict[str, JobCheckpoint] | None = None
        self._checkpoints_load_error: BaseException | None = None
        self._checkpoints_load_attempted = False
        self._waits: dict[str, JobWait] | None = None
        self._waits_load_error: BaseException | None = None
        self._waits_load_attempted = False
        self._progress: JobProgress | None = None
        self._progress_load_error: BaseException | None = None
        self._progress_load_attempted = False
        self._checkpoint_calls: dict[str, Future[Json]] = {}
        self._wait_calls: dict[str, Future[None]] = {}
        self._signal_calls: dict[str, Future[Json]] = {}
        self._human_calls: dict[str, tuple[str, Future[Json]]] = {}
        self._child_calls: dict[str, tuple[str, Future[Json]]] = {}
        self._children_call: tuple[str, Future[dict[str, Json]]] | None = None

    def context(self) -> HandlerContext:
        return HandlerContext(
            self._job,
            self._cancellation,
            self.get_checkpoint,
            self.get_wait,
            self.get_progress,
            self.set_progress,
            self.checkpoint,
            self.sleep,
            self.sleep_until,
            self.wait_for_signal,
            self.wait_for_human,
            self.run_child,
            self.run_children,
        )

    def _load_checkpoints(self) -> dict[str, JobCheckpoint]:
        with self._lock:
            if not self._checkpoints_load_attempted:
                self._checkpoints_load_attempted = True
                try:
                    rows = self._executor.rows(STATEMENTS.list_checkpoints, (self._job.id,))
                    self._checkpoints = {
                        str(row["checkpoint_name"]): _checkpoint_record(self._job.id, row)
                        for row in rows
                    }
                except BaseException as error:
                    self._checkpoints_load_error = error
            if self._checkpoints_load_error is not None:
                raise self._checkpoints_load_error
            assert self._checkpoints is not None
            return self._checkpoints

    def _load_waits(self) -> dict[str, JobWait]:
        with self._lock:
            if not self._waits_load_attempted:
                self._waits_load_attempted = True
                try:
                    rows = self._executor.rows(STATEMENTS.list_waits, (self._job.id,))
                    self._waits = {
                        str(row["wait_name"]): _wait_record(self._job.id, row) for row in rows
                    }
                except BaseException as error:
                    self._waits_load_error = error
            if self._waits_load_error is not None:
                raise self._waits_load_error
            assert self._waits is not None
            return self._waits

    def get_checkpoint(self, name: str) -> JobCheckpoint | None:
        return self._load_checkpoints().get(name)

    def get_wait(self, name: str) -> JobWait | None:
        return self._load_waits().get(name)

    def get_progress(self) -> JobProgress | None:
        with self._lock:
            if not self._progress_load_attempted:
                self._progress_load_attempted = True
                try:
                    rows = self._executor.rows(STATEMENTS.list_progress, (self._job.id,))
                    if len(rows) > 1:
                        raise RuntimeError("PostgreSQL returned an invalid progress result")
                    self._progress = None if not rows else _progress_record(self._job.id, rows[0])
                except BaseException as error:
                    self._progress_load_error = error
            if self._progress_load_error is not None:
                raise self._progress_load_error
            return self._progress

    def set_progress(self, value: Json) -> JobProgress:
        encoded = json.dumps(value, separators=(",", ":"), allow_nan=False)
        self._cancellation.raise_if_cancelled()
        row = _require_lifecycle_row(
            self._executor.rows(
                STATEMENTS.update_progress,
                (self._job.id, self._worker_id, self._job.fence_token, encoded),
            )
        )
        status = row["status"]
        if status == "stale":
            raise ProgressLeaseLostError(self._job.id)
        if status == "rate_limited":
            raise ProgressRateLimitError(self._job.id, int(cast(int | str, row["retry_after_ms"])))
        if status not in {"updated", "unchanged"}:
            raise RuntimeError(f"Unexpected progress status: {status}")
        progress = _progress_record(self._job.id, row)
        with self._lock:
            self._progress_load_attempted = True
            self._progress_load_error = None
            self._progress = progress
        emit_log(
            "DEBUG",
            "workhorse.job.progress_updated",
            "Job progress persisted",
            {
                **job_span_attributes(self._job),
                "workhorse.progress.status": str(status),
                "workhorse.worker.id": self._worker_id,
            },
        )
        return progress

    def checkpoint(self, name: str, operation: Callable[[], Json]) -> Json:
        with self._lock:
            pending = self._checkpoint_calls.get(name)
            if pending is None:
                pending = Future()
                self._checkpoint_calls[name] = pending
                owns_call = True
            else:
                owns_call = False
        if not owns_call:
            return pending.result()
        try:
            existing = self._load_checkpoints().get(name)
            if existing is not None:
                result = existing.value
            else:
                self._cancellation.raise_if_cancelled()
                value = operation()
                encoded = json.dumps(value, separators=(",", ":"), allow_nan=False)
                row = _require_lifecycle_row(
                    self._executor.rows(
                        STATEMENTS.save_checkpoint,
                        (
                            self._job.id,
                            self._worker_id,
                            self._job.fence_token,
                            name,
                            encoded,
                        ),
                    )
                )
                status = row["status"]
                if status == "stale":
                    raise CheckpointLeaseLostError(self._job.id, name)
                if status == "conflict":
                    raise CheckpointConflictError(self._job.id, name)
                if status not in {"saved", "existing"}:
                    raise RuntimeError(f"Unexpected checkpoint status: {status}")
                emit_log(
                    "DEBUG",
                    "workhorse.job.checkpoint_saved",
                    "Job checkpoint persisted",
                    {
                        **job_span_attributes(self._job),
                        "workhorse.checkpoint.name": name,
                        "workhorse.checkpoint.status": str(status),
                        "workhorse.worker.id": self._worker_id,
                    },
                )
                saved = _checkpoint_record(self._job.id, row, name=name)
                with self._lock:
                    assert self._checkpoints is not None
                    self._checkpoints[name] = saved
                result = saved.value
            pending.set_result(result)
            return result
        except BaseException as error:
            pending.set_exception(error)
            raise
        finally:
            with self._lock:
                if self._checkpoint_calls.get(name) is pending:
                    del self._checkpoint_calls[name]

    def sleep(self, name: str, duration_ms: int) -> None:
        if isinstance(duration_ms, bool) or not isinstance(duration_ms, int):
            raise TypeError("Wait duration_ms must be an integer number of milliseconds")
        if not 1 <= duration_ms <= _MAX_WAIT_DURATION_MS:
            raise ValueError(f"Wait duration_ms must be between 1 and {_MAX_WAIT_DURATION_MS}")
        self._schedule_wait(name, duration_ms=duration_ms, wake_at=None)

    def sleep_until(self, name: str, wake_at: datetime) -> None:
        if (
            not isinstance(wake_at, datetime)
            or wake_at.tzinfo is None
            or wake_at.utcoffset() is None
        ):
            raise TypeError("Wait wake_at must be a timezone-aware datetime")
        if (wake_at - datetime.now(timezone.utc)).total_seconds() * 1000 > _MAX_WAIT_DURATION_MS:
            raise ValueError("Wait wake_at must be no more than 365 days in the future")
        self._schedule_wait(name, duration_ms=None, wake_at=wake_at)

    def _schedule_wait(
        self,
        name: str,
        *,
        duration_ms: int | None,
        wake_at: datetime | None,
    ) -> None:
        with self._lock:
            pending = self._wait_calls.get(name)
            if pending is None:
                pending = Future()
                self._wait_calls[name] = pending
                owns_call = True
            else:
                owns_call = False
        if not owns_call:
            return pending.result()
        try:
            self._cancellation.raise_if_cancelled()
            row = _require_lifecycle_row(
                self._executor.rows(
                    STATEMENTS.schedule_wait,
                    (
                        self._job.id,
                        self._worker_id,
                        self._job.fence_token,
                        name,
                        duration_ms,
                        wake_at,
                    ),
                )
            )
            status = row["status"]
            if status == "stale":
                raise WaitLeaseLostError(self._job.id, name)
            if status == "conflict":
                raise WaitConflictError(self._job.id, name)
            if status == "limit_exceeded":
                raise WaitLimitExceededError(self._job.id)
            if status not in {"scheduled", "elapsed"}:
                raise RuntimeError(f"Unexpected wait status: {status}")
            emit_log(
                "INFO",
                "workhorse.job.wait_processed",
                "Durable job wait processed",
                {
                    **job_span_attributes(self._job),
                    "workhorse.wait.name": name,
                    "workhorse.wait.status": str(status),
                    "workhorse.worker.id": self._worker_id,
                },
            )
            wait = _wait_record(self._job.id, row, name=name)
            with self._lock:
                if self._waits is not None:
                    self._waits[name] = wait
            if status == "scheduled" and self._arbiter.submit("suspended_for_wait"):
                self._cancellation._cancel(_DURABLE_WAIT_SUSPENSION)
                raise _DURABLE_WAIT_SUSPENSION
            pending.set_result(None)
        except BaseException as error:
            pending.set_exception(error)
            raise
        finally:
            with self._lock:
                if self._wait_calls.get(name) is pending:
                    del self._wait_calls[name]

    def wait_for_signal(self, name: str, timeout_ms: int | None = None) -> Json:
        validate_wait_name(name, "Signal")
        validate_wait_timeout(timeout_ms, "Signal")
        with self._lock:
            pending = self._signal_calls.get(name)
            if pending is None:
                pending = Future()
                self._signal_calls[name] = pending
                owns_call = True
            else:
                owns_call = False
        if not owns_call:
            return pending.result()
        try:
            self._cancellation.raise_if_cancelled()
            row = _require_lifecycle_row(
                self._executor.rows(
                    STATEMENTS.wait_for_signal,
                    (
                        self._job.id,
                        self._worker_id,
                        self._job.fence_token,
                        name,
                        timeout_ms,
                    ),
                )
            )
            status = row["status"]
            if status == "stale":
                raise SignalWaitLeaseLostError(self._job.id, name)
            if status == "already_waiting":
                raise SignalWaitConflictError(self._job.id, name)
            if status == "limit_exceeded":
                raise SignalWaitLimitExceededError(self._job.id)
            if status == "waiting":
                if self._arbiter.submit("suspended_for_wait"):
                    self._cancellation._cancel(_DURABLE_WAIT_SUSPENSION)
                raise _DURABLE_WAIT_SUSPENSION
            if status != "delivered":
                raise RuntimeError(f"Unexpected signal wait status: {status}")
            result = cast(Json, row["payload"])
            pending.set_result(result)
            return result
        except BaseException as error:
            pending.set_exception(error)
            raise
        finally:
            with self._lock:
                if self._signal_calls.get(name) is pending:
                    del self._signal_calls[name]

    def wait_for_human(self, name: str, context: Json, timeout_ms: int | None = None) -> Json:
        validate_wait_name(name, "Human wait")
        validate_wait_timeout(timeout_ms, "Human wait")
        encoded_context = encode_wait_value(context, "Human wait context")
        with self._lock:
            current = self._human_calls.get(name)
            if current is None:
                pending: Future[Json] = Future()
                self._human_calls[name] = (encoded_context, pending)
                owns_call = True
            else:
                pending_context, pending = current
                if pending_context != encoded_context:
                    raise HumanWaitConflictError(self._job.id, name)
                owns_call = False
        if not owns_call:
            return pending.result()
        try:
            self._cancellation.raise_if_cancelled()
            row = _require_lifecycle_row(
                self._executor.rows(
                    STATEMENTS.wait_for_human,
                    (
                        self._job.id,
                        self._worker_id,
                        self._job.fence_token,
                        name,
                        encoded_context,
                        timeout_ms,
                    ),
                )
            )
            status = row["status"]
            if status == "stale":
                raise HumanWaitLeaseLostError(self._job.id, name)
            if status == "already_waiting":
                raise HumanWaitAlreadyWaitingError(self._job.id, name)
            if status == "limit_exceeded":
                raise HumanWaitLimitExceededError(self._job.id)
            if status == "conflict":
                raise HumanWaitConflictError(self._job.id, name)
            if status == "waiting":
                if self._arbiter.submit("suspended_for_wait"):
                    self._cancellation._cancel(_DURABLE_WAIT_SUSPENSION)
                raise _DURABLE_WAIT_SUSPENSION
            if status != "completed":
                raise RuntimeError(f"Unexpected human wait status: {status}")
            result = cast(Json, row["result"])
            pending.set_result(result)
            return result
        except BaseException as error:
            pending.set_exception(error)
            raise
        finally:
            with self._lock:
                current = self._human_calls.get(name)
                if current is not None and current[1] is pending:
                    del self._human_calls[name]

    def run_child(
        self,
        name: str,
        type: str,
        payload: Json,
        options: EnqueueOptions,
    ) -> Json:
        if not isinstance(name, str) or not 1 <= len(name) <= 200:
            raise ValueError("Child name must contain between 1 and 200 characters")
        request = serialize_child_request(self._job, type, payload, options, "default")
        encoded = json.dumps(request, separators=(",", ":"), allow_nan=False, sort_keys=True)
        with self._lock:
            current = self._child_calls.get(name)
            if current is None:
                pending: Future[Json] = Future()
                self._child_calls[name] = (encoded, pending)
                owns_call = True
            else:
                pending_request, pending = current
                if pending_request != encoded:
                    raise ChildConflictError(self._job.id, name)
                owns_call = False
        if not owns_call:
            return pending.result()
        try:
            self._cancellation.raise_if_cancelled()
            row = _require_lifecycle_row(
                self._executor.rows(
                    STATEMENTS.create_child,
                    (self._job.id, self._worker_id, self._job.fence_token, name, encoded),
                )
            )
            status = row["status"]
            if status == "stale":
                raise ChildLeaseLostError(self._job.id)
            if status == "conflict":
                raise ChildConflictError(self._job.id, name)
            if status == "limit_exceeded":
                raise ChildLimitExceededError(self._job.id)
            if status in {"created", "completed"}:
                emit_log(
                    "INFO",
                    "workhorse.job.child_processed",
                    "Child job processed",
                    {
                        "workhorse.job.id": self._job.id,
                        "workhorse.child.name": name,
                        "workhorse.child.status": str(status),
                        "workhorse.worker.id": self._worker_id,
                    },
                )
            if status == "created":
                if self._arbiter.submit("suspended_for_child"):
                    self._cancellation._cancel(_DURABLE_WAIT_SUSPENSION)
                raise _DURABLE_WAIT_SUSPENSION
            if status != "completed":
                raise RuntimeError(f"Unexpected child status: {status}")
            result = cast(Json, row["result"])
            pending.set_result(result)
            return result
        except BaseException as error:
            pending.set_exception(error)
            raise
        finally:
            with self._lock:
                current = self._child_calls.get(name)
                if current is not None and current[1] is pending:
                    del self._child_calls[name]

    def run_children(self, children: Sequence[ChildJobRequest]) -> dict[str, Json]:
        if isinstance(children, (str, bytes)) or not isinstance(children, Sequence):
            raise TypeError("Children must be a sequence")
        if len(children) > 100:
            raise ChildLimitExceededError(self._job.id)
        names: set[str] = set()
        requests: list[dict[str, Json]] = []
        for child in children:
            if not isinstance(child, ChildJobRequest):
                raise TypeError("Each child must be a ChildJobRequest")
            if not isinstance(child.name, str) or not 1 <= len(child.name) <= 200:
                raise ValueError("Child name must contain between 1 and 200 characters")
            if child.name in names:
                raise ValueError("Child names must be unique")
            names.add(child.name)
            requests.append(
                {
                    "name": child.name,
                    "request": serialize_child_request(
                        self._job,
                        child.type,
                        child.payload,
                        child.options,
                        "default",
                    ),
                }
            )
        encoded = json.dumps(requests, separators=(",", ":"), allow_nan=False, sort_keys=True)
        with self._lock:
            current = self._children_call
            if current is None:
                pending: Future[dict[str, Json]] = Future()
                self._children_call = (encoded, pending)
                owns_call = True
            else:
                pending_request, pending = current
                if pending_request != encoded:
                    raise ChildConflictError(self._job.id, "child set")
                owns_call = False
        if not owns_call:
            return pending.result()
        try:
            self._cancellation.raise_if_cancelled()
            row = _require_lifecycle_row(
                self._executor.rows(
                    STATEMENTS.create_children,
                    (self._job.id, self._worker_id, self._job.fence_token, encoded),
                )
            )
            status = row["status"]
            if status == "stale":
                raise ChildLeaseLostError(self._job.id)
            if status == "conflict":
                raise ChildConflictError(self._job.id, "child set")
            if status == "limit_exceeded":
                raise ChildLimitExceededError(self._job.id)
            if status == "result_too_large":
                raise ChildResultLimitExceededError(
                    self._job.id,
                    int(cast(int, row["result_bytes"] or 0)),
                    int(cast(int, row["result_limit_bytes"] or 0)),
                )
            if status in {"created", "completed"}:
                emit_log(
                    "INFO",
                    "workhorse.job.child_processed",
                    "Child set processed",
                    {
                        "workhorse.job.id": self._job.id,
                        "workhorse.child.count": len(children),
                        "workhorse.child.status": str(status),
                        "workhorse.worker.id": self._worker_id,
                    },
                )
            if status == "created":
                if self._arbiter.submit("suspended_for_child"):
                    self._cancellation._cancel(_DURABLE_WAIT_SUSPENSION)
                raise _DURABLE_WAIT_SUSPENSION
            if status != "completed":
                raise RuntimeError(f"Unexpected child-set status: {status}")
            result = cast(dict[str, Json], row["results"] or {})
            pending.set_result(result)
            return result
        except BaseException as error:
            pending.set_exception(error)
            raise
        finally:
            with self._lock:
                current = self._children_call
                if current is not None and current[1] is pending:
                    self._children_call = None


class Worker:
    """A synchronous worker over a dedicated, thread-safe Psycopg connection."""

    def __init__(
        self,
        connection: SyncConnection,
        *,
        queue: str | None = None,
        queues: Sequence[str] | None = None,
        worker_id: str | None = None,
        concurrency: int = 1,
        poll_ms: int | None = None,
        lease_ms: int = 30_000,
        heartbeat_ms: int | None = None,
        maintenance_interval_ms: int = 1_000,
        registry_interval_ms: int = 5_000,
        schedule_namespaces: Sequence[str] = (),
        schedule_catchup_limit: int = 100,
        notification_connection_factory: NotificationConnectionFactory | None = None,
        on_notification_error: Callable[[BaseException], None] | None = None,
        on_registration_error: Callable[[BaseException], None] | None = None,
        _executor: SyncRowExecutor | None = None,
    ) -> None:
        if _executor is None and getattr(connection, "autocommit", False) is not True:
            raise ValueError("Worker requires a dedicated Psycopg connection in autocommit mode")
        if queue is not None and queues is not None:
            raise ValueError("queue and queues cannot be configured together")
        configured_queues = queues if queues is not None else (queue or "default",)
        unique_queues = tuple(dict.fromkeys(configured_queues))
        if not unique_queues or any(
            not isinstance(name, str) or not name for name in unique_queues
        ):
            raise ValueError("queues must contain at least one non-empty queue name")
        if (
            isinstance(concurrency, bool)
            or not isinstance(concurrency, int)
            or not 1 <= concurrency <= 100
        ):
            raise ValueError("concurrency must be an integer between 1 and 100")
        resolved_poll_ms = poll_ms if poll_ms is not None else 250
        if (
            isinstance(resolved_poll_ms, bool)
            or not isinstance(resolved_poll_ms, int)
            or resolved_poll_ms < 1
        ):
            raise ValueError("poll_ms must be a positive integer")
        self._executor = _executor or SyncExecutor(cast(PsycopgConnection, connection))
        self._compatibility = CachedCompatibilityCheck(self._executor)
        self._handlers: dict[str, Handler] = {}
        self.queues = unique_queues
        self.queue = unique_queues[0]
        self.worker_id = worker_id or _default_worker_id()
        self.concurrency = concurrency
        self.poll_ms = resolved_poll_ms
        self._notification_poll_ms = poll_ms if poll_ms is not None else 5_000
        self._query_connection = connection
        self._notification_connection_factory = notification_connection_factory
        self._on_notification_error = on_notification_error
        self._on_registration_error = on_registration_error
        if not 100 <= lease_ms <= 86_400_000:
            raise ValueError("lease_ms must be between 100 and 86400000")
        self.lease_ms = lease_ms
        self.heartbeat_ms = heartbeat_ms if heartbeat_ms is not None else max(100, lease_ms // 3)
        if not 0 < self.heartbeat_ms < self.lease_ms:
            raise ValueError("heartbeat_ms must be positive and less than lease_ms")
        if (
            isinstance(maintenance_interval_ms, bool)
            or not isinstance(maintenance_interval_ms, int)
            or maintenance_interval_ms < 100
        ):
            raise ValueError("maintenance_interval_ms must be an integer of at least 100")
        if (
            isinstance(registry_interval_ms, bool)
            or not isinstance(registry_interval_ms, int)
            or (registry_interval_ms != 0 and registry_interval_ms < 100)
        ):
            raise ValueError("registry_interval_ms must be 0 or an integer of at least 100")
        if (
            isinstance(schedule_catchup_limit, bool)
            or not isinstance(schedule_catchup_limit, int)
            or not 1 <= schedule_catchup_limit <= 10_000
        ):
            raise ValueError("schedule_catchup_limit must be an integer between 1 and 10000")
        unique_namespaces = tuple(dict.fromkeys(schedule_namespaces))
        if any(not isinstance(namespace, str) or not namespace for namespace in unique_namespaces):
            raise ValueError("schedule_namespaces must contain non-empty namespace names")
        self.maintenance_interval_ms = maintenance_interval_ms
        self.registry_interval_ms = registry_interval_ms
        self.schedule_namespaces = unique_namespaces
        self.schedule_catchup_limit = schedule_catchup_limit
        self._last_maintenance_at = float("-inf")
        self._last_registry_refresh_at = float("-inf")
        self._instance_id = ""
        self._registered = False
        self._next_queue_index = 0
        self._state_lock = Lock()
        self._contract_validators: dict[tuple[str, str], Any] = {}
        self._execution_lock = Lock()
        self._wake = Event()
        self._active_threads: set[Thread] = set()
        self._run_errors: list[BaseException] = []
        self._locally_paused = False
        self._remotely_paused = False
        self._stopping = False
        self._stop_version = 0

    def handle(self, type: str, handler: Handler) -> Worker:
        self._handlers[type] = handler
        emit_log(
            "DEBUG",
            "workhorse.handler.registered",
            "Job handler registered",
            {"workhorse.job.type": type, "workhorse.worker.id": self.worker_id},
        )
        return self

    def _validate_result_contract(self, job: ClaimedJob, result: Json) -> None:
        version = job.contract_version
        if version is None:
            return
        key = (job.type, version)
        with self._state_lock:
            validator = self._contract_validators.get(key)
        if validator is None:
            rows = self._executor.rows(STATEMENTS.get_contract, (job.type, version))
            if len(rows) != 1:
                raise JobContractUnavailableError(job.type, version)
            document = rows[0].get("schema")
            if isinstance(document, str):
                document = json.loads(document)
            if not isinstance(document, Mapping) or "result" not in document:
                raise JobContractUnavailableError(job.type, version)
            validator = compile_contract_schema(cast(Json, document["result"]))
            with self._state_lock:
                self._contract_validators[key] = validator
        if not validator.is_valid(result):
            raise JobContractValidationError(job.type, version, "result")

    def handle_batch(
        self,
        type: str,
        handler: BatchHandler,
        *,
        max_size: int,
        linger_ms: int,
    ) -> Worker:
        if isinstance(max_size, bool) or not isinstance(max_size, int) or not 1 <= max_size <= 100:
            raise ValueError("max_size must be an integer between 1 and 100")
        if max_size > self.concurrency:
            raise ValueError("max_size must not exceed worker concurrency")
        if (
            isinstance(linger_ms, bool)
            or not isinstance(linger_ms, int)
            or not 0 <= linger_ms <= 60_000
        ):
            raise ValueError("linger_ms must be an integer between 0 and 60000")

        pending_lock = Lock()
        pending_queues: dict[str, list[_PendingBatchMember]] = {}
        next_arrival = 0

        def take_batch(queue_name: str) -> list[_PendingBatchMember]:
            pending = pending_queues.get(queue_name)
            if not pending:
                return []
            batch = pending[:max_size]
            del pending[:max_size]
            if not pending:
                del pending_queues[queue_name]
            return sorted(
                batch, key=lambda member: (-member.item.context.job.priority, member.arrival_order)
            )

        def record_batch(
            statement: DriverStatement,
            batch_id: str,
            batch: Sequence[_PendingBatchMember],
        ) -> None:
            jobs = [member.item.context.job for member in batch]
            try:
                row = _require_lifecycle_row(
                    self._executor.rows(
                        statement,
                        (
                            batch_id,
                            [job.id for job in jobs],
                            [job.attempt for job in jobs],
                            [job.fence_token for job in jobs],
                            self.worker_id,
                        ),
                    )
                )
                if int(cast(int, row["recorded"])) != len(batch):
                    raise RuntimeError("PostgreSQL did not record every batch member")
            except Exception as error:
                jobs = [member.item.context.job for member in batch]
                emit_log(
                    "WARN",
                    "workhorse.handler.batch_evidence_failed",
                    "Batch execution evidence could not be persisted",
                    {
                        "workhorse.queue.name": jobs[0].queue,
                        "workhorse.job.type": type,
                        "workhorse.handler.batch.full": len(batch) == max_size,
                        "workhorse.handler.batch.size": len(batch),
                        "workhorse.handler.batch.evidence_phase": (
                            "dispatch"
                            if statement is STATEMENTS.record_batch_dispatch
                            else "failure"
                        ),
                        "workhorse.worker.id": self.worker_id,
                        "error.type": error.__class__.__name__,
                    },
                )
                return

        def dispatch(batch: Sequence[_PendingBatchMember]) -> None:
            batch_id = str(uuid4())
            first_arrived_at = min(member.arrived_at for member in batch)
            actual_linger_ms = max(0.0, (monotonic() - first_arrived_at) * 1_000)
            queue_name = batch[0].item.context.job.queue
            full = len(batch) == max_size
            record_batch_metrics(queue_name, type, len(batch), actual_linger_ms, full)
            emit_log(
                "INFO",
                "workhorse.handler.batch_dispatched",
                "Job batch dispatched",
                {
                    "workhorse.queue.name": queue_name,
                    "workhorse.job.type": type,
                    "workhorse.handler.batch.full": full,
                    "workhorse.handler.batch.size": len(batch),
                    "workhorse.handler.batch.linger_ms": actual_linger_ms,
                    "workhorse.worker.id": self.worker_id,
                },
            )
            record_batch(STATEMENTS.record_batch_dispatch, batch_id, batch)
            try:
                outcomes = handler(tuple(member.item for member in batch))
                validated = _validate_batch_outcomes(type, outcomes, len(batch))
            except BaseException as cause:
                error = (
                    cause
                    if isinstance(cause, Exception)
                    else RuntimeError(
                        f"Batch handler for {type} raised {cause.__class__.__name__}: {cause}"
                    )
                )
                record_batch(STATEMENTS.record_batch_failure, batch_id, batch)
                for member in batch:
                    member.result.set_exception(error)
                return
            for member, outcome in zip(batch, validated, strict=True):
                if outcome["status"] == "succeeded":
                    member.result.set_result(outcome["result"])
                else:
                    member.result.set_exception(outcome["error"])

        def batch_member_handler(payload: Any, context: HandlerContext) -> Json:
            nonlocal next_arrival
            member = _PendingBatchMember(
                arrival_order=0,
                arrived_at=monotonic(),
                item=BatchHandlerItem(cast(Json, payload), context._as_batch_context()),
                result=Future(),
            )
            with pending_lock:
                member.arrival_order = next_arrival
                next_arrival += 1
                pending = pending_queues.setdefault(context.job.queue, [])
                pending.append(member)
                batch = take_batch(context.job.queue) if len(pending) >= max_size else []
                first_arrived_at = pending[0].arrived_at if pending else member.arrived_at
            if batch:
                dispatch(batch)
            elif linger_ms == 0:
                with pending_lock:
                    batch = take_batch(context.job.queue)
                if batch:
                    dispatch(batch)
            else:
                remaining = max(0.0, first_arrived_at + linger_ms / 1000 - monotonic())
                try:
                    return member.result.result(timeout=remaining)
                except FutureTimeoutError:
                    with pending_lock:
                        batch = take_batch(context.job.queue)
                    if batch:
                        dispatch(batch)
            return member.result.result()

        self._handlers[type] = batch_member_handler
        emit_log(
            "DEBUG",
            "workhorse.handler.registered",
            "Batch job handler registered",
            {
                "workhorse.job.type": type,
                "workhorse.handler.batch.max_size": max_size,
                "workhorse.handler.batch.linger_ms": linger_ms,
                "workhorse.worker.id": self.worker_id,
            },
        )
        return self

    def run_once(self) -> bool:
        """Fill available slots until one empty queue sweep, then drain the claimed jobs."""
        requested_stop_version = self._stop_version_snapshot()
        with self._execution_lock:
            return self._run_loop(
                continuous=False,
                requested_stop_version=requested_stop_version,
            )

    def run(self) -> None:
        """Run until stopped, then return after every claimed job has settled."""
        requested_stop_version = self._stop_version_snapshot()
        self._run_continuously(requested_stop_version)

    def _run_continuously(self, requested_stop_version: int) -> None:
        with self._execution_lock:
            self._run_loop(
                continuous=True,
                requested_stop_version=requested_stop_version,
            )

    def pause(self) -> None:
        """Stop new claims without interrupting running handlers."""
        with self._state_lock:
            self._locally_paused = True
        emit_log(
            "INFO",
            "workhorse.worker.paused",
            "Worker paused locally",
            {"workhorse.worker.id": self.worker_id, "workhorse.worker.queues": self.queues},
        )
        self._wake.set()

    def resume(self) -> None:
        """Allow claims and wake an idle run loop immediately."""
        with self._state_lock:
            self._locally_paused = False
        emit_log(
            "INFO",
            "workhorse.worker.resumed",
            "Worker resumed locally",
            {"workhorse.worker.id": self.worker_id, "workhorse.worker.queues": self.queues},
        )
        self._wake.set()

    def is_paused(self) -> bool:
        with self._state_lock:
            return self._locally_paused or self._remotely_paused

    def stop(self) -> None:
        """Request a graceful stop; the active run call performs the drain."""
        with self._state_lock:
            self._stop_version += 1
            self._stopping = True
            active_slots = len(self._active_threads)
        emit_log(
            "INFO",
            "workhorse.worker.stop_requested",
            "Worker stop requested",
            {
                "workhorse.worker.id": self.worker_id,
                "workhorse.worker.active_slots": active_slots,
                "workhorse.worker.queues": self.queues,
            },
        )
        self._wake.set()

    def _stop_version_snapshot(self) -> int:
        with self._state_lock:
            return self._stop_version

    def _wake_dispatcher(self) -> None:
        self._wake.set()

    def _dispatch_state(self) -> Literal["stopping", "paused", "full", "ready"]:
        with self._state_lock:
            if self._stopping:
                return "stopping"
            if self._locally_paused or self._remotely_paused:
                return "paused"
            if len(self._active_threads) >= self.concurrency:
                return "full"
            return "ready"

    def _run_loop(self, *, continuous: bool, requested_stop_version: int) -> bool:
        self._compatibility.assert_compatible()
        self._instance_id = str(uuid4())
        self._registered = False
        with self._state_lock:
            self._stopping = self._stop_version != requested_stop_version
            self._run_errors.clear()
        claimed_any = False
        listener = self._start_notification_listener() if continuous else None
        self._refresh_registration(force=True)
        emit_log(
            "INFO",
            "workhorse.worker.started",
            "Worker started",
            {
                "workhorse.worker.id": self.worker_id,
                "workhorse.worker.concurrency": self.concurrency,
                "workhorse.worker.queues": self.queues,
            },
        )
        try:
            while True:
                # Clear before the sweep. A completion or state change that arrives while a claim
                # is in flight remains latched and prevents the following wait from sleeping.
                self._wake.clear()
                self._refresh_registration()
                state = self._dispatch_state()
                if state == "stopping":
                    break
                if state == "paused":
                    if not continuous:
                        break
                    self._wake.wait(self._dispatch_wait_seconds(listener))
                    continue
                if state == "full":
                    self._wake.wait(self._dispatch_wait_seconds(listener))
                    continue

                maintenance_was_due = self._run_maintenance_if_due()
                if not maintenance_was_due:
                    _require_lifecycle_row(self._executor.rows(STATEMENTS.promote, (100,)))
                    self._recover_expired()
                empty_attempts = 0
                while empty_attempts < len(self.queues):
                    if self._dispatch_state() != "ready":
                        break
                    with self._state_lock:
                        queue_name = self.queues[self._next_queue_index]
                        self._next_queue_index = (self._next_queue_index + 1) % len(self.queues)
                    claim_started_at = monotonic()
                    with start_span(
                        "workhorse.claim",
                        {"workhorse.queue.name": queue_name},
                    ) as claim_span:
                        rows = self._executor.rows(
                            STATEMENTS.claim,
                            (queue_name, self.worker_id, self.lease_ms),
                        )
                        job = _claimed_job(rows[0], queue_name) if rows else None
                        record_claim(
                            queue_name,
                            (monotonic() - claim_started_at) * 1_000,
                            job,
                        )
                        if job is not None:
                            for key, value in job_span_attributes(job).items():
                                claim_span.set_attribute(key, value)
                    if not rows:
                        empty_attempts += 1
                        continue
                    empty_attempts = 0
                    claimed_any = True
                    assert job is not None
                    emit_log(
                        "DEBUG",
                        "workhorse.job.claimed",
                        "Job claimed",
                        {
                            **job_span_attributes(job),
                            "workhorse.queue.name": queue_name,
                            "workhorse.worker.id": self.worker_id,
                        },
                    )
                    self._start_claimed_job(job)

                state = self._dispatch_state()
                if state == "stopping":
                    break
                if state == "paused":
                    continue
                if empty_attempts >= len(self.queues):
                    if not continuous:
                        break
                    self._wake.wait(self._dispatch_wait_seconds(listener))
                    continue
                if state == "full":
                    self._wake.wait(self._dispatch_wait_seconds(listener))
        finally:
            if listener is not None:
                listener.close()
            self._refresh_registration(force=True, draining=True)
            self._drain_active_threads()
            self._deregister()
            with self._state_lock:
                self._stopping = False
                errors = list(self._run_errors)
                self._run_errors.clear()
                active_slots = len(self._active_threads)
            emit_log(
                "INFO",
                "workhorse.worker.stopped",
                "Worker stopped",
                {
                    "workhorse.worker.id": self.worker_id,
                    "workhorse.worker.active_slots": active_slots,
                    "workhorse.worker.queues": self.queues,
                },
            )
        if errors:
            raise errors[0]
        return claimed_any

    def _run_maintenance_if_due(self) -> bool:
        now_monotonic = monotonic()
        if now_monotonic - self._last_maintenance_at < self.maintenance_interval_ms / 1000:
            return False
        with (
            start_span(
                "workhorse.maintenance",
                {"workhorse.maintenance.operation": "tick"},
            ) as maintenance_span,
            start_span("workhorse.recovery", {}) as recovery_span,
        ):
            tick = self._executor.rows(STATEMENTS.tick, (100, 100))
            total_rows = 0
            for row in tick:
                phase = str(row["phase"])
                rows_affected = int(cast(int, row["rows_affected"]))
                duration_ms = float(cast(int | float, row["duration_ms"]))
                skipped_lock = row["skipped_lock"] is True
                has_error = row["error"] is not None
                total_rows += rows_affected
                record_maintenance(
                    phase,
                    rows_affected,
                    duration_ms,
                    skipped_lock,
                    has_error,
                )
                if phase == "recover":
                    recovery_span.set_attribute("workhorse.recovery.skipped", skipped_lock)
                    if not skipped_lock and not has_error:
                        expired_leases = int(cast(int, row["expired_leases"]))
                        retried = int(cast(int, row["retried"]))
                        recovery_span.set_attribute(
                            "workhorse.recovery.rows_affected", rows_affected
                        )
                        recovery_span.set_attribute(
                            "workhorse.recovery.expired_leases", expired_leases
                        )
                        recovery_span.set_attribute("workhorse.recovery.retried", retried)
                        record_recovery(
                            expired_leases,
                            retried,
                            row["retry_dimensions"],
                        )
                    if rows_affected > 0:
                        emit_log(
                            "INFO",
                            "workhorse.leases.recovered",
                            "Expired leases recovered",
                            {
                                "workhorse.recovery.rows_affected": rows_affected,
                                "workhorse.recovery.expired_leases": int(
                                    cast(int, row["expired_leases"])
                                ),
                                "workhorse.recovery.retried": int(cast(int, row["retried"])),
                            },
                        )
                if rows_affected > 0 or has_error:
                    attributes: dict[str, str | bool | int | float] = {
                        "workhorse.maintenance.operation": "tick",
                        "workhorse.maintenance.phase": phase,
                        "workhorse.maintenance.rows_affected": rows_affected,
                        "workhorse.maintenance.skipped_lock": skipped_lock,
                    }
                    if has_error:
                        attributes["error.type"] = "PostgreSQLError"
                    emit_log(
                        "INFO",
                        "workhorse.maintenance.completed",
                        "Maintenance phase completed",
                        attributes,
                    )
            slow_maintenance = self._executor.rows(
                STATEMENTS.run_maintenance, (datetime.now(timezone.utc),)
            )
            for row in slow_maintenance:
                phase = str(row["phase"])
                rows_affected = int(cast(int, row["rows_affected"]))
                duration_ms = float(cast(int | float, row["duration_ms"]))
                skipped_lock = row["skipped_lock"] is True
                has_error = row["error"] is not None
                total_rows += rows_affected
                record_maintenance(
                    phase,
                    rows_affected,
                    duration_ms,
                    skipped_lock,
                    has_error,
                )
            maintenance_span.set_attribute("workhorse.maintenance.rows_affected", total_rows)
        self._last_maintenance_at = now_monotonic
        owns_tick = bool(tick) and all(row["skipped_lock"] is not True for row in tick)
        if not owns_tick or not self.schedule_namespaces:
            return True
        now = datetime.now(timezone.utc)
        fired_occurrences = self._executor.rows(
            STATEMENTS.fire_due_schedules,
            (list(self.schedule_namespaces), now, self.schedule_catchup_limit),
        )
        for fired in fired_occurrences:
            occurrence = cast(datetime, fired["occurrence_at"])
            job_id = fired["job_id"]
            schedule_attributes = {
                "workhorse.schedule.namespace": str(fired["namespace"]),
                "workhorse.schedule.name": str(fired["schedule_name"]),
            }
            if job_id is None:
                emit_log(
                    "DEBUG",
                    "workhorse.schedule.fire_replayed",
                    "Recurring schedule occurrence replayed",
                    schedule_attributes,
                )
            else:
                record_schedule_fired(
                    str(fired["namespace"]),
                    str(fired["schedule_name"]),
                    (now - occurrence).total_seconds(),
                )
                emit_log(
                    "INFO",
                    "workhorse.schedule.fired",
                    "Recurring schedule fired",
                    {**schedule_attributes, "workhorse.job.id": str(job_id)},
                )
        return True

    def _refresh_registration(self, *, force: bool = False, draining: bool = False) -> None:
        if self.registry_interval_ms == 0:
            return
        now = monotonic()
        if not force and now - self._last_registry_refresh_at < self.registry_interval_ms / 1_000:
            return
        self._last_registry_refresh_at = now
        with self._state_lock:
            active_slots = len(self._active_threads)
        try:
            row = _require_lifecycle_row(
                self._executor.rows(
                    STATEMENTS.register_worker,
                    (
                        self.worker_id,
                        self._instance_id,
                        socket.gethostname() or "python-worker",
                        os.getpid(),
                        list(self.queues),
                        self.concurrency,
                        self.lease_ms,
                        self.heartbeat_ms,
                        self.poll_ms,
                        self.maintenance_interval_ms,
                        self.maintenance_interval_ms,
                        self.registry_interval_ms,
                        active_slots,
                        draining,
                    ),
                )
            )
            paused = row["paused"] is True
        except Exception as error:
            emit_log(
                "INFO",
                "workhorse.worker.registration_failed",
                "Worker registration failed",
                {
                    "workhorse.worker.id": self.worker_id,
                    "error.type": error.__class__.__name__,
                },
            )
            if self._on_registration_error is not None:
                self._on_registration_error(error)
            return
        with self._state_lock:
            changed = self._remotely_paused != paused
            self._remotely_paused = paused
            self._registered = True
        emit_log(
            "DEBUG",
            "workhorse.worker.registered",
            "Worker registration refreshed",
            {
                "workhorse.worker.id": self.worker_id,
                "workhorse.worker.active_slots": active_slots,
                "workhorse.worker.draining": draining,
                "workhorse.worker.paused": paused,
            },
        )
        if changed:
            emit_log(
                "INFO",
                "workhorse.worker.paused" if paused else "workhorse.worker.resumed",
                "Worker paused remotely" if paused else "Worker resumed remotely",
                {"workhorse.worker.id": self.worker_id},
            )
            self._wake.set()

    def _deregister(self) -> None:
        if not self._registered:
            return
        self._registered = False
        with suppress(Exception):
            self._executor.rows(STATEMENTS.deregister_worker, (self.worker_id,))

    def _recover_expired(self) -> None:
        with start_span("workhorse.recovery", {}) as recovery_span:
            recovery = _require_lifecycle_row(
                self._executor.rows(STATEMENTS.recover_expired, (100, None))
            )
            rows_affected = int(cast(int, recovery["rows_affected"]))
            expired_leases = int(cast(int, recovery["expired_leases"]))
            retried = int(cast(int, recovery["retried"]))
            recovery_span.set_attribute("workhorse.recovery.rows_affected", rows_affected)
            recovery_span.set_attribute("workhorse.recovery.expired_leases", expired_leases)
            recovery_span.set_attribute("workhorse.recovery.retried", retried)
            record_recovery(expired_leases, retried, recovery["retry_dimensions"])
            if rows_affected > 0:
                emit_log(
                    "INFO",
                    "workhorse.leases.recovered",
                    "Expired leases recovered",
                    {
                        "workhorse.recovery.rows_affected": rows_affected,
                        "workhorse.recovery.expired_leases": expired_leases,
                        "workhorse.recovery.retried": retried,
                    },
                )

    def _dispatch_wait_seconds(self, listener: JobNotificationListener | None) -> float:
        wait_ms = (
            self._notification_poll_ms
            if listener is not None and listener.is_listening()
            else self.poll_ms
        )
        if self.registry_interval_ms > 0:
            wait_ms = min(wait_ms, self.registry_interval_ms)
        return wait_ms / 1000

    def _start_notification_listener(self) -> JobNotificationListener | None:
        if self._notification_connection_factory is None:
            return None
        listener = JobNotificationListener(
            self._notification_connection_factory,
            self.queues,
            self._wake.set,
            self._on_notification_error,
            self._query_connection,
        )
        listener.start()
        return listener

    def _start_claimed_job(self, job: ClaimedJob) -> None:
        thread = Thread(
            target=self._run_claimed_job,
            args=(job,),
            name=f"workhorse-handler-{job.id}",
        )
        with self._state_lock:
            self._active_threads.add(thread)
        thread.start()

    def _run_claimed_job(self, job: ClaimedJob) -> None:
        try:
            self._execute_claimed_job(job)
        except BaseException as error:
            with self._state_lock:
                self._run_errors.append(error)
                self._stopping = True
        finally:
            with self._state_lock:
                self._active_threads.discard(current_thread())
            self._wake.set()

    def _drain_active_threads(self) -> None:
        while True:
            with self._state_lock:
                active = list(self._active_threads)
            if not active:
                return
            for thread in active:
                thread.join()

    def _execute_claimed_job(self, job: ClaimedJob) -> None:
        arbiter = _AttemptOutcomeArbiter()
        span_outcome = {"value": "unknown"}
        span_errors: list[str] = []
        started_at = monotonic()
        attributes = {"workhorse.queue.name": job.queue, **job_span_attributes(job)}
        with start_span(
            "workhorse.handler",
            attributes,
            trace_context=job.trace_context,
            consumer=True,
        ) as handler_span:
            emit_log(
                "DEBUG",
                "workhorse.handler.started",
                "Job handler started",
                {**attributes, "workhorse.worker.id": self.worker_id},
            )
            try:
                self._execute_claimed_job_within_span(job, arbiter, span_outcome, span_errors)
            except BaseException as error:
                record_span_error(handler_span, error.__class__.__name__)
                raise
            finally:
                duration_ms = (monotonic() - started_at) * 1_000
                outcome = _telemetry_outcome(arbiter.outcome)
                handler_span.set_attribute(
                    "workhorse.handler.outcome",
                    span_outcome["value"]
                    if span_outcome["value"] != "unknown"
                    else _handler_span_outcome(arbiter.outcome),
                )
                if span_errors:
                    record_span_error(handler_span, span_errors[0])
                record_handler_execution(job, outcome, duration_ms)
                emit_log(
                    "DEBUG",
                    "workhorse.handler.finished",
                    "Job handler finished",
                    {
                        **attributes,
                        "workhorse.worker.id": self.worker_id,
                        "workhorse.handler.duration_ms": duration_ms,
                    },
                )
                emit_log(
                    "INFO",
                    "workhorse.job.execution_finished",
                    "Job execution finished",
                    {
                        **attributes,
                        "workhorse.worker.id": self.worker_id,
                        "workhorse.handler.outcome": outcome,
                    },
                )

    def _execute_claimed_job_within_span(
        self,
        job: ClaimedJob,
        arbiter: _AttemptOutcomeArbiter,
        span_outcome: dict[str, str],
        span_errors: list[str],
    ) -> None:
        handler = self._handlers.get(job.type)
        if handler is None:
            error = RuntimeError(f"No handler registered for {job.type}")
            failure_outcome, failure_state = self._settle_failure(job, error)
            span_outcome["value"] = failure_state
            span_errors.append(
                _REDACTED_ERROR_NAME if job.redact_error_details else type(error).__name__
            )
            arbiter.submit(failure_outcome)
            return
        heartbeat_stop = Event()
        heartbeat_error: list[BaseException] = []
        cancellation = CancellationToken()
        handler_parent_context = current_context()

        def deliver_status(status: object) -> bool:
            outcome = _outcome_for_status(status, neutral=frozenset({"accepted"}))
            if outcome is None:
                return False
            arbiter.submit(outcome)
            if outcome == "cancelled":
                cancellation._cancel(CancellationRequestedError(job.id))
            elif outcome == "deadline_exceeded":
                cancellation._cancel(DeadlineExceededError(job.id))
            elif outcome == "attempt_timeout":
                cancellation._cancel(ExecutionTimeoutError(job.id, job.attempt))
            else:
                cancellation._cancel(StaleLeaseError(job.id))
            return True

        def heartbeat() -> None:
            next_heartbeat_at = monotonic() + self.heartbeat_ms / 1000
            expiration_at = _earliest_expiration(job)
            expiration_retry_at: float | None = None
            while True:
                now = monotonic()
                heartbeat_delay = max(0.0, next_heartbeat_at - now)
                expiration_delay = _expiration_delay(expiration_at, expiration_retry_at)
                wait_seconds = (
                    heartbeat_delay
                    if expiration_delay is None
                    else min(heartbeat_delay, expiration_delay)
                )
                if heartbeat_stop.wait(wait_seconds):
                    return
                try:
                    expiration_is_due = expiration_delay is not None and expiration_delay <= 0
                    if expiration_is_due:
                        expiration = _require_lifecycle_row(
                            self._executor.rows(
                                STATEMENTS.expire_owned,
                                (job.id, self.worker_id, job.fence_token),
                            )
                        )
                        status = expiration["status"]
                        if status == "not_due":
                            expiration_retry_at = monotonic() + 0.005
                            continue
                        retry_state = expiration["retry_state"]
                        if retry_state is not None:
                            with start_span(
                                "workhorse.retry",
                                job_span_attributes(job),
                                parent_context=handler_parent_context,
                            ) as retry_span:
                                retry_span.set_attribute(
                                    "workhorse.retry.outcome", str(retry_state)
                                )
                                record_retry(job)
                        emit_log(
                            "INFO",
                            "workhorse.job.ownership_expired",
                            "Owned job lease expired",
                            {
                                **job_span_attributes(job),
                                "workhorse.expiration.status": str(status),
                                "workhorse.worker.id": self.worker_id,
                            },
                        )
                        deliver_status(status)
                        return
                    with start_span(
                        "workhorse.heartbeat",
                        job_span_attributes(job),
                        parent_context=handler_parent_context,
                    ) as heartbeat_span:
                        status = _require_lifecycle_row(
                            self._executor.rows(
                                STATEMENTS.heartbeat,
                                (job.id, self.worker_id, job.fence_token, self.lease_ms),
                            )
                        )["status"]
                        status_text = str(status)
                        heartbeat_span.set_attribute("workhorse.heartbeat.status", status_text)
                        if status_text == "accepted":
                            emit_log(
                                "DEBUG",
                                "workhorse.job.heartbeat_accepted",
                                "Job heartbeat accepted",
                                {
                                    **job_span_attributes(job),
                                    "workhorse.worker.id": self.worker_id,
                                },
                            )
                        else:
                            record_heartbeat_failure(status_text)
                            emit_log(
                                "INFO",
                                "workhorse.job.heartbeat_rejected",
                                "Job heartbeat rejected",
                                {
                                    **job_span_attributes(job),
                                    "workhorse.heartbeat.status": status_text,
                                    "workhorse.worker.id": self.worker_id,
                                },
                            )
                    if deliver_status(status):
                        return
                    next_heartbeat_at = monotonic() + self.heartbeat_ms / 1000
                except BaseException as error:
                    heartbeat_error.append(error)
                    cancellation._cancel(error)
                    return

        heartbeat_thread = Thread(target=heartbeat, name=f"workhorse-heartbeat-{job.id}")
        heartbeat_thread.start()
        durability = _HandlerDurability(
            self._executor,
            job,
            self.worker_id,
            cancellation,
            arbiter,
        )

        def finish_ownership_lifecycle(cause: Exception | None = None) -> bool:
            heartbeat_stop.set()
            heartbeat_thread.join()
            if self._finish_lifecycle_outcome(job, arbiter.outcome):
                return True
            if heartbeat_error:
                if cause is None:
                    raise heartbeat_error[0]
                raise heartbeat_error[0] from cause
            return False

        try:
            result = handler(job.payload, durability.context())
            self._validate_result_contract(job, result)
            encoded_result = json.dumps(result, separators=(",", ":"))
        except _DurableWaitSuspension:
            if finish_ownership_lifecycle():
                return
            raise RuntimeError("Durable wait suspension was not accepted by the arbiter") from None
        except Exception as error:
            if finish_ownership_lifecycle(error):
                return
            failure_outcome, failure_state = self._settle_failure(job, error)
            span_outcome["value"] = failure_state
            span_errors.append(
                _REDACTED_ERROR_NAME if job.redact_error_details else type(error).__name__
            )
            arbiter.submit(failure_outcome)
            return
        if finish_ownership_lifecycle():
            if arbiter.outcome in {"suspended_for_wait", "suspended_for_child"}:
                emit_log(
                    "WARN",
                    "workhorse.handler.signal_swallowed",
                    "Job handler swallowed its suspension signal",
                    {
                        **job_span_attributes(job),
                        "workhorse.queue.name": job.queue,
                        "workhorse.worker.id": self.worker_id,
                        "workhorse.handler.outcome": "suspended",
                    },
                )
            return
        with start_span("workhorse.complete", job_span_attributes(job)) as completion_span:
            accepted = _require_lifecycle_row(
                self._executor.rows(
                    STATEMENTS.complete,
                    (job.id, self.worker_id, job.fence_token, encoded_result),
                )
            )["accepted"]
            completion_span.set_attribute("workhorse.complete.accepted", accepted is True)
            emit_log(
                "INFO",
                "workhorse.job.completed"
                if accepted is True
                else "workhorse.job.completion_rejected",
                "Job completed" if accepted is True else "Stale job completion rejected",
                {
                    **job_span_attributes(job),
                    "workhorse.complete.accepted": accepted is True,
                    "workhorse.worker.id": self.worker_id,
                },
            )
        if accepted is not True:
            if self._acknowledge_cancel(job):
                arbiter.submit("cancelled")
                return
            arbiter.submit("lease_expired")
            raise StaleLeaseError(job.id)
        record_completion(job)
        arbiter.submit("completed")

    def _finish_lifecycle_outcome(self, job: ClaimedJob, outcome: AttemptOutcome | None) -> bool:
        if outcome in {"suspended_for_wait", "suspended_for_child"}:
            return True
        if outcome == "cancelled":
            if not self._acknowledge_cancel(job):
                raise StaleLeaseError(job.id)
            return True
        if outcome in {"deadline_exceeded", "attempt_timeout"}:
            return True
        if outcome == "lease_expired":
            raise StaleLeaseError(job.id)
        return False

    def _acknowledge_cancel(self, job: ClaimedJob) -> bool:
        accepted = (
            _require_lifecycle_row(
                self._executor.rows(
                    STATEMENTS.acknowledge_cancel,
                    (job.id, self.worker_id, job.fence_token),
                )
            )["accepted"]
            is True
        )
        emit_log(
            "INFO",
            "workhorse.job.cancellation_acknowledged",
            "Job cancellation acknowledged",
            {
                **job_span_attributes(job),
                "workhorse.cancel.accepted": accepted,
                "workhorse.worker.id": self.worker_id,
            },
        )
        return accepted

    def _settle_failure(self, job: ClaimedJob, error: Exception) -> tuple[AttemptOutcome, str]:
        envelope = _error_envelope(error, job.redact_error_details)
        with start_span("workhorse.retry", job_span_attributes(job)) as retry_span:
            state = _require_lifecycle_row(
                self._executor.rows(
                    STATEMENTS.fail,
                    (job.id, self.worker_id, job.fence_token, json.dumps(envelope), None),
                )
            )["state"]
            state_text = str(state)
            retry_span.set_attribute("workhorse.retry.outcome", state_text)
            record_failure(job, state_text)
            emit_log(
                "INFO",
                "workhorse.job.failure_processed",
                "Job attempt failure processed",
                {
                    **job_span_attributes(job),
                    "workhorse.attempt.outcome": state_text,
                    "workhorse.worker.id": self.worker_id,
                },
            )
        if state in {"ready", "scheduled"}:
            return "retry", state_text
        outcome = _outcome_for_status(
            state,
            neutral=frozenset({"ready", "scheduled", "failed"}),
        )
        if outcome is None:
            return "failed", state_text
        if outcome == "cancelled":
            if not self._acknowledge_cancel(job):
                raise StaleLeaseError(job.id) from error
            return "cancelled", state_text
        if outcome == "lease_expired":
            raise StaleLeaseError(job.id) from error
        return outcome, state_text


def _claimed_job(row: Row, queue: str) -> ClaimedJob:
    return ClaimedJob(
        id=str(row["job_id"]),
        queue=queue,
        type=str(row["job_type"]),
        priority=int(cast(int, row["priority"])),
        payload=cast(Json, row["payload"]),
        contract_version=cast(str | None, row["contract_version"]),
        result_max_bytes=int(cast(int, row["result_max_bytes"])),
        redact_error_details=row["redact_error_details"] is True,
        trace_context=cast(Json, row["trace_context"]),
        attempt=int(cast(int, row["attempt"])),
        max_attempts=int(cast(int, row["max_attempts"])),
        retry_policy=cast(dict[str, Json] | None, row["retry_policy"]),
        deadline_at=cast(Any, row["deadline_at"]),
        execution_timeout_ms=(
            None
            if row["execution_timeout_ms"] is None
            else int(cast(int, row["execution_timeout_ms"]))
        ),
        attempt_timeout_at=cast(Any, row["attempt_timeout_at"]),
        fence_token=int(cast(int, row["fence_token"])),
        lease_expires_at=cast(Any, row["lease_expires_at"]),
    )


def _validate_batch_outcomes(
    type: str,
    outcomes: object,
    expected: int,
) -> list[BatchHandlerOutcome]:
    if isinstance(outcomes, (str, bytes)) or not isinstance(outcomes, Sequence):
        raise RuntimeError(f"Batch handler for {type} returned a non-sequence outcome value")
    if len(outcomes) != expected:
        raise RuntimeError(
            f"Batch handler for {type} returned {len(outcomes)} outcomes for {expected} jobs"
        )
    validated: list[BatchHandlerOutcome] = []
    for index, outcome in enumerate(outcomes):
        if not isinstance(outcome, Mapping):
            raise RuntimeError(
                f"Batch handler for {type} returned an invalid outcome at index {index}"
            )
        if outcome.get("status") == "succeeded" and "result" in outcome:
            validated.append(cast(BatchHandlerOutcome, outcome))
            continue
        if (
            outcome.get("status") == "failed"
            and "error" in outcome
            and isinstance(outcome["error"], Exception)
        ):
            validated.append(cast(BatchHandlerOutcome, outcome))
            continue
        raise RuntimeError(f"Batch handler for {type} returned an invalid outcome at index {index}")
    return validated


def _checkpoint_record(job_id: str, row: Row, *, name: str | None = None) -> JobCheckpoint:
    return JobCheckpoint(
        job_id=job_id,
        name=name or str(row["checkpoint_name"]),
        value=cast(Json, row["checkpoint_value"]),
        attempt=int(cast(int, row["attempt"])),
        fence_token=int(cast(int, row["fence_token"])),
        worker_id=str(row["worker_id"]),
        created_at=cast(datetime, row["created_at"]),
    )


def _progress_record(job_id: str, row: Row) -> JobProgress:
    return JobProgress(
        job_id=job_id,
        value=cast(Json, row["progress_value"]),
        revision=int(cast(int | str, row["revision"])),
        attempt=int(cast(int, row["attempt"])),
        fence_token=int(cast(int | str, row["fence_token"])),
        worker_id=str(row["worker_id"]),
        created_at=cast(datetime, row["created_at"]),
        updated_at=cast(datetime, row["updated_at"]),
    )


def _wait_record(job_id: str, row: Row, *, name: str | None = None) -> JobWait:
    mode = str(row["mode"])
    if mode not in {"relative", "absolute"}:
        raise RuntimeError(f"Unexpected durable wait mode: {mode}")
    return JobWait(
        job_id=job_id,
        name=name or str(row["wait_name"]),
        mode=cast(Literal["relative", "absolute"], mode),
        duration_ms=(
            None if row["duration_ms"] is None else int(cast(int | str, row["duration_ms"]))
        ),
        requested_wake_at=cast(datetime | None, row["requested_wake_at"]),
        wake_at=cast(datetime, row["wake_at"]),
        attempt=int(cast(int, row["attempt"])),
        fence_token=int(cast(int | str, row["fence_token"])),
        worker_id=str(row["worker_id"]),
        created_at=cast(datetime, row["created_at"]),
    )


def _require_lifecycle_row(rows: list[Row]) -> Row:
    if len(rows) != 1:
        raise RuntimeError("PostgreSQL lifecycle transition did not return exactly one row")
    return rows[0]


def _outcome_for_status(status: object, *, neutral: frozenset[str]) -> AttemptOutcome | None:
    if not isinstance(status, str):
        raise RuntimeError("PostgreSQL returned a non-string lifecycle status")
    if status in neutral:
        return None
    try:
        return _STATUS_OUTCOMES[status]
    except KeyError as error:
        raise RuntimeError(f"PostgreSQL returned unknown lifecycle status {status!r}") from error


def _telemetry_outcome(
    outcome: AttemptOutcome | None,
) -> JobExecutionOutcome:
    outcomes: dict[AttemptOutcome | None, JobExecutionOutcome] = {
        "completed": "succeeded",
        "failed": "failed",
        "retry": "retry",
        "lease_expired": "lease_lost",
        "deadline_exceeded": "deadline_exceeded",
        "attempt_timeout": "timeout",
        "cancelled": "canceled",
        "suspended_for_wait": "suspended",
        "suspended_for_child": "suspended",
        None: "unknown",
    }
    return outcomes[outcome]


def _handler_span_outcome(outcome: AttemptOutcome | None) -> str:
    outcomes: dict[AttemptOutcome | None, str] = {
        "completed": "succeeded",
        "failed": "failed",
        "retry": "retry",
        "lease_expired": "stale",
        "deadline_exceeded": "deadline_exceeded",
        "attempt_timeout": "timeout_exceeded",
        "cancelled": "canceled",
        "suspended_for_wait": "suspended",
        "suspended_for_child": "suspended",
        None: "unknown",
    }
    return outcomes[outcome]


def _earliest_expiration(job: ClaimedJob) -> datetime | None:
    candidates = [value for value in (job.deadline_at, job.attempt_timeout_at) if value is not None]
    return min(candidates) if candidates else None


def _expiration_delay(expiration_at: datetime | None, retry_at: float | None) -> float | None:
    if retry_at is not None:
        return retry_at - monotonic()
    if expiration_at is None:
        return None
    return (expiration_at - datetime.now(timezone.utc)).total_seconds()


def _error_envelope(error: Exception, redact_details: bool) -> Json:
    if redact_details:
        return {"name": _REDACTED_ERROR_NAME, "message": _REDACTED_ERROR_MESSAGE}
    return {
        "name": type(error).__name__,
        "message": str(error),
        "stack": "".join(traceback.format_exception(error)),
    }


def _default_worker_id() -> str:
    return f"{socket.gethostname()}-{os.getpid()}-{uuid4().hex[:8]}"
