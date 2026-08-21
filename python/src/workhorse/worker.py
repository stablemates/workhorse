from __future__ import annotations

import json
import os
import socket
import traceback
from collections.abc import Callable, Mapping, Sequence
from concurrent.futures import Future
from concurrent.futures import TimeoutError as FutureTimeoutError
from dataclasses import dataclass
from datetime import datetime, timezone
from threading import Event, Lock, Thread, current_thread
from time import monotonic
from typing import TYPE_CHECKING, Any, Literal, cast
from uuid import uuid4

from ._compatibility import CachedCompatibilityCheck
from ._drivers import PsycopgConnection, Row, SyncExecutor
from ._external_waits import encode_wait_value, validate_wait_name, validate_wait_timeout
from ._notifications import (
    JobNotificationListener,
    NotificationConnectionFactory,
)
from ._protocol import serialize_child_request
from ._statements import STATEMENTS, DriverStatement
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
        executor: SyncExecutor,
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
        notification_connection_factory: NotificationConnectionFactory | None = None,
        on_notification_error: Callable[[BaseException], None] | None = None,
    ) -> None:
        if getattr(connection, "autocommit", False) is not True:
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
        self._executor = SyncExecutor(cast(PsycopgConnection, connection))
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
        if not 100 <= lease_ms <= 86_400_000:
            raise ValueError("lease_ms must be between 100 and 86400000")
        self.lease_ms = lease_ms
        self.heartbeat_ms = heartbeat_ms if heartbeat_ms is not None else max(100, lease_ms // 3)
        if not 0 < self.heartbeat_ms < self.lease_ms:
            raise ValueError("heartbeat_ms must be positive and less than lease_ms")
        self._next_queue_index = 0
        self._state_lock = Lock()
        self._execution_lock = Lock()
        self._wake = Event()
        self._active_threads: set[Thread] = set()
        self._run_errors: list[BaseException] = []
        self._paused = False
        self._stopping = False
        self._stop_version = 0

    def handle(self, type: str, handler: Handler) -> Worker:
        self._handlers[type] = handler
        return self

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
            except Exception:
                return

        def dispatch(batch: Sequence[_PendingBatchMember]) -> None:
            batch_id = str(uuid4())
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
            self._paused = True
        self._wake.set()

    def resume(self) -> None:
        """Allow claims and wake an idle run loop immediately."""
        with self._state_lock:
            self._paused = False
        self._wake.set()

    def is_paused(self) -> bool:
        with self._state_lock:
            return self._paused

    def stop(self) -> None:
        """Request a graceful stop; the active run call performs the drain."""
        with self._state_lock:
            self._stop_version += 1
            self._stopping = True
        self._wake.set()

    def _stop_version_snapshot(self) -> int:
        with self._state_lock:
            return self._stop_version

    def _dispatch_state(self) -> Literal["stopping", "paused", "full", "ready"]:
        with self._state_lock:
            if self._stopping:
                return "stopping"
            if self._paused:
                return "paused"
            if len(self._active_threads) >= self.concurrency:
                return "full"
            return "ready"

    def _run_loop(self, *, continuous: bool, requested_stop_version: int) -> bool:
        self._compatibility.assert_compatible()
        with self._state_lock:
            self._stopping = self._stop_version != requested_stop_version
            self._run_errors.clear()
        claimed_any = False
        listener = self._start_notification_listener() if continuous else None
        try:
            while True:
                # Clear before the sweep. A completion or state change that arrives while a claim
                # is in flight remains latched and prevents the following wait from sleeping.
                self._wake.clear()
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

                _require_lifecycle_row(self._executor.rows(STATEMENTS.promote, (100,)))
                _require_lifecycle_row(self._executor.rows(STATEMENTS.recover_expired, (100, None)))
                empty_attempts = 0
                while empty_attempts < len(self.queues):
                    if self._dispatch_state() != "ready":
                        break
                    with self._state_lock:
                        queue_name = self.queues[self._next_queue_index]
                        self._next_queue_index = (self._next_queue_index + 1) % len(self.queues)
                    rows = self._executor.rows(
                        STATEMENTS.claim,
                        (queue_name, self.worker_id, self.lease_ms),
                    )
                    if not rows:
                        empty_attempts += 1
                        continue
                    empty_attempts = 0
                    claimed_any = True
                    self._start_claimed_job(_claimed_job(rows[0], queue_name))

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
            self._drain_active_threads()
            with self._state_lock:
                self._stopping = False
                errors = list(self._run_errors)
                self._run_errors.clear()
        if errors:
            raise errors[0]
        return claimed_any

    def _dispatch_wait_seconds(self, listener: JobNotificationListener | None) -> float:
        wait_ms = (
            self._notification_poll_ms
            if listener is not None and listener.is_listening()
            else self.poll_ms
        )
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
        handler = self._handlers.get(job.type)
        if handler is None:
            error = RuntimeError(f"No handler registered for {job.type}")
            arbiter.submit(self._settle_failure(job, error))
            return
        heartbeat_stop = Event()
        heartbeat_error: list[BaseException] = []
        cancellation = CancellationToken()

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
                        status = _require_lifecycle_row(
                            self._executor.rows(
                                STATEMENTS.expire_owned,
                                (job.id, self.worker_id, job.fence_token),
                            )
                        )["status"]
                        if status == "not_due":
                            expiration_retry_at = monotonic() + 0.005
                            continue
                        deliver_status(status)
                        return
                    status = _require_lifecycle_row(
                        self._executor.rows(
                            STATEMENTS.heartbeat,
                            (job.id, self.worker_id, job.fence_token, self.lease_ms),
                        )
                    )["status"]
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
            encoded_result = json.dumps(result, separators=(",", ":"))
        except _DurableWaitSuspension:
            if finish_ownership_lifecycle():
                return
            raise RuntimeError("Durable wait suspension was not accepted by the arbiter") from None
        except Exception as error:
            if finish_ownership_lifecycle(error):
                return
            arbiter.submit(self._settle_failure(job, error))
            return
        if finish_ownership_lifecycle():
            return
        accepted = _require_lifecycle_row(
            self._executor.rows(
                STATEMENTS.complete,
                (job.id, self.worker_id, job.fence_token, encoded_result),
            )
        )["accepted"]
        if accepted is not True:
            if self._acknowledge_cancel(job):
                arbiter.submit("cancelled")
                return
            arbiter.submit("lease_expired")
            raise StaleLeaseError(job.id)
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
        return (
            _require_lifecycle_row(
                self._executor.rows(
                    STATEMENTS.acknowledge_cancel,
                    (job.id, self.worker_id, job.fence_token),
                )
            )["accepted"]
            is True
        )

    def _settle_failure(self, job: ClaimedJob, error: Exception) -> AttemptOutcome:
        envelope = _error_envelope(error, job.redact_error_details)
        state = _require_lifecycle_row(
            self._executor.rows(
                STATEMENTS.fail,
                (job.id, self.worker_id, job.fence_token, json.dumps(envelope), None),
            )
        )["state"]
        outcome = _outcome_for_status(
            state,
            neutral=frozenset({"ready", "scheduled", "failed"}),
        )
        if outcome is None:
            return "failed"
        if outcome == "cancelled":
            if not self._acknowledge_cancel(job):
                raise StaleLeaseError(job.id) from error
            return "cancelled"
        if outcome == "lease_expired":
            raise StaleLeaseError(job.id) from error
        return outcome


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
