from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Literal, cast

from .types import MAX_TASK_GROUP_MEMBERS

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
    def __init__(self, task_id: str) -> None:
        self.task_id = task_id
        super().__init__("Task lease was lost")


class CancellationRequestedError(WorkhorseError):
    def __init__(self, task_id: str) -> None:
        self.task_id = task_id
        super().__init__(f"Cancellation was requested for task {task_id}")


class DeadlineExceededError(WorkhorseError):
    def __init__(self, task_id: str) -> None:
        self.task_id = task_id
        super().__init__(f"Deadline was exceeded for task {task_id}")


class ExecutionTimeoutError(WorkhorseError):
    def __init__(self, task_id: str, attempt: int) -> None:
        self.task_id = task_id
        self.attempt = attempt
        super().__init__(f"Execution timeout was exceeded for task {task_id} attempt {attempt}")


class CheckpointLeaseLostError(LifecycleError):
    def __init__(self, task_id: str, checkpoint_name: str) -> None:
        self.task_id = task_id
        self.checkpoint_name = checkpoint_name
        super().__init__(
            f"Cannot save checkpoint {checkpoint_name} for task {task_id} under a stale lease"
        )


class CheckpointConflictError(WorkhorseError):
    def __init__(self, task_id: str, checkpoint_name: str) -> None:
        self.task_id = task_id
        self.checkpoint_name = checkpoint_name
        super().__init__(
            f"Checkpoint {checkpoint_name} for task {task_id} already has a different value"
        )


class CheckpointInputConflictError(CheckpointConflictError):
    """A checkpoint stores the result of a different input (ADR 0098).

    The call gave an input whose fingerprint differs from the stored fingerprint, or from the
    fingerprint of an overlapping call with the same name. The operation does not run. A retry of
    the same handler cannot succeed, so the worker fails the task at once, as for every
    ``CheckpointConflictError``.
    """

    def __init__(
        self,
        task_id: str,
        checkpoint_name: str,
        stored_fingerprint: str,
        requested_fingerprint: str,
    ) -> None:
        WorkhorseError.__init__(
            self,
            f"Checkpoint {checkpoint_name} for task {task_id} stores the result of a different "
            "input",
        )
        self.task_id = task_id
        self.checkpoint_name = checkpoint_name
        self.stored_fingerprint = stored_fingerprint
        self.requested_fingerprint = requested_fingerprint


class ProgressLeaseLostError(LifecycleError):
    def __init__(self, task_id: str) -> None:
        self.task_id = task_id
        super().__init__(f"Cannot update progress for task {task_id} under a stale lease")


class ProgressRateLimitError(WorkhorseError):
    def __init__(self, task_id: str, retry_after_ms: int) -> None:
        self.task_id = task_id
        self.retry_after_ms = retry_after_ms
        super().__init__(
            f"Cannot update progress for task {task_id} yet; "
            f"retry after {retry_after_ms} milliseconds"
        )


class ChildLeaseLostError(LifecycleError):
    def __init__(self, parent_task_id: str) -> None:
        self.parent_task_id = parent_task_id
        super().__init__(
            f"Cannot create a child for task {parent_task_id} because the lease is stale or expired"
        )


class ChildConflictError(WorkhorseError):
    def __init__(
        self, parent_task_id: str, child_name: str, stored_child_name: str | None = None
    ) -> None:
        self.parent_task_id = parent_task_id
        self.child_name = child_name
        if stored_child_name is not None and stored_child_name != child_name:
            message = (
                f"Child replay for task {parent_task_id} conflicts: "
                f"stored child {json.dumps(stored_child_name)}, "
                f"requested child {json.dumps(child_name)}"
            )
        else:
            message = (
                f"Child {child_name} for task {parent_task_id} "
                "already exists with a different request"
            )
        super().__init__(message)


class ChildLimitExceededError(WorkhorseError):
    def __init__(self, parent_task_id: str) -> None:
        self.parent_task_id = parent_task_id
        super().__init__(f"Task {parent_task_id} exceeds the supported child limit")


class ChildResultLimitExceededError(WorkhorseError):
    def __init__(self, parent_task_id: str, result_bytes: int, result_limit_bytes: int) -> None:
        self.parent_task_id = parent_task_id
        self.result_bytes = result_bytes
        self.result_limit_bytes = result_limit_bytes
        super().__init__(
            f"Joined child results for task {parent_task_id} exceed its configured size limit"
        )


class WaitLeaseLostError(LifecycleError):
    def __init__(self, task_id: str, wait_name: str) -> None:
        self.task_id = task_id
        self.wait_name = wait_name
        super().__init__(f"Cannot schedule wait {wait_name} for task {task_id} under a stale lease")


class WaitConflictError(WorkhorseError):
    def __init__(self, task_id: str, wait_name: str) -> None:
        self.task_id = task_id
        self.wait_name = wait_name
        super().__init__(f"Wait {wait_name} for task {task_id} has a conflicting target")


class WaitLimitExceededError(WorkhorseError):
    def __init__(self, task_id: str) -> None:
        self.task_id = task_id
        super().__init__(f"Task {task_id} already has the maximum number of durable waits")


class SignalWaitLeaseLostError(LifecycleError):
    def __init__(self, task_id: str, wait_name: str) -> None:
        self.task_id = task_id
        self.wait_name = wait_name
        super().__init__(
            f"Signal wait {wait_name} for task {task_id} cannot be recorded under a stale lease"
        )


class SignalWaitConflictError(WorkhorseError):
    def __init__(self, task_id: str, wait_name: str) -> None:
        self.task_id = task_id
        self.wait_name = wait_name
        super().__init__(f"Signal wait {wait_name} for task {task_id} is already waiting")


class SignalWaitLimitExceededError(WorkhorseError):
    def __init__(self, task_id: str) -> None:
        self.task_id = task_id
        super().__init__(f"Task {task_id} already has the maximum number of signal waits")


class SignalIdempotencyConflictError(WorkhorseError):
    def __init__(self, task_id: str, wait_name: str) -> None:
        self.task_id = task_id
        self.wait_name = wait_name
        super().__init__(
            f"Signal {wait_name} for task {task_id} received a different idempotent request"
        )


class HumanWaitLeaseLostError(LifecycleError):
    def __init__(self, task_id: str, wait_name: str) -> None:
        self.task_id = task_id
        self.wait_name = wait_name
        super().__init__(
            f"Human wait {wait_name} for task {task_id} cannot be recorded under a stale lease"
        )


class HumanWaitAlreadyWaitingError(WorkhorseError):
    def __init__(self, task_id: str, wait_name: str) -> None:
        self.task_id = task_id
        self.wait_name = wait_name
        super().__init__(f"Human wait {wait_name} for task {task_id} is already waiting")


class HumanWaitLimitExceededError(WorkhorseError):
    def __init__(self, task_id: str) -> None:
        self.task_id = task_id
        super().__init__(f"Task {task_id} already has the maximum number of human waits")


class HumanWaitConflictError(WorkhorseError):
    def __init__(self, task_id: str, wait_name: str) -> None:
        self.task_id = task_id
        self.wait_name = wait_name
        super().__init__(f"Human wait {wait_name} for task {task_id} has different context")


class HumanWaitIdempotencyConflictError(WorkhorseError):
    def __init__(self, task_id: str, wait_name: str) -> None:
        self.task_id = task_id
        self.wait_name = wait_name
        super().__init__(
            f"Human wait {wait_name} for task {task_id} received a different idempotent completion"
        )


class ProtocolCompatibilityError(WorkhorseError):
    def __init__(self, code: CompatibilityCode) -> None:
        self.code = code
        super().__init__(f"SQL protocol compatibility check refused mutation: {code}")


class TaskContractValidationError(WorkhorseError):
    def __init__(self, task_type: str, version: str, kind: str) -> None:
        self.task_type = task_type
        self.version = version
        self.kind = kind
        super().__init__(f"{task_type} {kind} does not satisfy contract version {version}")


class TaskContractUnavailableError(WorkhorseError):
    def __init__(self, task_type: str, version: str) -> None:
        self.task_type = task_type
        self.version = version
        super().__init__(f"{task_type} contract version {version} is unavailable")


class TaskValueSizeLimitError(WorkhorseError):
    """A task value measures more bytes than its configured limit allows."""

    def __init__(self, task_type: str, value_kind: str, actual_bytes: int, max_bytes: int) -> None:
        self.task_type = task_type
        self.value_kind = value_kind
        self.actual_bytes = actual_bytes
        self.max_bytes = max_bytes
        super().__init__(f"{task_type} {value_kind} exceeds its configured size limit")


class EnqueueIdempotencyConflictError(WorkhorseError):
    def __init__(self, details: Mapping[str, object]) -> None:
        self.details = details
        super().__init__("PostgreSQL rejected a materially different idempotent enqueue")


class DependencyCycleError(WorkhorseError):
    def __init__(self, details: Mapping[str, object]) -> None:
        self.details = details
        super().__init__("PostgreSQL rejected a cyclic task dependency")


class DependencyLimitExceededError(WorkhorseError):
    def __init__(self, details: Mapping[str, object]) -> None:
        self.details = details
        super().__init__("PostgreSQL rejected a task dependency limit")


class RedriveIdempotencyConflictError(WorkhorseError):
    def __init__(self, details: Mapping[str, object]) -> None:
        self.details = details
        super().__init__("PostgreSQL rejected a materially different idempotent redrive")


class PurgeIdempotencyConflictError(WorkhorseError):
    def __init__(self, details: Mapping[str, object]) -> None:
        self.details = details
        super().__init__("PostgreSQL rejected a materially different idempotent queue purge")


class FastTierUnsupportedError(WorkhorseError):
    """A fast-tier queue refused a feature that only the full tier provides."""

    def __init__(self, queue: str, feature: str, ordinal: int | None = None) -> None:
        self.queue = queue
        self.feature = feature
        self.ordinal = ordinal
        super().__init__(f"Fast-tier queue {queue} does not support {feature}")


class TaskGroupClosedError(WorkhorseError):
    """The task group does not accept tasks: it is sealed, finished, or canceled (``P1008``).

    ``reason`` is ``sealed``, ``finished``, ``canceled``, or ``not_running_member``.
    """

    def __init__(self, details: Mapping[str, object]) -> None:
        self.details = details
        self.group_id = str(details["groupId"])
        self.state = str(details["state"])
        self.reason = str(details["reason"])
        super().__init__(f"Task group {self.group_id} does not accept tasks ({self.reason})")


class TaskGroupLimitExceededError(WorkhorseError):
    """An add would take the task group above its member limit (``P1009``)."""

    def __init__(self, details: Mapping[str, object]) -> None:
        self.details = details
        self.group_id = str(details["groupId"])
        self.limit = cast(int, details["limit"])
        self.total = cast(int, details["total"])
        self.requested = cast(int, details["requested"])
        super().__init__(
            f"Task group {self.group_id} holds {self.total} tasks and accepts at most {self.limit}"
        )


class TaskGroupMembershipConflictError(WorkhorseError):
    """Enqueue idempotency returned a task that is not a member of the task group (``P1010``).

    ``member_of`` names the group the existing task belongs to, or is None.
    """

    def __init__(self, details: Mapping[str, object]) -> None:
        self.details = details
        self.group_id = str(details["groupId"])
        self.task_id = str(details["taskId"])
        self.ordinal = cast(int, details["ordinal"])
        member_of = details["memberOf"]
        self.member_of = None if member_of is None else str(member_of)
        super().__init__(
            f"Enqueue idempotency returned task {self.task_id}, which is not a member of task "
            f"group {self.group_id}"
        )


# The details a task group error carries when PostgreSQL sent DETAIL text this client cannot read.
_TASK_GROUP_FALLBACK_DETAILS: dict[str, dict[str, object]] = {
    "P1008": {"groupId": "unknown", "state": "finished", "reason": "finished"},
    "P1009": {"groupId": "unknown", "limit": MAX_TASK_GROUP_MEMBERS, "total": 0, "requested": 0},
    "P1010": {"groupId": "unknown", "taskId": "unknown", "ordinal": 0, "memberOf": None},
}


def _valid_task_group_details(sqlstate: str, details: Mapping[str, object]) -> bool:
    def integer(name: str) -> bool:
        value = details.get(name)
        return isinstance(value, int) and not isinstance(value, bool)

    def text(name: str) -> bool:
        return isinstance(details.get(name), str)

    if sqlstate == "P1008":
        return text("groupId") and text("state") and text("reason")
    if sqlstate == "P1009":
        return text("groupId") and integer("limit") and integer("total") and integer("requested")
    return (
        text("groupId")
        and text("taskId")
        and integer("ordinal")
        and "memberOf" in details
        and (details["memberOf"] is None or text("memberOf"))
    )


def _task_group_error(sqlstate: str, details: Mapping[str, object]) -> WorkhorseError:
    if not _valid_task_group_details(sqlstate, details):
        # A copy, so a caller that changes error.details cannot change a later fallback.
        details = dict(_TASK_GROUP_FALLBACK_DETAILS[sqlstate])
    if sqlstate == "P1008":
        return TaskGroupClosedError(details)
    if sqlstate == "P1009":
        return TaskGroupLimitExceededError(details)
    return TaskGroupMembershipConflictError(details)


def _translate_database_error(error: Exception) -> WorkhorseError | None:
    sqlstate = getattr(error, "sqlstate", None) or getattr(error, "code", None)
    if sqlstate not in {"P1001", "P1003", "P1005", "P1007", "P1008", "P1009", "P1010"}:
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
    if sqlstate in _TASK_GROUP_FALLBACK_DETAILS:
        return _task_group_error(sqlstate, details)
    if sqlstate == "P1001":
        return EnqueueIdempotencyConflictError(details)
    if sqlstate == "P1005":
        return DependencyLimitExceededError(details)
    if sqlstate == "P1007":
        ordinal = details.get("ordinal")
        return FastTierUnsupportedError(
            str(details.get("queue", "")),
            str(details.get("feature", "")),
            ordinal if isinstance(ordinal, int) else None,
        )
    return DependencyCycleError(details)


__all__ = [
    "CancellationRequestedError",
    "CheckpointConflictError",
    "CheckpointInputConflictError",
    "CheckpointLeaseLostError",
    "ChildConflictError",
    "ChildLeaseLostError",
    "ChildLimitExceededError",
    "ChildResultLimitExceededError",
    "CompatibilityCode",
    "DeadlineExceededError",
    "DependencyCycleError",
    "DependencyLimitExceededError",
    "EnqueueIdempotencyConflictError",
    "ExecutionTimeoutError",
    "FastTierUnsupportedError",
    "HumanWaitAlreadyWaitingError",
    "HumanWaitConflictError",
    "HumanWaitIdempotencyConflictError",
    "HumanWaitLeaseLostError",
    "HumanWaitLimitExceededError",
    "LifecycleError",
    "ProgressLeaseLostError",
    "ProgressRateLimitError",
    "ProtocolCompatibilityError",
    "PurgeIdempotencyConflictError",
    "RedriveIdempotencyConflictError",
    "SignalIdempotencyConflictError",
    "SignalWaitConflictError",
    "SignalWaitLeaseLostError",
    "SignalWaitLimitExceededError",
    "StaleLeaseError",
    "TaskContractUnavailableError",
    "TaskContractValidationError",
    "TaskGroupClosedError",
    "TaskGroupLimitExceededError",
    "TaskGroupMembershipConflictError",
    "TaskValueSizeLimitError",
    "WaitConflictError",
    "WaitLeaseLostError",
    "WaitLimitExceededError",
    "WorkhorseError",
]
