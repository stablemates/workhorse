from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING, Any, Literal, NoReturn, cast

from ._compatibility import assert_async_compatible, assert_sync_compatible
from ._drivers import (
    AsyncpgConnection,
    AsyncpgExecutor,
    AsyncPsycopgConnection,
    AsyncPsycopgExecutor,
    PsycopgConnection,
    Row,
    SyncExecutor,
)
from ._statements import DriverStatement
from .errors import (
    PurgeIdempotencyConflictError,
    RedriveIdempotencyConflictError,
    translate_database_error,
)
from .types import JobCheckpoint, JobProgress, JobState, JobWait, Json, RetryPolicy

if TYPE_CHECKING:
    import psycopg

    SyncConnection = psycopg.Connection[Any]
    AsyncPsycopgConnectionInput = psycopg.AsyncConnection[Any]
else:
    SyncConnection = PsycopgConnection
    AsyncPsycopgConnectionInput = AsyncPsycopgConnection

MAX_PAGE_SIZE = 1_000
MAX_REDRIVE_BATCH_SIZE = 1_000
DEFAULT_PAYLOAD_BYTES = 16_384
MAX_PAYLOAD_BYTES = 1_048_576
MAX_REDACT_KEYS = 50
JOB_STATES = frozenset(
    {"blocked", "scheduled", "ready", "active", "succeeded", "failed", "canceled"}
)


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
    job_id: str


@dataclass(frozen=True)
class DeadLetterQuery(DeadLetterFilter):
    limit: int = 100
    cursor: DeadLetterCursor | None = None


@dataclass(frozen=True)
class DeadLetter:
    job_id: str
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
class JobListCursor:
    created_at: str
    job_id: str
    signature: str


@dataclass(frozen=True)
class JobPayloadProjection:
    include: bool = False
    max_bytes: int = DEFAULT_PAYLOAD_BYTES
    redact_keys: tuple[str, ...] = ()


@dataclass(frozen=True)
class JobListQuery:
    queue: str | None = None
    type: str | None = None
    states: tuple[JobState, ...] = ()
    created_after: datetime | None = None
    created_before: datetime | None = None
    limit: int = 100
    cursor: JobListCursor | None = None
    payload: JobPayloadProjection = field(default_factory=JobPayloadProjection)


@dataclass(frozen=True)
class DependencyPolicy:
    on_success: Literal["release", "cancel", "fail"]
    on_failure: Literal["release", "cancel", "fail"]
    on_cancellation: Literal["release", "cancel", "fail"]


@dataclass(frozen=True)
class JobListItem:
    id: str
    queue: str
    type: str
    concurrency_key: str | None
    priority: int
    tags: tuple[str, ...]
    state: JobState
    prerequisite_job_id: str | None
    prerequisite_job_ids: tuple[str, ...]
    dependency_policy: DependencyPolicy | None
    blocked_reason: Literal["prerequisite_pending"] | None
    parent_job_id: str | None
    child_job_ids: tuple[str, ...]
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
class JobListPage:
    items: tuple[JobListItem, ...]
    next_cursor: JobListCursor | None


@dataclass(frozen=True)
class JobTimelineCursor:
    job_id: str
    occurred_at: str
    kind: Literal["event", "attempt"]
    record_id: str


@dataclass(frozen=True)
class JobTimelineEvent:
    kind: Literal["event"]
    record_id: str
    priority: int
    attempt: int | None
    occurred_at: datetime
    event_type: str
    details: Json


@dataclass(frozen=True)
class JobTimelineAttempt:
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


JobTimelineEntry = JobTimelineEvent | JobTimelineAttempt


@dataclass(frozen=True)
class JobTimelinePage:
    items: tuple[JobTimelineEntry, ...]
    next_cursor: JobTimelineCursor | None


@dataclass(frozen=True)
class JobSnapshot:
    id: str
    queue: str
    type: str
    concurrency_key: str | None
    priority: int
    payload: Json
    contract_version: str | None
    tags: tuple[str, ...]
    state: JobState
    prerequisite_job_id: str | None
    prerequisite_job_ids: tuple[str, ...]
    dependency_policy: DependencyPolicy | None
    blocked_reason: Literal["prerequisite_pending"] | None
    parent_job_id: str | None
    child_job_ids: tuple[str, ...]
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
    progress: JobProgress | None
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True)
class RedriveResult:
    status: Literal["redriven", "replayed", "eligible", "not_found", "not_failed"]
    source_job_id: str
    target_job_id: str | None
    source_state: JobState | None
    target_state: JobState | None
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
    job_id: str
    name: str


@dataclass(frozen=True)
class ExternalWait:
    job_id: str
    queue: str
    job_type: str
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


def _statement(psycopg: str, asyncpg: str) -> DriverStatement:
    return DriverStatement(psycopg=psycopg, asyncpg=asyncpg)


def _same_statement(sql: str) -> DriverStatement:
    return _statement(sql, sql)


LIST_JOBS = _statement(
    """SELECT listed.job_id, listed.queue_name, listed.job_type, listed.concurrency_key,
              listed.priority, listed.tags, listed.state, dependency.prerequisite_job_id,
              dependency.prerequisite_job_ids, dependency.on_success AS dependency_on_success,
              dependency.on_failure AS dependency_on_failure,
              dependency.on_cancellation AS dependency_on_cancellation,
              CASE WHEN listed.state = 'blocked' THEN 'prerequisite_pending' END AS blocked_reason,
              parent_edge.parent_job_id, children.child_job_ids, listed.current_attempt,
              listed.max_attempts, listed.retry_policy, listed.deadline_at,
              listed.execution_timeout_ms::text AS execution_timeout_ms, listed.run_at,
              listed.cancel_requested_at, listed.cancel_requested_by, listed.cancel_reason,
              listed.created_at, listed.updated_at, listed.payload, listed.payload_status,
              listed.payload_bytes, listed.has_more,
              listed.cursor_created_at::text AS cursor_created_at, listed.cursor_signature
         FROM workhorse.list_jobs_v1(
           %s::jsonb, %s::integer, %s::timestamptz, %s::uuid, %s::text, %s::jsonb
         ) listed
         LEFT JOIN LATERAL (
           SELECT CASE WHEN count(*) = 1 THEN (array_agg(edge.prerequisite_job_id))[1] END
                    AS prerequisite_job_id,
                  COALESCE(array_agg(edge.prerequisite_job_id ORDER BY edge.prerequisite_job_id)
                    FILTER (WHERE edge.prerequisite_job_id IS NOT NULL), '{}')
                    AS prerequisite_job_ids,
                  min(edge.on_success) AS on_success, min(edge.on_failure) AS on_failure,
                  min(edge.on_cancellation) AS on_cancellation
             FROM workhorse.job_dependency edge
            WHERE edge.dependent_job_id = listed.job_id
         ) dependency ON true
         LEFT JOIN workhorse.job_child parent_edge ON parent_edge.child_job_id = listed.job_id
         LEFT JOIN LATERAL (
           SELECT COALESCE(array_agg(edge.child_job_id ORDER BY edge.child_job_id)
                    FILTER (WHERE edge.child_job_id IS NOT NULL), '{}') AS child_job_ids
             FROM workhorse.job_child edge WHERE edge.parent_job_id = listed.job_id
         ) children ON true""",
    """SELECT listed.job_id, listed.queue_name, listed.job_type, listed.concurrency_key,
              listed.priority, listed.tags, listed.state, dependency.prerequisite_job_id,
              dependency.prerequisite_job_ids, dependency.on_success AS dependency_on_success,
              dependency.on_failure AS dependency_on_failure,
              dependency.on_cancellation AS dependency_on_cancellation,
              CASE WHEN listed.state = 'blocked' THEN 'prerequisite_pending' END AS blocked_reason,
              parent_edge.parent_job_id, children.child_job_ids, listed.current_attempt,
              listed.max_attempts, listed.retry_policy, listed.deadline_at,
              listed.execution_timeout_ms::text AS execution_timeout_ms, listed.run_at,
              listed.cancel_requested_at, listed.cancel_requested_by, listed.cancel_reason,
              listed.created_at, listed.updated_at, listed.payload, listed.payload_status,
              listed.payload_bytes, listed.has_more,
              listed.cursor_created_at::text AS cursor_created_at, listed.cursor_signature
         FROM workhorse.list_jobs_v1(
           $1::jsonb, $2::integer, $3::timestamptz, $4::uuid, $5::text, $6::jsonb
         ) listed
         LEFT JOIN LATERAL (
           SELECT CASE WHEN count(*) = 1 THEN (array_agg(edge.prerequisite_job_id))[1] END
                    AS prerequisite_job_id,
                  COALESCE(array_agg(edge.prerequisite_job_id ORDER BY edge.prerequisite_job_id)
                    FILTER (WHERE edge.prerequisite_job_id IS NOT NULL), '{}')
                    AS prerequisite_job_ids,
                  min(edge.on_success) AS on_success, min(edge.on_failure) AS on_failure,
                  min(edge.on_cancellation) AS on_cancellation
             FROM workhorse.job_dependency edge
            WHERE edge.dependent_job_id = listed.job_id
         ) dependency ON true
         LEFT JOIN workhorse.job_child parent_edge ON parent_edge.child_job_id = listed.job_id
         LEFT JOIN LATERAL (
           SELECT COALESCE(array_agg(edge.child_job_id ORDER BY edge.child_job_id)
                    FILTER (WHERE edge.child_job_id IS NOT NULL), '{}') AS child_job_ids
             FROM workhorse.job_child edge WHERE edge.parent_job_id = listed.job_id
         ) children ON true""",
)

GET_JOB = _statement(
    """SELECT j.id, j.queue_name, j.job_type, j.concurrency_key, j.priority,
              workhorse.redact_top_level_keys_v1(j.payload, j.payload_redact_keys) AS payload,
              j.contract_version, j.tags, j.retry_policy, j.deadline_at,
              j.execution_timeout_ms::text, COALESCE(r.state, o.state) AS state,
              dependency.prerequisite_job_id, dependency.prerequisite_job_ids,
              dependency.on_success AS dependency_on_success,
              dependency.on_failure AS dependency_on_failure,
              dependency.on_cancellation AS dependency_on_cancellation,
              CASE WHEN r.state = 'blocked' THEN 'prerequisite_pending' END AS blocked_reason,
              parent_edge.parent_job_id, children.child_job_ids,
              COALESCE(r.current_attempt, o.current_attempt) AS current_attempt, j.max_attempts,
              COALESCE(r.fence_token, o.fence_token)::text AS version,
              COALESCE(r.run_at, o.run_at) AS run_at,
              workhorse.redact_top_level_keys_v1(o.result, j.result_redact_keys) AS result,
              COALESCE(r.error, o.error) AS error, r.cancel_requested_at,
              r.cancel_requested_by, r.cancel_reason, p.progress_value,
              p.revision::text AS progress_revision, p.attempt AS progress_attempt,
              p.fence_token::text AS progress_fence_token, p.worker_id AS progress_worker_id,
              p.created_at AS progress_created_at, p.updated_at AS progress_updated_at,
              j.created_at, COALESCE(r.updated_at, o.updated_at) AS updated_at
         FROM workhorse.job j
         LEFT JOIN workhorse.job_runtime r ON r.job_id = j.id
         LEFT JOIN workhorse.job_outcome o ON o.job_id = j.id
         LEFT JOIN LATERAL (
           SELECT CASE WHEN count(*) = 1 THEN (array_agg(edge.prerequisite_job_id))[1] END
                    AS prerequisite_job_id,
                  COALESCE(array_agg(edge.prerequisite_job_id ORDER BY edge.prerequisite_job_id)
                    FILTER (WHERE edge.prerequisite_job_id IS NOT NULL), '{}')
                    AS prerequisite_job_ids,
                  min(edge.on_success) AS on_success, min(edge.on_failure) AS on_failure,
                  min(edge.on_cancellation) AS on_cancellation
             FROM workhorse.job_dependency edge WHERE edge.dependent_job_id = j.id
         ) dependency ON true
         LEFT JOIN workhorse.job_child parent_edge ON parent_edge.child_job_id = j.id
         LEFT JOIN LATERAL (
           SELECT COALESCE(array_agg(edge.child_job_id ORDER BY edge.child_job_id)
                    FILTER (WHERE edge.child_job_id IS NOT NULL), '{}') AS child_job_ids
             FROM workhorse.job_child edge WHERE edge.parent_job_id = j.id
         ) children ON true
         LEFT JOIN workhorse.job_progress p ON p.job_id = j.id
        WHERE j.id = %s::uuid""",
    """SELECT j.id, j.queue_name, j.job_type, j.concurrency_key, j.priority,
              workhorse.redact_top_level_keys_v1(j.payload, j.payload_redact_keys) AS payload,
              j.contract_version, j.tags, j.retry_policy, j.deadline_at,
              j.execution_timeout_ms::text, COALESCE(r.state, o.state) AS state,
              dependency.prerequisite_job_id, dependency.prerequisite_job_ids,
              dependency.on_success AS dependency_on_success,
              dependency.on_failure AS dependency_on_failure,
              dependency.on_cancellation AS dependency_on_cancellation,
              CASE WHEN r.state = 'blocked' THEN 'prerequisite_pending' END AS blocked_reason,
              parent_edge.parent_job_id, children.child_job_ids,
              COALESCE(r.current_attempt, o.current_attempt) AS current_attempt, j.max_attempts,
              COALESCE(r.fence_token, o.fence_token)::text AS version,
              COALESCE(r.run_at, o.run_at) AS run_at,
              workhorse.redact_top_level_keys_v1(o.result, j.result_redact_keys) AS result,
              COALESCE(r.error, o.error) AS error, r.cancel_requested_at,
              r.cancel_requested_by, r.cancel_reason, p.progress_value,
              p.revision::text AS progress_revision, p.attempt AS progress_attempt,
              p.fence_token::text AS progress_fence_token, p.worker_id AS progress_worker_id,
              p.created_at AS progress_created_at, p.updated_at AS progress_updated_at,
              j.created_at, COALESCE(r.updated_at, o.updated_at) AS updated_at
         FROM workhorse.job j
         LEFT JOIN workhorse.job_runtime r ON r.job_id = j.id
         LEFT JOIN workhorse.job_outcome o ON o.job_id = j.id
         LEFT JOIN LATERAL (
           SELECT CASE WHEN count(*) = 1 THEN (array_agg(edge.prerequisite_job_id))[1] END
                    AS prerequisite_job_id,
                  COALESCE(array_agg(edge.prerequisite_job_id ORDER BY edge.prerequisite_job_id)
                    FILTER (WHERE edge.prerequisite_job_id IS NOT NULL), '{}')
                    AS prerequisite_job_ids,
                  min(edge.on_success) AS on_success, min(edge.on_failure) AS on_failure,
                  min(edge.on_cancellation) AS on_cancellation
             FROM workhorse.job_dependency edge WHERE edge.dependent_job_id = j.id
         ) dependency ON true
         LEFT JOIN workhorse.job_child parent_edge ON parent_edge.child_job_id = j.id
         LEFT JOIN LATERAL (
           SELECT COALESCE(array_agg(edge.child_job_id ORDER BY edge.child_job_id)
                    FILTER (WHERE edge.child_job_id IS NOT NULL), '{}') AS child_job_ids
             FROM workhorse.job_child edge WHERE edge.parent_job_id = j.id
         ) children ON true
         LEFT JOIN workhorse.job_progress p ON p.job_id = j.id
        WHERE j.id = $1::uuid""",
)

LIST_TIMELINE = _statement(
    """SELECT kind, record_id::text, priority, attempt, event_type, details,
              fence_token::text, worker_id, outcome, started_at, claimed_at, finished_at,
              error, occurred_at, has_more, cursor_occurred_at::text
         FROM workhorse.list_job_timeline_v1(
           %s::uuid, %s::integer, %s::timestamptz, %s::text, %s::bigint)""",
    """SELECT kind, record_id::text, priority, attempt, event_type, details,
              fence_token::text, worker_id, outcome, started_at, claimed_at, finished_at,
              error, occurred_at, has_more, cursor_occurred_at::text
         FROM workhorse.list_job_timeline_v1(
           $1::uuid, $2::integer, $3::timestamptz, $4::text, $5::bigint)""",
)

LIST_DEAD_LETTERS = _statement(
    """SELECT * FROM workhorse.list_dead_letters_v1(
         %s::jsonb, %s::integer, %s::timestamptz, %s::uuid)""",
    """SELECT * FROM workhorse.list_dead_letters_v1(
         $1::jsonb, $2::integer, $3::timestamptz, $4::uuid)""",
)
REDRIVE = _statement(
    "SELECT * FROM workhorse.redrive_v1(%s::uuid, %s::text, %s::text, %s::text)",
    "SELECT * FROM workhorse.redrive_v1($1::uuid, $2::text, $3::text, $4::text)",
)
REDRIVE_MANY = _statement(
    """SELECT status, source_job_id, target_job_id, source_state, target_state,
              requested_at, source_finished_at_cursor, has_more
         FROM workhorse.redrive_many_v1(
           %s::jsonb, %s::integer, %s::boolean, %s::text, %s::text, %s::text,
           %s::timestamptz, %s::uuid) ORDER BY ordinal""",
    """SELECT status, source_job_id, target_job_id, source_state, target_state,
              requested_at, source_finished_at_cursor, has_more
         FROM workhorse.redrive_many_v1(
           $1::jsonb, $2::integer, $3::boolean, $4::text, $5::text, $6::text,
           $7::timestamptz, $8::uuid) ORDER BY ordinal""",
)
GET_CHECKPOINT = _statement(
    """SELECT job_id, checkpoint_name, checkpoint_value, attempt, fence_token::text,
              worker_id, created_at FROM workhorse.job_checkpoint
        WHERE job_id = %s::uuid AND checkpoint_name = %s::text""",
    """SELECT job_id, checkpoint_name, checkpoint_value, attempt, fence_token::text,
              worker_id, created_at FROM workhorse.job_checkpoint
        WHERE job_id = $1::uuid AND checkpoint_name = $2::text""",
)
LIST_CHECKPOINTS = _statement(
    """SELECT job_id, checkpoint_name, checkpoint_value, attempt, fence_token::text,
              worker_id, created_at FROM workhorse.job_checkpoint
        WHERE job_id = %s::uuid ORDER BY created_at, checkpoint_name""",
    """SELECT job_id, checkpoint_name, checkpoint_value, attempt, fence_token::text,
              worker_id, created_at FROM workhorse.job_checkpoint
        WHERE job_id = $1::uuid ORDER BY created_at, checkpoint_name""",
)
GET_PROGRESS = _statement(
    """SELECT job_id, progress_value, revision::text, attempt, fence_token::text,
              worker_id, created_at, updated_at FROM workhorse.job_progress
        WHERE job_id = %s::uuid""",
    """SELECT job_id, progress_value, revision::text, attempt, fence_token::text,
              worker_id, created_at, updated_at FROM workhorse.job_progress
        WHERE job_id = $1::uuid""",
)
GET_WAIT = _statement(
    """SELECT job_id, wait_name, mode, duration_ms::text, requested_wake_at, wake_at,
              attempt, fence_token::text, worker_id, created_at FROM workhorse.job_wait
        WHERE job_id = %s::uuid AND wait_name = %s::text""",
    """SELECT job_id, wait_name, mode, duration_ms::text, requested_wake_at, wake_at,
              attempt, fence_token::text, worker_id, created_at FROM workhorse.job_wait
        WHERE job_id = $1::uuid AND wait_name = $2::text""",
)
LIST_WAITS = _statement(
    """SELECT job_id, wait_name, mode, duration_ms::text, requested_wake_at, wake_at,
              attempt, fence_token::text, worker_id, created_at FROM workhorse.job_wait
        WHERE job_id = %s::uuid ORDER BY created_at, wait_name""",
    """SELECT job_id, wait_name, mode, duration_ms::text, requested_wake_at, wake_at,
              attempt, fence_token::text, worker_id, created_at FROM workhorse.job_wait
        WHERE job_id = $1::uuid ORDER BY created_at, wait_name""",
)
LIST_SIGNAL_WAITS = _statement(
    """WITH parameters AS (
         SELECT %s::integer AS page_limit, %s::timestamptz AS cursor_created_at,
                %s::uuid AS cursor_job_id, %s::text AS cursor_name
       )
       SELECT job_id, queue_name, job_type, signal_name AS wait_name, attempt, created_at,
              deadline_at, created_at::text AS cursor_created_at
         FROM workhorse.dashboard_signal_wait_v1, parameters
        WHERE parameters.cursor_created_at IS NULL OR (created_at, job_id, signal_name) >
              (parameters.cursor_created_at, parameters.cursor_job_id, parameters.cursor_name)
        ORDER BY created_at, job_id, signal_name LIMIT (SELECT page_limit FROM parameters)""",
    """WITH parameters AS (
         SELECT $1::integer AS page_limit, $2::timestamptz AS cursor_created_at,
                $3::uuid AS cursor_job_id, $4::text AS cursor_name
       )
       SELECT job_id, queue_name, job_type, signal_name AS wait_name, attempt, created_at,
              deadline_at, created_at::text AS cursor_created_at
         FROM workhorse.dashboard_signal_wait_v1, parameters
        WHERE parameters.cursor_created_at IS NULL OR (created_at, job_id, signal_name) >
              (parameters.cursor_created_at, parameters.cursor_job_id, parameters.cursor_name)
        ORDER BY created_at, job_id, signal_name LIMIT (SELECT page_limit FROM parameters)""",
)
LIST_HUMAN_WAITS = _statement(
    """WITH parameters AS (
         SELECT %s::integer AS page_limit, %s::timestamptz AS cursor_created_at,
                %s::uuid AS cursor_job_id, %s::text AS cursor_name
       )
       SELECT job_id, queue_name, job_type, token_name AS wait_name, context, attempt,
              created_at, deadline_at, created_at::text AS cursor_created_at
         FROM workhorse.dashboard_human_wait_v1, parameters
        WHERE parameters.cursor_created_at IS NULL OR (created_at, job_id, token_name) >
              (parameters.cursor_created_at, parameters.cursor_job_id, parameters.cursor_name)
        ORDER BY created_at, job_id, token_name LIMIT (SELECT page_limit FROM parameters)""",
    """WITH parameters AS (
         SELECT $1::integer AS page_limit, $2::timestamptz AS cursor_created_at,
                $3::uuid AS cursor_job_id, $4::text AS cursor_name
       )
       SELECT job_id, queue_name, job_type, token_name AS wait_name, context, attempt,
              created_at, deadline_at, created_at::text AS cursor_created_at
         FROM workhorse.dashboard_human_wait_v1, parameters
        WHERE parameters.cursor_created_at IS NULL OR (created_at, job_id, token_name) >
              (parameters.cursor_created_at, parameters.cursor_job_id, parameters.cursor_name)
        ORDER BY created_at, job_id, token_name LIMIT (SELECT page_limit FROM parameters)""",
)
LIST_WORKERS = _same_statement(
    """SELECT worker_id, instance_id::text, hostname, pid, queue_names, queue_name,
              concurrency, active_slots, draining, paused, paused_by, paused_reason,
              paused_at, started_at, last_heartbeat_at FROM workhorse.worker_registry
        ORDER BY last_heartbeat_at DESC, worker_id"""
)
SET_WORKER_PAUSED = _statement(
    """SELECT * FROM workhorse.set_worker_paused_v1(
         %s::text, %s::boolean, %s::text, %s::text, %s::text)""",
    """SELECT * FROM workhorse.set_worker_paused_v1(
         $1::text, $2::boolean, $3::text, $4::text, $5::text)""",
)
SET_QUEUE_PAUSED = _statement(
    "SELECT workhorse.set_queue_paused_v1(%s::text, %s::boolean, %s::text, %s::text, %s::text)",
    "SELECT workhorse.set_queue_paused_v1($1::text, $2::boolean, $3::text, $4::text, $5::text)",
)
PURGE_QUEUE = _statement(
    "SELECT * FROM workhorse.purge_queue_v1(%s::text, %s::text, %s::text, %s::text)",
    "SELECT * FROM workhorse.purge_queue_v1($1::text, $2::text, $3::text, $4::text)",
)


class _AdminOperations:
    def _sync_rows(
        self, statement: DriverStatement, parameters: tuple[object, ...] = ()
    ) -> list[Row]:
        raise NotImplementedError

    async def _async_rows(
        self, statement: DriverStatement, parameters: tuple[object, ...] = ()
    ) -> list[Row]:
        raise NotImplementedError


class Admin(_AdminOperations):
    """Synchronous operator client over a caller-owned Psycopg connection."""

    def __init__(self, connection: SyncConnection, default_queue: str = "default") -> None:
        self._executor = SyncExecutor(cast(PsycopgConnection, connection))
        self.default_queue = default_queue

    @classmethod
    def _from_executor(cls, executor: SyncExecutor, default_queue: str = "default") -> Admin:
        instance = cls.__new__(cls)
        instance._executor = executor
        instance.default_queue = default_queue
        return instance

    def _sync_rows(
        self, statement: DriverStatement, parameters: tuple[object, ...] = ()
    ) -> list[Row]:
        return self._executor.rows(statement, parameters)

    def list_jobs(self, query: JobListQuery | None = None) -> JobListPage:
        assert_sync_compatible(self._executor)
        value = _validate_job_query(query or JobListQuery())
        return _job_page(self._sync_rows(LIST_JOBS, _job_parameters(value)))

    def get_job(self, job_id: str) -> JobSnapshot | None:
        assert_sync_compatible(self._executor)
        rows = self._sync_rows(GET_JOB, (job_id,))
        return None if not rows else _job_snapshot(rows[0])

    def get_job_timeline(
        self, job_id: str, *, limit: int = 100, cursor: JobTimelineCursor | None = None
    ) -> JobTimelinePage:
        assert_sync_compatible(self._executor)
        return _timeline_page(
            job_id, self._sync_rows(LIST_TIMELINE, _timeline_parameters(job_id, limit, cursor))
        )

    def list_dead_letters(self, query: DeadLetterQuery | None = None) -> DeadLetterPage:
        assert_sync_compatible(self._executor)
        value = query or DeadLetterQuery()
        return _dead_letter_page(self._sync_rows(LIST_DEAD_LETTERS, _dead_letter_parameters(value)))

    def redrive(self, source_job_id: str, audit: AdminAudit) -> RedriveResult:
        assert_sync_compatible(self._executor)
        _validate_audit(audit)
        try:
            return _redrive_result(
                _one(
                    self._sync_rows(
                        REDRIVE, (source_job_id, audit.actor, audit.reason, audit.request_id)
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
        assert_sync_compatible(self._executor)
        _validate_audit(audit)
        value = options or BulkRedriveOptions()
        try:
            return _bulk_redrive_page(
                self._sync_rows(REDRIVE_MANY, _bulk_redrive_parameters(filter, audit, value))
            )
        except Exception as error:
            _raise_admin_error(error)

    def get_checkpoint(self, job_id: str, name: str) -> JobCheckpoint | None:
        assert_sync_compatible(self._executor)
        rows = self._sync_rows(GET_CHECKPOINT, (job_id, name))
        return None if not rows else _checkpoint(rows[0])

    def list_checkpoints(self, job_id: str) -> tuple[JobCheckpoint, ...]:
        assert_sync_compatible(self._executor)
        return tuple(_checkpoint(row) for row in self._sync_rows(LIST_CHECKPOINTS, (job_id,)))

    def get_progress(self, job_id: str) -> JobProgress | None:
        assert_sync_compatible(self._executor)
        rows = self._sync_rows(GET_PROGRESS, (job_id,))
        return None if not rows else _progress(rows[0])

    def get_wait(self, job_id: str, name: str) -> JobWait | None:
        assert_sync_compatible(self._executor)
        rows = self._sync_rows(GET_WAIT, (job_id, name))
        return None if not rows else _wait(rows[0])

    def list_waits(self, job_id: str) -> tuple[JobWait, ...]:
        assert_sync_compatible(self._executor)
        return tuple(_wait(row) for row in self._sync_rows(LIST_WAITS, (job_id,)))

    def list_signal_waits(
        self, *, limit: int = 100, cursor: ExternalWaitCursor | None = None
    ) -> ExternalWaitPage:
        assert_sync_compatible(self._executor)
        return _external_wait_page(
            self._sync_rows(LIST_SIGNAL_WAITS, _wait_page_parameters(limit, cursor)), limit
        )

    def list_human_waits(
        self, *, limit: int = 100, cursor: ExternalWaitCursor | None = None
    ) -> HumanWaitPage:
        assert_sync_compatible(self._executor)
        return _human_wait_page(
            self._sync_rows(LIST_HUMAN_WAITS, _wait_page_parameters(limit, cursor)), limit
        )

    def list_workers(self) -> tuple[WorkerRegistryEntry, ...]:
        assert_sync_compatible(self._executor)
        return tuple(_worker(row) for row in self._sync_rows(LIST_WORKERS))

    def set_worker_paused(
        self, worker_id: str, paused: bool, audit: AdminAudit
    ) -> WorkerPauseResult | None:
        assert_sync_compatible(self._executor)
        _validate_audit(audit)
        rows = self._sync_rows(
            SET_WORKER_PAUSED, (worker_id, paused, audit.actor, audit.reason, audit.request_id)
        )
        return None if not rows else _worker_pause(rows[0])

    def pause_queue(self, queue_name: str, audit: AdminAudit) -> None:
        self._set_queue_paused(queue_name, True, audit)

    def resume_queue(self, queue_name: str, audit: AdminAudit) -> None:
        self._set_queue_paused(queue_name, False, audit)

    def _set_queue_paused(self, queue_name: str, paused: bool, audit: AdminAudit) -> None:
        assert_sync_compatible(self._executor)
        _validate_audit(audit)
        self._sync_rows(
            SET_QUEUE_PAUSED, (queue_name, paused, audit.actor, audit.reason, audit.request_id)
        )

    def purge_queue(self, queue_name: str, audit: AdminAudit) -> int:
        assert_sync_compatible(self._executor)
        _validate_audit(audit)
        try:
            row = _one(
                self._sync_rows(
                    PURGE_QUEUE, (queue_name, audit.actor, audit.reason, audit.request_id)
                ),
                "workhorse.purge_queue_v1",
            )
            return int(cast(int | str, row["deleted_count"]))
        except Exception as error:
            _raise_admin_error(error)


class AsyncAdmin(_AdminOperations):
    """Asynchronous operator client over a caller-owned Psycopg or asyncpg connection."""

    def __init__(
        self, executor: AsyncPsycopgExecutor | AsyncpgExecutor, default_queue: str = "default"
    ) -> None:
        self._executor = executor
        self.default_queue = default_queue

    @classmethod
    def from_psycopg(
        cls, connection: AsyncPsycopgConnectionInput, default_queue: str = "default"
    ) -> AsyncAdmin:
        return cls(AsyncPsycopgExecutor(cast(AsyncPsycopgConnection, connection)), default_queue)

    @classmethod
    def from_asyncpg(
        cls, connection: AsyncpgConnection, default_queue: str = "default"
    ) -> AsyncAdmin:
        return cls(AsyncpgExecutor(connection), default_queue)

    async def _async_rows(
        self, statement: DriverStatement, parameters: tuple[object, ...] = ()
    ) -> list[Row]:
        return await self._executor.rows(statement, parameters)

    async def list_jobs(self, query: JobListQuery | None = None) -> JobListPage:
        await assert_async_compatible(self._executor)
        value = _validate_job_query(query or JobListQuery())
        return _job_page(await self._async_rows(LIST_JOBS, _job_parameters(value)))

    async def get_job(self, job_id: str) -> JobSnapshot | None:
        await assert_async_compatible(self._executor)
        rows = await self._async_rows(GET_JOB, (job_id,))
        return None if not rows else _job_snapshot(rows[0])

    async def get_job_timeline(
        self, job_id: str, *, limit: int = 100, cursor: JobTimelineCursor | None = None
    ) -> JobTimelinePage:
        await assert_async_compatible(self._executor)
        return _timeline_page(
            job_id,
            await self._async_rows(LIST_TIMELINE, _timeline_parameters(job_id, limit, cursor)),
        )

    async def list_dead_letters(self, query: DeadLetterQuery | None = None) -> DeadLetterPage:
        await assert_async_compatible(self._executor)
        value = query or DeadLetterQuery()
        return _dead_letter_page(
            await self._async_rows(LIST_DEAD_LETTERS, _dead_letter_parameters(value))
        )

    async def redrive(self, source_job_id: str, audit: AdminAudit) -> RedriveResult:
        await assert_async_compatible(self._executor)
        _validate_audit(audit)
        try:
            return _redrive_result(
                _one(
                    await self._async_rows(
                        REDRIVE, (source_job_id, audit.actor, audit.reason, audit.request_id)
                    ),
                    "workhorse.redrive_v1",
                )
            )
        except Exception as error:
            _raise_admin_error(error)

    async def redrive_many(
        self, filter: DeadLetterFilter, audit: AdminAudit, options: BulkRedriveOptions | None = None
    ) -> BulkRedrivePage:
        await assert_async_compatible(self._executor)
        _validate_audit(audit)
        value = options or BulkRedriveOptions()
        try:
            return _bulk_redrive_page(
                await self._async_rows(REDRIVE_MANY, _bulk_redrive_parameters(filter, audit, value))
            )
        except Exception as error:
            _raise_admin_error(error)

    async def get_checkpoint(self, job_id: str, name: str) -> JobCheckpoint | None:
        await assert_async_compatible(self._executor)
        rows = await self._async_rows(GET_CHECKPOINT, (job_id, name))
        return None if not rows else _checkpoint(rows[0])

    async def list_checkpoints(self, job_id: str) -> tuple[JobCheckpoint, ...]:
        await assert_async_compatible(self._executor)
        return tuple(
            _checkpoint(row) for row in await self._async_rows(LIST_CHECKPOINTS, (job_id,))
        )

    async def get_progress(self, job_id: str) -> JobProgress | None:
        await assert_async_compatible(self._executor)
        rows = await self._async_rows(GET_PROGRESS, (job_id,))
        return None if not rows else _progress(rows[0])

    async def get_wait(self, job_id: str, name: str) -> JobWait | None:
        await assert_async_compatible(self._executor)
        rows = await self._async_rows(GET_WAIT, (job_id, name))
        return None if not rows else _wait(rows[0])

    async def list_waits(self, job_id: str) -> tuple[JobWait, ...]:
        await assert_async_compatible(self._executor)
        return tuple(_wait(row) for row in await self._async_rows(LIST_WAITS, (job_id,)))

    async def list_signal_waits(
        self, *, limit: int = 100, cursor: ExternalWaitCursor | None = None
    ) -> ExternalWaitPage:
        await assert_async_compatible(self._executor)
        return _external_wait_page(
            await self._async_rows(LIST_SIGNAL_WAITS, _wait_page_parameters(limit, cursor)), limit
        )

    async def list_human_waits(
        self, *, limit: int = 100, cursor: ExternalWaitCursor | None = None
    ) -> HumanWaitPage:
        await assert_async_compatible(self._executor)
        return _human_wait_page(
            await self._async_rows(LIST_HUMAN_WAITS, _wait_page_parameters(limit, cursor)), limit
        )

    async def list_workers(self) -> tuple[WorkerRegistryEntry, ...]:
        await assert_async_compatible(self._executor)
        return tuple(_worker(row) for row in await self._async_rows(LIST_WORKERS))

    async def set_worker_paused(
        self, worker_id: str, paused: bool, audit: AdminAudit
    ) -> WorkerPauseResult | None:
        await assert_async_compatible(self._executor)
        _validate_audit(audit)
        rows = await self._async_rows(
            SET_WORKER_PAUSED, (worker_id, paused, audit.actor, audit.reason, audit.request_id)
        )
        return None if not rows else _worker_pause(rows[0])

    async def pause_queue(self, queue_name: str, audit: AdminAudit) -> None:
        await self._set_queue_paused(queue_name, True, audit)

    async def resume_queue(self, queue_name: str, audit: AdminAudit) -> None:
        await self._set_queue_paused(queue_name, False, audit)

    async def _set_queue_paused(self, queue_name: str, paused: bool, audit: AdminAudit) -> None:
        await assert_async_compatible(self._executor)
        _validate_audit(audit)
        await self._async_rows(
            SET_QUEUE_PAUSED, (queue_name, paused, audit.actor, audit.reason, audit.request_id)
        )

    async def purge_queue(self, queue_name: str, audit: AdminAudit) -> int:
        await assert_async_compatible(self._executor)
        _validate_audit(audit)
        try:
            row = _one(
                await self._async_rows(
                    PURGE_QUEUE, (queue_name, audit.actor, audit.reason, audit.request_id)
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


def _validate_job_query(query: JobListQuery) -> JobListQuery:
    _validate_limit(query.limit, MAX_PAGE_SIZE, "list_jobs limit")
    if query.created_after and query.created_before and query.created_after >= query.created_before:
        raise ValueError("created_after must be earlier than created_before")
    if len(set(query.states)) != len(query.states):
        raise ValueError("states must be unique")
    if any(state not in JOB_STATES for state in query.states):
        raise ValueError("states contains an invalid job state")
    if (
        isinstance(query.payload.max_bytes, bool)
        or not isinstance(query.payload.max_bytes, int)
        or not 1 <= query.payload.max_bytes <= MAX_PAYLOAD_BYTES
    ):
        raise ValueError("payload max_bytes is out of range")
    if len(query.payload.redact_keys) > MAX_REDACT_KEYS:
        raise ValueError(f"payload redact_keys must contain at most {MAX_REDACT_KEYS} keys")
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


def _dependency_policy(row: Row) -> DependencyPolicy | None:
    if row["dependency_on_failure"] is None:
        return None
    return DependencyPolicy(
        on_success=cast(Any, row["dependency_on_success"]),
        on_failure=cast(Any, row["dependency_on_failure"]),
        on_cancellation=cast(Any, row["dependency_on_cancellation"]),
    )


def _job_parameters(query: JobListQuery) -> tuple[object, ...]:
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
        query.cursor.job_id if query.cursor else None,
        query.cursor.signature if query.cursor else None,
        json.dumps(projection),
    )


def _job_item(row: Row) -> JobListItem:
    return JobListItem(
        id=str(row["job_id"]),
        queue=cast(str, row["queue_name"]),
        type=cast(str, row["job_type"]),
        concurrency_key=cast(str | None, row["concurrency_key"]),
        priority=int(cast(int, row["priority"])),
        tags=tuple(cast(list[str], row["tags"])),
        state=cast(JobState, row["state"]),
        prerequisite_job_id=None
        if row["prerequisite_job_id"] is None
        else str(row["prerequisite_job_id"]),
        prerequisite_job_ids=tuple(
            str(value) for value in cast(list[object], row["prerequisite_job_ids"])
        ),
        dependency_policy=_dependency_policy(row),
        blocked_reason=cast(Any, row["blocked_reason"]),
        parent_job_id=None if row["parent_job_id"] is None else str(row["parent_job_id"]),
        child_job_ids=tuple(str(value) for value in cast(list[object], row["child_job_ids"])),
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


def _job_page(rows: list[Row]) -> JobListPage:
    last = rows[-1] if rows else None
    cursor = (
        None
        if last is None or last["has_more"] is not True
        else JobListCursor(
            str(last["cursor_created_at"]), str(last["job_id"]), cast(str, last["cursor_signature"])
        )
    )
    return JobListPage(tuple(_job_item(row) for row in rows), cursor)


def _job_snapshot(row: Row) -> JobSnapshot:
    progress = (
        None
        if row["progress_revision"] is None
        else _progress(
            {
                "job_id": row["id"],
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
    return JobSnapshot(
        id=str(row["id"]),
        queue=cast(str, row["queue_name"]),
        type=cast(str, row["job_type"]),
        concurrency_key=cast(str | None, row["concurrency_key"]),
        priority=int(cast(int, row["priority"])),
        payload=_json(row["payload"]),
        contract_version=cast(str | None, row["contract_version"]),
        tags=tuple(cast(list[str], row["tags"])),
        state=cast(JobState, row["state"]),
        prerequisite_job_id=None
        if row["prerequisite_job_id"] is None
        else str(row["prerequisite_job_id"]),
        prerequisite_job_ids=tuple(
            str(value) for value in cast(list[object], row["prerequisite_job_ids"])
        ),
        dependency_policy=_dependency_policy(row),
        blocked_reason=cast(Any, row["blocked_reason"]),
        parent_job_id=None if row["parent_job_id"] is None else str(row["parent_job_id"]),
        child_job_ids=tuple(str(value) for value in cast(list[object], row["child_job_ids"])),
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
    job_id: str, limit: int, cursor: JobTimelineCursor | None
) -> tuple[object, ...]:
    _validate_limit(limit, MAX_PAGE_SIZE, "get_job_timeline limit")
    if cursor is not None and cursor.job_id != job_id:
        raise ValueError("cursor job_id must match the requested job_id")
    return (
        job_id,
        limit,
        cursor.occurred_at if cursor else None,
        cursor.kind if cursor else None,
        cursor.record_id if cursor else None,
    )


def _timeline_entry(row: Row) -> JobTimelineEntry:
    if row["kind"] == "event":
        return JobTimelineEvent(
            "event",
            str(row["record_id"]),
            int(cast(int, row["priority"])),
            cast(int | None, row["attempt"]),
            cast(datetime, row["occurred_at"]),
            cast(str, row["event_type"]),
            _json(row["details"]),
        )
    return JobTimelineAttempt(
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


def _timeline_page(job_id: str, rows: list[Row]) -> JobTimelinePage:
    last = rows[-1] if rows else None
    cursor = (
        None
        if last is None or last["has_more"] is not True
        else JobTimelineCursor(
            job_id, str(last["cursor_occurred_at"]), cast(Any, last["kind"]), str(last["record_id"])
        )
    )
    return JobTimelinePage(tuple(_timeline_entry(row) for row in rows), cursor)


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
    _validate_limit(query.limit, MAX_REDRIVE_BATCH_SIZE, "list_dead_letters limit")
    return (
        _filter_document(query),
        query.limit,
        query.cursor.finished_at if query.cursor else None,
        query.cursor.job_id if query.cursor else None,
    )


def _dead_letter(row: Row) -> DeadLetter:
    return DeadLetter(
        str(row["job_id"]),
        cast(str, row["queue_name"]),
        cast(str, row["job_type"]),
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


def _dead_letter_page(rows: list[Row]) -> DeadLetterPage:
    last = rows[-1] if rows else None
    cursor = (
        None
        if last is None or last["has_more"] is not True
        else DeadLetterCursor(str(last["cursor_finished_at"]), str(last["job_id"]))
    )
    return DeadLetterPage(tuple(_dead_letter(row) for row in rows), cursor)


def _redrive_result(row: Row) -> RedriveResult:
    return RedriveResult(
        cast(Any, row["status"]),
        str(row["source_job_id"]),
        None if row["target_job_id"] is None else str(row["target_job_id"]),
        cast(JobState | None, row["source_state"]),
        cast(JobState | None, row["target_state"]),
        cast(datetime | None, row["requested_at"]),
    )


def _bulk_redrive_parameters(
    filter: DeadLetterFilter, audit: AdminAudit, options: BulkRedriveOptions
) -> tuple[object, ...]:
    _validate_limit(options.limit, MAX_REDRIVE_BATCH_SIZE, "redrive_many limit")
    return (
        _filter_document(filter),
        options.limit,
        options.dry_run,
        audit.actor,
        audit.reason,
        audit.request_id,
        options.cursor.finished_at if options.cursor else None,
        options.cursor.job_id if options.cursor else None,
    )


def _bulk_redrive_page(rows: list[Row]) -> BulkRedrivePage:
    last = rows[-1] if rows else None
    cursor = (
        None
        if last is None or last["has_more"] is not True
        else DeadLetterCursor(str(last["source_finished_at_cursor"]), str(last["source_job_id"]))
    )
    return BulkRedrivePage(tuple(_redrive_result(row) for row in rows), cursor)


def _checkpoint(row: Row) -> JobCheckpoint:
    return JobCheckpoint(
        str(row["job_id"]),
        cast(str, row["checkpoint_name"]),
        _json(row["checkpoint_value"]),
        int(cast(int, row["attempt"])),
        int(cast(str | int, row["fence_token"])),
        cast(str, row["worker_id"]),
        cast(datetime, row["created_at"]),
    )


def _progress(row: Row) -> JobProgress:
    return JobProgress(
        str(row["job_id"]),
        _json(row["progress_value"]),
        int(cast(str | int, row["revision"])),
        int(cast(int, row["attempt"])),
        int(cast(str | int, row["fence_token"])),
        cast(str, row["worker_id"]),
        cast(datetime, row["created_at"]),
        cast(datetime, row["updated_at"]),
    )


def _wait(row: Row) -> JobWait:
    return JobWait(
        str(row["job_id"]),
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
    _validate_limit(limit, MAX_PAGE_SIZE, "external wait limit")
    return (
        limit + 1,
        cursor.created_at if cursor else None,
        cursor.job_id if cursor else None,
        cursor.name if cursor else None,
    )


def _external_wait(row: Row) -> ExternalWait:
    return ExternalWait(
        str(row["job_id"]),
        cast(str, row["queue_name"]),
        cast(str, row["job_type"]),
        cast(str, row["wait_name"]),
        int(cast(int, row["attempt"])),
        cast(datetime, row["created_at"]),
        cast(datetime, row["deadline_at"]),
    )


def _external_wait_page(rows: list[Row], limit: int) -> ExternalWaitPage:
    page = rows[:limit]
    last = page[-1] if page else None
    cursor = (
        None
        if len(rows) <= limit or last is None
        else ExternalWaitCursor(
            str(last["cursor_created_at"]), str(last["job_id"]), cast(str, last["wait_name"])
        )
    )
    return ExternalWaitPage(tuple(_external_wait(row) for row in page), cursor)


def _human_wait_page(rows: list[Row], limit: int) -> HumanWaitPage:
    page = rows[:limit]
    last = page[-1] if page else None
    cursor = (
        None
        if len(rows) <= limit or last is None
        else ExternalWaitCursor(
            str(last["cursor_created_at"]), str(last["job_id"]), cast(str, last["wait_name"])
        )
    )
    return HumanWaitPage(
        tuple(
            HumanWait(**_external_wait(row).__dict__, context=_json(row["context"])) for row in page
        ),
        cursor,
    )


def _worker_pause(row: Row) -> WorkerPauseResult:
    return WorkerPauseResult(
        cast(str, row["worker_id"]),
        bool(row["paused"]),
        cast(str | None, row["paused_by"]),
        cast(str | None, row["paused_reason"]),
        cast(datetime | None, row["paused_at"]),
        cast(datetime, row["last_heartbeat_at"]),
    )


def _worker(row: Row) -> WorkerRegistryEntry:
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


def _one(rows: list[Row], operation: str) -> Row:
    if len(rows) != 1:
        raise RuntimeError(f"{operation} returned {len(rows)} rows; expected one")
    return rows[0]


def _raise_admin_error(error: Exception) -> NoReturn:
    translated = translate_database_error(error)
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
