from __future__ import annotations

import json
import os
import socket
import traceback
from collections.abc import Callable
from datetime import datetime, timezone
from threading import Event, Lock, Thread
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
    """A synchronous, single-slot worker over a dedicated Psycopg connection."""

    def __init__(
        self,
        connection: SyncConnection,
        *,
        queue: str = "default",
        worker_id: str | None = None,
        lease_ms: int = 30_000,
        heartbeat_ms: int | None = None,
    ) -> None:
        if getattr(connection, "autocommit", False) is not True:
            raise ValueError("Worker requires a dedicated Psycopg connection in autocommit mode")
        self._executor = SyncExecutor(cast(PsycopgConnection, connection))
        self._compatibility = CachedCompatibilityCheck(self._executor)
        self._handlers: dict[str, Handler] = {}
        self.queue = queue
        self.worker_id = worker_id or _default_worker_id()
        if not 100 <= lease_ms <= 86_400_000:
            raise ValueError("lease_ms must be between 100 and 86400000")
        self.lease_ms = lease_ms
        self.heartbeat_ms = heartbeat_ms if heartbeat_ms is not None else max(100, lease_ms // 3)
        if not 0 < self.heartbeat_ms < self.lease_ms:
            raise ValueError("heartbeat_ms must be positive and less than lease_ms")

    def handle(self, type: str, handler: Handler) -> Worker:
        self._handlers[type] = handler
        return self

    def run_once(self) -> bool:
        """Claim and settle at most one job, returning whether PostgreSQL granted a claim."""
        self._compatibility.assert_compatible()
        _require_lifecycle_row(self._executor.rows(STATEMENTS.recover_expired, (100, None)))
        rows = self._executor.rows(
            STATEMENTS.claim,
            (self.queue, self.worker_id, self.lease_ms),
        )
        if not rows:
            return False
        job = _claimed_job(rows[0], self.queue)
        arbiter = _AttemptOutcomeArbiter()
        handler = self._handlers.get(job.type)
        if handler is None:
            error = RuntimeError(f"No handler registered for {job.type}")
            arbiter.submit(self._settle_failure(job, error))
            return True
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
                return True
            arbiter.submit(self._settle_failure(job, error))
            return True
        if finish_ownership_lifecycle():
            return True
        accepted = _require_lifecycle_row(
            self._executor.rows(
                STATEMENTS.complete,
                (job.id, self.worker_id, job.fence_token, encoded_result),
            )
        )["accepted"]
        if accepted is not True:
            if self._acknowledge_cancel(job):
                arbiter.submit("cancelled")
                return True
            arbiter.submit("lease_expired")
            raise StaleLeaseError(job.id)
        arbiter.submit("completed")
        return True

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
