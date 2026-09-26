from __future__ import annotations

import json
import os
import random
import socket
import traceback
from bisect import insort
from collections.abc import Callable, Mapping, Sequence
from concurrent.futures import Future, TimeoutError as FutureTimeoutError
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import UTC, datetime
from itertools import islice
from queue import SimpleQueue
from threading import Event, Lock, Thread, current_thread
from time import monotonic, sleep
from typing import TYPE_CHECKING, Any, Literal, cast
from uuid import uuid4

from ._compatibility import (
    CachedCompatibilityCheck as _CachedCompatibilityCheck,
    SyncRowExecutor as _SyncRowExecutor,
)
from ._contracts import compile_contract_schema as _compile_contract_schema
from ._drivers import (
    PooledSyncExecutor as _PooledSyncExecutor,
    PsycopgConnection as _PsycopgConnection,
    PsycopgPool as _PsycopgPool,
    Row as _Row,
    SyncExecutor as _SyncExecutor,
)
from ._external_waits import (
    encode_wait_value as _encode_wait_value,
    validate_wait_name as _validate_wait_name,
    validate_wait_timeout as _validate_wait_timeout,
)
from ._notifications import (
    NotificationConnectionFactory as _NotificationConnectionFactory,
    TaskNotificationListener as _TaskNotificationListener,
)
from ._protocol import serialize_child_request as _serialize_child_request
from ._statements import (
    PROTOCOL_VERSION as _PROTOCOL_VERSION,
    STATEMENTS as _STATEMENTS,
    DriverStatement as _DriverStatement,
)
from ._telemetry import (
    TaskExecutionOutcome as _TaskExecutionOutcome,
    current_context as _current_context,
    emit_log as _emit_log,
    record_batch as _record_batch_metrics,
    record_claim as _record_claim,
    record_completion as _record_completion,
    record_failure as _record_failure,
    record_handler_execution as _record_handler_execution,
    record_heartbeat_failure as _record_heartbeat_failure,
    record_maintenance as _record_maintenance,
    record_recovery as _record_recovery,
    record_retry as _record_retry,
    record_schedule_fired as _record_schedule_fired,
    record_span_error as _record_span_error,
    start_span as _start_span,
    task_span_attributes as _task_span_attributes,
)
from ._version import WORKHORSE_VERSION as _WORKHORSE_VERSION
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
    FastTierUnsupportedError,
    HumanWaitAlreadyWaitingError,
    HumanWaitConflictError,
    HumanWaitLeaseLostError,
    HumanWaitLimitExceededError,
    ProgressLeaseLostError,
    ProgressRateLimitError,
    SignalWaitConflictError,
    SignalWaitLeaseLostError,
    SignalWaitLimitExceededError,
    StaleLeaseError,
    TaskContractUnavailableError,
    TaskContractValidationError,
    WaitConflictError,
    WaitLeaseLostError,
    WaitLimitExceededError,
    _translate_database_error,
)
from .types import (
    BatchHandlerItem,
    BatchHandlerOutcome,
    CancellationToken,
    ChildOutcome,
    ChildTaskRequest,
    ClaimedTask,
    EnqueueOptions,
    HandlerContext,
    Json,
    TaskCheckpoint,
    TaskProgress,
    TaskWait,
)

if TYPE_CHECKING:
    import psycopg

    _SyncConnection = psycopg.Connection[Any]
else:
    _SyncConnection = _PsycopgConnection

# Opens the heartbeat executor and returns it with the callable that closes it.
_HeartbeatExecutorFactory = Callable[[], tuple[_SyncRowExecutor, Callable[[], None]]]

Handler = Callable[[Any, HandlerContext], Json]
BatchHandler = Callable[[Sequence[BatchHandlerItem]], Sequence[BatchHandlerOutcome]]


@dataclass
class _PendingBatchMember:
    arrival_order: int
    arrived_at: float
    item: BatchHandlerItem
    result: Future[Json]


def _batch_member_order(member: _PendingBatchMember) -> tuple[int, int]:
    """Rank one waiting member by descending task priority, then worker claim order."""
    return (-member.item.context.task.priority, member.arrival_order)


@dataclass(eq=False, slots=True)
class _HeartbeatMember:
    task: ClaimedTask
    deliver_status: Callable[[object], bool]
    # Moves the attempt's lease watchdog to the moment the accepting round's request was sent.
    renew: Callable[[float], None]
    cancellation: CancellationToken
    errors: list[BaseException]
    parent_context: object


# What this client library is, reported to the registry on every registration refresh. An operator
# reads it to decide whether any worker still speaks a protocol they are about to retire.
_SDK_LANGUAGE = "python"

_REDACTED_ERROR_NAME = "RedactedTaskError"
_REDACTED_ERROR_MESSAGE = "Task handler failed; details redacted"

# The ceiling the empty-claim backoff doubles toward. An idle worker waits at most this long before
# it claims again, so a task enqueued into a quiet queue is never delayed past it.
_MAX_EMPTY_POLL_MS = 5_000
_NOTIFICATION_CLAIM_DELAY_SECONDS = 0.05


def _dispatch_refill_batch(concurrency: int) -> int:
    """Free slots that let a second claim start while one is in flight (ADR 0076).

    A quarter of the concurrency, rounded up.
    """
    return -(-concurrency // 4)


def _dispatch_cohorts(concurrency: int, spare_connections: int | None = None) -> int:
    """Slot cohorts a worker without a cohorts option uses (ADR 0076, rule 11).

    With a known pool size, it keeps one pooled connection per cohort after the listener and the
    heartbeat connection take theirs.
    """
    cohorts = 1 if concurrency < 8 else min(8, max(2, -(-concurrency // 8)))
    return cohorts if spare_connections is None else max(1, min(cohorts, spare_connections))


# Completions and claimed tasks one batched statement carries at most. complete_many_and_claim_v1
# rejects longer arrays and a larger claim limit.
_COMPLETION_BATCH_LIMIT = 100


@dataclass(eq=False, slots=True)
class _DispatchSlots:
    """Slot accounting one run shares between its dispatch loop and its handler threads.

    Every field is read and written under the worker's state lock. A handler thread reserves slots
    for its completion's fused claim, so the loop's own claims cannot count them free.
    """

    concurrency: int
    refill_batch: int
    cohort_capacity: list[int]
    listener: _TaskNotificationListener | None
    cohort_active: list[int]
    cohort_handed_over: list[int]
    cohort_reserved: list[int]
    cohort_claims: list[int]
    # Plain claims in flight that reserve slots across every cohort.
    whole_claims: int = 0
    reserved: int = 0
    # Handler threads whose completion claimed a task into their slot, with their cohort. A handed
    # over slot counts free: the tasks the fused claim returned already hold it.
    handed_over: dict[Thread, int] = field(default_factory=dict)
    # The cohort of every handler thread this run started.
    thread_cohorts: dict[Thread, int] = field(default_factory=dict)
    # Set by a claim that found nothing to run: no claim starts until its deadline, or until a
    # dispatch wake newer than that claim's start.
    empty_wait: tuple[float, int] | None = None
    consecutive_empty_claims: int = 0
    claimed_any: bool = False
    # A single pass ends at its first claim that made no progress.
    pass_ended: bool = False
    claim_error: BaseException | None = None
    # Closed once the loop stops starting claims, so no completion claims for it either.
    open: bool = True

    def free_slots(self, active: int) -> int:
        return self.concurrency - active + len(self.handed_over) - self.reserved

    def cohort_free(self, cohort: int) -> int:
        return (
            self.cohort_capacity[cohort]
            - self.cohort_active[cohort]
            + self.cohort_handed_over[cohort]
            - self.cohort_reserved[cohort]
        )

    def roomiest_cohort(self) -> int:
        free = [self.cohort_free(cohort) for cohort in range(len(self.cohort_capacity))]
        return free.index(max(free))


@dataclass(eq=False, slots=True)
class _CompletionClaim:
    """Slots one fused completion claim reserved, or none when its limit is zero."""

    cohort: int
    limit: int
    wake_version: int


@dataclass(eq=False, slots=True)
class _PendingCompletion:
    """One fast-tier completion waiting for the batched statement of its queue and cohort."""

    task: ClaimedTask
    encoded_result: str
    limit: int
    done: Event
    # Set on the waiting completion that sends the next statement for its batch key.
    lead: bool = False
    accepted: bool = False
    claimed: list[tuple[ClaimedTask, float]] | None = None
    # The queue left the fast tier, so this completion goes through complete_v1 instead.
    full_tier: bool = False
    error: BaseException | None = None


@dataclass(frozen=True, slots=True)
class _ClaimOutcome:
    """What one dispatch claim leased, and the error that ended it early, if any."""

    claim_id: int
    limit: int
    # The dispatch wake version when the claim started. A later wake ends its empty-poll wait.
    wake_version: int
    # None when the worker stopped or paused during the notification delay, so no claim was sent.
    claimed: tuple[tuple[ClaimedTask, float], ...] | None
    error: BaseException | None = None


_AttemptOutcome = Literal[
    "completed",
    "failed",
    "retry",
    "lease_expired",
    "released",
    "deadline_exceeded",
    "attempt_timeout",
    "cancelled",
    "suspended_for_wait",
    "suspended_for_child",
]
_STATUS_OUTCOMES: dict[str, _AttemptOutcome] = {
    "cancel_requested": "cancelled",
    "deadline_exceeded": "deadline_exceeded",
    "timeout_exceeded": "attempt_timeout",
    "stale": "lease_expired",
}


class _AttemptOutcomeArbiter:
    def __init__(self) -> None:
        self._lock = Lock()
        self._outcome: _AttemptOutcome | None = None

    @property
    def outcome(self) -> _AttemptOutcome | None:
        with self._lock:
            return self._outcome

    def submit(self, outcome: _AttemptOutcome) -> bool:
        with self._lock:
            if self._outcome is not None:
                return False
            self._outcome = outcome
            return True


class _DurableWaitSuspension(BaseException):
    pass


_MAX_WAIT_DURATION_MS = 31_536_000_000

# How long a worker claims a queue that rejected a fast claim through claim_many before probing it
# again. A queue can move to the fast tier only while it holds no live tasks (ADR 0077).
_TIER_PROBE_INTERVAL_SECONDS = 30.0


class _HandlerDurability:
    def __init__(
        self,
        executor: _SyncRowExecutor,
        task: ClaimedTask,
        worker_id: str,
        cancellation: CancellationToken,
        arbiter: _AttemptOutcomeArbiter,
        fast_tier: bool = False,
    ) -> None:
        self._executor = executor
        self._task = task
        self._fast_tier = fast_tier
        self._worker_id = worker_id
        self._cancellation = cancellation
        self._arbiter = arbiter
        self._lock = Lock()
        self._checkpoints: dict[str, TaskCheckpoint] | None = None
        self._checkpoints_load_error: BaseException | None = None
        self._checkpoints_load_attempted = False
        self._waits: dict[str, TaskWait] | None = None
        self._waits_load_error: BaseException | None = None
        self._waits_load_attempted = False
        self._progress: TaskProgress | None = None
        self._progress_load_error: BaseException | None = None
        self._progress_load_attempted = False
        self._checkpoint_calls: dict[str, Future[Json]] = {}
        self._wait_calls: dict[str, Future[None]] = {}
        self._signal_calls: dict[str, Future[Json]] = {}
        self._human_calls: dict[str, tuple[str, Future[Json]]] = {}
        self._child_calls: dict[str, tuple[str, Future[Json]]] = {}
        self._children_call: tuple[str, Future[dict[str, Json]]] | None = None

    def _suspension(self, *, cancel: bool) -> _DurableWaitSuspension:
        # Every wait raises its own instance. Re-raising one shared instance would append each
        # raise's frames to its traceback, keeping every suspended handler's locals alive.
        suspension = _DurableWaitSuspension()
        if cancel:
            self._cancellation._cancel(suspension)
        return suspension

    def context(self) -> HandlerContext:
        if self._fast_tier:
            return self._fast_tier_context()
        return HandlerContext(
            self._task,
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
            self.run_children_all,
        )

    def _fast_tier_context(self) -> HandlerContext:
        """Build a context that rejects durable execution state before any round trip.

        A fast-tier task has no checkpoints, progress, waits, or children (ADR 0077). Rejecting
        locally fails the attempt with a clear error instead of a PostgreSQL refusal.
        """
        queue = self._task.queue

        def reject(feature: str) -> Callable[..., Any]:
            def rejected(*_arguments: object) -> Any:
                raise FastTierUnsupportedError(queue, feature)

            return rejected

        return HandlerContext(
            self._task,
            self._cancellation,
            self.get_checkpoint,
            self.get_wait,
            self.get_progress,
            reject("progress"),
            reject("checkpoints"),
            reject("durable waits"),
            reject("durable waits"),
            reject("signal waits"),
            reject("human waits"),
            reject("child tasks"),
            reject("child tasks"),
            reject("child tasks"),
        )

    def _load_checkpoints(self) -> dict[str, TaskCheckpoint]:
        with self._lock:
            if not self._checkpoints_load_attempted:
                self._checkpoints_load_attempted = True
                try:
                    rows = self._executor.rows(_STATEMENTS.list_checkpoints, (self._task.id,))
                    self._checkpoints = {
                        str(row["checkpoint_name"]): _checkpoint_record(self._task.id, row)
                        for row in rows
                    }
                except BaseException as error:
                    self._checkpoints_load_error = error
            if self._checkpoints_load_error is not None:
                raise self._checkpoints_load_error
            assert self._checkpoints is not None
            return self._checkpoints

    def _load_waits(self) -> dict[str, TaskWait]:
        with self._lock:
            if not self._waits_load_attempted:
                self._waits_load_attempted = True
                try:
                    rows = self._executor.rows(_STATEMENTS.list_waits, (self._task.id,))
                    self._waits = {
                        str(row["wait_name"]): _wait_record(self._task.id, row) for row in rows
                    }
                except BaseException as error:
                    self._waits_load_error = error
            if self._waits_load_error is not None:
                raise self._waits_load_error
            assert self._waits is not None
            return self._waits

    def get_checkpoint(self, name: str) -> TaskCheckpoint | None:
        return self._load_checkpoints().get(name)

    def get_wait(self, name: str) -> TaskWait | None:
        return self._load_waits().get(name)

    def get_progress(self) -> TaskProgress | None:
        with self._lock:
            if not self._progress_load_attempted:
                self._progress_load_attempted = True
                try:
                    rows = self._executor.rows(_STATEMENTS.list_progress, (self._task.id,))
                    if len(rows) > 1:
                        raise RuntimeError("PostgreSQL returned an invalid progress result")
                    self._progress = None if not rows else _progress_record(self._task.id, rows[0])
                except BaseException as error:
                    self._progress_load_error = error
            if self._progress_load_error is not None:
                raise self._progress_load_error
            return self._progress

    def set_progress(self, value: Json) -> TaskProgress:
        encoded = json.dumps(value, separators=(",", ":"), allow_nan=False)
        self._cancellation.raise_if_cancelled()
        row = _require_lifecycle_row(
            self._executor.rows(
                _STATEMENTS.update_progress,
                (self._task.id, self._worker_id, self._task.fence_token, encoded),
            )
        )
        status = row["status"]
        if status == "stale":
            raise ProgressLeaseLostError(self._task.id)
        if status == "rate_limited":
            raise ProgressRateLimitError(self._task.id, int(cast(int | str, row["retry_after_ms"])))
        if status not in {"updated", "unchanged"}:
            raise RuntimeError(f"Unexpected progress status: {status}")
        progress = _progress_record(self._task.id, row)
        with self._lock:
            self._progress_load_attempted = True
            self._progress_load_error = None
            self._progress = progress
        _emit_log(
            "DEBUG",
            "workhorse.task.progress_updated",
            "Task progress persisted",
            {
                **_task_span_attributes(self._task),
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
                        _STATEMENTS.save_checkpoint,
                        (
                            self._task.id,
                            self._worker_id,
                            self._task.fence_token,
                            name,
                            encoded,
                        ),
                    )
                )
                status = row["status"]
                if status == "stale":
                    raise CheckpointLeaseLostError(self._task.id, name)
                if status == "conflict":
                    raise CheckpointConflictError(self._task.id, name)
                if status not in {"saved", "existing"}:
                    raise RuntimeError(f"Unexpected checkpoint status: {status}")
                _emit_log(
                    "DEBUG",
                    "workhorse.task.checkpoint_saved",
                    "Task checkpoint persisted",
                    {
                        **_task_span_attributes(self._task),
                        "workhorse.checkpoint.name": name,
                        "workhorse.checkpoint.status": str(status),
                        "workhorse.worker.id": self._worker_id,
                    },
                )
                saved = _checkpoint_record(self._task.id, row, name=name)
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
        if (wake_at - datetime.now(UTC)).total_seconds() * 1000 > _MAX_WAIT_DURATION_MS:
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
                    _STATEMENTS.schedule_wait,
                    (
                        self._task.id,
                        self._worker_id,
                        self._task.fence_token,
                        name,
                        duration_ms,
                        wake_at,
                    ),
                )
            )
            status = row["status"]
            if status == "stale":
                raise WaitLeaseLostError(self._task.id, name)
            if status == "conflict":
                raise WaitConflictError(self._task.id, name)
            if status == "limit_exceeded":
                raise WaitLimitExceededError(self._task.id)
            if status not in {"scheduled", "elapsed"}:
                raise RuntimeError(f"Unexpected wait status: {status}")
            _emit_log(
                "INFO",
                "workhorse.task.wait_processed",
                "Durable task wait processed",
                {
                    **_task_span_attributes(self._task),
                    "workhorse.wait.name": name,
                    "workhorse.wait.status": str(status),
                    "workhorse.worker.id": self._worker_id,
                },
            )
            wait = _wait_record(self._task.id, row, name=name)
            with self._lock:
                if self._waits is not None:
                    self._waits[name] = wait
            if status == "scheduled" and self._arbiter.submit("suspended_for_wait"):
                raise self._suspension(cancel=True)
            pending.set_result(None)
        except BaseException as error:
            pending.set_exception(error)
            raise
        finally:
            with self._lock:
                if self._wait_calls.get(name) is pending:
                    del self._wait_calls[name]

    def wait_for_signal(self, name: str, timeout_ms: int | None = None) -> Json:
        _validate_wait_name(name, "Signal")
        _validate_wait_timeout(timeout_ms, "Signal")
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
                    _STATEMENTS.wait_for_signal,
                    (
                        self._task.id,
                        self._worker_id,
                        self._task.fence_token,
                        name,
                        timeout_ms,
                    ),
                )
            )
            status = row["status"]
            if status == "stale":
                raise SignalWaitLeaseLostError(self._task.id, name)
            if status == "already_waiting":
                raise SignalWaitConflictError(self._task.id, name)
            if status == "limit_exceeded":
                raise SignalWaitLimitExceededError(self._task.id)
            if status == "waiting":
                raise self._suspension(cancel=self._arbiter.submit("suspended_for_wait"))
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
        _validate_wait_name(name, "Human wait")
        _validate_wait_timeout(timeout_ms, "Human wait")
        encoded_context = _encode_wait_value(context, "Human wait context")
        with self._lock:
            current = self._human_calls.get(name)
            if current is None:
                pending: Future[Json] = Future()
                self._human_calls[name] = (encoded_context, pending)
                owns_call = True
            else:
                pending_context, pending = current
                if pending_context != encoded_context:
                    raise HumanWaitConflictError(self._task.id, name)
                owns_call = False
        if not owns_call:
            return pending.result()
        try:
            self._cancellation.raise_if_cancelled()
            row = _require_lifecycle_row(
                self._executor.rows(
                    _STATEMENTS.wait_for_human,
                    (
                        self._task.id,
                        self._worker_id,
                        self._task.fence_token,
                        name,
                        encoded_context,
                        timeout_ms,
                    ),
                )
            )
            status = row["status"]
            if status == "stale":
                raise HumanWaitLeaseLostError(self._task.id, name)
            if status == "already_waiting":
                raise HumanWaitAlreadyWaitingError(self._task.id, name)
            if status == "limit_exceeded":
                raise HumanWaitLimitExceededError(self._task.id)
            if status == "conflict":
                raise HumanWaitConflictError(self._task.id, name)
            if status == "waiting":
                raise self._suspension(cancel=self._arbiter.submit("suspended_for_wait"))
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
        request = _serialize_child_request(self._task, type, payload, options, "default")
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
                    raise ChildConflictError(self._task.id, name)
                owns_call = False
        if not owns_call:
            return pending.result()
        try:
            self._cancellation.raise_if_cancelled()
            row = _require_lifecycle_row(
                self._executor.rows(
                    _STATEMENTS.create_child,
                    (self._task.id, self._worker_id, self._task.fence_token, name, encoded),
                )
            )
            status = row["status"]
            if status == "stale":
                raise ChildLeaseLostError(self._task.id)
            if status == "conflict":
                raise ChildConflictError(self._task.id, name)
            if status == "limit_exceeded":
                raise ChildLimitExceededError(self._task.id)
            if status in {"created", "completed"}:
                _emit_log(
                    "INFO",
                    "workhorse.task.child_processed",
                    "Child task processed",
                    {
                        "workhorse.task.id": self._task.id,
                        "workhorse.child.name": name,
                        "workhorse.child.status": str(status),
                        "workhorse.worker.id": self._worker_id,
                    },
                )
            if status == "created":
                raise self._suspension(cancel=self._arbiter.submit("suspended_for_child"))
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

    def run_children(self, children: Sequence[ChildTaskRequest]) -> dict[str, ChildOutcome]:
        return cast(dict[str, ChildOutcome], self._run_child_set(children, "settled"))

    def run_children_all(self, children: Sequence[ChildTaskRequest]) -> dict[str, Json]:
        return self._run_child_set(children, "all_success")

    def _run_child_set(
        self, children: Sequence[ChildTaskRequest], mode: Literal["settled", "all_success"]
    ) -> dict[str, Json]:
        if isinstance(children, (str, bytes)) or not isinstance(children, Sequence):
            raise TypeError("Children must be a sequence")
        if len(children) > 100:
            raise ChildLimitExceededError(self._task.id)
        names: set[str] = set()
        requests: list[dict[str, Json]] = []
        for child in children:
            if not isinstance(child, ChildTaskRequest):
                raise TypeError("Each child must be a ChildTaskRequest")
            if not isinstance(child.name, str) or not 1 <= len(child.name) <= 200:
                raise ValueError("Child name must contain between 1 and 200 characters")
            if child.name in names:
                raise ValueError("Child names must be unique")
            names.add(child.name)
            requests.append(
                {
                    "name": child.name,
                    "request": _serialize_child_request(
                        self._task,
                        child.type,
                        child.payload,
                        child.options,
                        "default",
                    ),
                }
            )
        encoded = json.dumps(requests, separators=(",", ":"), allow_nan=False, sort_keys=True)
        call_key = f"{mode}:{encoded}"
        with self._lock:
            current = self._children_call
            if current is None:
                pending: Future[dict[str, Json]] = Future()
                self._children_call = (call_key, pending)
                owns_call = True
            else:
                pending_request, pending = current
                if pending_request != call_key:
                    raise ChildConflictError(self._task.id, "child set")
                owns_call = False
        if not owns_call:
            return pending.result()
        try:
            self._cancellation.raise_if_cancelled()
            row = _require_lifecycle_row(
                self._executor.rows(
                    _STATEMENTS.create_children,
                    (self._task.id, self._worker_id, self._task.fence_token, encoded, mode),
                )
            )
            status = row["status"]
            if status == "stale":
                raise ChildLeaseLostError(self._task.id)
            if status == "conflict":
                raise ChildConflictError(self._task.id, "child set")
            if status == "limit_exceeded":
                raise ChildLimitExceededError(self._task.id)
            if status == "result_too_large":
                raise ChildResultLimitExceededError(
                    self._task.id,
                    int(cast(int, row["result_bytes"] or 0)),
                    int(cast(int, row["result_limit_bytes"] or 0)),
                )
            if status in {"created", "completed"}:
                _emit_log(
                    "INFO",
                    "workhorse.task.child_processed",
                    "Child set processed",
                    {
                        "workhorse.task.id": self._task.id,
                        "workhorse.child.count": len(children),
                        "workhorse.child.status": str(status),
                        "workhorse.worker.id": self._worker_id,
                    },
                )
            if status == "created":
                raise self._suspension(cancel=self._arbiter.submit("suspended_for_child"))
            if status != "completed":
                raise RuntimeError(f"Unexpected child-set status: {status}")
            joined = cast(list[dict[str, Json]], row["children"] or [])
            field = "outcome" if mode == "settled" else "result"
            result = {str(child["name"]): child[field] for child in joined}
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
    """A synchronous worker over a Psycopg connection pool."""

    def __init__(
        self,
        pool: _PsycopgPool,
        *,
        queue: str | None = None,
        queues: Sequence[str] | None = None,
        worker_id: str | None = None,
        concurrency: int = 1,
        cohorts: int | None = None,
        poll_ms: int | None = None,
        lease_ms: int = 30_000,
        heartbeat_ms: int | None = None,
        maintenance_interval_ms: int = 1_000,
        maintenance_routine_poll_ms: int = 60_000,
        registry_interval_ms: int = 5_000,
        retry_delay_ms: int | Callable[[int, ClaimedTask], int | None] | None = None,
        schedule_namespaces: Sequence[str] = (),
        schedule_catchup_limit: int = 100,
        on_notification_error: Callable[[BaseException], None] | None = None,
        on_registration_error: Callable[[BaseException], None] | None = None,
        shared_heartbeats: bool = False,
        _executor: _SyncRowExecutor | None = None,
        _heartbeat_executor_factory: _HeartbeatExecutorFactory | None = None,
    ) -> None:
        capacity = getattr(pool, "max_size", None)
        if capacity is None:
            get_max_size = getattr(pool, "get_max_size", None)
            if callable(get_max_size):
                capacity = get_max_size()
        if not shared_heartbeats and (not isinstance(capacity, int) or capacity < 3):
            found = "unknown" if capacity is None else str(capacity)
            raise ValueError(
                f"Worker pool capacity must be at least 3 (found {found}); "
                "set shared_heartbeats=True to opt out"
            )
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
        if cohorts is None:
            # The listener and the heartbeat connection each hold a pooled connection.
            cohorts = _dispatch_cohorts(
                concurrency,
                capacity - 1 - (0 if shared_heartbeats else 1)
                if isinstance(capacity, int) and not isinstance(capacity, bool)
                else None,
            )
        elif (
            isinstance(cohorts, bool)
            or not isinstance(cohorts, int)
            or not 1 <= cohorts <= concurrency
        ):
            raise ValueError("cohorts must be an integer between 1 and concurrency")
        resolved_poll_ms = poll_ms if poll_ms is not None else 250
        if (
            isinstance(resolved_poll_ms, bool)
            or not isinstance(resolved_poll_ms, int)
            or resolved_poll_ms < 1
        ):
            raise ValueError("poll_ms must be a positive integer")
        self._executor = _executor or _PooledSyncExecutor(pool)
        self._compatibility = _CachedCompatibilityCheck(self._executor)
        self._handlers: dict[str, Handler] = {}
        self.queues = unique_queues
        self.queue = unique_queues[0]
        self.worker_id = worker_id or _default_worker_id()
        self.concurrency = concurrency
        # Slot cohorts for fast-tier dispatch (ADR 0076). One cohort keeps every slot in one group.
        self.cohorts = cohorts
        self.poll_ms = resolved_poll_ms
        self._notification_poll_ms = poll_ms if poll_ms is not None else 5_000
        self._pool = pool
        self._shared_heartbeats = shared_heartbeats
        self._notification_wake = Event()
        self._notification_listening = Event()
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
            isinstance(maintenance_routine_poll_ms, bool)
            or not isinstance(maintenance_routine_poll_ms, int)
            or maintenance_routine_poll_ms < 100
        ):
            raise ValueError("maintenance_routine_poll_ms must be an integer of at least 100")
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
        # The tick bounds dispatch latency, so it runs every second. ADR 0011 puts the slow
        # retention routines on their own cadence, because PostgreSQL decides which phase is due.
        self.maintenance_routine_poll_ms = maintenance_routine_poll_ms
        self._last_routine_offer_at = float("-inf")
        self.retry_delay_ms = retry_delay_ms
        self.registry_interval_ms = registry_interval_ms
        self.schedule_namespaces = unique_namespaces
        self.schedule_catchup_limit = schedule_catchup_limit
        self._last_maintenance_at = float("-inf")
        self._last_registry_refresh_at = float("-inf")
        self._instance_id = ""
        self._hostname = socket.gethostname() or "python-worker"
        self._registered = False
        self._next_queue_index = 0
        # Queues that rejected a fast claim, with the monotonic time to probe them again.
        self._full_tier_until: dict[str, float] = {}
        # Tasks claimed from a queue that answered as fast-tier. Their handlers get the fast-tier
        # context, and their completions take the batched path.
        self._fast_task_ids: set[str] = set()
        # Queues whose last claim answered on the fast tier. A cohort claim asks them for one
        # cohort's share only once every queue is known here.
        self._fast_tier_queues: set[str] = set()
        # The slot accounting of the active run, shared with its handler threads.
        self._dispatch_slots: _DispatchSlots | None = None
        # Fast-tier completions waiting per queue and cohort. A key is present while one of its
        # statements is in flight, and its list holds the completions that arrived meanwhile.
        self._completion_lock = Lock()
        self._pending_completions: dict[tuple[str, int], list[_PendingCompletion]] = {}
        self._state_lock = Lock()
        self._contract_validators: dict[tuple[str, str], Any] = {}
        self._execution_lock = Lock()
        self._wake = Event()
        self._dispatch_wake_version = 0
        self._active_threads: set[Thread] = set()
        self._dispatch_sequence = 0
        self._dispatch_order: dict[str, int] = {}
        self._run_errors: list[BaseException] = []
        self._locally_paused = False
        self._remotely_paused = False
        self._stopping = False
        self._stop_version = 0
        self._heartbeat_lock = Lock()
        self._heartbeat_members: dict[str, _HeartbeatMember] = {}
        self._heartbeat_thread: Thread | None = None
        self._heartbeat_wake = Event()
        # Heartbeats get their own connection when one is configured, so a slow handler statement
        # on the shared connection cannot hold a lease renewal back.
        self._heartbeat_executor_factory = _heartbeat_executor_factory or (
            None if shared_heartbeats else _psycopg_pool_heartbeat_executor_factory(pool)
        )
        self._heartbeat_connection_lock = Lock()
        self._heartbeat_connection: tuple[_SyncRowExecutor, Callable[[], None]] | None = None
        self._notification_connection_factory: _NotificationConnectionFactory = (
            _psycopg_pool_notification_factory(pool)
        )

    def _register_heartbeat(
        self,
        task: ClaimedTask,
        deliver_status: Callable[[object], bool],
        renew: Callable[[float], None],
        cancellation: CancellationToken,
        errors: list[BaseException],
        parent_context: object,
    ) -> Callable[[], None]:
        member = _HeartbeatMember(task, deliver_status, renew, cancellation, errors, parent_context)
        with self._heartbeat_lock:
            self._heartbeat_members[task.id] = member
            if self._heartbeat_thread is None or not self._heartbeat_thread.is_alive():
                self._heartbeat_wake.clear()
                self._heartbeat_thread = Thread(
                    target=self._run_heartbeats,
                    name=f"workhorse-heartbeats-{self.worker_id}",
                    daemon=True,
                )
                self._heartbeat_thread.start()

        def unregister() -> None:
            with self._heartbeat_lock:
                if self._heartbeat_members.get(task.id) is member:
                    del self._heartbeat_members[task.id]
                if not self._heartbeat_members:
                    self._heartbeat_wake.set()

        return unregister

    def _run_heartbeats(self) -> None:
        while True:
            if self._heartbeat_wake.wait(self.heartbeat_ms / 1000):
                self._heartbeat_wake.clear()
            with self._heartbeat_lock:
                members = list(self._heartbeat_members.values())
                if not members:
                    self._heartbeat_thread = None
                    return
            leases = [
                {
                    "taskId": task.id,
                    "fenceToken": str(task.fence_token),
                    "leaseMs": self.lease_ms,
                }
                for task in (member.task for member in members)
            ]
            sent_at = monotonic()
            try:
                rows = self._heartbeat_rows(
                    (self.worker_id, json.dumps(leases, separators=(",", ":")))
                )
            except Exception:
                # A failed round proves nothing about ownership, so every task keeps running and
                # the next round retries. Each attempt's lease watchdog ends it once its last
                # accepted renewal is a full lease old.
                continue
            try:
                statuses = {str(row["task_id"]): row["status"] for row in rows}
                for member in members:
                    task = member.task
                    with self._heartbeat_lock:
                        if self._heartbeat_members.get(task.id) is not member:
                            continue
                    status = statuses.get(task.id, "stale")
                    if status == "accepted":
                        member.renew(sent_at)
                        _emit_log(
                            "DEBUG",
                            "workhorse.task.heartbeat_accepted",
                            "Task heartbeat accepted",
                            {**_task_span_attributes(task), "workhorse.worker.id": self.worker_id},
                        )
                    else:
                        _record_heartbeat_failure(str(status))
                        _emit_log(
                            "INFO",
                            "workhorse.task.heartbeat_rejected",
                            "Task heartbeat rejected",
                            {
                                **_task_span_attributes(task),
                                "workhorse.heartbeat.status": str(status),
                                "workhorse.worker.id": self.worker_id,
                            },
                        )
                    if status in {"deadline_exceeded", "timeout_exceeded"}:
                        status = self._expire_owned_task(task, member.parent_context)
                        if status == "not_due":
                            continue
                    member.deliver_status(status)
            except BaseException as error:
                for member in members:
                    task = member.task
                    with self._heartbeat_lock:
                        if self._heartbeat_members.get(task.id) is not member:
                            continue
                    member.errors.append(error)
                    member.cancellation._cancel(error)

    def _heartbeat_rows(self, parameters: Sequence[object]) -> list[Mapping[str, object]]:
        if self._heartbeat_executor_factory is None:
            return self._executor.rows(_STATEMENTS.heartbeat_many, parameters)
        with self._heartbeat_connection_lock:
            if self._heartbeat_connection is None:
                self._heartbeat_connection = self._heartbeat_executor_factory()
            executor, close = self._heartbeat_connection
            try:
                return executor.rows(_STATEMENTS.heartbeat_many, parameters)
            except BaseException:
                # Reconnect on the next beat rather than reuse a connection in an unknown state.
                self._heartbeat_connection = None
                with suppress(Exception):
                    close()
                raise

    def _close_heartbeat_connection(self) -> None:
        with self._heartbeat_connection_lock:
            connection, self._heartbeat_connection = self._heartbeat_connection, None
        if connection is not None:
            with suppress(Exception):
                connection[1]()

    def _expire_owned_task(self, task: ClaimedTask, parent_context: object) -> object:
        expiration = _require_lifecycle_row(
            self._executor.rows(
                _STATEMENTS.expire_owned,
                (task.id, self.worker_id, task.fence_token),
            )
        )
        status = expiration["status"]
        if status == "not_due":
            return status
        retry_state = expiration["retry_state"]
        if retry_state is not None:
            with _start_span(
                "workhorse.retry",
                _task_span_attributes(task),
                parent_context=parent_context,
            ) as retry_span:
                retry_span.set_attribute("workhorse.retry.outcome", str(retry_state))
                _record_retry(task)
        _emit_log(
            "INFO",
            "workhorse.task.ownership_expired",
            "Owned task lease expired",
            {
                **_task_span_attributes(task),
                "workhorse.expiration.status": str(status),
                "workhorse.worker.id": self.worker_id,
            },
        )
        return status

    def handle(self, type: str, handler: Handler) -> Worker:
        self._handlers[type] = handler
        _emit_log(
            "DEBUG",
            "workhorse.handler.registered",
            "Task handler registered",
            {"workhorse.task.type": type, "workhorse.worker.id": self.worker_id},
        )
        return self

    def _validate_result_contract(self, task: ClaimedTask, result: Json) -> None:
        version = task.contract_version
        if version is None:
            return
        key = (task.type, version)
        with self._state_lock:
            validator = self._contract_validators.get(key)
        if validator is None:
            rows = self._executor.rows(_STATEMENTS.get_contract, (task.type, version))
            if len(rows) != 1:
                raise TaskContractUnavailableError(task.type, version)
            document = rows[0].get("schema")
            if isinstance(document, str):
                document = json.loads(document)
            if not isinstance(document, Mapping) or "result" not in document:
                raise TaskContractUnavailableError(task.type, version)
            validator = _compile_contract_schema(cast(Json, document["result"]))
            with self._state_lock:
                self._contract_validators[key] = validator
        if not validator.is_valid(result):
            raise TaskContractValidationError(task.type, version, "result")

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

        def take_batch(queue_name: str) -> list[_PendingBatchMember]:
            # Callers hold pending_lock, and every member enters through insort, so the waiting
            # list is already in dispatch order. The prefix is both the group and its ordering.
            pending = pending_queues.get(queue_name)
            if not pending:
                return []
            batch = pending[:max_size]
            del pending[:max_size]
            if not pending:
                del pending_queues[queue_name]
            return batch

        def record_batch(
            statement: _DriverStatement,
            batch_id: str,
            batch: Sequence[_PendingBatchMember],
        ) -> None:
            tasks = [member.item.context.task for member in batch]
            try:
                row = _require_lifecycle_row(
                    self._executor.rows(
                        statement,
                        (
                            batch_id,
                            [task.id for task in tasks],
                            [task.attempt for task in tasks],
                            [task.fence_token for task in tasks],
                            self.worker_id,
                        ),
                    )
                )
                if int(cast(int, row["recorded"])) != len(batch):
                    raise RuntimeError("PostgreSQL did not record every batch member")
            except Exception as error:
                tasks = [member.item.context.task for member in batch]
                _emit_log(
                    "WARN",
                    "workhorse.handler.batch_evidence_failed",
                    "Batch execution evidence could not be persisted",
                    {
                        "workhorse.queue.name": tasks[0].queue,
                        "workhorse.task.type": type,
                        "workhorse.handler.batch.full": len(batch) == max_size,
                        "workhorse.handler.batch.size": len(batch),
                        "workhorse.handler.batch.evidence_phase": (
                            "dispatch"
                            if statement is _STATEMENTS.record_batch_dispatch
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
            queue_name = batch[0].item.context.task.queue
            full = len(batch) == max_size
            _record_batch_metrics(queue_name, type, len(batch), actual_linger_ms, full)
            _emit_log(
                "INFO",
                "workhorse.handler.batch_dispatched",
                "Task batch dispatched",
                {
                    "workhorse.queue.name": queue_name,
                    "workhorse.task.type": type,
                    "workhorse.handler.batch.full": full,
                    "workhorse.handler.batch.size": len(batch),
                    "workhorse.handler.batch.linger_ms": actual_linger_ms,
                    "workhorse.worker.id": self.worker_id,
                },
            )
            record_batch(_STATEMENTS.record_batch_dispatch, batch_id, batch)
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
                record_batch(_STATEMENTS.record_batch_failure, batch_id, batch)
                for member in batch:
                    member.result.set_exception(error)
                return
            for member, outcome in zip(batch, validated, strict=True):
                if outcome["status"] == "succeeded":
                    member.result.set_result(outcome["result"])
                else:
                    member.result.set_exception(outcome["error"])

        def batch_member_handler(payload: Any, context: HandlerContext) -> Json:
            member = _PendingBatchMember(
                arrival_order=self._claim_order(context.task),
                arrived_at=monotonic(),
                item=BatchHandlerItem(cast(Json, payload), context._as_batch_context()),
                result=Future(),
            )
            with pending_lock:
                pending = pending_queues.setdefault(context.task.queue, [])
                insort(pending, member, key=_batch_member_order)
                batch = take_batch(context.task.queue) if len(pending) >= max_size else []
                first_arrived_at = (
                    min(waiting.arrived_at for waiting in pending) if pending else member.arrived_at
                )
            if batch:
                dispatch(batch)
            elif linger_ms == 0:
                with pending_lock:
                    batch = take_batch(context.task.queue)
                if batch:
                    dispatch(batch)
            else:
                remaining = max(0.0, first_arrived_at + linger_ms / 1000 - monotonic())
                try:
                    return member.result.result(timeout=remaining)
                except FutureTimeoutError:
                    with pending_lock:
                        batch = take_batch(context.task.queue)
                    if batch:
                        dispatch(batch)
            return member.result.result()

        self._handlers[type] = batch_member_handler
        _emit_log(
            "DEBUG",
            "workhorse.handler.registered",
            "Batch task handler registered",
            {
                "workhorse.task.type": type,
                "workhorse.handler.batch.max_size": max_size,
                "workhorse.handler.batch.linger_ms": linger_ms,
                "workhorse.worker.id": self.worker_id,
            },
        )
        return self

    def run_once(self) -> bool:
        """Fill available slots until one empty queue sweep, then drain the claimed tasks."""
        requested_stop_version = self._stop_version_snapshot()
        with self._execution_lock:
            return self._run_loop(
                continuous=False,
                requested_stop_version=requested_stop_version,
            )

    def run(self) -> None:
        """Run until stopped, then return after every claimed task has settled."""
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
        _emit_log(
            "INFO",
            "workhorse.worker.paused",
            "Worker paused locally",
            {"workhorse.worker.id": self.worker_id, "workhorse.worker.queues": self.queues},
        )
        self._wake_dispatcher()

    def resume(self) -> None:
        """Allow claims and wake an idle run loop immediately."""
        with self._state_lock:
            self._locally_paused = False
        _emit_log(
            "INFO",
            "workhorse.worker.resumed",
            "Worker resumed locally",
            {"workhorse.worker.id": self.worker_id, "workhorse.worker.queues": self.queues},
        )
        self._wake_dispatcher()

    def is_paused(self) -> bool:
        with self._state_lock:
            return self._locally_paused or self._remotely_paused

    def stop(self) -> None:
        """Request a graceful stop; the active run call performs the drain."""
        with self._state_lock:
            self._stop_version += 1
            self._stopping = True
            active_slots = len(self._active_threads)
        _emit_log(
            "INFO",
            "workhorse.worker.stop_requested",
            "Worker stop requested",
            {
                "workhorse.worker.id": self.worker_id,
                "workhorse.worker.active_slots": active_slots,
                "workhorse.worker.queues": self.queues,
            },
        )
        self._wake_dispatcher()

    def _stop_version_snapshot(self) -> int:
        with self._state_lock:
            return self._stop_version

    def _wake_dispatcher(self) -> None:
        """Wake the run loop for a state change, which also ends an empty-poll wait."""
        with self._state_lock:
            self._dispatch_wake_version += 1
        self._wake.set()

    def _claims_halted(self) -> bool:
        with self._state_lock:
            return self._stopping or self._locally_paused or self._remotely_paused

    def _run_loop(self, *, continuous: bool, requested_stop_version: int) -> bool:
        self._compatibility.assert_compatible()
        self._instance_id = str(uuid4())
        self._registered = False
        with self._state_lock:
            self._stopping = self._stop_version != requested_stop_version
            self._run_errors.clear()
        listener = self._start_notification_listener() if continuous else None
        self._refresh_registration(force=True)
        _emit_log(
            "INFO",
            "workhorse.worker.started",
            "Worker started",
            {
                "workhorse.worker.id": self.worker_id,
                "workhorse.worker.concurrency": self.concurrency,
                "workhorse.worker.queues": self.queues,
            },
        )
        # Keeps the slots full without one serial claim round trip per task (ADR 0076). A claim
        # reserves the slots it asks for, so claimed tasks never exceed the concurrency. With no
        # claim in flight, any free slot starts one. While one is in flight, another starts only
        # once the unreserved free slots reach the refill batch, so a busy worker claims in
        # batches and its claims overlap. Claims run on their own threads and report back here.
        # A fast-tier completion claims too, and its slots come from the same accounting. On the
        # fast tier the slots split into cohorts, and plain claims leave one at a time, each for
        # the cohort with the most free slots.
        cohorts = self.cohorts
        slots = _DispatchSlots(
            concurrency=self.concurrency,
            refill_batch=_dispatch_refill_batch(self.concurrency),
            # The first cohorts take the remainder of an uneven split.
            cohort_capacity=[
                self.concurrency // cohorts + (1 if cohort < self.concurrency % cohorts else 0)
                for cohort in range(cohorts)
            ],
            listener=listener,
            cohort_active=[0] * cohorts,
            cohort_handed_over=[0] * cohorts,
            cohort_reserved=[0] * cohorts,
            cohort_claims=[0] * cohorts,
        )
        with self._state_lock:
            self._dispatch_slots = slots
        # Each claim in flight, with its limit, its cohort (None for the whole worker), and the
        # slots it reserved in that cohort.
        claims: dict[int, tuple[int, int | None, int]] = {}
        results: SimpleQueue[_ClaimOutcome] = SimpleQueue()
        next_claim_id = 0

        def settle(outcome: _ClaimOutcome) -> None:
            limit, cohort, cohort_limit = claims.pop(outcome.claim_id)
            threads: list[Thread] = []
            with self._state_lock:
                slots.reserved -= limit
                if cohort is None:
                    slots.whole_claims -= 1
                else:
                    slots.cohort_claims[cohort] -= 1
                    slots.cohort_reserved[cohort] -= cohort_limit
                if outcome.claimed is not None:
                    # A claimed task holds a lease, so it runs even when the loop is stopping or
                    # failed.
                    threads = [
                        self._admit_claimed_task(task, claim_started_at, cohort)
                        for task, claim_started_at in outcome.claimed
                    ]
                    self._settle_claim_progress(slots, outcome)
            for thread in threads:
                thread.start()

        def settle_returned() -> None:
            while not results.empty():
                settle(results.get())

        def start_claim(limit: int, cohort: int | None, cohort_limit: int) -> None:
            nonlocal next_claim_id
            claim_id = next_claim_id
            next_claim_id += 1
            claims[claim_id] = (limit, cohort, cohort_limit)
            delayed = self._notification_wake.is_set()
            self._notification_wake.clear()
            with self._state_lock:
                slots.reserved += limit
                if cohort is None:
                    slots.whole_claims += 1
                else:
                    slots.cohort_claims[cohort] += 1
                    slots.cohort_reserved[cohort] += cohort_limit
                wake_version = self._dispatch_wake_version
            Thread(
                target=self._run_dispatch_claim,
                args=(
                    claim_id,
                    limit,
                    limit if cohort is None else cohort_limit,
                    wake_version,
                    delayed,
                    results,
                ),
                name=f"workhorse-claim-{claim_id}",
                daemon=True,
            ).start()

        def next_claim() -> tuple[int, int | None, int] | None:
            """Plan the next plain claim: its limit, its cohort, and its slots in that cohort."""
            with self._state_lock:
                free = slots.free_slots(len(self._active_threads))
                if free <= 0:
                    return None
                if cohorts == 1 or self._full_tier_until:
                    if claims and free < slots.refill_batch:
                        return None
                    return free, None, free
                if claims:
                    return None
                cohort = slots.roomiest_cohort()
                cohort_limit = min(free, slots.cohort_free(cohort))
                # A claim that still has to learn a queue's tier reserves every free slot, so a
                # queue that answers on the full tier fills them all as before.
                if all(queue in self._fast_tier_queues for queue in self.queues):
                    return (cohort_limit, cohort, cohort_limit) if cohort_limit > 0 else None
                return free, cohort, max(0, cohort_limit)

        try:
            try:
                while True:
                    # Clear before observing. A completion, claim result, or state change that
                    # arrives afterwards remains latched and prevents the following wait.
                    self._wake.clear()
                    settle_returned()
                    self._refresh_registration()
                    with self._state_lock:
                        stopping = self._stopping or bool(self._run_errors)
                        paused = self._locally_paused or self._remotely_paused
                        wake_version = self._dispatch_wake_version
                        failed = slots.claim_error is not None
                        pass_ended = slots.pass_ended
                        consecutive_empty_claims = slots.consecutive_empty_claims
                        empty_wait = slots.empty_wait
                    if stopping or failed:
                        break
                    if not continuous and pass_ended:
                        break
                    if paused:
                        if not continuous:
                            break
                        # Paused starts no claims but keeps observing executions and claims.
                        self._wake.wait(
                            self._dispatch_wait_seconds(listener, consecutive_empty_claims)
                        )
                        continue
                    if empty_wait is not None:
                        remaining = empty_wait[0] - monotonic()
                        if remaining <= 0 or wake_version != empty_wait[1]:
                            with self._state_lock:
                                if slots.empty_wait is empty_wait:
                                    slots.empty_wait = None
                            continue
                        self._wake.wait(remaining)
                        continue
                    if next_claim() is not None:
                        # tick_v1 promotes and recovers, so a claim between ticks only claims.
                        self._run_maintenance_if_due()
                        while (claim := next_claim()) is not None:
                            start_claim(*claim)
                    self._wake.wait(self._dispatch_wait_seconds(listener, consecutive_empty_claims))
            finally:
                # Completions stop claiming with the loop. Tasks an in-flight claim returns hold
                # leases, so they run before the drain.
                with self._state_lock:
                    slots.open = False
                while claims:
                    settle(results.get())
        finally:
            if listener is not None:
                listener.close()
            self._refresh_registration(force=True, draining=True)
            self._drain_active_threads()
            self._close_heartbeat_connection()
            self._deregister()
            with self._state_lock:
                self._stopping = False
                self._dispatch_slots = None
                errors = list(self._run_errors)
                self._run_errors.clear()
                active_slots = len(self._active_threads)
            _emit_log(
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
        if slots.claim_error is not None:
            raise slots.claim_error
        return slots.claimed_any

    def _settle_claim_progress(self, slots: _DispatchSlots, outcome: _ClaimOutcome) -> None:
        """Record whether a returned plain claim made progress. The caller holds the state lock."""
        assert outcome.claimed is not None
        if outcome.error is not None:
            if slots.claim_error is None:
                slots.claim_error = outcome.error
            return
        # A claim that only handed its tasks back made no progress: every one of them goes
        # straight back to its queue. It backs off like an empty claim instead of spinning on
        # a task no handler here can run, and a caller looping run_once backs off too.
        if any(task.type in self._handlers for task, _ in outcome.claimed):
            slots.consecutive_empty_claims = 0
            slots.claimed_any = True
            slots.empty_wait = None
            return
        slots.consecutive_empty_claims += 1
        slots.pass_ended = True
        if slots.empty_wait is None:
            slots.empty_wait = (
                monotonic()
                + self._dispatch_wait_seconds(slots.listener, slots.consecutive_empty_claims),
                outcome.wake_version,
            )

    def _run_dispatch_claim(
        self,
        claim_id: int,
        limit: int,
        fast_limit: int,
        wake_version: int,
        delayed: bool,
        results: SimpleQueue[_ClaimOutcome],
    ) -> None:
        """Run one dispatch claim on its own thread and report the outcome to the run loop."""
        claimed: list[tuple[ClaimedTask, float]] = []
        outcome = _ClaimOutcome(claim_id, limit, wake_version, None)
        try:
            # The notification jitter spreads workers woken together. It delays only this claim.
            if delayed:
                sleep(random.uniform(0, _NOTIFICATION_CLAIM_DELAY_SECONDS))
                if self._claims_halted():
                    return
            self._claim_across_queues(limit, claimed, fast_limit)
            outcome = _ClaimOutcome(claim_id, limit, wake_version, tuple(claimed))
        except BaseException as error:
            outcome = _ClaimOutcome(claim_id, limit, wake_version, tuple(claimed), error)
        finally:
            results.put(outcome)
            self._wake.set()

    def _claim_across_queues(
        self,
        limit: int,
        claimed: list[tuple[ClaimedTask, float]],
        fast_limit: int | None = None,
    ) -> None:
        """Claim up to limit tasks, checking each queue at most once in rotation order.

        Fast-tier queues together give at most fast_limit of them, the free slots of one cohort.
        """
        if fast_limit is None:
            fast_limit = limit
        for _ in range(len(self.queues)):
            if len(claimed) >= limit:
                return
            with self._state_lock:
                queue_name = self.queues[self._next_queue_index]
                self._next_queue_index = (self._next_queue_index + 1) % len(self.queues)
            claim_started_at = monotonic()
            with _start_span(
                "workhorse.claim",
                {"workhorse.queue.name": queue_name},
            ) as claim_span:
                rows = self._claim_queue(
                    queue_name,
                    limit - len(claimed),
                    claim_started_at,
                    fast_limit - len(claimed),
                )
                if rows is None:
                    claim_span.set_attribute("workhorse.queue.tier", "full")
                    rows = self._executor.rows(
                        _STATEMENTS.claim_many,
                        (queue_name, self.worker_id, limit - len(claimed), self.lease_ms),
                    )
                claimed_tasks = tuple(_claimed_task(row, queue_name) for row in rows)
                _record_claim(
                    queue_name,
                    (monotonic() - claim_started_at) * 1_000,
                    claimed_tasks,
                )
                if rows:
                    for key, value in _task_span_attributes(claimed_tasks[0]).items():
                        claim_span.set_attribute(key, value)
            for task in claimed_tasks:
                _emit_log(
                    "DEBUG",
                    "workhorse.task.claimed",
                    "Task claimed",
                    {
                        **_task_span_attributes(task),
                        "workhorse.queue.name": queue_name,
                        "workhorse.worker.id": self.worker_id,
                    },
                )
                claimed.append((task, claim_started_at))

    def _claim_queue(
        self, queue_name: str, limit: int, sent_at: float, fast_limit: int | None = None
    ) -> list[_Row] | None:
        """Claim through the fast-tier path, or return None when the queue is full-tier.

        The fast claim is complete_many_and_claim_v1 with no completions, and asks for at most
        fast_limit tasks. A full-tier queue rejects it, and the worker then claims that queue
        through claim_many until the next probe.
        """
        with self._state_lock:
            if self._full_tier_until.get(queue_name, float("-inf")) > sent_at:
                return None
        fast_limit = limit if fast_limit is None else min(limit, fast_limit)
        if fast_limit <= 0:
            return []
        try:
            rows = self._executor.rows(
                _STATEMENTS.complete_many_and_claim,
                (self.worker_id, [], [], [], queue_name, fast_limit, self.lease_ms),
            )
        except Exception as error:
            if not isinstance(_translate_database_error(error), FastTierUnsupportedError):
                raise
            self._mark_full_tier(queue_name, sent_at)
            return None
        # A claim that finds nothing still returns one row, with every claim column null.
        claimed = [row for row in rows if row["task_id"] is not None]
        with self._state_lock:
            self._full_tier_until.pop(queue_name, None)
            self._fast_tier_queues.add(queue_name)
            self._fast_task_ids.update(str(row["task_id"]) for row in claimed)
        return claimed

    def _mark_full_tier(self, queue_name: str, sent_at: float) -> None:
        """Claim a queue that rejected a fast-tier statement through claim_many until the probe."""
        with self._state_lock:
            self._full_tier_until[queue_name] = sent_at + _TIER_PROBE_INTERVAL_SECONDS
            self._fast_tier_queues.discard(queue_name)

    def _complete_fast_task(self, task: ClaimedTask, encoded_result: str) -> bool:
        """Complete a fast-tier attempt through the batched statement, and refill its slot.

        Completions of one queue and cohort that arrive while its statement is in flight share
        the next one. The statement also claims tasks into the slots the dispatch loop set aside
        for it. A queue that left the fast tier after the claim rejects that statement, so the
        attempt completes through complete_v1 instead.
        """
        reservation = self._reserve_completion_claim()
        pending = _PendingCompletion(task, encoded_result, reservation.limit, Event())
        try:
            self._send_batched_completion(pending, (task.queue, reservation.cohort))
        finally:
            self._settle_completion_claim(
                reservation, None if pending.error is not None else pending.claimed
            )
        if pending.error is not None:
            raise pending.error
        if pending.full_tier:
            return (
                _require_lifecycle_row(
                    self._executor.rows(
                        _STATEMENTS.complete,
                        (task.id, self.worker_id, task.fence_token, encoded_result),
                    )
                )["accepted"]
                is True
            )
        return pending.accepted

    def _reserve_completion_claim(self) -> _CompletionClaim:
        """Set aside the slots a completion's fused claim may fill (ADR 0076, rules 12 and 13).

        The claim asks for the free slots of the task's cohort plus the slot the task leaves. It
        claims nothing while the worker stops, pauses, or waits after an empty claim, and it waits
        for the cohort's refill batch while another claim for the cohort is in flight.
        """
        running = current_thread()
        with self._state_lock:
            slots = self._dispatch_slots
            wake_version = self._dispatch_wake_version
            if slots is None:
                return _CompletionClaim(0, 0, wake_version)
            cohort = slots.thread_cohorts.get(running, 0)
            if (
                not slots.open
                or self._stopping
                or self._run_errors
                or self._locally_paused
                or self._remotely_paused
                or slots.claim_error is not None
                or slots.empty_wait is not None
            ):
                return _CompletionClaim(cohort, 0, wake_version)
            limit = min(slots.free_slots(len(self._active_threads)), slots.cohort_free(cohort)) + 1
            if (
                slots.whole_claims > 0 or slots.cohort_claims[cohort] > 0
            ) and limit < slots.refill_batch:
                return _CompletionClaim(cohort, 0, wake_version)
            slots.reserved += limit
            slots.cohort_reserved[cohort] += limit
            slots.handed_over[running] = cohort
            slots.cohort_handed_over[cohort] += 1
            return _CompletionClaim(cohort, limit, wake_version)

    def _settle_completion_claim(
        self,
        reservation: _CompletionClaim,
        claimed: list[tuple[ClaimedTask, float]] | None,
    ) -> None:
        """Release a fused claim's reservation and start the tasks it claimed in its cohort.

        claimed is None when the completion failed.
        """
        if reservation.limit == 0:
            return
        running = current_thread()
        threads: list[Thread] = []
        with self._state_lock:
            slots = self._dispatch_slots
            if slots is None:
                return
            slots.reserved -= reservation.limit
            slots.cohort_reserved[reservation.cohort] -= reservation.limit
            # A claimed task took over this handler's slot. Without one, the slot stays this
            # handler's until it exits.
            if not claimed and slots.handed_over.pop(running, None) is not None:
                slots.cohort_handed_over[reservation.cohort] -= 1
            threads = [
                self._admit_claimed_task(next_task, claim_sent_at, reservation.cohort)
                for next_task, claim_sent_at in claimed or ()
            ]
            if claimed and any(next_task.type in self._handlers for next_task, _ in claimed):
                slots.claimed_any = True
                slots.consecutive_empty_claims = 0
            elif claimed is not None and not claimed and len(self.queues) == 1:
                # The fused claim asks one queue only, so it proves that queue empty when this
                # worker has no other.
                slots.consecutive_empty_claims += 1
                slots.pass_ended = True
                if slots.empty_wait is None:
                    slots.empty_wait = (
                        monotonic()
                        + self._dispatch_wait_seconds(
                            slots.listener, slots.consecutive_empty_claims
                        ),
                        reservation.wake_version,
                    )
        for thread in threads:
            thread.start()
        self._wake.set()

    def _send_batched_completion(self, pending: _PendingCompletion, key: tuple[str, int]) -> None:
        """Send a completion in the next statement of its batch key, and wait for its result.

        One statement per key is in flight. The first completion sends its own at once. Those
        that arrive meanwhile wait, and the first of them sends them all together when it returns.
        """
        with self._completion_lock:
            waiting = self._pending_completions.get(key)
            if waiting is None:
                self._pending_completions[key] = []
                batch = [pending]
            else:
                waiting.append(pending)
                batch = None
        if batch is None:
            pending.done.wait()
            if not pending.lead:
                return
            with self._completion_lock:
                batch = self._pending_completions[key]
                self._pending_completions[key] = []
        try:
            self._flush_completions(key[0], batch)
        finally:
            with self._completion_lock:
                waiting = self._pending_completions[key]
                if waiting:
                    waiting[0].lead = True
                    waiting[0].done.set()
                else:
                    del self._pending_completions[key]

    def _flush_completions(self, queue_name: str, batch: list[_PendingCompletion]) -> None:
        """Complete a batch in statements within the protocol's array and claim limits.

        A failed statement fails only the completions it carried.
        """
        start = 0
        while start < len(batch):
            end = start
            claim_limit = 0
            while (
                end < len(batch)
                and end - start < _COMPLETION_BATCH_LIMIT
                and claim_limit + batch[end].limit <= _COMPLETION_BATCH_LIMIT
            ):
                claim_limit += batch[end].limit
                end += 1
            chunk = batch[start:end]
            start = end
            try:
                self._send_completion_chunk(queue_name, chunk, claim_limit)
            except BaseException as error:
                for pending in chunk:
                    pending.error = error
            finally:
                for pending in chunk:
                    pending.done.set()

    def _send_completion_chunk(
        self, queue_name: str, chunk: list[_PendingCompletion], claim_limit: int
    ) -> None:
        sent_at = monotonic()
        try:
            rows = self._executor.rows(
                _STATEMENTS.complete_many_and_claim,
                (
                    self.worker_id,
                    [pending.task.id for pending in chunk],
                    [pending.task.fence_token for pending in chunk],
                    [pending.encoded_result for pending in chunk],
                    queue_name,
                    claim_limit,
                    self.lease_ms,
                ),
            )
        except Exception as error:
            if not isinstance(_translate_database_error(error), FastTierUnsupportedError):
                raise
            self._mark_full_tier(queue_name, sent_at)
            for pending in chunk:
                pending.full_tier = True
            return
        # Only the first row carries the accepted completions. A statement that claims nothing
        # still returns that row, with every claim column null.
        accepted = (
            {str(value) for value in cast(list[object], rows[0]["accepted"] or [])}
            if rows
            else set()
        )
        claimed_rows = [row for row in rows if row["task_id"] is not None]
        claimed_tasks = [_claimed_task(row, queue_name) for row in claimed_rows]
        with self._state_lock:
            self._full_tier_until.pop(queue_name, None)
            self._fast_tier_queues.add(queue_name)
            self._fast_task_ids.update(task.id for task in claimed_tasks)
        if claim_limit > 0:
            _record_claim(queue_name, (monotonic() - sent_at) * 1_000, claimed_tasks)
        for task in claimed_tasks:
            _emit_log(
                "DEBUG",
                "workhorse.task.claimed",
                "Task claimed",
                {
                    **_task_span_attributes(task),
                    "workhorse.queue.name": queue_name,
                    "workhorse.worker.id": self.worker_id,
                },
            )
        # Claimed tasks go to the completions in order, each up to the slots it reserved.
        remaining = iter(claimed_tasks)
        for pending in chunk:
            pending.accepted = pending.task.id in accepted
            pending.claimed = [(task, sent_at) for task in islice(remaining, pending.limit)]

    def _due_for_maintenance_routines(self, now_monotonic: float) -> bool:
        """Report whether this pass offers the slow routines, and claim the offer when it does."""
        if now_monotonic - self._last_routine_offer_at < self.maintenance_routine_poll_ms / 1000:
            return False
        self._last_routine_offer_at = now_monotonic
        return True

    def _retry_delay_override(self, task: ClaimedTask) -> int | None:
        """Report the delay this attempt sends to fail_v1, in milliseconds.

        A worker without the option, or a callable that declines, sends None and PostgreSQL
        applies the persisted retry policy.
        """
        override = self.retry_delay_ms
        if callable(override):
            override = override(task.attempt, task)
        if override is None:
            return None
        if isinstance(override, bool) or not isinstance(override, int) or override < 0:
            raise ValueError("retry_delay_ms must be a whole number of milliseconds, or None")
        return override

    def _run_maintenance_if_due(self) -> bool:
        now_monotonic = monotonic()
        if now_monotonic - self._last_maintenance_at < self.maintenance_interval_ms / 1000:
            return False
        with (
            _start_span(
                "workhorse.maintenance",
                {"workhorse.maintenance.operation": "tick"},
            ) as maintenance_span,
            _start_span("workhorse.recovery", {}) as recovery_span,
        ):
            tick = self._executor.rows(_STATEMENTS.tick, (100, 100))
            total_rows = 0
            for row in tick:
                phase = str(row["phase"])
                rows_affected = int(cast(int, row["rows_affected"]))
                duration_ms = float(cast(int | float, row["duration_ms"]))
                skipped_lock = row["skipped_lock"] is True
                has_error = row["error"] is not None
                total_rows += rows_affected
                _record_maintenance(
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
                        _record_recovery(
                            expired_leases,
                            retried,
                            row["retry_dimensions"],
                        )
                    if rows_affected > 0:
                        _emit_log(
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
                    _emit_log(
                        "INFO",
                        "workhorse.maintenance.completed",
                        "Maintenance phase completed",
                        attributes,
                    )
            slow_maintenance = (
                self._executor.rows(_STATEMENTS.run_maintenance, (datetime.now(UTC),))
                if self._due_for_maintenance_routines(now_monotonic)
                else ()
            )
            for row in slow_maintenance:
                phase = str(row["phase"])
                rows_affected = int(cast(int, row["rows_affected"]))
                duration_ms = float(cast(int | float, row["duration_ms"]))
                skipped_lock = row["skipped_lock"] is True
                has_error = row["error"] is not None
                total_rows += rows_affected
                _record_maintenance(
                    phase,
                    rows_affected,
                    duration_ms,
                    skipped_lock,
                    has_error,
                )
            maintenance_span.set_attribute("workhorse.maintenance.rows_affected", total_rows)
        self._last_maintenance_at = now_monotonic
        if not self.schedule_namespaces:
            return True
        now = datetime.now(UTC)
        fired_occurrences = self._executor.rows(
            _STATEMENTS.fire_due_schedules,
            (
                list(self.schedule_namespaces),
                None,
                self.schedule_catchup_limit,
                self.maintenance_interval_ms,
            ),
        )
        for fired in fired_occurrences:
            occurrence = cast(datetime, fired["occurrence_at"])
            task_id = fired["task_id"]
            schedule_attributes = {
                "workhorse.schedule.namespace": str(fired["namespace"]),
                "workhorse.schedule.name": str(fired["schedule_name"]),
            }
            if task_id is None:
                _emit_log(
                    "DEBUG",
                    "workhorse.schedule.fire_replayed",
                    "Recurring schedule occurrence replayed",
                    schedule_attributes,
                )
            else:
                _record_schedule_fired(
                    str(fired["namespace"]),
                    str(fired["schedule_name"]),
                    (now - occurrence).total_seconds(),
                )
                _emit_log(
                    "INFO",
                    "workhorse.schedule.fired",
                    "Recurring schedule fired",
                    {**schedule_attributes, "workhorse.task.id": str(task_id)},
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
                    _STATEMENTS.register_worker,
                    (
                        self.worker_id,
                        self._instance_id,
                        self._hostname,
                        os.getpid(),
                        list(self.queues),
                        list(self.schedule_namespaces),
                        self.concurrency,
                        self.lease_ms,
                        self.heartbeat_ms,
                        self.poll_ms,
                        self.maintenance_interval_ms,
                        self.maintenance_routine_poll_ms,
                        self.registry_interval_ms,
                        active_slots,
                        draining,
                        _PROTOCOL_VERSION,
                        _SDK_LANGUAGE,
                        _WORKHORSE_VERSION,
                    ),
                )
            )
            paused = row["paused"] is True
        except Exception as error:
            _emit_log(
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
        _emit_log(
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
            _emit_log(
                "INFO",
                "workhorse.worker.paused" if paused else "workhorse.worker.resumed",
                "Worker paused remotely" if paused else "Worker resumed remotely",
                {"workhorse.worker.id": self.worker_id},
            )
            self._wake_dispatcher()

    def _deregister(self) -> None:
        if not self._registered:
            return
        self._registered = False
        with suppress(Exception):
            self._executor.rows(_STATEMENTS.deregister_worker, (self.worker_id,))

    def _dispatch_wait_seconds(
        self, listener: _TaskNotificationListener | None, consecutive_empty_claims: int = 0
    ) -> float:
        listening = self._notification_listening.is_set() or (
            listener is not None and listener.is_listening()
        )
        wait_ms = (
            self._notification_poll_ms
            if listening
            else min(
                _MAX_EMPTY_POLL_MS,
                self.poll_ms * 2 ** max(0, consecutive_empty_claims - 1),
            )
        )
        wait_ms = max(1, round(wait_ms * random.uniform(0.9, 1.1)))
        if self.registry_interval_ms > 0:
            wait_ms = min(wait_ms, self.registry_interval_ms)
        return wait_ms / 1000

    def _wake_from_notification(self) -> None:
        self._notification_wake.set()
        self._wake_dispatcher()

    def _set_notification_listening(self, listening: bool) -> None:
        if listening:
            self._notification_listening.set()
        else:
            self._notification_listening.clear()

    def _start_notification_listener(self) -> _TaskNotificationListener | None:
        if self._notification_connection_factory is None:
            return None
        listener = _TaskNotificationListener(
            self._notification_connection_factory,
            self.queues,
            self._wake_from_notification,
            self._on_notification_error,
            None,
        )
        listener.start()
        return listener

    def _admit_claimed_task(
        self, task: ClaimedTask, claim_sent_at: float, cohort: int | None
    ) -> Thread:
        """Give a claimed task a slot and its handler thread, which the caller starts.

        The caller holds the state lock, so the slot and the reservation it came from change
        together. The task joins cohort while that cohort has a free slot, and the roomiest cohort
        otherwise.
        """
        thread = Thread(
            target=self._run_claimed_task,
            args=(task, claim_sent_at),
            name=f"workhorse-handler-{task.id}",
        )
        # The dispatcher assigns this in claim order. A batch coordinator cannot read arrival
        # order off its own lock instead, because handler threads start concurrently and reach
        # that lock in scheduler order, not claim order.
        self._dispatch_order[task.id] = self._dispatch_sequence
        self._dispatch_sequence += 1
        self._active_threads.add(thread)
        slots = self._dispatch_slots
        if slots is not None:
            if cohort is None or slots.cohort_free(cohort) <= 0:
                cohort = slots.roomiest_cohort()
            slots.cohort_active[cohort] += 1
            slots.thread_cohorts[thread] = cohort
        return thread

    def _claim_order(self, task: ClaimedTask) -> int:
        with self._state_lock:
            return self._dispatch_order.get(task.id, self._dispatch_sequence)

    def _run_claimed_task(self, task: ClaimedTask, claim_sent_at: float) -> None:
        try:
            self._execute_claimed_task(task, claim_sent_at)
        except StaleLeaseError:
            # A lost lease ends this attempt only. Lease recovery already owns the task, and the
            # execution log records the lease_lost outcome, so the worker keeps claiming.
            pass
        except BaseException as error:
            with self._state_lock:
                self._run_errors.append(error)
                self._stopping = True
        finally:
            running = current_thread()
            with self._state_lock:
                self._active_threads.discard(running)
                self._dispatch_order.pop(task.id, None)
                self._fast_task_ids.discard(task.id)
                slots = self._dispatch_slots
                if slots is not None:
                    cohort = slots.thread_cohorts.pop(running, None)
                    if cohort is not None:
                        slots.cohort_active[cohort] -= 1
                        if slots.handed_over.pop(running, None) is not None:
                            slots.cohort_handed_over[cohort] -= 1
            self._wake.set()

    def _drain_active_threads(self) -> None:
        while True:
            with self._state_lock:
                active = list(self._active_threads)
            if not active:
                return
            for thread in active:
                # A fused completion admits a claimed task's thread under the state lock and
                # starts it after releasing the lock, so the drain can see it before it starts.
                while thread.ident is None:
                    sleep(0.001)
                thread.join()

    def _execute_claimed_task(self, task: ClaimedTask, claim_sent_at: float) -> None:
        arbiter = _AttemptOutcomeArbiter()
        span_outcome = {"value": "unknown"}
        span_errors: list[str] = []
        started_at = monotonic()
        attributes = {"workhorse.queue.name": task.queue, **_task_span_attributes(task)}
        with _start_span(
            "workhorse.handler",
            attributes,
            trace_context=task.trace_context,
            consumer=True,
        ) as handler_span:
            _emit_log(
                "DEBUG",
                "workhorse.handler.started",
                "Task handler started",
                {**attributes, "workhorse.worker.id": self.worker_id},
            )
            try:
                self._execute_claimed_task_within_span(
                    task, claim_sent_at, arbiter, span_outcome, span_errors
                )
            except BaseException as error:
                _record_span_error(handler_span, error.__class__.__name__)
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
                    _record_span_error(handler_span, span_errors[0])
                _record_handler_execution(task, outcome, duration_ms)
                _emit_log(
                    "DEBUG",
                    "workhorse.handler.finished",
                    "Task handler finished",
                    {
                        **attributes,
                        "workhorse.worker.id": self.worker_id,
                        "workhorse.handler.duration_ms": duration_ms,
                    },
                )
                _emit_log(
                    "INFO",
                    "workhorse.task.execution_finished",
                    "Task execution finished",
                    {
                        **attributes,
                        "workhorse.worker.id": self.worker_id,
                        "workhorse.handler.outcome": outcome,
                    },
                )

    def _execute_claimed_task_within_span(
        self,
        task: ClaimedTask,
        claim_sent_at: float,
        arbiter: _AttemptOutcomeArbiter,
        span_outcome: dict[str, str],
        span_errors: list[str],
    ) -> None:
        handler = self._handlers.get(task.type)
        if handler is None:
            release_outcome, release_status = self._release_owned_task(task)
            span_outcome["value"] = release_status
            arbiter.submit(release_outcome)
            return
        heartbeat_stop = Event()
        heartbeat_error: list[BaseException] = []
        cancellation = CancellationToken()
        handler_parent_context = _current_context()

        def deliver_status(status: object) -> bool:
            outcome = _outcome_for_status(status, neutral=frozenset({"accepted"}))
            if outcome is None:
                return False
            arbiter.submit(outcome)
            if outcome == "cancelled":
                cancellation._cancel(CancellationRequestedError(task.id))
            elif outcome == "deadline_exceeded":
                cancellation._cancel(DeadlineExceededError(task.id))
            elif outcome == "attempt_timeout":
                cancellation._cancel(ExecutionTimeoutError(task.id, task.attempt))
            else:
                cancellation._cancel(StaleLeaseError(task.id))
            return True

        # The lease watchdog ends this attempt once its last accepted renewal is a full lease old.
        # By then a peer may own the task, so the handler must stop even though no round rejected
        # it. It measures from when a request left, so a slow answer shortens the watchdog instead
        # of overrunning the lease PostgreSQL granted.
        renewal_lock = Lock()
        renewed_at = claim_sent_at

        def renew_lease(sent_at: float) -> None:
            nonlocal renewed_at
            with renewal_lock:
                renewed_at = max(renewed_at, sent_at)

        def lease_deadline() -> float:
            with renewal_lock:
                return renewed_at + self.lease_ms / 1000

        def expire_lease_locally() -> None:
            arbiter.submit("lease_expired")
            unregister_heartbeat()
            cancellation._cancel(StaleLeaseError(task.id))

        def watch_expiration() -> None:
            expiration_at = _earliest_expiration(task)
            expiration_retry_at: float | None = None
            while True:
                expiration_delay = _expiration_delay(expiration_at, expiration_retry_at)
                lease_delay = lease_deadline() - monotonic()
                if expiration_delay is None or lease_delay < expiration_delay:
                    if lease_delay > 0:
                        if heartbeat_stop.wait(lease_delay):
                            return
                        # An accepted round may have moved the deadline while this thread waited.
                        continue
                    expire_lease_locally()
                    return
                wait_seconds = max(0.0, expiration_delay)
                if heartbeat_stop.wait(wait_seconds):
                    return
                try:
                    status = self._expire_owned_task(task, handler_parent_context)
                    if status == "not_due":
                        expiration_retry_at = monotonic() + 0.005
                        continue
                    deliver_status(status)
                    return
                except BaseException as error:
                    heartbeat_error.append(error)
                    cancellation._cancel(error)
                    return

        unregister_heartbeat = self._register_heartbeat(
            task, deliver_status, renew_lease, cancellation, heartbeat_error, handler_parent_context
        )
        expiration_thread = Thread(target=watch_expiration, name=f"workhorse-expiration-{task.id}")
        expiration_thread.start()
        with self._state_lock:
            fast_tier = task.id in self._fast_task_ids
        durability = _HandlerDurability(
            self._executor,
            task,
            self.worker_id,
            cancellation,
            arbiter,
            fast_tier,
        )

        ownership_released = False

        def release_ownership() -> None:
            nonlocal ownership_released
            if ownership_released:
                return
            ownership_released = True
            unregister_heartbeat()
            heartbeat_stop.set()
            expiration_thread.join()

        def finish_ownership_lifecycle(cause: Exception | None = None) -> bool:
            release_ownership()
            if self._finish_lifecycle_outcome(task, arbiter.outcome):
                return True
            if heartbeat_error:
                if cause is None:
                    raise heartbeat_error[0]
                raise heartbeat_error[0] from cause
            return False

        try:
            result = handler(task.payload, durability.context())
            self._validate_result_contract(task, result)
            encoded_result = json.dumps(result, separators=(",", ":"))
        except _DurableWaitSuspension:
            if finish_ownership_lifecycle():
                return
            raise RuntimeError("Durable wait suspension was not accepted by the arbiter") from None
        except Exception as error:
            if finish_ownership_lifecycle(error):
                return
            failure_outcome, failure_state = self._settle_failure(task, error)
            span_outcome["value"] = failure_state
            span_errors.append(
                _REDACTED_ERROR_NAME if task.redact_error_details else type(error).__name__
            )
            arbiter.submit(failure_outcome)
            return
        finally:
            # A BaseException such as SystemExit skips both handlers above. Stop renewing the lease
            # and join the non-daemon expiration thread anyway, or the process cannot exit.
            release_ownership()
        if finish_ownership_lifecycle():
            if arbiter.outcome in {"suspended_for_wait", "suspended_for_child"}:
                _emit_log(
                    "WARN",
                    "workhorse.handler.signal_swallowed",
                    "Task handler swallowed its suspension signal",
                    {
                        **_task_span_attributes(task),
                        "workhorse.queue.name": task.queue,
                        "workhorse.worker.id": self.worker_id,
                        "workhorse.handler.outcome": "suspended",
                    },
                )
            return
        with _start_span("workhorse.complete", _task_span_attributes(task)) as completion_span:
            accepted = (
                self._complete_fast_task(task, encoded_result)
                if fast_tier
                else _require_lifecycle_row(
                    self._executor.rows(
                        _STATEMENTS.complete,
                        (task.id, self.worker_id, task.fence_token, encoded_result),
                    )
                )["accepted"]
            )
            completion_span.set_attribute("workhorse.complete.accepted", accepted is True)
            _emit_log(
                "INFO",
                "workhorse.task.completed"
                if accepted is True
                else "workhorse.task.completion_rejected",
                "Task completed" if accepted is True else "Stale task completion rejected",
                {
                    **_task_span_attributes(task),
                    "workhorse.complete.accepted": accepted is True,
                    "workhorse.worker.id": self.worker_id,
                },
            )
        if accepted is not True:
            if self._acknowledge_cancel(task):
                arbiter.submit("cancelled")
                return
            arbiter.submit("lease_expired")
            raise StaleLeaseError(task.id)
        _record_completion(task)
        arbiter.submit("completed")

    def _finish_lifecycle_outcome(self, task: ClaimedTask, outcome: _AttemptOutcome | None) -> bool:
        if outcome in {"suspended_for_wait", "suspended_for_child"}:
            return True
        if outcome == "cancelled":
            if not self._acknowledge_cancel(task):
                raise StaleLeaseError(task.id)
            return True
        if outcome in {"deadline_exceeded", "attempt_timeout"}:
            return True
        if outcome == "lease_expired":
            raise StaleLeaseError(task.id)
        return False

    def _acknowledge_cancel(self, task: ClaimedTask) -> bool:
        accepted = (
            _require_lifecycle_row(
                self._executor.rows(
                    _STATEMENTS.acknowledge_cancel,
                    (task.id, self.worker_id, task.fence_token),
                )
            )["accepted"]
            is True
        )
        _emit_log(
            "INFO",
            "workhorse.task.cancellation_acknowledged",
            "Task cancellation acknowledged",
            {
                **_task_span_attributes(task),
                "workhorse.cancel.accepted": accepted,
                "workhorse.worker.id": self.worker_id,
            },
        )
        return accepted

    def _release_owned_task(self, task: ClaimedTask) -> tuple[_AttemptOutcome, str]:
        """Give back a claim whose task type this worker has no handler for.

        A claim carries no task-type filter, so a worker can hold a task it cannot run. The attempt
        belongs to whichever worker reaches the handler, so PostgreSQL returns the task to its queue
        with its attempt untouched rather than charging this worker's refusal to it. During a
        rolling deployment that is what keeps the old release from retrying away the new one's task
        types.
        """
        attributes = {
            **_task_span_attributes(task),
            "workhorse.queue.name": task.queue,
            "workhorse.worker.id": self.worker_id,
        }
        _emit_log(
            "WARN",
            "workhorse.handler.missing",
            "No handler registered for the claimed task type",
            attributes,
        )
        status = _require_lifecycle_row(
            self._executor.rows(
                _STATEMENTS.release_owned,
                (task.id, self.worker_id, task.fence_token),
            )
        )["status"]
        status_text = str(status)
        _emit_log(
            "INFO",
            "workhorse.task.release_processed",
            "Owned task release processed",
            {**attributes, "workhorse.release.status": status_text},
        )
        if status_text == "released":
            return "released", status_text
        # A boundary the database already passed cannot come back, so not_due never answers a
        # release; treating it as lease loss keeps this total without inventing a fifth outcome.
        outcome = _outcome_for_status(status, neutral=frozenset({"not_due"}))
        if outcome is None:
            return "lease_expired", status_text
        if outcome == "cancelled":
            if not self._acknowledge_cancel(task):
                raise StaleLeaseError(task.id)
            return "cancelled", status_text
        if outcome == "lease_expired":
            raise StaleLeaseError(task.id)
        return outcome, status_text

    def _settle_failure(self, task: ClaimedTask, error: Exception) -> tuple[_AttemptOutcome, str]:
        envelope = _error_envelope(error, task.redact_error_details)
        with _start_span("workhorse.retry", _task_span_attributes(task)) as retry_span:
            state = _require_lifecycle_row(
                self._executor.rows(
                    _STATEMENTS.fail,
                    (
                        task.id,
                        self.worker_id,
                        task.fence_token,
                        json.dumps(envelope),
                        self._retry_delay_override(task),
                    ),
                )
            )["state"]
            state_text = str(state)
            retry_span.set_attribute("workhorse.retry.outcome", state_text)
            _record_failure(task, state_text)
            _emit_log(
                "INFO",
                "workhorse.task.failure_processed",
                "Task attempt failure processed",
                {
                    **_task_span_attributes(task),
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
            if not self._acknowledge_cancel(task):
                raise StaleLeaseError(task.id) from error
            return "cancelled", state_text
        if outcome == "lease_expired":
            raise StaleLeaseError(task.id) from error
        return outcome, state_text


def _claimed_task(row: _Row, queue: str) -> ClaimedTask:
    return ClaimedTask(
        id=str(row["task_id"]),
        queue=queue,
        type=str(row["task_type"]),
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
            f"Batch handler for {type} returned {len(outcomes)} outcomes for {expected} tasks"
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


def _checkpoint_record(task_id: str, row: _Row, *, name: str | None = None) -> TaskCheckpoint:
    return TaskCheckpoint(
        task_id=task_id,
        name=name or str(row["checkpoint_name"]),
        value=cast(Json, row["checkpoint_value"]),
        attempt=int(cast(int, row["attempt"])),
        fence_token=int(cast(int, row["fence_token"])),
        worker_id=str(row["worker_id"]),
        created_at=cast(datetime, row["created_at"]),
    )


def _progress_record(task_id: str, row: _Row) -> TaskProgress:
    return TaskProgress(
        task_id=task_id,
        value=cast(Json, row["progress_value"]),
        revision=int(cast(int | str, row["revision"])),
        attempt=int(cast(int, row["attempt"])),
        fence_token=int(cast(int | str, row["fence_token"])),
        worker_id=str(row["worker_id"]),
        created_at=cast(datetime, row["created_at"]),
        updated_at=cast(datetime, row["updated_at"]),
    )


def _wait_record(task_id: str, row: _Row, *, name: str | None = None) -> TaskWait:
    mode = str(row["mode"])
    if mode not in {"relative", "absolute"}:
        raise RuntimeError(f"Unexpected durable wait mode: {mode}")
    return TaskWait(
        task_id=task_id,
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


class _PoolConnectionLease:
    def __init__(self, context: Any, connection: Any) -> None:
        self._context = context
        self._connection = connection

    def __getattr__(self, name: str) -> Any:
        return getattr(self._connection, name)

    def close(self) -> None:
        self._context.__exit__(None, None, None)


def _pool_connection(pool: _PsycopgPool) -> _PoolConnectionLease:
    context = pool.connection()
    connection = context.__enter__()
    return _PoolConnectionLease(context, connection)


def _psycopg_pool_notification_factory(pool: _PsycopgPool) -> _NotificationConnectionFactory:
    def open_connection() -> _SyncConnection:
        connection = _pool_connection(pool)
        if getattr(connection, "autocommit", False) is not True:
            connection.close()
            raise ValueError("Notification connection must be in autocommit mode")
        return cast(_SyncConnection, connection)

    return open_connection


def _psycopg_pool_heartbeat_executor_factory(pool: _PsycopgPool) -> _HeartbeatExecutorFactory:
    def open_heartbeat_executor() -> tuple[_SyncRowExecutor, Callable[[], None]]:
        connection = _pool_connection(pool)
        if getattr(connection, "autocommit", False) is not True:
            connection.close()
            raise ValueError("Heartbeat connection must be in autocommit mode")
        return _SyncExecutor(cast(_PsycopgConnection, connection)), connection.close

    return open_heartbeat_executor


def _require_lifecycle_row(rows: list[_Row]) -> _Row:
    if len(rows) != 1:
        raise RuntimeError("PostgreSQL lifecycle transition did not return exactly one row")
    return rows[0]


def _outcome_for_status(status: object, *, neutral: frozenset[str]) -> _AttemptOutcome | None:
    if not isinstance(status, str):
        raise RuntimeError("PostgreSQL returned a non-string lifecycle status")
    if status in neutral:
        return None
    try:
        return _STATUS_OUTCOMES[status]
    except KeyError as error:
        raise RuntimeError(f"PostgreSQL returned unknown lifecycle status {status!r}") from error


_TELEMETRY_OUTCOMES: dict[_AttemptOutcome | None, _TaskExecutionOutcome] = {
    "completed": "succeeded",
    "failed": "failed",
    "retry": "retry",
    "lease_expired": "lease_lost",
    "released": "released",
    "deadline_exceeded": "deadline_exceeded",
    "attempt_timeout": "timeout",
    "cancelled": "canceled",
    "suspended_for_wait": "suspended",
    "suspended_for_child": "suspended",
    None: "unknown",
}

_HANDLER_SPAN_OUTCOMES: dict[_AttemptOutcome | None, str] = {
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


def _telemetry_outcome(
    outcome: _AttemptOutcome | None,
) -> _TaskExecutionOutcome:
    return _TELEMETRY_OUTCOMES[outcome]


def _handler_span_outcome(outcome: _AttemptOutcome | None) -> str:
    return _HANDLER_SPAN_OUTCOMES[outcome]


def _earliest_expiration(task: ClaimedTask) -> datetime | None:
    candidates = [
        value for value in (task.deadline_at, task.attempt_timeout_at) if value is not None
    ]
    return min(candidates) if candidates else None


def _expiration_delay(expiration_at: datetime | None, retry_at: float | None) -> float | None:
    if retry_at is not None:
        return retry_at - monotonic()
    if expiration_at is None:
        return None
    return (expiration_at - datetime.now(UTC)).total_seconds()


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


__all__ = ["BatchHandler", "Handler", "Worker"]
