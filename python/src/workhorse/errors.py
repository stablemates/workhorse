from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Literal

CompatibilityCode = Literal[
    "schema-not-installed",
    "schema-too-old",
    "schema-too-new",
    "client-protocol-too-old",
    "client-protocol-too-new",
]


class WorkhorseError(Exception):
    """Base class for failures translated by the Workhorse client."""


class LifecycleError(WorkhorseError):
    """Base class for a worker lifecycle transition rejected by PostgreSQL."""


class StaleLeaseError(LifecycleError):
    def __init__(self, job_id: str) -> None:
        self.job_id = job_id
        super().__init__("Job lease was lost")


class CancellationRequestedError(WorkhorseError):
    def __init__(self, job_id: str) -> None:
        self.job_id = job_id
        super().__init__(f"Cancellation was requested for job {job_id}")


class DeadlineExceededError(WorkhorseError):
    def __init__(self, job_id: str) -> None:
        self.job_id = job_id
        super().__init__(f"Deadline was exceeded for job {job_id}")


class ExecutionTimeoutError(WorkhorseError):
    def __init__(self, job_id: str, attempt: int) -> None:
        self.job_id = job_id
        self.attempt = attempt
        super().__init__(f"Execution timeout was exceeded for job {job_id} attempt {attempt}")


class CheckpointLeaseLostError(LifecycleError):
    def __init__(self, job_id: str, checkpoint_name: str) -> None:
        self.job_id = job_id
        self.checkpoint_name = checkpoint_name
        super().__init__(
            f"Cannot save checkpoint {checkpoint_name} for job {job_id} under a stale lease"
        )


class CheckpointConflictError(WorkhorseError):
    def __init__(self, job_id: str, checkpoint_name: str) -> None:
        self.job_id = job_id
        self.checkpoint_name = checkpoint_name
        super().__init__(
            f"Checkpoint {checkpoint_name} for job {job_id} already has a different value"
        )


class ProgressLeaseLostError(LifecycleError):
    def __init__(self, job_id: str) -> None:
        self.job_id = job_id
        super().__init__(f"Cannot update progress for job {job_id} under a stale lease")


class ProgressRateLimitError(WorkhorseError):
    def __init__(self, job_id: str, retry_after_ms: int) -> None:
        self.job_id = job_id
        self.retry_after_ms = retry_after_ms
        super().__init__(
            f"Cannot update progress for job {job_id} yet; "
            f"retry after {retry_after_ms} milliseconds"
        )


class ChildLeaseLostError(LifecycleError):
    def __init__(self, parent_job_id: str) -> None:
        self.parent_job_id = parent_job_id
        super().__init__(
            f"Cannot create a child for job {parent_job_id} because the lease is stale or expired"
        )


class ChildConflictError(WorkhorseError):
    def __init__(self, parent_job_id: str, child_name: str) -> None:
        self.parent_job_id = parent_job_id
        self.child_name = child_name
        super().__init__(
            f"Child {child_name} for job {parent_job_id} already exists with a different request"
        )


class ChildLimitExceededError(WorkhorseError):
    def __init__(self, parent_job_id: str) -> None:
        self.parent_job_id = parent_job_id
        super().__init__(f"Job {parent_job_id} exceeds the supported child limit")


class ChildResultLimitExceededError(WorkhorseError):
    def __init__(self, parent_job_id: str, result_bytes: int, result_limit_bytes: int) -> None:
        self.parent_job_id = parent_job_id
        self.result_bytes = result_bytes
        self.result_limit_bytes = result_limit_bytes
        super().__init__(
            f"Joined child results for job {parent_job_id} exceed its configured size limit"
        )


class WaitLeaseLostError(LifecycleError):
    def __init__(self, job_id: str, wait_name: str) -> None:
        self.job_id = job_id
        self.wait_name = wait_name
        super().__init__(f"Cannot schedule wait {wait_name} for job {job_id} under a stale lease")


class WaitConflictError(WorkhorseError):
    def __init__(self, job_id: str, wait_name: str) -> None:
        self.job_id = job_id
        self.wait_name = wait_name
        super().__init__(f"Wait {wait_name} for job {job_id} has a conflicting target")


class WaitLimitExceededError(WorkhorseError):
    def __init__(self, job_id: str) -> None:
        self.job_id = job_id
        super().__init__(f"Job {job_id} already has the maximum number of durable waits")


class SignalWaitLeaseLostError(LifecycleError):
    def __init__(self, job_id: str, wait_name: str) -> None:
        self.job_id = job_id
        self.wait_name = wait_name
        super().__init__(
            f"Signal wait {wait_name} for job {job_id} cannot be recorded under a stale lease"
        )


class SignalWaitConflictError(WorkhorseError):
    def __init__(self, job_id: str, wait_name: str) -> None:
        self.job_id = job_id
        self.wait_name = wait_name
        super().__init__(f"Signal wait {wait_name} for job {job_id} is already waiting")


class SignalWaitLimitExceededError(WorkhorseError):
    def __init__(self, job_id: str) -> None:
        self.job_id = job_id
        super().__init__(f"Job {job_id} already has the maximum number of signal waits")


class SignalIdempotencyConflictError(WorkhorseError):
    def __init__(self, job_id: str, wait_name: str) -> None:
        self.job_id = job_id
        self.wait_name = wait_name
        super().__init__(
            f"Signal {wait_name} for job {job_id} received a different idempotent request"
        )


class HumanWaitLeaseLostError(LifecycleError):
    def __init__(self, job_id: str, wait_name: str) -> None:
        self.job_id = job_id
        self.wait_name = wait_name
        super().__init__(
            f"Human wait {wait_name} for job {job_id} cannot be recorded under a stale lease"
        )


class HumanWaitAlreadyWaitingError(WorkhorseError):
    def __init__(self, job_id: str, wait_name: str) -> None:
        self.job_id = job_id
        self.wait_name = wait_name
        super().__init__(f"Human wait {wait_name} for job {job_id} is already waiting")


class HumanWaitLimitExceededError(WorkhorseError):
    def __init__(self, job_id: str) -> None:
        self.job_id = job_id
        super().__init__(f"Job {job_id} already has the maximum number of human waits")


class HumanWaitConflictError(WorkhorseError):
    def __init__(self, job_id: str, wait_name: str) -> None:
        self.job_id = job_id
        self.wait_name = wait_name
        super().__init__(f"Human wait {wait_name} for job {job_id} has different context")


class HumanWaitIdempotencyConflictError(WorkhorseError):
    def __init__(self, job_id: str, wait_name: str) -> None:
        self.job_id = job_id
        self.wait_name = wait_name
        super().__init__(
            f"Human wait {wait_name} for job {job_id} received a different idempotent completion"
        )


class ProtocolCompatibilityError(WorkhorseError):
    def __init__(self, code: CompatibilityCode) -> None:
        self.code = code
        super().__init__(f"SQL protocol compatibility check refused mutation: {code}")


class EnqueueIdempotencyConflictError(WorkhorseError):
    def __init__(self, details: Mapping[str, object]) -> None:
        self.details = details
        super().__init__("PostgreSQL rejected a materially different idempotent enqueue")


class DependencyCycleError(WorkhorseError):
    def __init__(self, details: Mapping[str, object]) -> None:
        self.details = details
        super().__init__("PostgreSQL rejected a cyclic job dependency")


class DependencyLimitExceededError(WorkhorseError):
    def __init__(self, details: Mapping[str, object]) -> None:
        self.details = details
        super().__init__("PostgreSQL rejected a job dependency limit")


def translate_database_error(error: Exception) -> WorkhorseError | None:
    sqlstate = getattr(error, "sqlstate", None) or getattr(error, "code", None)
    if sqlstate not in {"P1001", "P1003", "P1005"}:
        return None
    diagnostic = getattr(error, "diag", None)
    raw_detail = getattr(diagnostic, "message_detail", None) or getattr(error, "detail", None)
    details: Mapping[str, object] = {}
    if isinstance(raw_detail, str):
        try:
            parsed = json.loads(raw_detail)
            if isinstance(parsed, dict):
                details = parsed
        except json.JSONDecodeError:
            pass
    elif isinstance(raw_detail, Mapping):
        details = raw_detail
    if sqlstate == "P1001":
        return EnqueueIdempotencyConflictError(details)
    if sqlstate == "P1005":
        return DependencyLimitExceededError(details)
    return DependencyCycleError(details)
