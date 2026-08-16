from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal, TypeAlias

Json: TypeAlias = bool | int | float | str | list["Json"] | dict[str, "Json"] | None
RetryPolicy: TypeAlias = Mapping[str, Json]
EnqueueOutcome: TypeAlias = Literal[
    "accepted", "replayed", "replaced", "non_replaceable", "coalesced"
]
NonReplaceableReason: TypeAlias = Literal[
    "incompatible_key_mode", "not_pending", "window_elapsed_pending"
]
TerminalPolicy: TypeAlias = Literal["release", "cancel", "fail"]


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
class EnqueueResult:
    job_id: str
    outcome: EnqueueOutcome
    reason: NonReplaceableReason | None = None


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
