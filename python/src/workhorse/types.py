from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from threading import Event, Lock
from typing import Literal, TypeAlias, TypedDict, TypeVar, cast

Json: TypeAlias = bool | int | float | str | list["Json"] | dict[str, "Json"] | None
RetryPolicy: TypeAlias = Mapping[str, Json]
EnqueueOutcome: TypeAlias = Literal[
    "accepted", "replayed", "replaced", "non_replaceable", "coalesced"
]
NonReplaceableReason: TypeAlias = Literal[
    "incompatible_key_mode", "not_pending", "window_elapsed_pending"
]
TerminalPolicy: TypeAlias = Literal["release", "cancel", "fail"]
SignalDeliveryStatus: TypeAlias = Literal[
    "delivered", "duplicate", "not_waiting", "already_delivered", "stale", "not_found"
]
HumanWaitCompletionStatus: TypeAlias = Literal[
    "completed", "duplicate", "not_waiting", "already_completed", "stale", "not_found"
]
TJson = TypeVar("TJson", bound=Json)


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
    prerequisite_job_ids: Sequence[str]
    on_success: TerminalPolicy
    on_failure: TerminalPolicy
    on_cancellation: TerminalPolicy


@dataclass(frozen=True)
class EnqueueOptions:
    queue: str | None = None
    priority: int = 0
    concurrency_key: str | None = None
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
class ChildJobRequest:
    name: str
    type: str
    payload: Json
    options: EnqueueOptions = field(default_factory=EnqueueOptions)


@dataclass(frozen=True)
class EnqueueResult:
    job_id: str
    outcome: EnqueueOutcome
    reason: NonReplaceableReason | None = None


@dataclass(frozen=True)
class ClaimedJob:
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

    async def wait(self, timeout: float | None = None) -> bool:
        import asyncio

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
class JobCheckpoint:
    job_id: str
    name: str
    value: Json
    attempt: int
    fence_token: int
    worker_id: str
    created_at: datetime


@dataclass(frozen=True)
class JobWait:
    job_id: str
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
    job_id: str
    name: str
    payload: Json
    delivered_at: datetime | None
    delivered_by: str | None


@dataclass(frozen=True)
class HumanWaitCompletionResult:
    status: HumanWaitCompletionStatus
    job_id: str
    name: str
    payload: Json
    completed_at: datetime | None
    completed_by: str | None


@dataclass(frozen=True)
class HandlerContext:
    job: ClaimedJob
    cancellation: CancellationToken
    _get_checkpoint: Callable[[str], JobCheckpoint | None] = field(repr=False)
    _get_wait: Callable[[str], JobWait | None] = field(repr=False)
    _checkpoint: Callable[[str, Callable[[], Json]], Json] = field(repr=False)
    _sleep: Callable[[str, int], None] = field(repr=False)
    _sleep_until: Callable[[str, datetime], None] = field(repr=False)
    _wait_for_signal: Callable[[str, int | None], Json] = field(repr=False)
    _wait_for_human: Callable[[str, Json, int | None], Json] = field(repr=False)
    _run_child: Callable[[str, str, Json, EnqueueOptions], Json] = field(repr=False)
    _run_children: Callable[[Sequence[ChildJobRequest]], dict[str, Json]] = field(repr=False)

    def get_checkpoint(self, name: str) -> JobCheckpoint | None:
        return self._get_checkpoint(name)

    def get_wait(self, name: str) -> JobWait | None:
        return self._get_wait(name)

    def checkpoint(self, name: str, operation: Callable[[], TJson]) -> TJson:
        return cast(TJson, self._checkpoint(name, operation))

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

    def run_children(self, children: Sequence[ChildJobRequest]) -> dict[str, Json]:
        return self._run_children(children)

    def _as_batch_context(self) -> BatchHandlerContext:
        return BatchHandlerContext(
            self.job,
            self.cancellation,
            self._get_checkpoint,
            self._checkpoint,
        )


@dataclass(frozen=True)
class AsyncHandlerContext:
    """Async handler access to one claimed job's durable primitives."""

    job: ClaimedJob
    cancellation: AsyncCancellationToken
    _get_checkpoint: Callable[[str], Awaitable[JobCheckpoint | None]] = field(repr=False)
    _get_wait: Callable[[str], Awaitable[JobWait | None]] = field(repr=False)
    _checkpoint: Callable[[str, Callable[[], Awaitable[Json]]], Awaitable[Json]] = field(repr=False)
    _sleep: Callable[[str, int], Awaitable[None]] = field(repr=False)
    _sleep_until: Callable[[str, datetime], Awaitable[None]] = field(repr=False)
    _wait_for_signal: Callable[[str, int | None], Awaitable[Json]] = field(repr=False)
    _wait_for_human: Callable[[str, Json, int | None], Awaitable[Json]] = field(repr=False)
    _run_child: Callable[[str, str, Json, EnqueueOptions], Awaitable[Json]] = field(repr=False)
    _run_children: Callable[[Sequence[ChildJobRequest]], Awaitable[dict[str, Json]]] = field(
        repr=False
    )

    async def get_checkpoint(self, name: str) -> JobCheckpoint | None:
        return await self._get_checkpoint(name)

    async def get_wait(self, name: str) -> JobWait | None:
        return await self._get_wait(name)

    async def checkpoint(self, name: str, operation: Callable[[], Awaitable[TJson]]) -> TJson:
        return cast(TJson, await self._checkpoint(name, operation))

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

    async def run_children(self, children: Sequence[ChildJobRequest]) -> dict[str, Json]:
        return await self._run_children(children)


@dataclass(frozen=True)
class BatchHandlerContext:
    """Per-job batch context without APIs that suspend one shared invocation."""

    job: ClaimedJob
    cancellation: CancellationToken
    _get_checkpoint: Callable[[str], JobCheckpoint | None] = field(repr=False)
    _checkpoint: Callable[[str, Callable[[], Json]], Json] = field(repr=False)

    def get_checkpoint(self, name: str) -> JobCheckpoint | None:
        return self._get_checkpoint(name)

    def checkpoint(self, name: str, operation: Callable[[], TJson]) -> TJson:
        return cast(TJson, self._checkpoint(name, operation))


@dataclass(frozen=True)
class BatchHandlerItem:
    payload: Json
    context: BatchHandlerContext


@dataclass(frozen=True)
class AsyncBatchHandlerContext:
    """Async per-job batch context without suspending primitives."""

    job: ClaimedJob
    cancellation: AsyncCancellationToken
    _get_checkpoint: Callable[[str], Awaitable[JobCheckpoint | None]] = field(repr=False)
    _checkpoint: Callable[[str, Callable[[], Awaitable[Json]]], Awaitable[Json]] = field(repr=False)

    async def get_checkpoint(self, name: str) -> JobCheckpoint | None:
        return await self._get_checkpoint(name)

    async def checkpoint(self, name: str, operation: Callable[[], Awaitable[TJson]]) -> TJson:
        return cast(TJson, await self._checkpoint(name, operation))


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


BatchHandlerOutcome: TypeAlias = BatchSucceeded | BatchFailed


@dataclass(frozen=True)
class ScheduledJob:
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
    job: ScheduledJob
    enabled: bool = True
