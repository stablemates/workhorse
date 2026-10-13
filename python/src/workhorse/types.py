from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from threading import Event, Lock
from typing import Any, Literal, TypedDict, TypeVar, cast

type Json = bool | int | float | str | list["Json"] | dict[str, "Json"] | None
type QueueHealth = dict[str, Json]
type RetryPolicy = Mapping[str, Json]
type ScheduleCatchupPolicy = Literal["skip", "latest", "all"]
type EnqueueOutcome = Literal["accepted", "replayed", "replaced", "non_replaceable", "coalesced"]
type EnqueueNonReplaceableReason = Literal[
    "incompatible_key_mode", "not_pending", "window_elapsed_pending"
]
type NonReplaceableReason = EnqueueNonReplaceableReason
"""Deprecated. Renamed to ``EnqueueNonReplaceableReason``. Removed in 1.0.0."""
type DependencyTerminalPolicy = Literal["release", "cancel", "fail"]
type TerminalPolicy = DependencyTerminalPolicy
"""Deprecated. Renamed to ``DependencyTerminalPolicy``. Removed in 1.0.0."""
type SignalDeliveryStatus = Literal[
    "delivered", "duplicate", "not_waiting", "already_delivered", "stale", "not_found"
]
type HumanWaitCompletionStatus = Literal[
    "completed", "duplicate", "not_waiting", "already_completed", "stale", "not_found"
]
type CancelStatus = Literal["canceled", "cancel_requested", "already_terminal", "not_found"]
type TaskState = Literal[
    "blocked", "scheduled", "ready", "active", "succeeded", "failed", "canceled"
]
_TJson = TypeVar("_TJson", bound=Json)


class _NoInput(Enum):
    """The default of a checkpoint input, so that ``None`` stays the JSON input null."""

    NO_INPUT = "no input"


@dataclass(frozen=True)
class TaskContractVersion:
    payload_schema: Json = True
    result_schema: Json = True
    max_payload_bytes: int = 1_048_576
    max_result_bytes: int = 1_048_576
    sensitive_payload_keys: Sequence[str] = field(default_factory=tuple)
    sensitive_result_keys: Sequence[str] = field(default_factory=tuple)


@dataclass(frozen=True)
class TaskTypeContracts:
    current_version: str
    versions: Mapping[str, TaskContractVersion]


@dataclass(frozen=True)
class Idempotency:
    key: str
    scope: str = "default"
    ttl_ms: int = 86_400_000


@dataclass(frozen=True)
class Debounce:
    key: str
    window_ms: int
    schedule: Literal["reset", "preserve"]
    scope: str = "default"


@dataclass(frozen=True)
class Throttle:
    key: str
    window_ms: int
    scope: str = "default"


@dataclass(frozen=True)
class Dependencies:
    prerequisite_task_ids: Sequence[str]
    on_success: DependencyTerminalPolicy
    on_failure: DependencyTerminalPolicy
    on_cancellation: DependencyTerminalPolicy


@dataclass(frozen=True)
class EnqueueOptions:
    queue: str | None = None
    priority: int = 0
    concurrency_key: str | None = None
    budget: str | None = None
    run_at: datetime | None = None
    deadline: datetime | None = None
    execution_timeout_ms: int | None = None
    max_attempts: int = 25
    retry_policy: RetryPolicy | None = None
    tags: Sequence[str] = field(default_factory=tuple)
    idempotency: Idempotency | None = None
    debounce: Debounce | None = None
    throttle: Throttle | None = None
    dependencies: Dependencies | None = None


@dataclass(frozen=True)
class EnqueueRequest:
    type: str
    payload: Json
    options: EnqueueOptions = field(default_factory=EnqueueOptions)


@dataclass(frozen=True)
class ConcurrencyPolicyDefinition:
    queue: str
    max_active: int
    max_active_per_key: int | None = None


@dataclass(frozen=True)
class ConcurrencyPolicy:
    namespace: str
    queue: str
    max_active: int
    max_active_per_key: int | None
    updated_at: datetime


@dataclass(frozen=True)
class RateLimit:
    limit: int
    interval_ms: int
    burst: int


@dataclass(frozen=True)
class RateLimitPolicyDefinition:
    queue: str
    rate: RateLimit
    per_key: RateLimit | None = None


@dataclass(frozen=True)
class RateLimitPolicy:
    namespace: str
    queue: str
    rate: RateLimit
    per_key: RateLimit | None
    updated_at: datetime


@dataclass(frozen=True)
class BudgetDefinition:
    """One named budget that tasks in any queue can name. Set max_active, rate, or both."""

    name: str
    max_active: int | None = None
    rate: RateLimit | None = None


@dataclass(frozen=True)
class Budget:
    namespace: str
    name: str
    max_active: int | None
    rate: RateLimit | None
    updated_at: datetime


@dataclass(frozen=True)
class ChildTaskRequest:
    name: str
    type: str
    payload: Json
    options: EnqueueOptions = field(default_factory=EnqueueOptions)


class ChildSucceeded(TypedDict):
    status: Literal["succeeded"]
    result: Json


class ChildFailed(TypedDict):
    status: Literal["failed"]
    error: Json


class ChildCanceled(TypedDict):
    status: Literal["canceled"]
    error: Json


type ChildOutcome = ChildSucceeded | ChildFailed | ChildCanceled


@dataclass(frozen=True)
class EnqueueResult:
    task_id: str
    outcome: EnqueueOutcome
    reason: EnqueueNonReplaceableReason | None = None


@dataclass(frozen=True)
class CancelResult:
    status: CancelStatus
    task_id: str
    state: TaskState | None
    current_attempt: int | None
    requested_at: datetime | None
    requested_by: str | None
    reason: str | None
    finished_at: datetime | None


@dataclass(frozen=True)
class ClaimedTask:
    id: str
    queue: str
    type: str
    priority: int
    payload: Json
    contract_version: str | None
    result_max_bytes: int
    redact_error_details: bool
    trace_context: Json
    attempt: int
    max_attempts: int
    retry_policy: RetryPolicy | None
    deadline_at: datetime | None
    execution_timeout_ms: int | None
    attempt_timeout_at: datetime | None
    fence_token: int
    lease_expires_at: datetime


class CancellationToken:
    """Cooperative stop signal delivered by the worker ownership lifecycle."""

    def __init__(self) -> None:
        self._event = Event()
        self._lock = Lock()
        self._reason: BaseException | None = None

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()

    @property
    def reason(self) -> BaseException:
        with self._lock:
            if self._reason is None:
                raise RuntimeError("Cancellation has not been requested")
            return self._reason

    def wait(self, timeout: float | None = None) -> bool:
        return self._event.wait(timeout)

    def raise_if_cancelled(self) -> None:
        if self.cancelled:
            raise self.reason

    def _cancel(self, reason: BaseException) -> bool:
        with self._lock:
            if self._reason is not None:
                return False
            self._reason = reason
            self._event.set()
            return True


class AsyncCancellationToken:
    """Async view of the worker's cooperative cancellation signal."""

    def __init__(self, token: CancellationToken) -> None:
        self._token = token

    @property
    def cancelled(self) -> bool:
        return self._token.cancelled

    @property
    def reason(self) -> BaseException:
        return self._token.reason

    async def wait(self, timeout: float | None = None) -> bool:  # noqa: ASYNC109
        loop = asyncio.get_running_loop()
        deadline = None if timeout is None else loop.time() + timeout
        while not self.cancelled:
            if deadline is not None:
                remaining = deadline - loop.time()
                if remaining <= 0:
                    return False
                await asyncio.sleep(min(0.01, remaining))
            else:
                await asyncio.sleep(0.01)
        return True

    def raise_if_cancelled(self) -> None:
        self._token.raise_if_cancelled()


@dataclass(frozen=True)
class TaskCheckpoint:
    task_id: str
    name: str
    value: Json
    attempt: int
    fence_token: int
    worker_id: str
    created_at: datetime
    input_fingerprint: str | None = None
    """The fingerprint of the input that produced ``value``, or ``None`` when the save gave no
    input (ADR 0098)."""


@dataclass(frozen=True)
class TaskProgress:
    task_id: str
    value: Json
    revision: int
    attempt: int
    fence_token: int
    worker_id: str
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True)
class TaskWait:
    task_id: str
    name: str
    mode: Literal["relative", "absolute"]
    duration_ms: int | None
    requested_wake_at: datetime | None
    wake_at: datetime
    attempt: int
    fence_token: int
    worker_id: str
    created_at: datetime


@dataclass(frozen=True)
class SignalDeliveryResult:
    status: SignalDeliveryStatus
    task_id: str
    name: str
    payload: Json
    delivered_at: datetime | None
    delivered_by: str | None


@dataclass(frozen=True)
class HumanWaitCompletionResult:
    status: HumanWaitCompletionStatus
    task_id: str
    name: str
    payload: Json
    completed_at: datetime | None
    completed_by: str | None


MAX_TASK_GROUP_MEMBERS = 100_000
"""The largest number of member tasks one task group holds (ADR 0095)."""
MAX_TASK_GROUP_PAGE_SIZE = 1_000
"""The largest number of member tasks or events one task group read returns."""
MAX_TASK_GROUP_DRIFT_LIMIT = 10_000
"""The largest number of drifted groups one drift read or repair examines."""
_MAX_TASK_GROUP_ADD = 1_000

type TaskGroupState = Literal["open", "sealed", "finished"]
"""``open`` accepts tasks. ``sealed`` accepts tasks only from a running member task.

``finished`` means every member task is finished and the callbacks are enqueued.
"""
type TaskGroupResult = Literal["succeeded", "failed"]
type TaskGroupCallbackKind = Literal["on_finish", "on_success", "on_failure"]
type TaskGroupMemberOutcome = Literal["succeeded", "failed", "canceled"]
type TaskGroupRole = Literal["member", "callback"]
type TaskGroupEventType = Literal[
    "created",
    "sealed",
    "canceled",
    "finished",
    "callback_enqueued",
    "callback_failed",
    "counter_repaired",
]
type TaskGroupRepairAction = Literal["recounted", "finished"]
type TaskGroupRefusal = Literal["sealed", "finished", "canceled", "not_running_member"]


@dataclass(frozen=True)
class TaskGroupCounts:
    total: int
    succeeded: int
    failed: int
    canceled: int
    pending: int


@dataclass(frozen=True)
class TaskGroupCallback:
    """A requested callback, and the task the finished group enqueued for it."""

    kind: TaskGroupCallbackKind
    # None until the group finishes, and None for the callback that the result does not select.
    task_id: str | None


@dataclass(frozen=True)
class TaskGroup:
    id: str
    state: TaskGroupState
    result: TaskGroupResult | None
    counts: TaskGroupCounts
    created_at: datetime
    sealed_at: datetime | None
    finished_at: datetime | None
    canceled_at: datetime | None
    canceled_by: str | None
    cancel_reason: str | None
    # The requested callbacks in the order on_finish, on_success, on_failure.
    callbacks: tuple[TaskGroupCallback, ...]


@dataclass(frozen=True)
class TaskGroupMember:
    # One-based order in which the member joined its group.
    position: int
    task_id: str
    # queue, type, and state are None after a purge or retention deletes the task.
    queue: str | None
    type: str | None
    state: TaskState | None
    # The outcome the group counted, or None while the member is pending.
    outcome: TaskGroupMemberOutcome | None
    added_at: datetime
    counted_at: datetime | None


@dataclass(frozen=True)
class TaskGroupMemberPage:
    members: tuple[TaskGroupMember, ...]
    # The ``after`` value of the next page, or None on the last page.
    next_after: int | None


@dataclass(frozen=True)
class TaskGroupLink:
    """The group of a running task, as its handler sees it through ``ctx.task_group``."""

    role: TaskGroupRole
    # The kind of callback, for a callback task.
    callback: TaskGroupCallbackKind | None
    group: TaskGroup


@dataclass(frozen=True)
class TaskGroupEvent:
    id: str
    type: TaskGroupEventType
    details: Json
    occurred_at: datetime


@dataclass(frozen=True)
class TaskGroupBlockResult:
    group: TaskGroup
    # One result for each added request, in order.
    tasks: tuple[EnqueueResult, ...]


class TaskGroupBuilder:
    """Collects the tasks of the ``task_group`` block form.

    The block creates, adds, and seals the group in one statement when it exits without an error.
    ``result`` holds the group and the enqueue results after that.
    """

    def __init__(self) -> None:
        self._requests: list[EnqueueRequest] = []
        self._result: TaskGroupBlockResult | None = None

    def add(self, requests: Sequence[EnqueueRequest]) -> None:
        """Collect up to 1,000 requests. The block holds at most 100,000 requests."""
        if self._result is not None:
            raise RuntimeError("the task group block has already created its group")
        _validate_task_group_add(requests)
        if len(self._requests) + len(requests) > MAX_TASK_GROUP_MEMBERS:
            raise ValueError(f"a task group holds at most {MAX_TASK_GROUP_MEMBERS} tasks")
        self._requests.extend(requests)

    @property
    def result(self) -> TaskGroupBlockResult:
        if self._result is None:
            raise RuntimeError("the task group block has not created its group yet")
        return self._result


def _validate_task_group_add(requests: Sequence[EnqueueRequest]) -> None:
    if len(requests) > _MAX_TASK_GROUP_ADD:
        raise ValueError(f"a task group add accepts at most {_MAX_TASK_GROUP_ADD} tasks")
    for request in requests:
        if request.options.debounce is not None or request.options.throttle is not None:
            raise ValueError("a task group add cannot use debounce or throttle")


@dataclass(frozen=True)
class TaskGroupRecordedCounts:
    """The counters a group row records."""

    total: int
    succeeded: int
    failed: int
    canceled: int


@dataclass(frozen=True)
class TaskGroupDrift:
    """One group whose counters disagree with its member outcomes, or that should have finished."""

    group_id: str
    state: TaskGroupState
    recorded: TaskGroupRecordedCounts
    # The counts the member outcomes give.
    counted: TaskGroupCounts
    action: TaskGroupRepairAction


@dataclass(frozen=True)
class TaskGroupRepair:
    group_id: str
    recorded_pending: int
    pending: int
    action: TaskGroupRepairAction


@dataclass(frozen=True)
class TaskGroupContext:
    """Task group operations of one handler activation (ADR 0095)."""

    _get: Callable[[], TaskGroupLink | None] = field(repr=False)
    _add: Callable[[Sequence[EnqueueRequest]], list[EnqueueResult]] = field(repr=False)

    def get(self) -> TaskGroupLink | None:
        """Read the group this task is a member of, or whose callback this task is.

        Returns None for a task with no group. The activation reads it one time and keeps it.
        """
        return self._get()

    def add(self, requests: Sequence[EnqueueRequest]) -> list[EnqueueResult]:
        """Add up to 1,000 tasks to the group of this member task, under its fenced lease.

        A running member task can add tasks after the seal, until its group is canceled.
        """
        return self._add(requests)


@dataclass(frozen=True)
class AsyncTaskGroupContext:
    """Async task group operations of one handler activation (ADR 0095)."""

    _get: Callable[[], Awaitable[TaskGroupLink | None]] = field(repr=False)
    _add: Callable[[Sequence[EnqueueRequest]], Awaitable[list[EnqueueResult]]] = field(repr=False)

    async def get(self) -> TaskGroupLink | None:
        """Read the group this task is a member of, or whose callback this task is."""
        return await self._get()

    async def add(self, requests: Sequence[EnqueueRequest]) -> list[EnqueueResult]:
        """Add up to 1,000 tasks to the group of this member task, under its fenced lease."""
        return await self._add(requests)


def _task_groups_unsupported(*_arguments: object) -> Any:
    raise TypeError("This handler context does not support task groups")


async def _async_task_groups_unsupported(*_arguments: object) -> Any:
    raise TypeError("This handler context does not support task groups")


@dataclass(frozen=True)
class HandlerContext:
    task: ClaimedTask
    cancellation: CancellationToken
    _get_checkpoint: Callable[[str], TaskCheckpoint | None] = field(repr=False)
    _get_wait: Callable[[str], TaskWait | None] = field(repr=False)
    _get_progress: Callable[[], TaskProgress | None] = field(repr=False)
    _set_progress: Callable[[Json], TaskProgress] = field(repr=False)
    _checkpoint: Callable[[str, Callable[[], Json], Json | _NoInput], Json] = field(repr=False)
    _sleep: Callable[[str, int], None] = field(repr=False)
    _sleep_until: Callable[[str, datetime], None] = field(repr=False)
    _wait_for_signal: Callable[[str, int | None], Json] = field(repr=False)
    _wait_for_human: Callable[[str, Json, int | None], Json] = field(repr=False)
    _run_child: Callable[[str, str, Json, EnqueueOptions], Json] = field(repr=False)
    _run_children: Callable[[Sequence[ChildTaskRequest]], dict[str, ChildOutcome]] = field(
        repr=False
    )
    _run_children_all: Callable[[Sequence[ChildTaskRequest]], dict[str, Json]] = field(repr=False)
    _get_task_group: Callable[[], TaskGroupLink | None] = field(
        default=_task_groups_unsupported, repr=False
    )
    _add_to_task_group: Callable[[Sequence[EnqueueRequest]], list[EnqueueResult]] = field(
        default=_task_groups_unsupported, repr=False
    )

    @property
    def task_group(self) -> TaskGroupContext:
        """The task group of this task, as a member task or as a callback task (ADR 0095)."""
        return TaskGroupContext(self._get_task_group, self._add_to_task_group)

    def get_checkpoint(self, name: str) -> TaskCheckpoint | None:
        return self._get_checkpoint(name)

    def get_wait(self, name: str) -> TaskWait | None:
        return self._get_wait(name)

    def get_progress(self) -> TaskProgress | None:
        return self._get_progress()

    def set_progress(self, value: Json) -> TaskProgress:
        return self._set_progress(value)

    def checkpoint(
        self,
        name: str,
        operation: Callable[[], _TJson],
        *,
        input: Json | _NoInput = _NoInput.NO_INPUT,
    ) -> _TJson:
        """Return the value of the checkpoint ``name``. Run ``operation`` only if none is saved.

        With ``input``, a JSON value, the checkpoint also stores the fingerprint of the input, as
        ``checkpoint_input_fingerprint`` computes it. If the stored checkpoint or an overlapping
        call with the same name has the fingerprint of a different input, the call raises
        ``CheckpointInputConflictError`` and ``operation`` does not run. If either side has no
        input, the call compares nothing (ADR 0098).
        """
        return cast(_TJson, self._checkpoint(name, operation, input))

    def sleep(self, name: str, duration_ms: int) -> None:
        self._sleep(name, duration_ms)

    def sleep_until(self, name: str, wake_at: datetime) -> None:
        self._sleep_until(name, wake_at)

    def wait_for_signal(self, name: str, *, timeout_ms: int | None = None) -> Json:
        return self._wait_for_signal(name, timeout_ms)

    def wait_for_human(self, name: str, context: Json, *, timeout_ms: int | None = None) -> Json:
        return self._wait_for_human(name, context, timeout_ms)

    def run_child(
        self,
        name: str,
        type: str,
        payload: Json,
        options: EnqueueOptions | None = None,
    ) -> Json:
        return self._run_child(name, type, payload, options or EnqueueOptions())

    def run_children(self, children: Sequence[ChildTaskRequest]) -> dict[str, ChildOutcome]:
        return self._run_children(children)

    def run_children_all(self, children: Sequence[ChildTaskRequest]) -> dict[str, Json]:
        return self._run_children_all(children)

    def _as_batch_context(self) -> BatchHandlerContext:
        return BatchHandlerContext(
            self.task,
            self.cancellation,
            self._get_checkpoint,
            self._get_progress,
            self._set_progress,
            self._checkpoint,
            self._get_task_group,
            self._add_to_task_group,
        )


@dataclass(frozen=True)
class AsyncHandlerContext:
    """Async handler access to one claimed task's durable primitives."""

    task: ClaimedTask
    cancellation: AsyncCancellationToken
    _get_checkpoint: Callable[[str], Awaitable[TaskCheckpoint | None]] = field(repr=False)
    _get_wait: Callable[[str], Awaitable[TaskWait | None]] = field(repr=False)
    _get_progress: Callable[[], Awaitable[TaskProgress | None]] = field(repr=False)
    _set_progress: Callable[[Json], Awaitable[TaskProgress]] = field(repr=False)
    _checkpoint: Callable[
        [str, Callable[[], Awaitable[Json]], Json | _NoInput], Awaitable[Json]
    ] = field(repr=False)
    _sleep: Callable[[str, int], Awaitable[None]] = field(repr=False)
    _sleep_until: Callable[[str, datetime], Awaitable[None]] = field(repr=False)
    _wait_for_signal: Callable[[str, int | None], Awaitable[Json]] = field(repr=False)
    _wait_for_human: Callable[[str, Json, int | None], Awaitable[Json]] = field(repr=False)
    _run_child: Callable[[str, str, Json, EnqueueOptions], Awaitable[Json]] = field(repr=False)
    _run_children: Callable[[Sequence[ChildTaskRequest]], Awaitable[dict[str, ChildOutcome]]] = (
        field(repr=False)
    )
    _run_children_all: Callable[[Sequence[ChildTaskRequest]], Awaitable[dict[str, Json]]] = field(
        repr=False
    )
    _get_task_group: Callable[[], Awaitable[TaskGroupLink | None]] = field(
        default=_async_task_groups_unsupported, repr=False
    )
    _add_to_task_group: Callable[[Sequence[EnqueueRequest]], Awaitable[list[EnqueueResult]]] = (
        field(default=_async_task_groups_unsupported, repr=False)
    )

    @property
    def task_group(self) -> AsyncTaskGroupContext:
        """The task group of this task, as a member task or as a callback task (ADR 0095)."""
        return AsyncTaskGroupContext(self._get_task_group, self._add_to_task_group)

    async def get_checkpoint(self, name: str) -> TaskCheckpoint | None:
        return await self._get_checkpoint(name)

    async def get_wait(self, name: str) -> TaskWait | None:
        return await self._get_wait(name)

    async def get_progress(self) -> TaskProgress | None:
        return await self._get_progress()

    async def set_progress(self, value: Json) -> TaskProgress:
        return await self._set_progress(value)

    async def checkpoint(
        self,
        name: str,
        operation: Callable[[], Awaitable[_TJson]],
        *,
        input: Json | _NoInput = _NoInput.NO_INPUT,
    ) -> _TJson:
        """Return the value of the checkpoint ``name``. Run ``operation`` only if none is saved.

        With ``input``, a JSON value, the checkpoint also stores the fingerprint of the input, as
        ``checkpoint_input_fingerprint`` computes it. If the stored checkpoint or an overlapping
        call with the same name has the fingerprint of a different input, the call raises
        ``CheckpointInputConflictError`` and ``operation`` does not run. If either side has no
        input, the call compares nothing (ADR 0098).
        """
        return cast(_TJson, await self._checkpoint(name, operation, input))

    async def sleep(self, name: str, duration_ms: int) -> None:
        await self._sleep(name, duration_ms)

    async def sleep_until(self, name: str, wake_at: datetime) -> None:
        await self._sleep_until(name, wake_at)

    async def wait_for_signal(self, name: str, *, timeout_ms: int | None = None) -> Json:
        return await self._wait_for_signal(name, timeout_ms)

    async def wait_for_human(
        self, name: str, context: Json, *, timeout_ms: int | None = None
    ) -> Json:
        return await self._wait_for_human(name, context, timeout_ms)

    async def run_child(
        self,
        name: str,
        type: str,
        payload: Json,
        options: EnqueueOptions | None = None,
    ) -> Json:
        return await self._run_child(name, type, payload, options or EnqueueOptions())

    async def run_children(self, children: Sequence[ChildTaskRequest]) -> dict[str, ChildOutcome]:
        return await self._run_children(children)

    async def run_children_all(self, children: Sequence[ChildTaskRequest]) -> dict[str, Json]:
        return await self._run_children_all(children)


@dataclass(frozen=True)
class BatchHandlerContext:
    """Per-task batch context without APIs that suspend one shared invocation."""

    task: ClaimedTask
    cancellation: CancellationToken
    _get_checkpoint: Callable[[str], TaskCheckpoint | None] = field(repr=False)
    _get_progress: Callable[[], TaskProgress | None] = field(repr=False)
    _set_progress: Callable[[Json], TaskProgress] = field(repr=False)
    _checkpoint: Callable[[str, Callable[[], Json], Json | _NoInput], Json] = field(repr=False)
    _get_task_group: Callable[[], TaskGroupLink | None] = field(
        default=_task_groups_unsupported, repr=False
    )
    _add_to_task_group: Callable[[Sequence[EnqueueRequest]], list[EnqueueResult]] = field(
        default=_task_groups_unsupported, repr=False
    )

    @property
    def task_group(self) -> TaskGroupContext:
        """The task group of this task in the batch, as a member task or as a callback task."""
        return TaskGroupContext(self._get_task_group, self._add_to_task_group)

    def get_checkpoint(self, name: str) -> TaskCheckpoint | None:
        return self._get_checkpoint(name)

    def get_progress(self) -> TaskProgress | None:
        return self._get_progress()

    def set_progress(self, value: Json) -> TaskProgress:
        return self._set_progress(value)

    def checkpoint(
        self,
        name: str,
        operation: Callable[[], _TJson],
        *,
        input: Json | _NoInput = _NoInput.NO_INPUT,
    ) -> _TJson:
        """Return the value of the checkpoint ``name``. Run ``operation`` only if none is saved.

        With ``input``, a JSON value, the checkpoint also stores the fingerprint of the input, as
        ``checkpoint_input_fingerprint`` computes it. If the stored checkpoint or an overlapping
        call with the same name has the fingerprint of a different input, the call raises
        ``CheckpointInputConflictError`` and ``operation`` does not run. If either side has no
        input, the call compares nothing (ADR 0098).
        """
        return cast(_TJson, self._checkpoint(name, operation, input))


@dataclass(frozen=True)
class BatchHandlerItem:
    payload: Json
    context: BatchHandlerContext


@dataclass(frozen=True)
class AsyncBatchHandlerContext:
    """Async per-task batch context without suspending primitives."""

    task: ClaimedTask
    cancellation: AsyncCancellationToken
    _get_checkpoint: Callable[[str], Awaitable[TaskCheckpoint | None]] = field(repr=False)
    _get_progress: Callable[[], Awaitable[TaskProgress | None]] = field(repr=False)
    _set_progress: Callable[[Json], Awaitable[TaskProgress]] = field(repr=False)
    _checkpoint: Callable[
        [str, Callable[[], Awaitable[Json]], Json | _NoInput], Awaitable[Json]
    ] = field(repr=False)
    _get_task_group: Callable[[], Awaitable[TaskGroupLink | None]] = field(
        default=_async_task_groups_unsupported, repr=False
    )
    _add_to_task_group: Callable[[Sequence[EnqueueRequest]], Awaitable[list[EnqueueResult]]] = (
        field(default=_async_task_groups_unsupported, repr=False)
    )

    @property
    def task_group(self) -> AsyncTaskGroupContext:
        """The task group of this task in the batch, as a member task or as a callback task."""
        return AsyncTaskGroupContext(self._get_task_group, self._add_to_task_group)

    async def get_checkpoint(self, name: str) -> TaskCheckpoint | None:
        return await self._get_checkpoint(name)

    async def get_progress(self) -> TaskProgress | None:
        return await self._get_progress()

    async def set_progress(self, value: Json) -> TaskProgress:
        return await self._set_progress(value)

    async def checkpoint(
        self,
        name: str,
        operation: Callable[[], Awaitable[_TJson]],
        *,
        input: Json | _NoInput = _NoInput.NO_INPUT,
    ) -> _TJson:
        """Return the value of the checkpoint ``name``. Run ``operation`` only if none is saved.

        With ``input``, a JSON value, the checkpoint also stores the fingerprint of the input, as
        ``checkpoint_input_fingerprint`` computes it. If the stored checkpoint or an overlapping
        call with the same name has the fingerprint of a different input, the call raises
        ``CheckpointInputConflictError`` and ``operation`` does not run. If either side has no
        input, the call compares nothing (ADR 0098).
        """
        return cast(_TJson, await self._checkpoint(name, operation, input))


@dataclass(frozen=True)
class AsyncBatchHandlerItem:
    payload: Json
    context: AsyncBatchHandlerContext


class BatchSucceeded(TypedDict):
    status: Literal["succeeded"]
    result: Json


class BatchFailed(TypedDict):
    status: Literal["failed"]
    error: Exception


type BatchHandlerOutcome = BatchSucceeded | BatchFailed


@dataclass(frozen=True)
class ScheduledTask:
    type: str
    payload: Json
    queue: str | None = None
    priority: int = 0
    concurrency_key: str | None = None
    max_attempts: int = 25
    retry_policy: RetryPolicy | None = None


@dataclass(frozen=True)
class ScheduleDefinition:
    name: str
    schedule: str
    task: ScheduledTask
    timezone: str = "UTC"
    catchup_policy: ScheduleCatchupPolicy = "skip"
    enabled: bool = True


__all__ = [
    "MAX_TASK_GROUP_DRIFT_LIMIT",
    "MAX_TASK_GROUP_MEMBERS",
    "MAX_TASK_GROUP_PAGE_SIZE",
    "AsyncBatchHandlerContext",
    "AsyncBatchHandlerItem",
    "AsyncCancellationToken",
    "AsyncHandlerContext",
    "AsyncTaskGroupContext",
    "BatchFailed",
    "BatchHandlerContext",
    "BatchHandlerItem",
    "BatchHandlerOutcome",
    "BatchSucceeded",
    "Budget",
    "BudgetDefinition",
    "CancelResult",
    "CancelStatus",
    "CancellationToken",
    "ChildCanceled",
    "ChildFailed",
    "ChildOutcome",
    "ChildSucceeded",
    "ChildTaskRequest",
    "ClaimedTask",
    "ConcurrencyPolicy",
    "ConcurrencyPolicyDefinition",
    "Debounce",
    "Dependencies",
    "DependencyTerminalPolicy",
    "EnqueueNonReplaceableReason",
    "EnqueueOptions",
    "EnqueueOutcome",
    "EnqueueRequest",
    "EnqueueResult",
    "HandlerContext",
    "HumanWaitCompletionResult",
    "HumanWaitCompletionStatus",
    "Idempotency",
    "Json",
    "NonReplaceableReason",
    "QueueHealth",
    "RateLimit",
    "RateLimitPolicy",
    "RateLimitPolicyDefinition",
    "RetryPolicy",
    "ScheduleCatchupPolicy",
    "ScheduleDefinition",
    "ScheduledTask",
    "SignalDeliveryResult",
    "SignalDeliveryStatus",
    "TaskCheckpoint",
    "TaskContractVersion",
    "TaskGroup",
    "TaskGroupBlockResult",
    "TaskGroupBuilder",
    "TaskGroupCallback",
    "TaskGroupCallbackKind",
    "TaskGroupContext",
    "TaskGroupCounts",
    "TaskGroupDrift",
    "TaskGroupEvent",
    "TaskGroupEventType",
    "TaskGroupLink",
    "TaskGroupMember",
    "TaskGroupMemberOutcome",
    "TaskGroupMemberPage",
    "TaskGroupRecordedCounts",
    "TaskGroupRefusal",
    "TaskGroupRepair",
    "TaskGroupRepairAction",
    "TaskGroupResult",
    "TaskGroupRole",
    "TaskGroupState",
    "TaskProgress",
    "TaskState",
    "TaskTypeContracts",
    "TaskWait",
    "TerminalPolicy",
    "Throttle",
]
