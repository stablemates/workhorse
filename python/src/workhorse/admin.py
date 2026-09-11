from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING, Any, Literal, NoReturn, cast

from ._compatibility import (
    assert_async_compatible as _assert_async_compatible,
    assert_sync_compatible as _assert_sync_compatible,
)
from ._drivers import (
    AsyncpgConnection as _AsyncpgConnection,
    AsyncpgExecutor as _AsyncpgExecutor,
    AsyncPsycopgConnection as _AsyncPsycopgConnection,
    AsyncPsycopgExecutor as _AsyncPsycopgExecutor,
    PsycopgConnection as _PsycopgConnection,
    Row as _Row,
    SyncExecutor as _SyncExecutor,
)
from ._statements import SQL_STATEMENTS as _SQL_STATEMENTS, DriverStatement as _DriverStatement
from .errors import (
    PurgeIdempotencyConflictError,
    RedriveIdempotencyConflictError,
    _translate_database_error,
)
from .types import Json, RetryPolicy, TaskCheckpoint, TaskProgress, TaskState, TaskWait

if TYPE_CHECKING:
    import psycopg

    _SyncConnection = psycopg.Connection[Any]
    _AsyncPsycopgConnectionInput = psycopg.AsyncConnection[Any]
else:
    _SyncConnection = _PsycopgConnection
    _AsyncPsycopgConnectionInput = _AsyncPsycopgConnection

_MAX_PAGE_SIZE = 1_000
_MAX_REDRIVE_BATCH_SIZE = 1_000
_DEFAULT_PAYLOAD_BYTES = 16_384
_MAX_PAYLOAD_BYTES = 1_048_576
_MAX_REDACT_KEYS = 50
_TASK_STATES = frozenset(
    {"blocked", "scheduled", "ready", "active", "succeeded", "failed", "canceled"}
)


def _catalogue_statement(name: str) -> _DriverStatement:
    psycopg, asyncpg = _SQL_STATEMENTS[name]
    return _DriverStatement(psycopg=psycopg, asyncpg=asyncpg)


_LIST_TASKS = _catalogue_statement("list_tasks")
_GET_TASK = _catalogue_statement("get_task")
_LIST_TIMELINE = _catalogue_statement("list_task_timeline")
_LIST_DEAD_LETTERS = _catalogue_statement("list_dead_letters")
_REDRIVE = _catalogue_statement("redrive")
_REDRIVE_MANY = _catalogue_statement("redrive_many")
_GET_CHECKPOINT = _catalogue_statement("get_checkpoint")
_LIST_CHECKPOINTS = _catalogue_statement("list_checkpoints")
_GET_PROGRESS = _catalogue_statement("get_progress")
_GET_WAIT = _catalogue_statement("get_wait")
_LIST_WAITS = _catalogue_statement("list_waits")
_LIST_SIGNAL_WAITS = _catalogue_statement("list_signal_waits")
_LIST_HUMAN_WAITS = _catalogue_statement("list_human_waits")
_LIST_WORKERS = _catalogue_statement("list_workers")
_SET_WORKER_PAUSED = _catalogue_statement("set_worker_paused")
_SET_QUEUE_PAUSED = _catalogue_statement("set_queue_paused")
_PURGE_QUEUE = _catalogue_statement("purge_queue")


@dataclass(frozen=True)
class AdminAudit:
    actor: str
    reason: str
    request_id: str


@dataclass(frozen=True)
class DeadLetterFilter:
    queue: str | None = None
    type: str | None = None
    tags: tuple[str, ...] = ()
    error_name: str | None = None
    finished_after: datetime | None = None
    finished_before: datetime | None = None


@dataclass(frozen=True)
class DeadLetterCursor:
    finished_at: str
    task_id: str


@dataclass(frozen=True)
class DeadLetterQuery(DeadLetterFilter):
    limit: int = 100
    cursor: DeadLetterCursor | None = None


@dataclass(frozen=True)
class DeadLetter:
    task_id: str
    queue: str
    type: str
    concurrency_key: str | None
    priority: int
    payload: Json
    tags: tuple[str, ...]
    current_attempt: int
    max_attempts: int
    retry_policy: RetryPolicy | None
    deadline_at: datetime | None
    execution_timeout_ms: int | None
    error: Json
    finished_at: datetime
    redrive_count: int


@dataclass(frozen=True)
class DeadLetterPage:
    items: tuple[DeadLetter, ...]
    next_cursor: DeadLetterCursor | None


@dataclass(frozen=True)
class TaskListCursor:
    created_at: str
    task_id: str
    signature: str


@dataclass(frozen=True)
class TaskPayloadProjection:
    include: bool = False
    max_bytes: int = _DEFAULT_PAYLOAD_BYTES
    redact_keys: tuple[str, ...] = ()


@dataclass(frozen=True)
class TaskListQuery:
    queue: str | None = None
    type: str | None = None
    states: tuple[TaskState, ...] = ()
    created_after: datetime | None = None
    created_before: datetime | None = None
    limit: int = 100
    cursor: TaskListCursor | None = None
    payload: TaskPayloadProjection = field(default_factory=TaskPayloadProjection)


@dataclass(frozen=True)
class DependencyPolicy:
    on_success: Literal["release", "cancel", "fail"]
    on_failure: Literal["release", "cancel", "fail"]
    on_cancellation: Literal["release", "cancel", "fail"]


@dataclass(frozen=True)
class TaskListItem:
    id: str
    queue: str
    type: str
    concurrency_key: str | None
    priority: int
    tags: tuple[str, ...]
    state: TaskState
    prerequisite_task_id: str | None
    prerequisite_task_ids: tuple[str, ...]
    dependency_policy: DependencyPolicy | None
    blocked_reason: Literal["prerequisite_pending"] | None
    parent_task_id: str | None
    child_task_ids: tuple[str, ...]
    current_attempt: int
    max_attempts: int
    retry_policy: RetryPolicy | None
    deadline_at: datetime | None
    execution_timeout_ms: int | None
    run_at: datetime
    cancel_requested_at: datetime | None
    cancel_requested_by: str | None
    cancel_reason: str | None
    created_at: datetime
    updated_at: datetime
    payload: Json
    payload_status: Literal["omitted", "included", "too_large"]
    payload_bytes: int | None


@dataclass(frozen=True)
class TaskListPage:
    items: tuple[TaskListItem, ...]
    next_cursor: TaskListCursor | None


@dataclass(frozen=True)
class TaskTimelineCursor:
    task_id: str
    occurred_at: str
    kind: Literal["event", "attempt"]
    record_id: str


@dataclass(frozen=True)
class TaskTimelineEvent:
    kind: Literal["event"]
    record_id: str
    priority: int
    attempt: int | None
    occurred_at: datetime
    event_type: str
    details: Json


@dataclass(frozen=True)
class TaskTimelineAttempt:
    kind: Literal["attempt"]
    record_id: str
    priority: int
    attempt: int
    occurred_at: datetime
    fence_token: int
    worker_id: str
    outcome: str
    started_at: datetime
    claimed_at: datetime
    finished_at: datetime
    error: Json


TaskTimelineEntry = TaskTimelineEvent | TaskTimelineAttempt


@dataclass(frozen=True)
class TaskTimelinePage:
    items: tuple[TaskTimelineEntry, ...]
    next_cursor: TaskTimelineCursor | None


@dataclass(frozen=True)
class TaskSnapshot:
    id: str
    queue: str
    type: str
    concurrency_key: str | None
    priority: int
    payload: Json
    contract_version: str | None
    tags: tuple[str, ...]
    state: TaskState
    prerequisite_task_id: str | None
    prerequisite_task_ids: tuple[str, ...]
    dependency_policy: DependencyPolicy | None
    blocked_reason: Literal["prerequisite_pending"] | None
    parent_task_id: str | None
    child_task_ids: tuple[str, ...]
    current_attempt: int
    max_attempts: int
    retry_policy: RetryPolicy | None
    deadline_at: datetime | None
    execution_timeout_ms: int | None
    fence_token: int
    run_at: datetime
    result: Json
    error: Json
    cancel_requested_at: datetime | None
    cancel_requested_by: str | None
    cancel_reason: str | None
    progress: TaskProgress | None
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True)
class RedriveResult:
    status: Literal["redriven", "replayed", "eligible", "not_found", "not_failed"]
    source_task_id: str
    target_task_id: str | None
    source_state: TaskState | None
    target_state: TaskState | None
    requested_at: datetime | None


@dataclass(frozen=True)
class BulkRedriveOptions:
    limit: int = 100
    dry_run: bool = False
    cursor: DeadLetterCursor | None = None


@dataclass(frozen=True)
class BulkRedrivePage:
    results: tuple[RedriveResult, ...]
    next_cursor: DeadLetterCursor | None


@dataclass(frozen=True)
class ExternalWaitCursor:
    created_at: str
    task_id: str
    name: str


@dataclass(frozen=True)
class ExternalWait:
    task_id: str
    queue: str
    task_type: str
    name: str
    attempt: int
    created_at: datetime
    deadline_at: datetime


@dataclass(frozen=True)
class HumanWait(ExternalWait):
    context: Json


@dataclass(frozen=True)
class ExternalWaitPage:
    items: tuple[ExternalWait, ...]
    next_cursor: ExternalWaitCursor | None


@dataclass(frozen=True)
class HumanWaitPage:
    items: tuple[HumanWait, ...]
    next_cursor: ExternalWaitCursor | None


@dataclass(frozen=True)
class WorkerPauseResult:
    worker_id: str
    paused: bool
    paused_by: str | None
    reason: str | None
    paused_at: datetime | None
    last_heartbeat_at: datetime


@dataclass(frozen=True)
class WorkerRegistryEntry(WorkerPauseResult):
    instance_id: str
    hostname: str
    pid: int
    queues: tuple[str, ...]
    queue: str
    concurrency: int
    active_slots: int
    draining: bool
    started_at: datetime


class _AdminOperations:
    def _sync_rows(
        self, statement: _DriverStatement, parameters: tuple[object, ...] = ()
    ) -> list[_Row]:
        raise NotImplementedError

    async def _async_rows(
        self, statement: _DriverStatement, parameters: tuple[object, ...] = ()
    ) -> list[_Row]:
        raise NotImplementedError


class Admin(_AdminOperations):
    """Synchronous operator client over a caller-owned Psycopg connection."""

    def __init__(self, connection: _SyncConnection, default_queue: str = "default") -> None:
        self._executor = _SyncExecutor(cast(_PsycopgConnection, connection))
        self.default_queue = default_queue

    @classmethod
    def _from_executor(cls, executor: _SyncExecutor, default_queue: str = "default") -> Admin:
        instance = cls.__new__(cls)
        instance._executor = executor
        instance.default_queue = default_queue
        return instance

    def _sync_rows(
        self, statement: _DriverStatement, parameters: tuple[object, ...] = ()
    ) -> list[_Row]:
        return self._executor.rows(statement, parameters)

    def list_tasks(self, query: TaskListQuery | None = None) -> TaskListPage:
        _assert_sync_compatible(self._executor)
        value = _validate_task_query(query or TaskListQuery())
        return _task_page(self._sync_rows(_LIST_TASKS, _task_parameters(value)))

    def get_task(self, task_id: str) -> TaskSnapshot | None:
        _assert_sync_compatible(self._executor)
        rows = self._sync_rows(_GET_TASK, (task_id,))
        return None if not rows else _task_snapshot(rows[0])

    def get_task_timeline(
        self, task_id: str, *, limit: int = 100, cursor: TaskTimelineCursor | None = None
    ) -> TaskTimelinePage:
        _assert_sync_compatible(self._executor)
        return _timeline_page(
            task_id, self._sync_rows(_LIST_TIMELINE, _timeline_parameters(task_id, limit, cursor))
        )

    def list_dead_letters(self, query: DeadLetterQuery | None = None) -> DeadLetterPage:
        _assert_sync_compatible(self._executor)
        value = query or DeadLetterQuery()
        return _dead_letter_page(
            self._sync_rows(_LIST_DEAD_LETTERS, _dead_letter_parameters(value))
        )

    def redrive(self, source_task_id: str, audit: AdminAudit) -> RedriveResult:
        _assert_sync_compatible(self._executor)
        _validate_audit(audit)
        try:
            return _redrive_result(
                _one(
                    self._sync_rows(
                        _REDRIVE, (source_task_id, audit.actor, audit.reason, audit.request_id)
                    ),
                    "workhorse.redrive_v1",
                )
            )
        except Exception as error:
            _raise_admin_error(error)

    def redrive_many(
        self,
        filter: DeadLetterFilter,
        audit: AdminAudit,
        options: BulkRedriveOptions | None = None,
    ) -> BulkRedrivePage:
        _assert_sync_compatible(self._executor)
        _validate_audit(audit)
        value = options or BulkRedriveOptions()
        try:
            return _bulk_redrive_page(
                self._sync_rows(_REDRIVE_MANY, _bulk_redrive_parameters(filter, audit, value))
            )
        except Exception as error:
            _raise_admin_error(error)

    def get_checkpoint(self, task_id: str, name: str) -> TaskCheckpoint | None:
        _assert_sync_compatible(self._executor)
        rows = self._sync_rows(_GET_CHECKPOINT, (task_id, name))
        return None if not rows else _checkpoint(rows[0])

    def list_checkpoints(self, task_id: str) -> tuple[TaskCheckpoint, ...]:
        _assert_sync_compatible(self._executor)
        return tuple(_checkpoint(row) for row in self._sync_rows(_LIST_CHECKPOINTS, (task_id,)))

    def get_progress(self, task_id: str) -> TaskProgress | None:
        _assert_sync_compatible(self._executor)
        rows = self._sync_rows(_GET_PROGRESS, (task_id,))
        return None if not rows else _progress(rows[0])

    def get_wait(self, task_id: str, name: str) -> TaskWait | None:
        _assert_sync_compatible(self._executor)
        rows = self._sync_rows(_GET_WAIT, (task_id, name))
        return None if not rows else _wait(rows[0])

    def list_waits(self, task_id: str) -> tuple[TaskWait, ...]:
        _assert_sync_compatible(self._executor)
        return tuple(_wait(row) for row in self._sync_rows(_LIST_WAITS, (task_id,)))

    def list_signal_waits(
        self, *, limit: int = 100, cursor: ExternalWaitCursor | None = None
    ) -> ExternalWaitPage:
        _assert_sync_compatible(self._executor)
        return _external_wait_page(
            self._sync_rows(_LIST_SIGNAL_WAITS, _wait_page_parameters(limit, cursor)), limit
        )

    def list_human_waits(
        self, *, limit: int = 100, cursor: ExternalWaitCursor | None = None
    ) -> HumanWaitPage:
        _assert_sync_compatible(self._executor)
        return _human_wait_page(
            self._sync_rows(_LIST_HUMAN_WAITS, _wait_page_parameters(limit, cursor)), limit
        )

    def list_workers(self) -> tuple[WorkerRegistryEntry, ...]:
        _assert_sync_compatible(self._executor)
        return tuple(_worker(row) for row in self._sync_rows(_LIST_WORKERS))

    def set_worker_paused(
        self, worker_id: str, paused: bool, audit: AdminAudit
    ) -> WorkerPauseResult | None:
        _assert_sync_compatible(self._executor)
        _validate_audit(audit)
        rows = self._sync_rows(
            _SET_WORKER_PAUSED, (worker_id, paused, audit.actor, audit.reason, audit.request_id)
        )
        return None if not rows else _worker_pause(rows[0])

    def pause_queue(self, queue_name: str, audit: AdminAudit) -> None:
        self._set_queue_paused(queue_name, True, audit)

    def resume_queue(self, queue_name: str, audit: AdminAudit) -> None:
        self._set_queue_paused(queue_name, False, audit)

    def _set_queue_paused(self, queue_name: str, paused: bool, audit: AdminAudit) -> None:
        _assert_sync_compatible(self._executor)
        _validate_audit(audit)
        self._sync_rows(
            _SET_QUEUE_PAUSED, (queue_name, paused, audit.actor, audit.reason, audit.request_id)
        )

    def purge_queue(self, queue_name: str, audit: AdminAudit) -> int:
        _assert_sync_compatible(self._executor)
        _validate_audit(audit)
        try:
            row = _one(
                self._sync_rows(
                    _PURGE_QUEUE, (queue_name, audit.actor, audit.reason, audit.request_id)
                ),
                "workhorse.purge_queue_v1",
            )
            return int(cast(int | str, row["deleted_count"]))
        except Exception as error:
            _raise_admin_error(error)


class AsyncAdmin(_AdminOperations):
    """Asynchronous operator client over a caller-owned Psycopg or asyncpg connection."""

    def __init__(
        self, executor: _AsyncPsycopgExecutor | _AsyncpgExecutor, default_queue: str = "default"
    ) -> None:
        self._executor = executor
        self.default_queue = default_queue

    @classmethod
    def from_psycopg(
        cls, connection: _AsyncPsycopgConnectionInput, default_queue: str = "default"
    ) -> AsyncAdmin:
        return cls(_AsyncPsycopgExecutor(cast(_AsyncPsycopgConnection, connection)), default_queue)

    @classmethod
    def from_asyncpg(
        cls, connection: _AsyncpgConnection, default_queue: str = "default"
    ) -> AsyncAdmin:
        return cls(_AsyncpgExecutor(connection), default_queue)

    async def _async_rows(
        self, statement: _DriverStatement, parameters: tuple[object, ...] = ()
    ) -> list[_Row]:
        return await self._executor.rows(statement, parameters)

    async def list_tasks(self, query: TaskListQuery | None = None) -> TaskListPage:
        await _assert_async_compatible(self._executor)
        value = _validate_task_query(query or TaskListQuery())
        return _task_page(await self._async_rows(_LIST_TASKS, _task_parameters(value)))

    async def get_task(self, task_id: str) -> TaskSnapshot | None:
        await _assert_async_compatible(self._executor)
        rows = await self._async_rows(_GET_TASK, (task_id,))
        return None if not rows else _task_snapshot(rows[0])

    async def get_task_timeline(
        self, task_id: str, *, limit: int = 100, cursor: TaskTimelineCursor | None = None
    ) -> TaskTimelinePage:
        await _assert_async_compatible(self._executor)
        return _timeline_page(
            task_id,
            await self._async_rows(_LIST_TIMELINE, _timeline_parameters(task_id, limit, cursor)),
        )

    async def list_dead_letters(self, query: DeadLetterQuery | None = None) -> DeadLetterPage:
        await _assert_async_compatible(self._executor)
        value = query or DeadLetterQuery()
        return _dead_letter_page(
            await self._async_rows(_LIST_DEAD_LETTERS, _dead_letter_parameters(value))
        )

    async def redrive(self, source_task_id: str, audit: AdminAudit) -> RedriveResult:
        await _assert_async_compatible(self._executor)
        _validate_audit(audit)
        try:
            return _redrive_result(
                _one(
                    await self._async_rows(
                        _REDRIVE, (source_task_id, audit.actor, audit.reason, audit.request_id)
                    ),
                    "workhorse.redrive_v1",
                )
            )
        except Exception as error:
            _raise_admin_error(error)

    async def redrive_many(
        self, filter: DeadLetterFilter, audit: AdminAudit, options: BulkRedriveOptions | None = None
    ) -> BulkRedrivePage:
        await _assert_async_compatible(self._executor)
        _validate_audit(audit)
        value = options or BulkRedriveOptions()
        try:
            return _bulk_redrive_page(
                await self._async_rows(
                    _REDRIVE_MANY, _bulk_redrive_parameters(filter, audit, value)
                )
            )
        except Exception as error:
            _raise_admin_error(error)

    async def get_checkpoint(self, task_id: str, name: str) -> TaskCheckpoint | None:
        await _assert_async_compatible(self._executor)
        rows = await self._async_rows(_GET_CHECKPOINT, (task_id, name))
        return None if not rows else _checkpoint(rows[0])

    async def list_checkpoints(self, task_id: str) -> tuple[TaskCheckpoint, ...]:
        await _assert_async_compatible(self._executor)
        return tuple(
            _checkpoint(row) for row in await self._async_rows(_LIST_CHECKPOINTS, (task_id,))
        )

    async def get_progress(self, task_id: str) -> TaskProgress | None:
        await _assert_async_compatible(self._executor)
        rows = await self._async_rows(_GET_PROGRESS, (task_id,))
        return None if not rows else _progress(rows[0])

    async def get_wait(self, task_id: str, name: str) -> TaskWait | None:
        await _assert_async_compatible(self._executor)
        rows = await self._async_rows(_GET_WAIT, (task_id, name))
        return None if not rows else _wait(rows[0])

    async def list_waits(self, task_id: str) -> tuple[TaskWait, ...]:
        await _assert_async_compatible(self._executor)
        return tuple(_wait(row) for row in await self._async_rows(_LIST_WAITS, (task_id,)))

    async def list_signal_waits(
        self, *, limit: int = 100, cursor: ExternalWaitCursor | None = None
    ) -> ExternalWaitPage:
        await _assert_async_compatible(self._executor)
        return _external_wait_page(
            await self._async_rows(_LIST_SIGNAL_WAITS, _wait_page_parameters(limit, cursor)), limit
        )

    async def list_human_waits(
        self, *, limit: int = 100, cursor: ExternalWaitCursor | None = None
    ) -> HumanWaitPage:
        await _assert_async_compatible(self._executor)
        return _human_wait_page(
            await self._async_rows(_LIST_HUMAN_WAITS, _wait_page_parameters(limit, cursor)), limit
        )

    async def list_workers(self) -> tuple[WorkerRegistryEntry, ...]:
        await _assert_async_compatible(self._executor)
        return tuple(_worker(row) for row in await self._async_rows(_LIST_WORKERS))

    async def set_worker_paused(
        self, worker_id: str, paused: bool, audit: AdminAudit
    ) -> WorkerPauseResult | None:
        await _assert_async_compatible(self._executor)
        _validate_audit(audit)
        rows = await self._async_rows(
            _SET_WORKER_PAUSED, (worker_id, paused, audit.actor, audit.reason, audit.request_id)
        )
        return None if not rows else _worker_pause(rows[0])

    async def pause_queue(self, queue_name: str, audit: AdminAudit) -> None:
        await self._set_queue_paused(queue_name, True, audit)

    async def resume_queue(self, queue_name: str, audit: AdminAudit) -> None:
        await self._set_queue_paused(queue_name, False, audit)

    async def _set_queue_paused(self, queue_name: str, paused: bool, audit: AdminAudit) -> None:
        await _assert_async_compatible(self._executor)
        _validate_audit(audit)
        await self._async_rows(
            _SET_QUEUE_PAUSED, (queue_name, paused, audit.actor, audit.reason, audit.request_id)
        )

    async def purge_queue(self, queue_name: str, audit: AdminAudit) -> int:
        await _assert_async_compatible(self._executor)
        _validate_audit(audit)
        try:
            row = _one(
                await self._async_rows(
                    _PURGE_QUEUE, (queue_name, audit.actor, audit.reason, audit.request_id)
                ),
                "workhorse.purge_queue_v1",
            )
            return int(cast(int | str, row["deleted_count"]))
        except Exception as error:
            _raise_admin_error(error)


def _validate_audit(audit: AdminAudit) -> None:
    if not isinstance(audit.actor, str) or not 1 <= len(audit.actor) <= 200:
        raise ValueError("actor must contain between 1 and 200 characters")
    if not isinstance(audit.reason, str) or not 1 <= len(audit.reason) <= 2_000:
        raise ValueError("reason must contain between 1 and 2000 characters")
    if not isinstance(audit.request_id, str) or not 1 <= len(audit.request_id.encode()) <= 512:
        raise ValueError("request_id must contain between 1 and 512 UTF-8 bytes")


def _validate_limit(limit: int, maximum: int, label: str) -> int:
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= maximum:
        raise ValueError(f"{label} must be an integer between 1 and {maximum}")
    return limit


def _validate_task_query(query: TaskListQuery) -> TaskListQuery:
    _validate_limit(query.limit, _MAX_PAGE_SIZE, "list_tasks limit")
    if query.created_after and query.created_before and query.created_after >= query.created_before:
        raise ValueError("created_after must be earlier than created_before")
    if len(set(query.states)) != len(query.states):
        raise ValueError("states must be unique")
    if any(state not in _TASK_STATES for state in query.states):
        raise ValueError("states contains an invalid task state")
    if (
        isinstance(query.payload.max_bytes, bool)
        or not isinstance(query.payload.max_bytes, int)
        or not 1 <= query.payload.max_bytes <= _MAX_PAYLOAD_BYTES
    ):
        raise ValueError("payload max_bytes is out of range")
    if len(query.payload.redact_keys) > _MAX_REDACT_KEYS:
        raise ValueError(f"payload redact_keys must contain at most {_MAX_REDACT_KEYS} keys")
    if len(set(query.payload.redact_keys)) != len(query.payload.redact_keys):
        raise ValueError("payload redact_keys must be unique")
    if any(
        not isinstance(key, str) or not 1 <= len(key) <= 200 for key in query.payload.redact_keys
    ):
        raise ValueError("payload redact_keys must contain strings of 1 to 200 characters")
    return query


def _json(value: object) -> Json:
    return cast(Json, value)


def _iso(value: datetime | None) -> str | None:
    return None if value is None else value.isoformat()


def _dependency_policy(row: _Row) -> DependencyPolicy | None:
    if row["dependency_on_failure"] is None:
        return None
    return DependencyPolicy(
        on_success=cast(Any, row["dependency_on_success"]),
        on_failure=cast(Any, row["dependency_on_failure"]),
        on_cancellation=cast(Any, row["dependency_on_cancellation"]),
    )


def _task_parameters(query: TaskListQuery) -> tuple[object, ...]:
    filter = {
        **({"queue": query.queue} if query.queue is not None else {}),
        **({"type": query.type} if query.type is not None else {}),
        **({"states": query.states} if query.states else {}),
        **({"createdAfter": _iso(query.created_after)} if query.created_after else {}),
        **({"createdBefore": _iso(query.created_before)} if query.created_before else {}),
    }
    projection = {
        "include": query.payload.include,
        "maxBytes": query.payload.max_bytes,
        "redactKeys": query.payload.redact_keys,
    }
    return (
        json.dumps(filter),
        query.limit,
        query.cursor.created_at if query.cursor else None,
        query.cursor.task_id if query.cursor else None,
        query.cursor.signature if query.cursor else None,
        json.dumps(projection),
    )


def _task_item(row: _Row) -> TaskListItem:
    return TaskListItem(
        id=str(row["task_id"]),
        queue=cast(str, row["queue_name"]),
        type=cast(str, row["task_type"]),
        concurrency_key=cast(str | None, row["concurrency_key"]),
        priority=int(cast(int, row["priority"])),
        tags=tuple(cast(list[str], row["tags"])),
        state=cast(TaskState, row["state"]),
        prerequisite_task_id=None
        if row["prerequisite_task_id"] is None
        else str(row["prerequisite_task_id"]),
        prerequisite_task_ids=tuple(
            str(value) for value in cast(list[object], row["prerequisite_task_ids"])
        ),
        dependency_policy=_dependency_policy(row),
        blocked_reason=cast(Any, row["blocked_reason"]),
        parent_task_id=None if row["parent_task_id"] is None else str(row["parent_task_id"]),
        child_task_ids=tuple(str(value) for value in cast(list[object], row["child_task_ids"])),
        current_attempt=int(cast(int, row["current_attempt"])),
        max_attempts=int(cast(int, row["max_attempts"])),
        retry_policy=cast(
            RetryPolicy | None,
            _json(row["retry_policy"]) if row["retry_policy"] is not None else None,
        ),
        deadline_at=cast(datetime | None, row["deadline_at"]),
        execution_timeout_ms=None
        if row["execution_timeout_ms"] is None
        else int(cast(str | int, row["execution_timeout_ms"])),
        run_at=cast(datetime, row["run_at"]),
        cancel_requested_at=cast(datetime | None, row["cancel_requested_at"]),
        cancel_requested_by=cast(str | None, row["cancel_requested_by"]),
        cancel_reason=cast(str | None, row["cancel_reason"]),
        created_at=cast(datetime, row["created_at"]),
        updated_at=cast(datetime, row["updated_at"]),
        payload=_json(row["payload"]) if row["payload"] is not None else None,
        payload_status=cast(Any, row["payload_status"]),
        payload_bytes=None
        if row["payload_bytes"] is None
        else int(cast(str | int, row["payload_bytes"])),
    )


def _task_page(rows: list[_Row]) -> TaskListPage:
    last = rows[-1] if rows else None
    cursor = (
        None
        if last is None or last["has_more"] is not True
        else TaskListCursor(
            str(last["cursor_created_at"]),
            str(last["task_id"]),
            cast(str, last["cursor_signature"]),
        )
    )
    return TaskListPage(tuple(_task_item(row) for row in rows), cursor)


def _task_snapshot(row: _Row) -> TaskSnapshot:
    progress = (
        None
        if row["progress_revision"] is None
        else _progress(
            {
                "task_id": row["id"],
                "progress_value": row["progress_value"],
                "revision": row["progress_revision"],
                "attempt": row["progress_attempt"],
                "fence_token": row["progress_fence_token"],
                "worker_id": row["progress_worker_id"],
                "created_at": row["progress_created_at"],
                "updated_at": row["progress_updated_at"],
            }
        )
    )
    return TaskSnapshot(
        id=str(row["id"]),
        queue=cast(str, row["queue_name"]),
        type=cast(str, row["task_type"]),
        concurrency_key=cast(str | None, row["concurrency_key"]),
        priority=int(cast(int, row["priority"])),
        payload=_json(row["payload"]),
        contract_version=cast(str | None, row["contract_version"]),
        tags=tuple(cast(list[str], row["tags"])),
        state=cast(TaskState, row["state"]),
        prerequisite_task_id=None
        if row["prerequisite_task_id"] is None
        else str(row["prerequisite_task_id"]),
        prerequisite_task_ids=tuple(
            str(value) for value in cast(list[object], row["prerequisite_task_ids"])
        ),
        dependency_policy=_dependency_policy(row),
        blocked_reason=cast(Any, row["blocked_reason"]),
        parent_task_id=None if row["parent_task_id"] is None else str(row["parent_task_id"]),
        child_task_ids=tuple(str(value) for value in cast(list[object], row["child_task_ids"])),
        current_attempt=int(cast(int, row["current_attempt"])),
        max_attempts=int(cast(int, row["max_attempts"])),
        retry_policy=cast(
            RetryPolicy | None,
            _json(row["retry_policy"]) if row["retry_policy"] is not None else None,
        ),
        deadline_at=cast(datetime | None, row["deadline_at"]),
        execution_timeout_ms=None
        if row["execution_timeout_ms"] is None
        else int(cast(str | int, row["execution_timeout_ms"])),
        fence_token=int(cast(str | int, row["version"])),
        run_at=cast(datetime, row["run_at"]),
        result=None if row["result"] is None else _json(row["result"]),
        error=None if row["error"] is None else _json(row["error"]),
        cancel_requested_at=cast(datetime | None, row["cancel_requested_at"]),
        cancel_requested_by=cast(str | None, row["cancel_requested_by"]),
        cancel_reason=cast(str | None, row["cancel_reason"]),
        progress=progress,
        created_at=cast(datetime, row["created_at"]),
        updated_at=cast(datetime, row["updated_at"]),
    )


def _timeline_parameters(
    task_id: str, limit: int, cursor: TaskTimelineCursor | None
) -> tuple[object, ...]:
    _validate_limit(limit, _MAX_PAGE_SIZE, "get_task_timeline limit")
    if cursor is not None and cursor.task_id != task_id:
        raise ValueError("cursor task_id must match the requested task_id")
    return (
        task_id,
        limit,
        cursor.occurred_at if cursor else None,
        cursor.kind if cursor else None,
        cursor.record_id if cursor else None,
    )


def _timeline_entry(row: _Row) -> TaskTimelineEntry:
    if row["kind"] == "event":
        return TaskTimelineEvent(
            "event",
            str(row["record_id"]),
            int(cast(int, row["priority"])),
            cast(int | None, row["attempt"]),
            cast(datetime, row["occurred_at"]),
            cast(str, row["event_type"]),
            _json(row["details"]),
        )
    return TaskTimelineAttempt(
        "attempt",
        str(row["record_id"]),
        int(cast(int, row["priority"])),
        int(cast(int, row["attempt"])),
        cast(datetime, row["occurred_at"]),
        int(cast(str | int, row["fence_token"])),
        cast(str, row["worker_id"]),
        cast(str, row["outcome"]),
        cast(datetime, row["started_at"]),
        cast(datetime, row["claimed_at"]),
        cast(datetime, row["finished_at"]),
        None if row["error"] is None else _json(row["error"]),
    )


def _timeline_page(task_id: str, rows: list[_Row]) -> TaskTimelinePage:
    last = rows[-1] if rows else None
    cursor = (
        None
        if last is None or last["has_more"] is not True
        else TaskTimelineCursor(
            task_id,
            str(last["cursor_occurred_at"]),
            cast(Any, last["kind"]),
            str(last["record_id"]),
        )
    )
    return TaskTimelinePage(tuple(_timeline_entry(row) for row in rows), cursor)


def _filter_document(filter: DeadLetterFilter) -> str:
    return json.dumps(
        {
            **({"queue": filter.queue} if filter.queue is not None else {}),
            **({"type": filter.type} if filter.type is not None else {}),
            **({"tags": filter.tags} if filter.tags else {}),
            **({"errorName": filter.error_name} if filter.error_name else {}),
            **({"finishedAfter": _iso(filter.finished_after)} if filter.finished_after else {}),
            **({"finishedBefore": _iso(filter.finished_before)} if filter.finished_before else {}),
        }
    )


def _dead_letter_parameters(query: DeadLetterQuery) -> tuple[object, ...]:
    _validate_limit(query.limit, _MAX_REDRIVE_BATCH_SIZE, "list_dead_letters limit")
    return (
        _filter_document(query),
        query.limit,
        query.cursor.finished_at if query.cursor else None,
        query.cursor.task_id if query.cursor else None,
    )


def _dead_letter(row: _Row) -> DeadLetter:
    return DeadLetter(
        str(row["task_id"]),
        cast(str, row["queue_name"]),
        cast(str, row["task_type"]),
        cast(str | None, row["concurrency_key"]),
        int(cast(int, row["priority"])),
        _json(row["payload"]),
        tuple(cast(list[str], row["tags"])),
        int(cast(int, row["current_attempt"])),
        int(cast(int, row["max_attempts"])),
        cast(
            RetryPolicy | None,
            _json(row["retry_policy"]) if row["retry_policy"] is not None else None,
        ),
        cast(datetime | None, row["deadline_at"]),
        None
        if row["execution_timeout_ms"] is None
        else int(cast(str | int, row["execution_timeout_ms"])),
        _json(row["error"]),
        cast(datetime, row["finished_at"]),
        int(cast(str | int, row["redrive_count"])),
    )


def _dead_letter_page(rows: list[_Row]) -> DeadLetterPage:
    last = rows[-1] if rows else None
    cursor = (
        None
        if last is None or last["has_more"] is not True
        else DeadLetterCursor(str(last["cursor_finished_at"]), str(last["task_id"]))
    )
    return DeadLetterPage(tuple(_dead_letter(row) for row in rows), cursor)


def _redrive_result(row: _Row) -> RedriveResult:
    return RedriveResult(
        cast(Any, row["status"]),
        str(row["source_task_id"]),
        None if row["target_task_id"] is None else str(row["target_task_id"]),
        cast(TaskState | None, row["source_state"]),
        cast(TaskState | None, row["target_state"]),
        cast(datetime | None, row["requested_at"]),
    )


def _bulk_redrive_parameters(
    filter: DeadLetterFilter, audit: AdminAudit, options: BulkRedriveOptions
) -> tuple[object, ...]:
    _validate_limit(options.limit, _MAX_REDRIVE_BATCH_SIZE, "redrive_many limit")
    return (
        _filter_document(filter),
        options.limit,
        options.dry_run,
        audit.actor,
        audit.reason,
        audit.request_id,
        options.cursor.finished_at if options.cursor else None,
        options.cursor.task_id if options.cursor else None,
    )


def _bulk_redrive_page(rows: list[_Row]) -> BulkRedrivePage:
    last = rows[-1] if rows else None
    cursor = (
        None
        if last is None or last["has_more"] is not True
        else DeadLetterCursor(str(last["source_finished_at_cursor"]), str(last["source_task_id"]))
    )
    return BulkRedrivePage(tuple(_redrive_result(row) for row in rows), cursor)


def _checkpoint(row: _Row) -> TaskCheckpoint:
    return TaskCheckpoint(
        str(row["task_id"]),
        cast(str, row["checkpoint_name"]),
        _json(row["checkpoint_value"]),
        int(cast(int, row["attempt"])),
        int(cast(str | int, row["fence_token"])),
        cast(str, row["worker_id"]),
        cast(datetime, row["created_at"]),
    )


def _progress(row: _Row) -> TaskProgress:
    return TaskProgress(
        str(row["task_id"]),
        _json(row["progress_value"]),
        int(cast(str | int, row["revision"])),
        int(cast(int, row["attempt"])),
        int(cast(str | int, row["fence_token"])),
        cast(str, row["worker_id"]),
        cast(datetime, row["created_at"]),
        cast(datetime, row["updated_at"]),
    )


def _wait(row: _Row) -> TaskWait:
    return TaskWait(
        str(row["task_id"]),
        cast(str, row["wait_name"]),
        cast(Any, row["mode"]),
        None if row["duration_ms"] is None else int(cast(str | int, row["duration_ms"])),
        cast(datetime | None, row["requested_wake_at"]),
        cast(datetime, row["wake_at"]),
        int(cast(int, row["attempt"])),
        int(cast(str | int, row["fence_token"])),
        cast(str, row["worker_id"]),
        cast(datetime, row["created_at"]),
    )


def _wait_page_parameters(limit: int, cursor: ExternalWaitCursor | None) -> tuple[object, ...]:
    _validate_limit(limit, _MAX_PAGE_SIZE, "external wait limit")
    return (
        limit + 1,
        cursor.created_at if cursor else None,
        cursor.task_id if cursor else None,
        cursor.name if cursor else None,
    )


def _external_wait(row: _Row) -> ExternalWait:
    return ExternalWait(
        str(row["task_id"]),
        cast(str, row["queue_name"]),
        cast(str, row["task_type"]),
        cast(str, row["wait_name"]),
        int(cast(int, row["attempt"])),
        cast(datetime, row["created_at"]),
        cast(datetime, row["deadline_at"]),
    )


def _external_wait_page(rows: list[_Row], limit: int) -> ExternalWaitPage:
    page = rows[:limit]
    last = page[-1] if page else None
    cursor = (
        None
        if len(rows) <= limit or last is None
        else ExternalWaitCursor(
            str(last["cursor_created_at"]), str(last["task_id"]), cast(str, last["wait_name"])
        )
    )
    return ExternalWaitPage(tuple(_external_wait(row) for row in page), cursor)


def _human_wait_page(rows: list[_Row], limit: int) -> HumanWaitPage:
    page = rows[:limit]
    last = page[-1] if page else None
    cursor = (
        None
        if len(rows) <= limit or last is None
        else ExternalWaitCursor(
            str(last["cursor_created_at"]), str(last["task_id"]), cast(str, last["wait_name"])
        )
    )
    return HumanWaitPage(
        tuple(
            HumanWait(**_external_wait(row).__dict__, context=_json(row["context"])) for row in page
        ),
        cursor,
    )


def _worker_pause(row: _Row) -> WorkerPauseResult:
    return WorkerPauseResult(
        cast(str, row["worker_id"]),
        bool(row["paused"]),
        cast(str | None, row["paused_by"]),
        cast(str | None, row["paused_reason"]),
        cast(datetime | None, row["paused_at"]),
        cast(datetime, row["last_heartbeat_at"]),
    )


def _worker(row: _Row) -> WorkerRegistryEntry:
    base = _worker_pause(row)
    return WorkerRegistryEntry(
        **base.__dict__,
        instance_id=str(row["instance_id"]),
        hostname=cast(str, row["hostname"]),
        pid=int(cast(int, row["pid"])),
        queues=tuple(cast(list[str], row["queue_names"])),
        queue=cast(str, row["queue_name"]),
        concurrency=int(cast(int, row["concurrency"])),
        active_slots=int(cast(int, row["active_slots"])),
        draining=bool(row["draining"]),
        started_at=cast(datetime, row["started_at"]),
    )


def _one(rows: list[_Row], operation: str) -> _Row:
    if len(rows) != 1:
        raise RuntimeError(f"{operation} returned {len(rows)} rows; expected one")
    return rows[0]


def _raise_admin_error(error: Exception) -> NoReturn:
    translated = _translate_database_error(error)
    if translated is not None:
        raise translated from error
    sqlstate = getattr(error, "sqlstate", None) or getattr(error, "code", None)
    details = _database_details(error)
    if sqlstate == "P1002":
        raise RedriveIdempotencyConflictError(details) from error
    if sqlstate == "P1006":
        raise PurgeIdempotencyConflictError(details) from error
    raise error


def _database_details(error: Exception) -> dict[str, object]:
    diagnostic = getattr(error, "diag", None)
    raw = getattr(diagnostic, "message_detail", None) or getattr(error, "detail", None)
    if isinstance(raw, str):
        try:
            value = json.loads(raw)
            return value if isinstance(value, dict) else {}
        except json.JSONDecodeError:
            return {}
    return dict(raw) if isinstance(raw, dict) else {}


__all__ = [
    "Admin",
    "AdminAudit",
    "AsyncAdmin",
    "BulkRedriveOptions",
    "BulkRedrivePage",
    "DeadLetter",
    "DeadLetterCursor",
    "DeadLetterFilter",
    "DeadLetterPage",
    "DeadLetterQuery",
    "DependencyPolicy",
    "ExternalWait",
    "ExternalWaitCursor",
    "ExternalWaitPage",
    "HumanWait",
    "HumanWaitPage",
    "RedriveResult",
    "TaskListCursor",
    "TaskListItem",
    "TaskListPage",
    "TaskListQuery",
    "TaskPayloadProjection",
    "TaskSnapshot",
    "TaskTimelineAttempt",
    "TaskTimelineCursor",
    "TaskTimelineEntry",
    "TaskTimelineEvent",
    "TaskTimelinePage",
    "WorkerPauseResult",
    "WorkerRegistryEntry",
]
