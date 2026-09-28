//! The operator client: task inspection, dead-letter repair and queue and worker controls.
//!
//! `Admin` mirrors Python's and Go's operator clients (ADR 0074). Reads return `None` or an
//! empty page when PostgreSQL finds nothing. Every control carries an [`AdminAudit`], and
//! `Admin` rejects an invalid audit or page limit before it calls PostgreSQL.
use std::collections::HashSet;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio::sync::OnceCell;
use tokio_postgres::{Client, NoTls, Row};
use uuid::Uuid;

use crate::compatibility::{check_compatibility, read_compatibility_state, CompatibilityCode};
use crate::queue::{exactly_one, parse_status, Executor};
use crate::sql_catalogue_generated as sql;
use crate::types::{string_enum, DependencyTerminalPolicy, RetryPolicy, TaskState};
use crate::{Error, Operation};

const MAX_PAGE_SIZE: u32 = 1_000;
const DEFAULT_PAGE_SIZE: u32 = 100;
const MAX_PAYLOAD_BYTES: u32 = 1_048_576;
const DEFAULT_PAYLOAD_BYTES: u32 = 16_384;
const MAX_REDACT_KEYS: usize = 50;

string_enum!(
    /// Whether a task list item carries its payload.
    PayloadStatus {
        Omitted => "omitted",
        Included => "included",
        TooLarge => "too_large",
    }
);

string_enum!(
    /// Why a task cannot run yet.
    BlockedReason {
        PrerequisitePending => "prerequisite_pending",
    }
);

string_enum!(
    /// The source table of one task timeline entry.
    TaskTimelineKind {
        Event => "event",
        Attempt => "attempt",
    }
);

string_enum!(
    /// How a durable timer was requested.
    WaitMode {
        Relative => "relative",
        Absolute => "absolute",
    }
);

string_enum!(
    /// PostgreSQL's disposition for one redrive request.
    RedriveStatus {
        Redriven => "redriven",
        Replayed => "replayed",
        Eligible => "eligible",
        NotFound => "not_found",
        NotFailed => "not_failed",
    }
);

string_enum!(
    /// Which storage a queue's tasks use (ADR 0077). A fast-tier task keeps one runtime row while
    /// it is live and one outcome row after it settles, and supports no durable execution.
    QueueTier {
        Fast => "fast",
        Full => "full",
    }
);

/// Whether a fast-tier queue records its attempts and claims for the dashboard.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct QueueHistory {
    pub record_attempts: bool,
    pub record_claims: bool,
}

/// Who performs a control, why, and the idempotency key PostgreSQL retains for it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AdminAudit {
    /// Between 1 and 200 characters.
    pub actor: String,
    /// Between 1 and 2000 characters.
    pub reason: String,
    /// Between 1 and 512 UTF-8 bytes.
    pub request_id: String,
}

/// The terminal outcomes a dependent task accepts from its prerequisites.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DependencyPolicy {
    pub on_success: DependencyTerminalPolicy,
    pub on_failure: DependencyTerminalPolicy,
    pub on_cancellation: DependencyTerminalPolicy,
}

/// Whether and how a task list carries each payload.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskPayloadProjection {
    pub include: bool,
    /// Between 1 and 1 MiB; a larger payload is reported as too large.
    pub max_bytes: u32,
    /// Up to 50 unique top-level keys of 1 to 200 characters to redact.
    pub redact_keys: Vec<String>,
}

impl Default for TaskPayloadProjection {
    fn default() -> Self {
        Self { include: false, max_bytes: DEFAULT_PAYLOAD_BYTES, redact_keys: Vec::new() }
    }
}

/// The position after the last task of a page.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskListCursor {
    pub created_at: DateTime<Utc>,
    pub task_id: Uuid,
    /// PostgreSQL's digest of the query the cursor belongs to.
    pub signature: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskListQuery {
    pub queue: Option<String>,
    pub task_type: Option<String>,
    /// Unique states; empty lists every state.
    pub states: Vec<TaskState>,
    pub created_after: Option<DateTime<Utc>>,
    pub created_before: Option<DateTime<Utc>>,
    /// Between 1 and 1000.
    pub limit: u32,
    pub cursor: Option<TaskListCursor>,
    pub payload: TaskPayloadProjection,
}

impl Default for TaskListQuery {
    fn default() -> Self {
        Self {
            queue: None,
            task_type: None,
            states: Vec::new(),
            created_after: None,
            created_before: None,
            limit: DEFAULT_PAGE_SIZE,
            cursor: None,
            payload: TaskPayloadProjection::default(),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct TaskListItem {
    pub id: Uuid,
    pub queue: String,
    pub task_type: String,
    pub concurrency_key: Option<String>,
    pub priority: i32,
    pub tags: Vec<String>,
    pub state: TaskState,
    pub prerequisite_task_id: Option<Uuid>,
    pub prerequisite_task_ids: Vec<Uuid>,
    pub dependency_policy: Option<DependencyPolicy>,
    pub blocked_reason: Option<BlockedReason>,
    pub parent_task_id: Option<Uuid>,
    pub child_task_ids: Vec<Uuid>,
    pub current_attempt: i32,
    pub max_attempts: i32,
    pub retry_policy: Option<RetryPolicy>,
    pub deadline_at: Option<DateTime<Utc>>,
    pub execution_timeout_ms: Option<i64>,
    pub run_at: DateTime<Utc>,
    pub cancel_requested_at: Option<DateTime<Utc>>,
    pub cancel_requested_by: Option<String>,
    pub cancel_reason: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Set only when the projection includes it and it fits `max_bytes`.
    pub payload: Option<Value>,
    pub payload_status: PayloadStatus,
    pub payload_bytes: Option<i32>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TaskListPage {
    pub items: Vec<TaskListItem>,
    pub next_cursor: Option<TaskListCursor>,
}

/// The latest progress a task reported.
#[derive(Clone, Debug, PartialEq)]
pub struct TaskProgress {
    pub task_id: Uuid,
    pub value: Value,
    pub revision: i64,
    pub attempt: i32,
    pub fence_token: i64,
    pub worker_id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// One task with its definition, lifecycle state, outcome and latest progress.
#[derive(Clone, Debug, PartialEq)]
pub struct TaskSnapshot {
    pub id: Uuid,
    pub queue: String,
    pub task_type: String,
    pub concurrency_key: Option<String>,
    pub priority: i32,
    /// Redacted by the task's retained payload redaction keys.
    pub payload: Value,
    pub contract_version: Option<String>,
    pub tags: Vec<String>,
    pub state: TaskState,
    pub prerequisite_task_id: Option<Uuid>,
    pub prerequisite_task_ids: Vec<Uuid>,
    pub dependency_policy: Option<DependencyPolicy>,
    pub blocked_reason: Option<BlockedReason>,
    pub parent_task_id: Option<Uuid>,
    pub child_task_ids: Vec<Uuid>,
    pub current_attempt: i32,
    pub max_attempts: i32,
    pub retry_policy: Option<RetryPolicy>,
    pub deadline_at: Option<DateTime<Utc>>,
    pub execution_timeout_ms: Option<i64>,
    pub fence_token: i64,
    pub run_at: DateTime<Utc>,
    pub result: Option<Value>,
    pub error: Option<Value>,
    pub cancel_requested_at: Option<DateTime<Utc>>,
    pub cancel_requested_by: Option<String>,
    pub cancel_reason: Option<String>,
    pub progress: Option<TaskProgress>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// The position after the last timeline entry of a page.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TaskTimelineCursor {
    pub task_id: Uuid,
    pub occurred_at: DateTime<Utc>,
    pub kind: TaskTimelineKind,
    pub record_id: Uuid,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TaskTimelineQuery {
    /// Between 1 and 1000.
    pub limit: u32,
    /// Must belong to the requested task.
    pub cursor: Option<TaskTimelineCursor>,
}

impl Default for TaskTimelineQuery {
    fn default() -> Self {
        Self { limit: DEFAULT_PAGE_SIZE, cursor: None }
    }
}

/// A recorded lifecycle event.
#[derive(Clone, Debug, PartialEq)]
pub struct TaskTimelineEvent {
    pub record_id: Uuid,
    pub priority: i32,
    pub attempt: Option<i32>,
    pub occurred_at: DateTime<Utc>,
    pub event_type: String,
    pub details: Value,
}

/// A finished execution attempt.
#[derive(Clone, Debug, PartialEq)]
pub struct TaskTimelineAttempt {
    pub record_id: Uuid,
    pub priority: i32,
    pub attempt: i32,
    pub occurred_at: DateTime<Utc>,
    pub fence_token: i64,
    pub worker_id: String,
    pub outcome: String,
    pub started_at: DateTime<Utc>,
    pub claimed_at: DateTime<Utc>,
    pub finished_at: DateTime<Utc>,
    pub error: Option<Value>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum TaskTimelineEntry {
    Event(TaskTimelineEvent),
    Attempt(TaskTimelineAttempt),
}

#[derive(Clone, Debug, PartialEq)]
pub struct TaskTimelinePage {
    pub items: Vec<TaskTimelineEntry>,
    pub next_cursor: Option<TaskTimelineCursor>,
}

/// Which failed tasks a dead-letter read or bulk redrive selects.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DeadLetterFilter {
    pub queue: Option<String>,
    pub task_type: Option<String>,
    /// A task matches when it carries every tag.
    pub tags: Vec<String>,
    pub error_name: Option<String>,
    pub finished_after: Option<DateTime<Utc>>,
    pub finished_before: Option<DateTime<Utc>>,
}

/// The position after the last dead letter of a page.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DeadLetterCursor {
    pub finished_at: DateTime<Utc>,
    pub task_id: Uuid,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeadLetterQuery {
    pub filter: DeadLetterFilter,
    /// Between 1 and 1000.
    pub limit: u32,
    pub cursor: Option<DeadLetterCursor>,
}

impl Default for DeadLetterQuery {
    fn default() -> Self {
        Self { filter: DeadLetterFilter::default(), limit: DEFAULT_PAGE_SIZE, cursor: None }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct DeadLetter {
    pub task_id: Uuid,
    pub queue: String,
    pub task_type: String,
    pub concurrency_key: Option<String>,
    pub priority: i32,
    pub payload: Value,
    pub tags: Vec<String>,
    pub current_attempt: i32,
    pub max_attempts: i32,
    pub retry_policy: Option<RetryPolicy>,
    pub deadline_at: Option<DateTime<Utc>>,
    pub execution_timeout_ms: Option<i64>,
    pub error: Value,
    pub finished_at: DateTime<Utc>,
    pub redrive_count: i32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DeadLetterPage {
    pub items: Vec<DeadLetter>,
    pub next_cursor: Option<DeadLetterCursor>,
}

/// PostgreSQL's disposition for one failed source task.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RedriveResult {
    pub status: RedriveStatus,
    pub source_task_id: Uuid,
    pub target_task_id: Option<Uuid>,
    pub source_state: Option<TaskState>,
    pub target_state: Option<TaskState>,
    pub requested_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BulkRedriveOptions {
    /// Between 1 and 1000.
    pub limit: u32,
    /// Reports eligible tasks without redriving them.
    pub dry_run: bool,
    pub cursor: Option<DeadLetterCursor>,
}

impl Default for BulkRedriveOptions {
    fn default() -> Self {
        Self { limit: DEFAULT_PAGE_SIZE, dry_run: false, cursor: None }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BulkRedrivePage {
    pub results: Vec<RedriveResult>,
    pub next_cursor: Option<DeadLetterCursor>,
}

/// A durable value a task saved under a name.
#[derive(Clone, Debug, PartialEq)]
pub struct TaskCheckpoint {
    pub task_id: Uuid,
    pub name: String,
    pub value: Value,
    pub attempt: i32,
    pub fence_token: i64,
    pub worker_id: String,
    pub created_at: DateTime<Utc>,
}

/// A durable timer a task scheduled under a name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskWait {
    pub task_id: Uuid,
    pub name: String,
    pub mode: WaitMode,
    /// Set for a relative wait.
    pub duration_ms: Option<i64>,
    /// Set for an absolute wait.
    pub requested_wake_at: Option<DateTime<Utc>>,
    pub wake_at: DateTime<Utc>,
    pub attempt: i32,
    pub fence_token: i64,
    pub worker_id: String,
    pub created_at: DateTime<Utc>,
}

/// The position after the last external wait of a page.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExternalWaitCursor {
    pub created_at: DateTime<Utc>,
    pub task_id: Uuid,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExternalWaitQuery {
    /// Between 1 and 1000.
    pub limit: u32,
    pub cursor: Option<ExternalWaitCursor>,
}

impl Default for ExternalWaitQuery {
    fn default() -> Self {
        Self { limit: DEFAULT_PAGE_SIZE, cursor: None }
    }
}

/// A task suspended until a named signal arrives.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExternalWait {
    pub task_id: Uuid,
    pub queue: String,
    pub task_type: String,
    pub name: String,
    pub attempt: i32,
    pub created_at: DateTime<Utc>,
    pub deadline_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExternalWaitPage {
    pub items: Vec<ExternalWait>,
    pub next_cursor: Option<ExternalWaitCursor>,
}

/// A task suspended until a person completes a named decision.
#[derive(Clone, Debug, PartialEq)]
pub struct HumanWait {
    pub task_id: Uuid,
    pub queue: String,
    pub task_type: String,
    pub name: String,
    pub attempt: i32,
    pub created_at: DateTime<Utc>,
    pub deadline_at: Option<DateTime<Utc>>,
    /// What the task showed the person deciding.
    pub context: Value,
}

#[derive(Clone, Debug, PartialEq)]
pub struct HumanWaitPage {
    pub items: Vec<HumanWait>,
    pub next_cursor: Option<ExternalWaitCursor>,
}

/// A worker's durable operator pause state after a control.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkerPauseResult {
    pub worker_id: String,
    pub paused: bool,
    pub paused_by: Option<String>,
    pub reason: Option<String>,
    pub paused_at: Option<DateTime<Utc>>,
    pub last_heartbeat_at: DateTime<Utc>,
}

/// One registered worker instance.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkerRegistryEntry {
    pub worker_id: String,
    pub instance_id: Uuid,
    pub hostname: String,
    pub pid: i32,
    pub queues: Vec<String>,
    pub queue: String,
    pub concurrency: i32,
    pub active_slots: i32,
    pub draining: bool,
    pub paused: bool,
    pub paused_by: Option<String>,
    pub reason: Option<String>,
    pub paused_at: Option<DateTime<Utc>>,
    pub started_at: DateTime<Utc>,
    pub last_heartbeat_at: DateTime<Utc>,
}

/// The operator client. It checks schema compatibility before its first protocol call.
pub struct Admin<E: Executor> {
    executor: E,
    compatibility: OnceCell<Result<(), CompatibilityCode>>,
}

impl Admin<Client> {
    /// Connects without TLS and drives the connection on the current Tokio runtime.
    pub async fn connect(url: &str) -> Result<Self, Error> {
        let (client, connection) = tokio_postgres::connect(url, NoTls).await?;
        tokio::spawn(connection);
        Ok(Self::new(client))
    }
}

impl<E: Executor> Admin<E> {
    pub fn new(executor: E) -> Self {
        Self { executor, compatibility: OnceCell::new() }
    }

    pub fn executor(&self) -> &E {
        &self.executor
    }

    /// Returns the executor, for example to commit a transaction.
    pub fn into_inner(self) -> E {
        self.executor
    }

    /// Runs the startup compatibility check once; a refusal is cached, a driver error is not.
    pub async fn assert_compatible(&self) -> Result<(), Error> {
        let outcome = self
            .compatibility
            .get_or_try_init(|| async {
                let state = read_compatibility_state(&self.executor).await?;
                Ok::<_, Error>(check_compatibility(
                    state.installed_schema_version,
                    sql::CLIENT_PROTOCOL_VERSION,
                    &state.served_protocol_versions,
                ))
            })
            .await?;
        outcome.map_err(|code| Error::Compatibility { code })
    }

    async fn query(
        &self,
        statement: &str,
        params: &[&(dyn tokio_postgres::types::ToSql + Sync)],
    ) -> Result<Vec<Row>, Error> {
        self.assert_compatible().await?;
        self.executor.rows(statement, params).await.map_err(Error::translate_admin)
    }

    pub async fn list_tasks(&self, query: TaskListQuery) -> Result<TaskListPage, Error> {
        let limit = page_limit(query.limit, "list_tasks limit")?;
        validate_task_query(&query)?;
        let mut filter = Map::new();
        insert_some(&mut filter, "queue", query.queue.as_deref().map(Value::from));
        insert_some(&mut filter, "type", query.task_type.as_deref().map(Value::from));
        if !query.states.is_empty() {
            let states = query.states.iter().map(|state| Value::from(state.as_str())).collect();
            filter.insert("states".into(), Value::Array(states));
        }
        insert_some(&mut filter, "createdAfter", query.created_after.map(timestamp));
        insert_some(&mut filter, "createdBefore", query.created_before.map(timestamp));
        let projection = json!({
            "include": query.payload.include,
            "maxBytes": query.payload.max_bytes,
            "redactKeys": query.payload.redact_keys,
        });
        let cursor = query.cursor.as_ref();
        let rows = self
            .query(
                sql::LIST_TASKS,
                &[
                    &Value::Object(filter),
                    &limit,
                    &cursor.map(|cursor| cursor.created_at),
                    &cursor.map(|cursor| cursor.task_id),
                    &cursor.map(|cursor| cursor.signature.as_str()),
                    &projection,
                ],
            )
            .await?;
        let next_cursor = match rows.last() {
            Some(last) if last.try_get::<_, bool>("has_more")? => Some(TaskListCursor {
                created_at: last.try_get("created_at")?,
                task_id: uuid_text(last, "task_id")?,
                signature: last.try_get("cursor_signature")?,
            }),
            _ => None,
        };
        let items = rows.iter().map(task_item).collect::<Result<_, _>>()?;
        Ok(TaskListPage { items, next_cursor })
    }

    pub async fn get_task(&self, task_id: Uuid) -> Result<Option<TaskSnapshot>, Error> {
        let rows = self.query(sql::GET_TASK, &[&task_id]).await?;
        rows.first().map(task_snapshot).transpose()
    }

    pub async fn get_task_timeline(
        &self,
        task_id: Uuid,
        query: TaskTimelineQuery,
    ) -> Result<TaskTimelinePage, Error> {
        let limit = page_limit(query.limit, "get_task_timeline limit")?;
        if query.cursor.is_some_and(|cursor| cursor.task_id != task_id) {
            return Err(Error::invalid("cursor task_id must match the requested task_id"));
        }
        let cursor = query.cursor;
        let rows = self
            .query(
                sql::LIST_TASK_TIMELINE,
                &[
                    &task_id,
                    &limit,
                    &cursor.map(|cursor| cursor.occurred_at),
                    &cursor.map(|cursor| cursor.kind.as_str()),
                    &cursor.map(|cursor| cursor.record_id),
                ],
            )
            .await?;
        let next_cursor = match rows.last() {
            Some(last) if last.try_get::<_, bool>("has_more")? => Some(TaskTimelineCursor {
                task_id,
                occurred_at: last.try_get("occurred_at")?,
                kind: wire(TaskTimelineKind::parse, last, "kind")?,
                record_id: uuid_text(last, "record_id")?,
            }),
            _ => None,
        };
        let items = rows.iter().map(timeline_entry).collect::<Result<_, _>>()?;
        Ok(TaskTimelinePage { items, next_cursor })
    }

    pub async fn list_dead_letters(&self, query: DeadLetterQuery) -> Result<DeadLetterPage, Error> {
        let limit = page_limit(query.limit, "list_dead_letters limit")?;
        let cursor = query.cursor;
        let rows = self
            .query(
                sql::LIST_DEAD_LETTERS,
                &[
                    &filter_document(&query.filter),
                    &limit,
                    &cursor.map(|cursor| cursor.finished_at),
                    &cursor.map(|cursor| cursor.task_id),
                ],
            )
            .await?;
        let next_cursor = match rows.last() {
            Some(last) if last.try_get::<_, bool>("has_more")? => Some(DeadLetterCursor {
                finished_at: last.try_get("finished_at")?,
                task_id: uuid_text(last, "task_id")?,
            }),
            _ => None,
        };
        let items = rows.iter().map(dead_letter).collect::<Result<_, _>>()?;
        Ok(DeadLetterPage { items, next_cursor })
    }

    pub async fn redrive(
        &self,
        source_task_id: Uuid,
        audit: &AdminAudit,
    ) -> Result<RedriveResult, Error> {
        validate_audit(audit)?;
        let rows = self
            .query(sql::REDRIVE, &[&source_task_id, &audit.actor, &audit.reason, &audit.request_id])
            .await?;
        redrive_result(exactly_one(&rows, "redrive_v1")?)
    }

    pub async fn redrive_many(
        &self,
        filter: DeadLetterFilter,
        audit: &AdminAudit,
        options: BulkRedriveOptions,
    ) -> Result<BulkRedrivePage, Error> {
        validate_audit(audit)?;
        let limit = page_limit(options.limit, "redrive_many limit")?;
        let cursor = options.cursor;
        let rows = self
            .query(
                sql::REDRIVE_MANY,
                &[
                    &filter_document(&filter),
                    &limit,
                    &options.dry_run,
                    &audit.actor,
                    &audit.reason,
                    &audit.request_id,
                    &cursor.map(|cursor| cursor.finished_at),
                    &cursor.map(|cursor| cursor.task_id),
                ],
            )
            .await?;
        let next_cursor = match rows.last() {
            Some(last) if last.try_get::<_, bool>("has_more")? => {
                let finished_at: String = last.try_get("source_finished_at_cursor")?;
                Some(DeadLetterCursor {
                    finished_at: DateTime::parse_from_rfc3339(&finished_at)
                        .map_err(|_| invalid_column("source_finished_at_cursor"))?
                        .with_timezone(&Utc),
                    task_id: uuid_text(last, "source_task_id")?,
                })
            }
            _ => None,
        };
        let results = rows.iter().map(redrive_result).collect::<Result<_, _>>()?;
        Ok(BulkRedrivePage { results, next_cursor })
    }

    pub async fn get_checkpoint(
        &self,
        task_id: Uuid,
        name: &str,
    ) -> Result<Option<TaskCheckpoint>, Error> {
        let rows = self.query(sql::GET_CHECKPOINT, &[&task_id, &name]).await?;
        rows.first().map(checkpoint).transpose()
    }

    pub async fn list_checkpoints(&self, task_id: Uuid) -> Result<Vec<TaskCheckpoint>, Error> {
        let rows = self.query(sql::LIST_CHECKPOINTS, &[&task_id]).await?;
        rows.iter().map(checkpoint).collect()
    }

    pub async fn get_progress(&self, task_id: Uuid) -> Result<Option<TaskProgress>, Error> {
        let rows = self.query(sql::GET_PROGRESS, &[&task_id]).await?;
        rows.first().map(progress).transpose()
    }

    pub async fn get_wait(&self, task_id: Uuid, name: &str) -> Result<Option<TaskWait>, Error> {
        let rows = self.query(sql::GET_WAIT, &[&task_id, &name]).await?;
        rows.first().map(wait).transpose()
    }

    pub async fn list_waits(&self, task_id: Uuid) -> Result<Vec<TaskWait>, Error> {
        let rows = self.query(sql::LIST_WAITS, &[&task_id]).await?;
        rows.iter().map(wait).collect()
    }

    pub async fn list_signal_waits(
        &self,
        query: ExternalWaitQuery,
    ) -> Result<ExternalWaitPage, Error> {
        let (rows, next_cursor) = self.external_waits(sql::LIST_SIGNAL_WAITS, query).await?;
        let items = rows.iter().map(external_wait).collect::<Result<_, _>>()?;
        Ok(ExternalWaitPage { items, next_cursor })
    }

    pub async fn list_human_waits(&self, query: ExternalWaitQuery) -> Result<HumanWaitPage, Error> {
        let (rows, next_cursor) = self.external_waits(sql::LIST_HUMAN_WAITS, query).await?;
        let items = rows
            .iter()
            .map(|row| {
                let wait = external_wait(row)?;
                Ok::<_, Error>(HumanWait {
                    task_id: wait.task_id,
                    queue: wait.queue,
                    task_type: wait.task_type,
                    name: wait.name,
                    attempt: wait.attempt,
                    created_at: wait.created_at,
                    deadline_at: wait.deadline_at,
                    context: row.try_get("context")?,
                })
            })
            .collect::<Result<_, _>>()?;
        Ok(HumanWaitPage { items, next_cursor })
    }

    /// Reads one row past the page to learn whether another page follows.
    async fn external_waits(
        &self,
        statement: &str,
        query: ExternalWaitQuery,
    ) -> Result<(Vec<Row>, Option<ExternalWaitCursor>), Error> {
        let limit = page_limit(query.limit, "external wait limit")?;
        let cursor = query.cursor.as_ref();
        let mut rows = self
            .query(
                statement,
                &[
                    &(limit + 1),
                    &cursor.map(|cursor| cursor.created_at),
                    &cursor.map(|cursor| cursor.task_id),
                    &cursor.map(|cursor| cursor.name.as_str()),
                ],
            )
            .await?;
        let more = rows.len() > query.limit as usize;
        rows.truncate(query.limit as usize);
        let next_cursor = match rows.last() {
            Some(last) if more => Some(ExternalWaitCursor {
                created_at: last.try_get("created_at")?,
                task_id: uuid_text(last, "task_id")?,
                name: last.try_get("wait_name")?,
            }),
            _ => None,
        };
        Ok((rows, next_cursor))
    }

    pub async fn list_workers(&self) -> Result<Vec<WorkerRegistryEntry>, Error> {
        let rows = self.query(sql::LIST_WORKERS, &[]).await?;
        rows.iter()
            .map(|row| {
                let pause = worker_pause(row)?;
                Ok(WorkerRegistryEntry {
                    worker_id: pause.worker_id,
                    instance_id: row.try_get("instance_id")?,
                    hostname: row.try_get("hostname")?,
                    pid: row.try_get("pid")?,
                    queues: row.try_get("queue_names")?,
                    queue: row.try_get("queue_name")?,
                    concurrency: row.try_get("concurrency")?,
                    active_slots: row.try_get("active_slots")?,
                    draining: row.try_get("draining")?,
                    paused: pause.paused,
                    paused_by: pause.paused_by,
                    reason: pause.reason,
                    paused_at: pause.paused_at,
                    started_at: row.try_get("started_at")?,
                    last_heartbeat_at: pause.last_heartbeat_at,
                })
            })
            .collect()
    }

    /// Pauses or resumes one worker durably; `None` when no such worker is registered.
    pub async fn set_worker_paused(
        &self,
        worker_id: &str,
        paused: bool,
        audit: &AdminAudit,
    ) -> Result<Option<WorkerPauseResult>, Error> {
        validate_audit(audit)?;
        let rows = self
            .query(
                sql::SET_WORKER_PAUSED,
                &[&worker_id, &paused, &audit.actor, &audit.reason, &audit.request_id],
            )
            .await?;
        rows.first().map(worker_pause).transpose()
    }

    /// Stops workers from claiming the queue's tasks until it is resumed.
    pub async fn pause_queue(&self, queue: &str, audit: &AdminAudit) -> Result<(), Error> {
        self.set_queue_paused(queue, true, audit).await
    }

    pub async fn resume_queue(&self, queue: &str, audit: &AdminAudit) -> Result<(), Error> {
        self.set_queue_paused(queue, false, audit).await
    }

    async fn set_queue_paused(
        &self,
        queue: &str,
        paused: bool,
        audit: &AdminAudit,
    ) -> Result<(), Error> {
        validate_audit(audit)?;
        self.query(
            sql::SET_QUEUE_PAUSED,
            &[&queue, &paused, &audit.actor, &audit.reason, &audit.request_id],
        )
        .await?;
        Ok(())
    }

    /// Deletes the queue's tasks that no worker holds and returns how many PostgreSQL deleted.
    pub async fn purge_queue(&self, queue: &str, audit: &AdminAudit) -> Result<u64, Error> {
        validate_audit(audit)?;
        let rows = self
            .query(sql::PURGE_QUEUE, &[&queue, &audit.actor, &audit.reason, &audit.request_id])
            .await?;
        let deleted: i32 = exactly_one(&rows, "purge_queue_v1")?.try_get("deleted_count")?;
        u64::try_from(deleted).map_err(|_| invalid_column("deleted_count"))
    }

    /// Moves a queue between tiers. PostgreSQL refuses with [`Error::FastTierUnsupported`] while
    /// the queue holds a live task, because a live task cannot move between the two storages.
    pub async fn set_queue_tier(
        &self,
        queue: &str,
        tier: QueueTier,
        audit: &AdminAudit,
    ) -> Result<QueueTier, Error> {
        validate_audit(audit)?;
        let rows = self
            .query(sql::SET_QUEUE_TIER, &[&queue, &tier.as_str(), &audit.actor, &audit.reason])
            .await?;
        let tier: String = exactly_one(&rows, "set_queue_tier_v1")?.try_get("tier")?;
        QueueTier::parse(&tier).ok_or_else(|| invalid_column("tier"))
    }

    /// Changes which history a fast-tier queue records; `None` keeps a setting as it is.
    pub async fn set_queue_history(
        &self,
        queue: &str,
        record_attempts: Option<bool>,
        record_claims: Option<bool>,
    ) -> Result<QueueHistory, Error> {
        let rows =
            self.query(sql::SET_QUEUE_HISTORY, &[&queue, &record_attempts, &record_claims]).await?;
        let row = exactly_one(&rows, "set_queue_history_v1")?;
        Ok(QueueHistory {
            record_attempts: row.try_get("record_attempts")?,
            record_claims: row.try_get("record_claims")?,
        })
    }
}

fn validate_audit(audit: &AdminAudit) -> Result<(), Error> {
    if !(1..=200).contains(&audit.actor.chars().count()) {
        return Err(Error::invalid("actor must contain between 1 and 200 characters"));
    }
    if !(1..=2_000).contains(&audit.reason.chars().count()) {
        return Err(Error::invalid("reason must contain between 1 and 2000 characters"));
    }
    if !(1..=512).contains(&audit.request_id.len()) {
        return Err(Error::invalid("request_id must contain between 1 and 512 UTF-8 bytes"));
    }
    Ok(())
}

fn page_limit(limit: u32, label: &str) -> Result<i32, Error> {
    if !(1..=MAX_PAGE_SIZE).contains(&limit) {
        return Err(Error::invalid(format!(
            "{label} must be an integer between 1 and {MAX_PAGE_SIZE}"
        )));
    }
    Ok(limit as i32)
}

fn validate_task_query(query: &TaskListQuery) -> Result<(), Error> {
    if let (Some(after), Some(before)) = (query.created_after, query.created_before) {
        if after >= before {
            return Err(Error::invalid("created_after must be earlier than created_before"));
        }
    }
    if query.states.iter().collect::<HashSet<_>>().len() != query.states.len() {
        return Err(Error::invalid("states must be unique"));
    }
    let payload = &query.payload;
    if !(1..=MAX_PAYLOAD_BYTES).contains(&payload.max_bytes) {
        return Err(Error::invalid("payload max_bytes is out of range"));
    }
    if payload.redact_keys.len() > MAX_REDACT_KEYS {
        return Err(Error::invalid(format!(
            "payload redact_keys must contain at most {MAX_REDACT_KEYS} keys"
        )));
    }
    if payload.redact_keys.iter().collect::<HashSet<_>>().len() != payload.redact_keys.len() {
        return Err(Error::invalid("payload redact_keys must be unique"));
    }
    if payload.redact_keys.iter().any(|key| !(1..=200).contains(&key.chars().count())) {
        return Err(Error::invalid(
            "payload redact_keys must contain strings of 1 to 200 characters",
        ));
    }
    Ok(())
}

fn filter_document(filter: &DeadLetterFilter) -> Value {
    let mut document = Map::new();
    insert_some(&mut document, "queue", filter.queue.as_deref().map(Value::from));
    insert_some(&mut document, "type", filter.task_type.as_deref().map(Value::from));
    if !filter.tags.is_empty() {
        document.insert("tags".into(), filter.tags.clone().into());
    }
    let error_name = filter.error_name.as_deref().filter(|name| !name.is_empty());
    insert_some(&mut document, "errorName", error_name.map(Value::from));
    insert_some(&mut document, "finishedAfter", filter.finished_after.map(timestamp));
    insert_some(&mut document, "finishedBefore", filter.finished_before.map(timestamp));
    Value::Object(document)
}

fn insert_some(document: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        document.insert(key.into(), value);
    }
}

fn timestamp(value: DateTime<Utc>) -> Value {
    Value::String(value.format("%Y-%m-%dT%H:%M:%S%.6fZ").to_string())
}

fn invalid_column(column: &str) -> Error {
    Error::invalid(format!("PostgreSQL returned an invalid {column}"))
}

fn uuid_text(row: &Row, column: &str) -> Result<Uuid, Error> {
    let value: String = row.try_get(column)?;
    Uuid::parse_str(&value).map_err(|_| invalid_column(column))
}

fn optional_uuid_text(row: &Row, column: &str) -> Result<Option<Uuid>, Error> {
    let value: Option<String> = row.try_get(column)?;
    value.map(|value| Uuid::parse_str(&value).map_err(|_| invalid_column(column))).transpose()
}

/// A bigint PostgreSQL sends as text so no client loses precision.
fn optional_integer_text(row: &Row, column: &str) -> Result<Option<i64>, Error> {
    let value: Option<String> = row.try_get(column)?;
    value.map(|value| value.parse().map_err(|_| invalid_column(column))).transpose()
}

fn integer_text(row: &Row, column: &str) -> Result<i64, Error> {
    optional_integer_text(row, column)?.ok_or_else(|| invalid_column(column))
}

fn wire<T>(parse: fn(&str) -> Option<T>, row: &Row, column: &str) -> Result<T, Error> {
    let value: &str = row.try_get(column)?;
    parse(value).ok_or_else(|| invalid_column(column))
}

fn optional_wire<T>(
    parse: fn(&str) -> Option<T>,
    row: &Row,
    column: &str,
) -> Result<Option<T>, Error> {
    let value: Option<&str> = row.try_get(column)?;
    value.map(|value| parse(value).ok_or_else(|| invalid_column(column))).transpose()
}

fn retry_policy(row: &Row) -> Result<Option<RetryPolicy>, Error> {
    match row.try_get::<_, Option<Value>>("retry_policy")? {
        Some(Value::Object(policy)) => Ok(Some(policy)),
        None => Ok(None),
        Some(_) => Err(invalid_column("retry_policy")),
    }
}

/// The dependency columns `list_tasks` and `get_task` share.
struct Lineage {
    prerequisite_task_id: Option<Uuid>,
    prerequisite_task_ids: Vec<Uuid>,
    dependency_policy: Option<DependencyPolicy>,
    blocked_reason: Option<BlockedReason>,
    parent_task_id: Option<Uuid>,
    child_task_ids: Vec<Uuid>,
}

fn lineage(row: &Row) -> Result<Lineage, Error> {
    let on_failure = optional_wire(DependencyTerminalPolicy::parse, row, "dependency_on_failure")?;
    let dependency_policy = match on_failure {
        None => None,
        Some(on_failure) => Some(DependencyPolicy {
            on_success: wire(DependencyTerminalPolicy::parse, row, "dependency_on_success")?,
            on_failure,
            on_cancellation: wire(
                DependencyTerminalPolicy::parse,
                row,
                "dependency_on_cancellation",
            )?,
        }),
    };
    Ok(Lineage {
        prerequisite_task_id: row.try_get("prerequisite_task_id")?,
        prerequisite_task_ids: row.try_get("prerequisite_task_ids")?,
        dependency_policy,
        blocked_reason: optional_wire(BlockedReason::parse, row, "blocked_reason")?,
        parent_task_id: row.try_get("parent_task_id")?,
        child_task_ids: row.try_get("child_task_ids")?,
    })
}

fn task_item(row: &Row) -> Result<TaskListItem, Error> {
    let lineage = lineage(row)?;
    Ok(TaskListItem {
        id: uuid_text(row, "task_id")?,
        queue: row.try_get("queue_name")?,
        task_type: row.try_get("task_type")?,
        concurrency_key: row.try_get("concurrency_key")?,
        priority: row.try_get("priority")?,
        tags: row.try_get("tags")?,
        state: wire(TaskState::parse, row, "state")?,
        prerequisite_task_id: lineage.prerequisite_task_id,
        prerequisite_task_ids: lineage.prerequisite_task_ids,
        dependency_policy: lineage.dependency_policy,
        blocked_reason: lineage.blocked_reason,
        parent_task_id: lineage.parent_task_id,
        child_task_ids: lineage.child_task_ids,
        current_attempt: row.try_get("current_attempt")?,
        max_attempts: row.try_get("max_attempts")?,
        retry_policy: retry_policy(row)?,
        deadline_at: row.try_get("deadline_at")?,
        execution_timeout_ms: optional_integer_text(row, "execution_timeout_ms")?,
        run_at: row.try_get("run_at")?,
        cancel_requested_at: row.try_get("cancel_requested_at")?,
        cancel_requested_by: row.try_get("cancel_requested_by")?,
        cancel_reason: row.try_get("cancel_reason")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
        payload: row.try_get("payload")?,
        payload_status: wire(PayloadStatus::parse, row, "payload_status")?,
        payload_bytes: row.try_get("payload_bytes")?,
    })
}

fn task_snapshot(row: &Row) -> Result<TaskSnapshot, Error> {
    let id = uuid_text(row, "id")?;
    let progress = match optional_integer_text(row, "progress_revision")? {
        None => None,
        Some(revision) => Some(TaskProgress {
            task_id: id,
            value: row.try_get("progress_value")?,
            revision,
            attempt: row.try_get("progress_attempt")?,
            fence_token: integer_text(row, "progress_fence_token")?,
            worker_id: row.try_get("progress_worker_id")?,
            created_at: row.try_get("progress_created_at")?,
            updated_at: row.try_get("progress_updated_at")?,
        }),
    };
    let lineage = lineage(row)?;
    Ok(TaskSnapshot {
        id,
        queue: row.try_get("queue_name")?,
        task_type: row.try_get("task_type")?,
        concurrency_key: row.try_get("concurrency_key")?,
        priority: row.try_get("priority")?,
        payload: row.try_get("payload")?,
        contract_version: row.try_get("contract_version")?,
        tags: row.try_get("tags")?,
        state: wire(TaskState::parse, row, "state")?,
        prerequisite_task_id: lineage.prerequisite_task_id,
        prerequisite_task_ids: lineage.prerequisite_task_ids,
        dependency_policy: lineage.dependency_policy,
        blocked_reason: lineage.blocked_reason,
        parent_task_id: lineage.parent_task_id,
        child_task_ids: lineage.child_task_ids,
        current_attempt: row.try_get("current_attempt")?,
        max_attempts: row.try_get("max_attempts")?,
        retry_policy: retry_policy(row)?,
        deadline_at: row.try_get("deadline_at")?,
        execution_timeout_ms: optional_integer_text(row, "execution_timeout_ms")?,
        fence_token: integer_text(row, "version")?,
        run_at: row.try_get("run_at")?,
        result: row.try_get("result")?,
        error: row.try_get("error")?,
        cancel_requested_at: row.try_get("cancel_requested_at")?,
        cancel_requested_by: row.try_get("cancel_requested_by")?,
        cancel_reason: row.try_get("cancel_reason")?,
        progress,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn timeline_entry(row: &Row) -> Result<TaskTimelineEntry, Error> {
    let record_id = uuid_text(row, "record_id")?;
    let priority = row.try_get("priority")?;
    let occurred_at = row.try_get("occurred_at")?;
    Ok(match wire(TaskTimelineKind::parse, row, "kind")? {
        TaskTimelineKind::Event => TaskTimelineEntry::Event(TaskTimelineEvent {
            record_id,
            priority,
            attempt: row.try_get("attempt")?,
            occurred_at,
            event_type: row.try_get("event_type")?,
            details: row.try_get("details")?,
        }),
        TaskTimelineKind::Attempt => TaskTimelineEntry::Attempt(TaskTimelineAttempt {
            record_id,
            priority,
            attempt: row.try_get("attempt")?,
            occurred_at,
            fence_token: integer_text(row, "fence_token")?,
            worker_id: row.try_get("worker_id")?,
            outcome: row.try_get("outcome")?,
            started_at: row.try_get("started_at")?,
            claimed_at: row.try_get("claimed_at")?,
            finished_at: row.try_get("finished_at")?,
            error: row.try_get("error")?,
        }),
    })
}

fn dead_letter(row: &Row) -> Result<DeadLetter, Error> {
    Ok(DeadLetter {
        task_id: uuid_text(row, "task_id")?,
        queue: row.try_get("queue_name")?,
        task_type: row.try_get("task_type")?,
        concurrency_key: row.try_get("concurrency_key")?,
        priority: row.try_get("priority")?,
        payload: row.try_get("payload")?,
        tags: row.try_get("tags")?,
        current_attempt: row.try_get("current_attempt")?,
        max_attempts: row.try_get("max_attempts")?,
        retry_policy: retry_policy(row)?,
        deadline_at: row.try_get("deadline_at")?,
        execution_timeout_ms: row.try_get("execution_timeout_ms")?,
        error: row.try_get("error")?,
        finished_at: row.try_get("finished_at")?,
        redrive_count: row.try_get("redrive_count")?,
    })
}

fn redrive_result(row: &Row) -> Result<RedriveResult, Error> {
    Ok(RedriveResult {
        status: parse_status(Operation::Redrive, row.try_get("status")?)?,
        source_task_id: uuid_text(row, "source_task_id")?,
        target_task_id: optional_uuid_text(row, "target_task_id")?,
        source_state: optional_wire(TaskState::parse, row, "source_state")?,
        target_state: optional_wire(TaskState::parse, row, "target_state")?,
        requested_at: row.try_get("requested_at")?,
    })
}

fn checkpoint(row: &Row) -> Result<TaskCheckpoint, Error> {
    Ok(TaskCheckpoint {
        task_id: uuid_text(row, "task_id")?,
        name: row.try_get("checkpoint_name")?,
        value: row.try_get("checkpoint_value")?,
        attempt: row.try_get("attempt")?,
        fence_token: integer_text(row, "fence_token")?,
        worker_id: row.try_get("worker_id")?,
        created_at: row.try_get("created_at")?,
    })
}

fn progress(row: &Row) -> Result<TaskProgress, Error> {
    Ok(TaskProgress {
        task_id: uuid_text(row, "task_id")?,
        value: row.try_get("progress_value")?,
        revision: integer_text(row, "revision")?,
        attempt: row.try_get("attempt")?,
        fence_token: integer_text(row, "fence_token")?,
        worker_id: row.try_get("worker_id")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn wait(row: &Row) -> Result<TaskWait, Error> {
    Ok(TaskWait {
        task_id: uuid_text(row, "task_id")?,
        name: row.try_get("wait_name")?,
        mode: wire(WaitMode::parse, row, "mode")?,
        duration_ms: optional_integer_text(row, "duration_ms")?,
        requested_wake_at: row.try_get("requested_wake_at")?,
        wake_at: row.try_get("wake_at")?,
        attempt: row.try_get("attempt")?,
        fence_token: integer_text(row, "fence_token")?,
        worker_id: row.try_get("worker_id")?,
        created_at: row.try_get("created_at")?,
    })
}

fn external_wait(row: &Row) -> Result<ExternalWait, Error> {
    Ok(ExternalWait {
        task_id: uuid_text(row, "task_id")?,
        queue: row.try_get("queue_name")?,
        task_type: row.try_get("task_type")?,
        name: row.try_get("wait_name")?,
        attempt: row.try_get("attempt")?,
        created_at: row.try_get("created_at")?,
        deadline_at: row.try_get("deadline_at")?,
    })
}

fn worker_pause(row: &Row) -> Result<WorkerPauseResult, Error> {
    Ok(WorkerPauseResult {
        worker_id: row.try_get("worker_id")?,
        paused: row.try_get("paused")?,
        paused_by: row.try_get("paused_by")?,
        reason: row.try_get("paused_reason")?,
        paused_at: row.try_get("paused_at")?,
        last_heartbeat_at: row.try_get("last_heartbeat_at")?,
    })
}
