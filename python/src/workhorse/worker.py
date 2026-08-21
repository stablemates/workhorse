from __future__ import annotations

import json
import os
import socket
import traceback
from collections.abc import Callable
from typing import TYPE_CHECKING, Any, cast
from uuid import uuid4

from ._compatibility import CachedCompatibilityCheck
from ._drivers import PsycopgConnection, Row, SyncExecutor
from ._statements import STATEMENTS
from .errors import StaleLeaseError
from .types import ClaimedJob, HandlerContext, Json

if TYPE_CHECKING:
    import psycopg

    SyncConnection = psycopg.Connection[Any]
else:
    SyncConnection = PsycopgConnection

Handler = Callable[[Any, HandlerContext], Json]

_REDACTED_ERROR_NAME = "RedactedJobError"
_REDACTED_ERROR_MESSAGE = "Job handler failed; details redacted"


class Worker:
    """A synchronous, single-slot worker over a dedicated Psycopg connection."""

    def __init__(
        self,
        connection: SyncConnection,
        *,
        queue: str = "default",
        worker_id: str | None = None,
        lease_ms: int = 30_000,
    ) -> None:
        if getattr(connection, "autocommit", False) is not True:
            raise ValueError("Worker requires a dedicated Psycopg connection in autocommit mode")
        self._executor = SyncExecutor(cast(PsycopgConnection, connection))
        self._compatibility = CachedCompatibilityCheck(self._executor)
        self._handlers: dict[str, Handler] = {}
        self.queue = queue
        self.worker_id = worker_id or _default_worker_id()
        self.lease_ms = lease_ms

    def handle(self, type: str, handler: Handler) -> Worker:
        self._handlers[type] = handler
        return self

    def run_once(self) -> bool:
        """Claim and settle at most one job, returning whether PostgreSQL granted a claim."""
        self._compatibility.assert_compatible()
        rows = self._executor.rows(
            STATEMENTS.claim,
            (self.queue, self.worker_id, self.lease_ms),
        )
        if not rows:
            return False
        job = _claimed_job(rows[0], self.queue)
        handler = self._handlers.get(job.type)
        if handler is None:
            error = RuntimeError(f"No handler registered for {job.type}")
            self._settle_failure(job, error)
            return True
        try:
            result = handler(job.payload, HandlerContext(job))
            encoded_result = json.dumps(result, separators=(",", ":"))
        except Exception as error:
            self._settle_failure(job, error)
            return True
        accepted = _require_lifecycle_row(
            self._executor.rows(
                STATEMENTS.complete,
                (job.id, self.worker_id, job.fence_token, encoded_result),
            )
        )["accepted"]
        if accepted is not True:
            raise StaleLeaseError(job.id)
        return True

    def _settle_failure(self, job: ClaimedJob, error: Exception) -> None:
        envelope = _error_envelope(error, job.redact_error_details)
        state = _require_lifecycle_row(
            self._executor.rows(
                STATEMENTS.fail,
                (job.id, self.worker_id, job.fence_token, json.dumps(envelope), None),
            )
        )["state"]
        if state == "stale":
            raise StaleLeaseError(job.id) from error


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
