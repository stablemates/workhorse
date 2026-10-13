//! Task groups (ADR 0095): a set of full-tier tasks that Workhorse tracks as one unit.
//!
//! When the group is sealed and every member task is finished, PostgreSQL enqueues the callback
//! tasks that the result selects, in the transaction that finishes the group. The client builds
//! the requests and reads the snapshots; PostgreSQL owns every count and state change.
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tokio_postgres::Row;
use uuid::Uuid;

use crate::admin::{validate_audit, Admin, AdminAudit};
use crate::enqueue::{enqueue_results, EnqueueClient, TokioTransport};
use crate::queue::{exactly_one, Executor, Queue};
use crate::sql_catalogue_generated as sql;
use crate::types::{string_enum, TaskState};
use crate::{
    EnqueueRequest, EnqueueResult, EnqueueRow, EnqueueValue, Error, HandlerContext, Operation,
};

/// The largest number of member tasks one task group holds.
pub const MAX_TASK_GROUP_MEMBERS: i32 = 100_000;
/// The largest number of member tasks or events one read returns.
pub const MAX_TASK_GROUP_PAGE_SIZE: u32 = 1_000;
/// The largest number of drifted groups one drift read or repair examines.
pub const MAX_TASK_GROUP_DRIFT_LIMIT: u32 = 10_000;

string_enum!(
    /// `open` accepts tasks. `sealed` accepts tasks only from a running member task. `finished`
    /// means every member task is finished and the callbacks are enqueued.
    TaskGroupState {
        Open => "open",
        Sealed => "sealed",
        Finished => "finished",
    }
);

string_enum!(
    /// `succeeded` when every member task succeeded, otherwise `failed`.
    TaskGroupResult {
        Succeeded => "succeeded",
        Failed => "failed",
    }
);

string_enum!(
    /// The kind of a task group callback.
    TaskGroupCallbackKind {
        OnFinish => "on_finish",
        OnSuccess => "on_success",
        OnFailure => "on_failure",
    }
);

string_enum!(
    /// The outcome a group counted for one member task.
    TaskGroupMemberOutcome {
        Succeeded => "succeeded",
        Failed => "failed",
        Canceled => "canceled",
    }
);

string_enum!(
    /// Whether a task is a member task or a callback task of its group.
    TaskGroupRole {
        Member => "member",
        Callback => "callback",
    }
);

string_enum!(
    /// The type of one task group history event.
    TaskGroupEventType {
        Created => "created",
        Sealed => "sealed",
        Canceled => "canceled",
        Finished => "finished",
        CallbackEnqueued => "callback_enqueued",
        CallbackFailed => "callback_failed",
        CounterRepaired => "counter_repaired",
    }
);

string_enum!(
    /// What a repair does to one drifted group.
    TaskGroupRepairAction {
        Recounted => "recounted",
        Finished => "finished",
    }
);

/// The callbacks of a task group. Each one is an ordinary enqueue request without enqueue
/// idempotency, debounce, or throttle. A callback can be on any queue, the fast tier included.
#[derive(Clone, Debug, Default)]
pub struct TaskGroupCallbacks {
    /// Runs when every member task is finished.
    pub on_finish: Option<EnqueueRequest>,
    /// Runs when every member task is finished and every member task succeeded.
    pub on_success: Option<EnqueueRequest>,
    /// Runs when every member task is finished and one or more member tasks did not succeed.
    pub on_failure: Option<EnqueueRequest>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TaskGroupCounts {
    pub total: u32,
    pub succeeded: u32,
    pub failed: u32,
    pub canceled: u32,
    pub pending: u32,
}

/// A requested callback, and the task the finished group enqueued for it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskGroupCallback {
    pub kind: TaskGroupCallbackKind,
    /// `None` until the group finishes, and `None` for the callback the result does not select.
    pub task_id: Option<Uuid>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TaskGroup {
    pub id: Uuid,
    pub state: TaskGroupState,
    pub result: Option<TaskGroupResult>,
    pub counts: TaskGroupCounts,
    pub created_at: DateTime<Utc>,
    pub sealed_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub canceled_at: Option<DateTime<Utc>>,
    pub canceled_by: Option<String>,
    pub cancel_reason: Option<String>,
    /// The requested callbacks in the order `on_finish`, `on_success`, `on_failure`.
    pub callbacks: Vec<TaskGroupCallback>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TaskGroupMember {
    /// One-based order in which the member joined its group.
    pub position: u32,
    pub task_id: Uuid,
    /// `None` after the task is deleted, by a purge or by retention.
    pub queue: Option<String>,
    pub task_type: Option<String>,
    pub state: Option<TaskState>,
    /// The outcome the group counted, or `None` while the member is pending.
    pub outcome: Option<TaskGroupMemberOutcome>,
    pub added_at: DateTime<Utc>,
    pub counted_at: Option<DateTime<Utc>>,
}

/// One page request of a group's member tasks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TaskGroupMemberQuery {
    /// Return members after this position.
    pub after: u32,
    /// Between 1 and 1,000; 100 by default.
    pub limit: u32,
}

impl Default for TaskGroupMemberQuery {
    fn default() -> Self {
        Self { after: 0, limit: 100 }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct TaskGroupMemberPage {
    pub members: Vec<TaskGroupMember>,
    /// The `after` value of the next page, or `None` on the last page.
    pub next_after: Option<u32>,
}

/// The group of a running task, as its handler sees it through [`HandlerContext::task_group`].
#[derive(Clone, Debug, PartialEq)]
pub struct TaskGroupLink {
    pub role: TaskGroupRole,
    /// The kind of callback, for a callback task.
    pub callback: Option<TaskGroupCallbackKind>,
    pub group: TaskGroup,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TaskGroupEvent {
    pub id: Uuid,
    pub event_type: TaskGroupEventType,
    pub details: Value,
    pub occurred_at: DateTime<Utc>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TaskGroupBlockResult {
    pub group: TaskGroup,
    /// One result for each added request, in order.
    pub tasks: Vec<EnqueueResult>,
}

/// The counters a group row records.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TaskGroupRecordedCounts {
    pub total: u32,
    pub succeeded: u32,
    pub failed: u32,
    pub canceled: u32,
}

/// One group whose counters disagree with its member outcomes, or that should have finished.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskGroupDrift {
    pub group_id: Uuid,
    pub state: TaskGroupState,
    pub recorded: TaskGroupRecordedCounts,
    /// The counts the member outcomes give.
    pub counted: TaskGroupCounts,
    pub action: TaskGroupRepairAction,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskGroupRepair {
    pub group_id: Uuid,
    pub recorded_pending: u32,
    pub pending: u32,
    pub action: TaskGroupRepairAction,
}

impl<E: Executor> Queue<E> {
    /// Creates an open task group. Add tasks with [`Queue::add_to_task_group`], then seal it with
    /// [`Queue::seal_task_group`]. When the group is sealed and every member task is finished,
    /// Workhorse enqueues the callbacks that the result selects.
    pub async fn create_task_group(
        &self,
        callbacks: TaskGroupCallbacks,
    ) -> Result<TaskGroup, Error> {
        Ok(create(self.enqueue_client(), self.executor(), &callbacks, &[], false).await?.group)
    }

    /// Creates a task group, adds `requests`, and seals the group, in one statement and so in one
    /// transaction. A group with no tasks finishes at the seal.
    pub async fn task_group(
        &self,
        callbacks: TaskGroupCallbacks,
        requests: Vec<EnqueueRequest>,
    ) -> Result<TaskGroupBlockResult, Error> {
        if requests.len() > MAX_TASK_GROUP_MEMBERS as usize {
            return Err(Error::invalid(format!(
                "a task group holds at most {MAX_TASK_GROUP_MEMBERS} tasks"
            )));
        }
        validate_coalescing(&requests)?;
        create(self.enqueue_client(), self.executor(), &callbacks, &requests, true).await
    }

    /// Enqueues up to 1,000 tasks as members of an open group. A sealed group accepts tasks only
    /// from a running member task, through [`HandlerContext::task_group`].
    pub async fn add_to_task_group(
        &self,
        group_id: Uuid,
        requests: Vec<EnqueueRequest>,
    ) -> Result<Vec<EnqueueResult>, Error> {
        add(self.enqueue_client(), self.executor(), group_id, &requests, None).await
    }

    /// Seals an open group. Sealing a sealed or finished group changes nothing.
    pub async fn seal_task_group(&self, group_id: Uuid) -> Result<TaskGroup, Error> {
        self.assert_compatible().await?;
        let rows = self.executor().rows(sql::SEAL_TASK_GROUP_V1, &[&group_id]).await?;
        task_group(exactly_one(&rows, "seal_task_group_v1")?)
    }

    pub async fn get_task_group(&self, group_id: Uuid) -> Result<Option<TaskGroup>, Error> {
        get(self.executor(), group_id).await
    }

    pub async fn list_task_group_members(
        &self,
        group_id: Uuid,
        query: TaskGroupMemberQuery,
    ) -> Result<TaskGroupMemberPage, Error> {
        let limit = limit(query.limit, MAX_TASK_GROUP_PAGE_SIZE)?;
        let after = after(query.after)?;
        let rows = self
            .executor()
            .rows(sql::LIST_TASK_GROUP_MEMBERS_V1, &[&group_id, &after, &limit])
            .await?;
        let more = match probe_after(&rows, limit)? {
            Some(last) => !self
                .executor()
                .rows(sql::LIST_TASK_GROUP_MEMBERS_V1, &[&group_id, &last, &1_i32])
                .await?
                .is_empty(),
            None => false,
        };
        member_page(&rows, more)
    }

    /// The group a task is a member of, or whose callback the task is.
    pub async fn find_task_group(&self, task_id: Uuid) -> Result<Option<TaskGroupLink>, Error> {
        find(self.executor(), task_id).await
    }
}

impl<E: Executor> Admin<E> {
    pub async fn get_task_group(&self, group_id: Uuid) -> Result<Option<TaskGroup>, Error> {
        let rows = self.query(sql::GET_TASK_GROUP_V1, &[&group_id]).await?;
        rows.first().map(task_group).transpose()
    }

    pub async fn list_task_group_members(
        &self,
        group_id: Uuid,
        query: TaskGroupMemberQuery,
    ) -> Result<TaskGroupMemberPage, Error> {
        let limit = limit(query.limit, MAX_TASK_GROUP_PAGE_SIZE)?;
        let after = after(query.after)?;
        let rows =
            self.query(sql::LIST_TASK_GROUP_MEMBERS_V1, &[&group_id, &after, &limit]).await?;
        let more = match probe_after(&rows, limit)? {
            Some(last) => !self
                .query(sql::LIST_TASK_GROUP_MEMBERS_V1, &[&group_id, &last, &1_i32])
                .await?
                .is_empty(),
            None => false,
        };
        member_page(&rows, more)
    }

    /// Reads a group's history in time order: create, seal, cancel, finish, callbacks, repairs.
    /// `limit` is between 1 and 1,000.
    pub async fn list_task_group_events(
        &self,
        group_id: Uuid,
        limit: u32,
    ) -> Result<Vec<TaskGroupEvent>, Error> {
        let limit = self::limit(limit, MAX_TASK_GROUP_PAGE_SIZE)?;
        let rows = self.query(sql::LIST_TASK_GROUP_EVENTS_V1, &[&group_id, &limit]).await?;
        rows.iter()
            .map(|row| {
                Ok(TaskGroupEvent {
                    id: row.try_get("event_id")?,
                    event_type: wire(TaskGroupEventType::parse, row, "event_type")?,
                    details: row.try_get("details")?,
                    occurred_at: row.try_get("occurred_at")?,
                })
            })
            .collect()
    }

    /// Seals an open group, so no task can join it after this call, not even from a running
    /// member task. Then cancels every member task that is not terminal. The canceled members
    /// count as not succeeded, so the group finishes as usual and `on_finish` and `on_failure`
    /// run. A finished group stays unchanged. Returns `None` for an unknown group.
    pub async fn cancel_task_group(
        &self,
        group_id: Uuid,
        audit: &AdminAudit,
    ) -> Result<Option<TaskGroup>, Error> {
        validate_audit(audit)?;
        let rows = self
            .query(
                sql::CANCEL_TASK_GROUP_V1,
                &[&group_id, &audit.actor, &audit.reason, &audit.request_id],
            )
            .await?;
        rows.first().map(task_group).transpose()
    }

    /// Lists groups that are not finished and whose counters disagree with their member
    /// outcomes, and sealed groups whose members are all finished. It writes nothing, so it is
    /// the dry run of [`Admin::repair_task_group_drift`]. `limit` is between 1 and 10,000.
    pub async fn list_task_group_drift(&self, limit: u32) -> Result<Vec<TaskGroupDrift>, Error> {
        let limit = self::limit(limit, MAX_TASK_GROUP_DRIFT_LIMIT)?;
        let rows = self.query(sql::LIST_TASK_GROUP_DRIFT_V1, &[&limit]).await?;
        rows.iter()
            .map(|row| {
                Ok(TaskGroupDrift {
                    group_id: row.try_get("group_id")?,
                    state: wire(TaskGroupState::parse, row, "state")?,
                    recorded: TaskGroupRecordedCounts {
                        total: count(row, "recorded_total")?,
                        succeeded: count(row, "recorded_succeeded")?,
                        failed: count(row, "recorded_failed")?,
                        canceled: count(row, "recorded_canceled")?,
                    },
                    counted: counts(row)?,
                    action: wire(TaskGroupRepairAction::parse, row, "action")?,
                })
            })
            .collect()
    }

    /// Recounts each group [`Admin::list_task_group_drift`] reports from its member outcomes, and
    /// finishes a sealed group with no pending member. Each repaired group's `counter_repaired`
    /// event records the audit.
    pub async fn repair_task_group_drift(
        &self,
        audit: &AdminAudit,
        limit: u32,
    ) -> Result<Vec<TaskGroupRepair>, Error> {
        validate_audit(audit)?;
        let limit = self::limit(limit, MAX_TASK_GROUP_DRIFT_LIMIT)?;
        let rows = self
            .query(
                sql::REPAIR_TASK_GROUP_DRIFT_V1,
                &[&limit, &audit.actor, &audit.reason, &audit.request_id],
            )
            .await?;
        rows.iter()
            .map(|row| {
                Ok(TaskGroupRepair {
                    group_id: row.try_get("group_id")?,
                    recorded_pending: count(row, "recorded_pending")?,
                    pending: count(row, "pending")?,
                    action: wire(TaskGroupRepairAction::parse, row, "action")?,
                })
            })
            .collect()
    }
}

/// The task group operations of one handler invocation.
#[derive(Clone, Copy, Debug)]
pub struct TaskGroupContext<'a> {
    context: &'a HandlerContext,
}

impl HandlerContext {
    /// The task group of this task, as a member task or as a callback task (ADR 0095).
    pub fn task_group(&self) -> TaskGroupContext<'_> {
        TaskGroupContext { context: self }
    }
}

impl TaskGroupContext<'_> {
    /// Reads the group this task is a member of, or whose callback this task is, with its counts.
    /// Returns `None` for a task with no group. The invocation reads it one time and keeps it.
    pub async fn get(&self) -> Result<Option<TaskGroupLink>, Error> {
        let context = self.context;
        context
            .task_group_link()
            .get_or_try_init(|| find(context.pool(), context.task().id))
            .await
            .cloned()
    }

    /// Adds up to 1,000 tasks to the group of this member task, under the current fenced lease. A
    /// running member task can add tasks after the seal, until its group is canceled. A request
    /// without a queue goes to the queue of the member task, as a child task request goes to the
    /// queue of its parent task.
    pub async fn add(&self, requests: Vec<EnqueueRequest>) -> Result<Vec<EnqueueResult>, Error> {
        let context = self.context;
        context.check(Operation::AddToTaskGroup)?;
        let task = context.task();
        let group_id = match self.get().await? {
            Some(TaskGroupLink { role: TaskGroupRole::Member, group, .. }) => group.id,
            _ => {
                return Err(Error::invalid(format!(
                    "Task {} is not a member of a task group",
                    task.id
                )))
            }
        };
        let member = Some((task.id, context.worker_id(), task.fence_token));
        add(context.group_enqueue(), context.pool(), group_id, &requests, member).await
    }
}

/// The task, worker, and fence token of a running member task that adds to its group.
type Member<'a> = Option<(Uuid, &'a str, i64)>;

async fn create<E: Executor>(
    client: &EnqueueClient,
    executor: &E,
    callbacks: &TaskGroupCallbacks,
    requests: &[EnqueueRequest],
    seal: bool,
) -> Result<TaskGroupBlockResult, Error> {
    let entries = [
        ("onFinish", &callbacks.on_finish),
        ("onSuccess", &callbacks.on_success),
        ("onFailure", &callbacks.on_failure),
    ];
    let mut known: Vec<&str> = requests.iter().map(|request| request.task_type.as_str()).collect();
    known.extend(
        entries
            .iter()
            .filter_map(|(_, request)| request.as_ref())
            .map(|request| request.task_type.as_str()),
    );
    // A contract mismatch of a member or a callback creates nothing, and the retry serializes the
    // callbacks again under the contract versions the mismatch refreshed.
    for _ in 0..2 {
        let mut transport = TokioTransport(executor);
        let mut document = Map::new();
        for (kind, request) in entries {
            if let Some(request) = request {
                let callback = client.prepare_callback(&mut transport, request).await?;
                document.insert(kind.into(), callback);
            }
        }
        let document = Value::Object(document);
        let input = client.prepare(&mut transport, requests).await?;
        let rows = executor
            .rows(sql::CREATE_TASK_GROUP_V1, &[&document, &input, &seal])
            .await
            .map_err(Error::translate_enqueue_error)?;
        let group_id = match rows.first() {
            Some(row) => row.try_get::<_, Option<Uuid>>("group_id")?,
            None => None,
        };
        let mut enqueued = Vec::with_capacity(rows.len());
        for row in &rows {
            if row.try_get::<_, Option<i32>>("ordinal")?.is_some() {
                enqueued.push(enqueue_row(row)?);
            }
        }
        if client.reload_mismatched(&mut transport, &enqueued, &known).await? {
            continue;
        }
        let tasks = enqueue_results(&enqueued, requests.len())?;
        let group_id =
            group_id.ok_or_else(|| Error::invalid("PostgreSQL created no task group"))?;
        let group = get(executor, group_id).await?.ok_or_else(|| {
            Error::invalid(format!("Task group {group_id} disappeared after its creation"))
        })?;
        return Ok(TaskGroupBlockResult { group, tasks });
    }
    Err(Error::ContractPolicyChanged)
}

async fn add<E: Executor>(
    client: &EnqueueClient,
    executor: &E,
    group_id: Uuid,
    requests: &[EnqueueRequest],
    member: Member<'_>,
) -> Result<Vec<EnqueueResult>, Error> {
    if requests.len() > sql::MAX_ENQUEUE_BATCH_SIZE {
        return Err(Error::invalid(format!(
            "a task group add accepts at most {} tasks",
            sql::MAX_ENQUEUE_BATCH_SIZE
        )));
    }
    validate_coalescing(requests)?;
    if requests.is_empty() {
        return Ok(Vec::new());
    }
    let known: Vec<&str> = requests.iter().map(|request| request.task_type.as_str()).collect();
    let task_id = member.map(|(task_id, _, _)| task_id);
    let worker_id = member.map(|(_, worker_id, _)| worker_id);
    let fence_token = member.map(|(_, _, fence_token)| fence_token);
    for _ in 0..2 {
        let mut transport = TokioTransport(executor);
        let input = client.prepare(&mut transport, requests).await?;
        let rows = executor
            .rows(
                sql::ADD_TASK_GROUP_MEMBERS_V1,
                &[&group_id, &input, &task_id, &worker_id, &fence_token],
            )
            .await
            .map_err(Error::translate_enqueue_error)?;
        let rows = rows.iter().map(enqueue_row).collect::<Result<Vec<_>, _>>()?;
        if !client.reload_mismatched(&mut transport, &rows, &known).await? {
            return enqueue_results(&rows, requests.len());
        }
    }
    Err(Error::ContractPolicyChanged)
}

async fn get<E: Executor>(executor: &E, group_id: Uuid) -> Result<Option<TaskGroup>, Error> {
    let rows = executor.rows(sql::GET_TASK_GROUP_V1, &[&group_id]).await?;
    rows.first().map(task_group).transpose()
}

async fn find<E: Executor>(executor: &E, task_id: Uuid) -> Result<Option<TaskGroupLink>, Error> {
    let rows = executor.rows(sql::TASK_GROUP_FOR_TASK_V1, &[&task_id]).await?;
    let Some(row) = rows.first() else {
        return Ok(None);
    };
    Ok(Some(TaskGroupLink {
        role: wire(TaskGroupRole::parse, row, "role")?,
        callback: row
            .try_get::<_, Option<&str>>("callback_kind")?
            .map(|kind| TaskGroupCallbackKind::parse(kind).ok_or_else(|| invalid("callback_kind")))
            .transpose()?,
        group: task_group(row)?,
    }))
}

/// A group add refuses debounce and throttle: they could return a task that is not a member.
fn validate_coalescing(requests: &[EnqueueRequest]) -> Result<(), Error> {
    if requests
        .iter()
        .any(|request| request.options.debounce.is_some() || request.options.throttle.is_some())
    {
        return Err(Error::invalid("a task group add cannot use debounce or throttle"));
    }
    Ok(())
}

fn limit(limit: u32, maximum: u32) -> Result<i32, Error> {
    if !(1..=maximum).contains(&limit) {
        return Err(Error::invalid(format!("limit must be an integer from 1 to {maximum}")));
    }
    Ok(limit as i32)
}

fn after(after: u32) -> Result<i32, Error> {
    i32::try_from(after).map_err(|_| Error::invalid("after must be at most 2147483647"))
}

fn enqueue_row(row: &Row) -> Result<EnqueueRow, Error> {
    let text = |name: &str| -> Result<EnqueueValue, Error> {
        Ok(row.try_get::<_, Option<String>>(name)?.map_or(EnqueueValue::Null, EnqueueValue::Text))
    };
    Ok(EnqueueRow::from([
        (
            "ordinal".into(),
            row.try_get::<_, Option<i32>>("ordinal")?.map_or(EnqueueValue::Null, EnqueueValue::Int),
        ),
        (
            "task_id".into(),
            row.try_get::<_, Option<Uuid>>("task_id")?
                .map_or(EnqueueValue::Null, EnqueueValue::Uuid),
        ),
        ("outcome".into(), text("outcome")?),
        ("reason".into(), text("reason")?),
    ]))
}

fn task_group(row: &Row) -> Result<TaskGroup, Error> {
    let callbacks: Value = row.try_get("callbacks")?;
    let Value::Object(callbacks) = callbacks else {
        return Err(invalid("callbacks"));
    };
    let mut requested = Vec::with_capacity(callbacks.len());
    for kind in [
        TaskGroupCallbackKind::OnFinish,
        TaskGroupCallbackKind::OnSuccess,
        TaskGroupCallbackKind::OnFailure,
    ] {
        let Some(callback) = callbacks.get(kind.as_str()) else {
            continue;
        };
        let task_id = match callback.get("taskId") {
            None | Some(Value::Null) => None,
            Some(Value::String(task_id)) => {
                Some(Uuid::parse_str(task_id).map_err(|_| invalid("callbacks"))?)
            }
            Some(_) => return Err(invalid("callbacks")),
        };
        requested.push(TaskGroupCallback { kind, task_id });
    }
    if requested.len() != callbacks.len() {
        return Err(invalid("callbacks"));
    }
    Ok(TaskGroup {
        id: row.try_get("group_id")?,
        state: wire(TaskGroupState::parse, row, "state")?,
        result: row
            .try_get::<_, Option<&str>>("result")?
            .map(|result| TaskGroupResult::parse(result).ok_or_else(|| invalid("result")))
            .transpose()?,
        counts: counts(row)?,
        created_at: row.try_get("created_at")?,
        sealed_at: row.try_get("sealed_at")?,
        finished_at: row.try_get("finished_at")?,
        canceled_at: row.try_get("canceled_at")?,
        canceled_by: row.try_get("canceled_by")?,
        cancel_reason: row.try_get("cancel_reason")?,
        callbacks: requested,
    })
}

/// The position after which one member is read when `rows` is a full page, or `None`.
///
/// A full page can be the last page. `list_task_group_members_v1` reads at most 1,000 members, so a
/// read of `limit + 1` fails at the maximum. The read of one member tells the two apart.
fn probe_after(rows: &[Row], limit: i32) -> Result<Option<i32>, Error> {
    match rows.last() {
        Some(last) if rows.len() == limit as usize => Ok(Some(last.try_get("position")?)),
        _ => Ok(None),
    }
}

fn member_page(rows: &[Row], more: bool) -> Result<TaskGroupMemberPage, Error> {
    let members = rows
        .iter()
        .map(|row| {
            Ok(TaskGroupMember {
                position: count(row, "position")?,
                task_id: row.try_get("task_id")?,
                queue: row.try_get("queue_name")?,
                task_type: row.try_get("task_type")?,
                state: row
                    .try_get::<_, Option<&str>>("state")?
                    .map(|state| TaskState::parse(state).ok_or_else(|| invalid("state")))
                    .transpose()?,
                outcome: row
                    .try_get::<_, Option<&str>>("outcome")?
                    .map(|outcome| {
                        TaskGroupMemberOutcome::parse(outcome).ok_or_else(|| invalid("outcome"))
                    })
                    .transpose()?,
                added_at: row.try_get("added_at")?,
                counted_at: row.try_get("counted_at")?,
            })
        })
        .collect::<Result<Vec<_>, Error>>()?;
    let next_after = members.last().filter(|_| more).map(|last| last.position);
    Ok(TaskGroupMemberPage { members, next_after })
}

fn counts(row: &Row) -> Result<TaskGroupCounts, Error> {
    Ok(TaskGroupCounts {
        total: count(row, "total")?,
        succeeded: count(row, "succeeded")?,
        failed: count(row, "failed")?,
        canceled: count(row, "canceled")?,
        pending: count(row, "pending")?,
    })
}

fn count(row: &Row, column: &str) -> Result<u32, Error> {
    u32::try_from(row.try_get::<_, i32>(column)?).map_err(|_| invalid(column))
}

fn wire<T>(parse: fn(&str) -> Option<T>, row: &Row, column: &str) -> Result<T, Error> {
    parse(row.try_get(column)?).ok_or_else(|| invalid(column))
}

fn invalid(column: &str) -> Error {
    Error::invalid(format!("PostgreSQL returned an invalid task group {column}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Debounce, DebounceSchedule, EnqueueOptions, Throttle};

    #[test]
    fn an_add_refuses_debounce_and_throttle() {
        let mut debounced = EnqueueRequest::new("member", serde_json::json!({}));
        debounced.options = EnqueueOptions {
            debounce: Some(Debounce::new("k", 1_000, DebounceSchedule::Reset)),
            ..Default::default()
        };
        let mut throttled = EnqueueRequest::new("member", serde_json::json!({}));
        throttled.options =
            EnqueueOptions { throttle: Some(Throttle::new("k", 1_000)), ..Default::default() };
        for request in [debounced, throttled] {
            match validate_coalescing(&[request]) {
                Err(Error::InvalidArgument(message)) => {
                    assert_eq!(message, "a task group add cannot use debounce or throttle");
                }
                other => panic!("expected a refusal, got {other:?}"),
            }
        }
    }

    fn translated(code: &str, detail: &str) -> Error {
        let source = std::io::Error::other("refused");
        Error::database(Some(code), Some(detail), source).translate_enqueue_error()
    }

    #[test]
    fn task_group_sqlstates_map_to_their_errors() {
        let detail = r#"{"groupId":"g","state":"sealed","reason":"not_running_member"}"#;
        match translated("P1008", detail) {
            Error::TaskGroupClosed { details } => {
                assert_eq!((details.group_id.as_str(), details.state.as_str()), ("g", "sealed"));
                assert_eq!(details.reason, "not_running_member");
            }
            other => panic!("expected P1008 to map, got {other:?}"),
        }
        let detail = r#"{"groupId":"g","limit":100000,"total":99999,"requested":2}"#;
        match translated("P1009", detail) {
            Error::TaskGroupLimitExceeded { details } => {
                assert_eq!((details.limit, details.total, details.requested), (100_000, 99_999, 2));
            }
            other => panic!("expected P1009 to map, got {other:?}"),
        }
        let detail = r#"{"groupId":"g","taskId":"t","ordinal":3,"memberOf":"h"}"#;
        match translated("P1010", detail) {
            Error::TaskGroupMembershipConflict { details } => {
                assert_eq!((details.ordinal, details.member_of.as_deref()), (3, Some("h")));
            }
            other => panic!("expected P1010 to map, got {other:?}"),
        }
    }

    // A DETAIL that does not parse still names the refusal, with the TypeScript placeholders.
    #[test]
    fn an_unparsed_detail_keeps_the_task_group_variant() {
        match translated("P1008", "not json") {
            Error::TaskGroupClosed { details } => {
                assert_eq!(*details, crate::TaskGroupClosedDetails::default());
                assert_eq!(
                    (details.group_id.as_str(), details.reason.as_str()),
                    ("unknown", "finished")
                );
            }
            other => panic!("expected P1008 to map, got {other:?}"),
        }
        match translated("P1009", r#"{"groupId":"g"}"#) {
            Error::TaskGroupLimitExceeded { details } => {
                assert_eq!((details.group_id.as_str(), details.limit), ("unknown", 100_000));
            }
            other => panic!("expected P1009 to map, got {other:?}"),
        }
        match translated("P1010", "") {
            Error::TaskGroupMembershipConflict { details } => {
                assert_eq!((details.task_id.as_str(), details.member_of), ("unknown", None));
            }
            other => panic!("expected P1010 to map, got {other:?}"),
        }
    }

    #[test]
    fn a_limit_outside_its_range_is_refused() {
        assert!(limit(0, MAX_TASK_GROUP_PAGE_SIZE).is_err());
        assert!(limit(1_001, MAX_TASK_GROUP_PAGE_SIZE).is_err());
        assert_eq!(limit(1_000, MAX_TASK_GROUP_PAGE_SIZE).unwrap(), 1_000);
        assert_eq!(limit(10_000, MAX_TASK_GROUP_DRIFT_LIMIT).unwrap(), 10_000);
        assert!(after(u32::MAX).is_err());
    }
}
