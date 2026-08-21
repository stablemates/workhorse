from __future__ import annotations

import json
import os
import socket
import traceback
from collections.abc import Callable, Sequence
from datetime import datetime, timezone
from threading import Event, Lock, Thread, current_thread
from time import monotonic
from typing import TYPE_CHECKING, Any, Literal, cast
from uuid import uuid4

from ._compatibility import CachedCompatibilityCheck
from ._drivers import PsycopgConnection, Row, SyncExecutor
from ._statements import STATEMENTS
from .errors import (
    CancellationRequestedError,
    DeadlineExceededError,
    ExecutionTimeoutError,
    StaleLeaseError,
)
from .types import CancellationToken, ClaimedJob, HandlerContext, Json

if TYPE_CHECKING:
    import psycopg

    SyncConnection = psycopg.Connection[Any]
else:
    SyncConnection = PsycopgConnection

Handler = Callable[[Any, HandlerContext], Json]

_REDACTED_ERROR_NAME = "RedactedJobError"
_REDACTED_ERROR_MESSAGE = "Job handler failed; details redacted"
AttemptOutcome = Literal[
    "completed",
    "failed",
    "lease_expired",
    "deadline_exceeded",
    "attempt_timeout",
    "cancelled",
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
        poll_ms: int = 250,
        lease_ms: int = 30_000,
        heartbeat_ms: int | None = None,
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
        if isinstance(poll_ms, bool) or not isinstance(poll_ms, int) or poll_ms < 1:
            raise ValueError("poll_ms must be a positive integer")
        self._executor = SyncExecutor(cast(PsycopgConnection, connection))
        self._compatibility = CachedCompatibilityCheck(self._executor)
        self._handlers: dict[str, Handler] = {}
        self.queues = unique_queues
        self.queue = unique_queues[0]
        self.worker_id = worker_id or _default_worker_id()
        self.concurrency = concurrency
        self.poll_ms = poll_ms
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
                    self._wake.wait(self.poll_ms / 1000)
                    continue
                if state == "full":
                    self._wake.wait(self.poll_ms / 1000)
                    continue

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
                    self._wake.wait(self.poll_ms / 1000)
                    continue
                if state == "full":
                    self._wake.wait(self.poll_ms / 1000)
        finally:
            self._drain_active_threads()
            with self._state_lock:
                self._stopping = False
                errors = list(self._run_errors)
                self._run_errors.clear()
        if errors:
            raise errors[0]
        return claimed_any

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
            result = handler(job.payload, HandlerContext(job, cancellation))
            encoded_result = json.dumps(result, separators=(",", ":"))
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
