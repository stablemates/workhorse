//! The built-in dashboard/v1 procedures, each one statement from the generated catalogue or one
//! [`Admin`] call.
use std::time::{Duration, Instant};

use chrono::{DateTime, NaiveTime, Utc};
use serde_json::{json, Map, Value};
use tokio::sync::Mutex;
use tokio_postgres::types::ToSql;
use tokio_postgres::Row;
use uuid::Uuid;

use super::{ProcedureError, RpcError};
use crate::queue::exactly_one;
use crate::sql_catalogue_generated as sql;
use crate::{
    Admin, AdminAudit, BulkRedriveOptions, DeadLetterCursor, DeadLetterFilter, Error, Executor,
    RedriveResult, RedriveStatus,
};

type Procedure = Result<Value, ProcedureError>;

/// Every procedure this module implements. `enqueueTest` and `setSchedulePaused` stay host
/// extensions, as in the Go and Python backends.
pub(super) const BUILT_INS: &[&str] = &[
    "meta",
    "taskCounts",
    "taskFacets",
    "queues",
    "tasks",
    "tasksCursor",
    "activity",
    "cron",
    "workers",
    "humanWaits",
    "events",
    "eventDetail",
    "previewRetentionPolicy",
    "taskDetail",
    "settings",
    "system",
    "checkpointValue",
    "taskValue",
    "setQueuePaused",
    "purgeQueue",
    "setWorkerPaused",
    "overrideMaintenancePolicy",
    "revertMaintenancePolicy",
    "overrideRetentionPolicy",
    "revertRetentionPolicy",
    "runTaskNow",
    "cancelTask",
    "signalTask",
    "completeHumanWait",
    "redriveTask",
    "redriveDeadLetters",
];

/// How long one health document serves nearby reads. It matches the TypeScript, Go and Python
/// hosts, so every backend agrees on staleness.
const QUEUE_HEALTH_TTL: Duration = Duration::from_secs(3);

/// The window `queue_health_v1` applies when a caller supplies none.
const QUEUE_HEALTH_WINDOW: chrono::Duration = chrono::Duration::hours(24);

/// Bounds each retention preview count, so an estimate never scans a whole table.
const PREVIEW_CAP: i64 = 10_000;

const RETENTION_SETTINGS: [&str; 6] = [
    "taskIdentityRetentionDays",
    "terminalOutcomeRetentionDays",
    "taskEventRetentionDays",
    "attemptHistoryRetentionDays",
    "scheduleOccurrenceRetentionDays",
    "statisticsRetentionDays",
];

const PREVIEW_COUNTS: [(&str, &str); 5] = [
    ("terminalTasks", "terminal_tasks"),
    ("taskEvents", "task_events"),
    ("attemptHistory", "attempt_history"),
    ("scheduleOccurrences", "schedule_occurrences"),
    ("statistics", "statistics"),
];

pub(super) struct Backend<E: Executor> {
    pub(super) admin: Admin<E>,
    pub(super) environment: String,
    pub(super) configured_workers: Vec<String>,
    pub(super) read_only: bool,
    pub(super) maintenance_loops: Value,
    health: Mutex<Option<(Value, Instant)>>,
}

impl<E: Executor> Backend<E> {
    pub(super) fn new(
        executor: E,
        environment: String,
        configured_workers: Vec<String>,
        read_only: bool,
        maintenance_loops: Value,
    ) -> Self {
        Self {
            admin: Admin::new(executor),
            environment,
            configured_workers,
            read_only,
            maintenance_loops,
            health: Mutex::new(None),
        }
    }

    pub(super) fn executor(&self) -> &E {
        self.admin.executor()
    }

    /// Runs one built-in procedure; `None` when `name` is not one.
    pub(super) async fn call(&self, name: &str, input: Value, actor: &str) -> Option<Procedure> {
        let writable = !self.read_only;
        Some(match name {
            "meta" => Ok(json!({ "environment": self.environment })),
            "taskCounts" => self.json_query(sql::DASHBOARD_TASK_COUNTS_V1, None).await,
            "taskFacets" => {
                let input = json!({ "configuredWorkers": self.configured_workers });
                self.json_query(sql::DASHBOARD_TASK_FACETS_V1, Some(input)).await
            }
            "queues" => self.json_query(sql::DASHBOARD_QUEUES_V1, None).await,
            "tasks" => self.tasks(input).await,
            "tasksCursor" => {
                let mut value = document(input);
                value.insert("canCompleteHumanWait".into(), writable.into());
                let result =
                    self.raw_json_query(sql::DASHBOARD_TASKS_CURSOR_V1, Some(value.into()));
                result.await.map(Option::unwrap_or_default)
            }
            "activity" => self.json_query(sql::DASHBOARD_ACTIVITY_V1, Some(input)).await,
            "cron" => {
                let input = json!({ "maintenanceLoops": self.maintenance_loops });
                self.json_query(sql::DASHBOARD_CRON_V1, Some(input)).await
            }
            "workers" => {
                let input = json!({
                    "configuredWorkers": self.configured_workers,
                    "canManageWorkers": writable,
                });
                self.json_query(sql::DASHBOARD_WORKERS_V1, Some(input)).await
            }
            "humanWaits" => self.human_waits().await,
            "events" => self.json_query(sql::DASHBOARD_EVENTS_V1, Some(input)).await,
            "eventDetail" => {
                let result = self.raw_json_query(sql::DASHBOARD_EVENT_DETAIL_V1, Some(input)).await;
                found(result.map(|value| value.map(normalize)), "Event not found")
            }
            "previewRetentionPolicy" => self.preview_retention_policy(input).await,
            "taskDetail" => self.task_detail(input).await,
            "settings" => {
                let input = json!({ "writable": writable, "settingsController": true });
                self.json_query(sql::DASHBOARD_SETTINGS_V1, Some(input)).await
            }
            "system" => match input {
                Value::Object(_) => self.json_query(sql::DASHBOARD_SYSTEM_V1, Some(input)).await,
                _ => Err(Error::invalid("dashboard input is not an object").into()),
            },
            "checkpointValue" => {
                let result = self.optional_query(sql::DASHBOARD_CHECKPOINT_VALUE_V1, input).await;
                found(result, "Checkpoint not found")
            }
            "taskValue" => found(
                self.optional_query(sql::DASHBOARD_TASK_VALUE_V1, input).await,
                "Task not found",
            ),
            "setQueuePaused" => self.set_queue_paused(input, actor).await,
            "purgeQueue" => {
                let value = document(input);
                let (queue, audit) = (text(&value, "queue"), audit(&value, actor));
                let deleted = self.admin.purge_queue(&queue, &audit).await;
                deleted.map(|count| json!({ "deletedCount": count })).map_err(Into::into)
            }
            "setWorkerPaused" => self.set_worker_paused(input, actor).await,
            "overrideMaintenancePolicy" => self.override_maintenance_policy(input).await,
            "revertMaintenancePolicy" => {
                self.revert(sql::REVERT_MAINTENANCE_POLICY_V1, input).await
            }
            "overrideRetentionPolicy" => {
                let value = document(input);
                let definition: Map<String, Value> = object(&value, "definition")
                    .into_iter()
                    .map(|(key, item)| (snake(&key), item))
                    .collect();
                let definition = Value::Object(definition);
                let rows = self.rows(sql::OVERRIDE_RETENTION_POLICY_V1, &[&definition]).await;
                rows.map(|_| Value::Null).map_err(Into::into)
            }
            "revertRetentionPolicy" => self.revert(sql::REVERT_RETENTION_POLICY_V1, input).await,
            "runTaskNow" => self.run_task_now(input, actor).await,
            "cancelTask" => self.cancel_task(input, actor).await,
            "signalTask" => self.deliver(input, actor, Delivery::Signal).await,
            "completeHumanWait" => self.deliver(input, actor, Delivery::HumanWait).await,
            "redriveTask" => self.redrive_task(input, actor).await,
            "redriveDeadLetters" => self.redrive_dead_letters(input, actor).await,
            _ => return None,
        })
    }

    async fn rows(
        &self,
        statement: &str,
        params: &[&(dyn ToSql + Sync)],
    ) -> Result<Vec<Row>, Error> {
        self.executor().rows(statement, params).await
    }

    async fn json_query(&self, statement: &str, input: Option<Value>) -> Procedure {
        let value = self.raw_json_query(statement, input).await?;
        Ok(value.map(normalize).unwrap_or_default())
    }

    /// Reads the `result` column without normalizing it, because SQL-owned cursor timestamps must
    /// pass through without display-time rounding.
    async fn raw_json_query(
        &self,
        statement: &str,
        input: Option<Value>,
    ) -> Result<Option<Value>, ProcedureError> {
        let rows = match &input {
            Some(input) => self.rows(statement, &[input]).await?,
            None => self.rows(statement, &[]).await?,
        };
        Ok(exactly_one(&rows, "dashboard JSON projection")?
            .try_get("result")
            .map_err(Error::from)?)
    }

    async fn optional_query(
        &self,
        statement: &str,
        input: Value,
    ) -> Result<Option<Value>, ProcedureError> {
        Ok(self.raw_json_query(statement, Some(input)).await?.map(normalize))
    }

    /// Reads the raw `queue_health_v1` document and shares it for [`QUEUE_HEALTH_TTL`].
    ///
    /// One dashboard page reads the document from several procedures, and composing it is a pass
    /// over live queue state. The lock also serialises concurrent misses, so a burst shares one
    /// read. A failed read is never cached.
    async fn queue_health(&self) -> Result<Value, Error> {
        let mut cached = self.health.lock().await;
        if let Some((value, expires_at)) = cached.as_ref() {
            if Instant::now() < *expires_at {
                return Ok(value.clone());
            }
        }
        let since = Utc::now() - QUEUE_HEALTH_WINDOW;
        let rows = self.rows(sql::QUEUE_HEALTH_V1, &[&since]).await?;
        let value: Value = exactly_one(&rows, "queue_health_v1")?.try_get("snapshot")?;
        *cached = Some((value.clone(), Instant::now() + QUEUE_HEALTH_TTL));
        Ok(value)
    }

    async fn tasks(&self, input: Value) -> Procedure {
        let mut value = document(input);
        let defaults = json!({
            "filter": "all", "queue": null, "page": 1, "worker": null, "taskType": null,
            "priority": null, "sort": "updated", "tags": [], "search": null, "pageSize": 50,
            "count": "none",
        });
        if let Value::Object(defaults) = defaults {
            for (key, default) in defaults {
                value.entry(key).or_insert(default);
            }
        }
        value.insert("canCompleteHumanWait".into(), (!self.read_only).into());
        self.json_query(sql::DASHBOARD_TASKS_V1, Some(value.into())).await
    }

    async fn human_waits(&self) -> Procedure {
        let health = self.queue_health().await?;
        let writable = !self.read_only;
        let input = json!({ "canComplete": writable, "canSignal": writable, "health": health });
        self.json_query(sql::DASHBOARD_HUMAN_WAITS_V1, Some(input)).await
    }

    async fn task_detail(&self, input: Value) -> Procedure {
        let mut value = document(input);
        let health = self.queue_health().await?;
        value.insert("canSignal".into(), (!self.read_only).into());
        value.insert("canCompleteHumanWait".into(), (!self.read_only).into());
        value.insert("health".into(), health);
        found(
            self.optional_query(sql::DASHBOARD_TASK_DETAIL_V1, value.into()).await,
            "Task not found",
        )
    }

    async fn preview_retention_policy(&self, input: Value) -> Procedure {
        let definition = object(&document(input), "definition");
        let rows = self.rows(sql::GET_RETENTION_POLICY_V1, &[]).await?;
        let current = exactly_one(&rows, "get_retention_policy_v1")?;
        let mut days = Vec::with_capacity(RETENTION_SETTINGS.len());
        for name in RETENTION_SETTINGS {
            days.push(match definition.get(name).and_then(Value::as_i64) {
                Some(value) => Some(integer(value, name)?),
                None => {
                    current.try_get::<_, Option<i32>>(snake(name).as_str()).map_err(Error::from)?
                }
            });
        }
        let params: Vec<&(dyn ToSql + Sync)> = days.iter().map(|day| day as _).collect();
        let rows = self.rows(sql::RETENTION_POLICY_PREVIEW, &params).await?;
        let counts = exactly_one(&rows, "retention_policy_preview")?;
        let (mut eligible, mut capped) = (Map::new(), Map::new());
        for (name, column) in PREVIEW_COUNTS {
            let count = i64::from(counts.try_get::<_, i32>(column).map_err(Error::from)?);
            eligible.insert(name.into(), count.min(PREVIEW_CAP).into());
            capped.insert(name.into(), (count > PREVIEW_CAP).into());
        }
        Ok(json!({ "eligible": eligible, "capped": capped }))
    }

    async fn set_queue_paused(&self, input: Value, actor: &str) -> Procedure {
        let value = document(input);
        let paused = value.get("paused").and_then(Value::as_bool).unwrap_or(false);
        let (queue, audit) = (text(&value, "queue"), audit(&value, actor));
        if paused {
            self.admin.pause_queue(&queue, &audit).await?;
        } else {
            self.admin.resume_queue(&queue, &audit).await?;
        }
        Ok(json!({ "paused": paused }))
    }

    async fn set_worker_paused(&self, input: Value, actor: &str) -> Procedure {
        let value = document(input);
        let paused = value.get("paused").and_then(Value::as_bool).unwrap_or(false);
        let worker = text(&value, "workerId");
        match self.admin.set_worker_paused(&worker, paused, &audit(&value, actor)).await? {
            Some(result) => Ok(json!({ "paused": result.paused })),
            None => Err(RpcError::not_found("Worker not found").into()),
        }
    }

    async fn override_maintenance_policy(&self, input: Value) -> Procedure {
        let definition = object(&document(input), "definition");
        let number = |name: &str| -> Result<Option<i32>, Error> {
            definition
                .get(name)
                .and_then(Value::as_i64)
                .map(|value| integer(value, name))
                .transpose()
        };
        let timezone = definition.get("timezone").and_then(Value::as_str);
        let local_time = match definition.get("historyRetentionLocalTime").and_then(Value::as_str) {
            Some(value) => Some(
                NaiveTime::parse_from_str(value, "%H:%M:%S")
                    .or_else(|_| NaiveTime::parse_from_str(value, "%H:%M"))
                    .map_err(|_| Error::invalid("historyRetentionLocalTime is not a time"))?,
            ),
            None => None,
        };
        let partition = number("partitionPreparationIntervalMs")?;
        let cleanup = number("terminalCleanupIntervalMs")?;
        let rollup = number("statisticsRollupIntervalMs")?;
        let groups = number("statisticsGroupLimit")?;
        let buckets = number("statisticsRecomputeBuckets")?;
        let params: [&(dyn ToSql + Sync); 7] =
            [&timezone, &partition, &cleanup, &local_time, &rollup, &groups, &buckets];
        self.rows(sql::OVERRIDE_MAINTENANCE_POLICY_V1, &params).await?;
        Ok(Value::Null)
    }

    async fn revert(&self, statement: &str, input: Value) -> Procedure {
        let value = document(input);
        let settings: Vec<String> = match value.get("settings") {
            Some(Value::Array(items)) => {
                items.iter().filter_map(Value::as_str).map(snake).collect()
            }
            _ => Vec::new(),
        };
        self.rows(statement, &[&settings]).await?;
        Ok(Value::Null)
    }

    async fn run_task_now(&self, input: Value, actor: &str) -> Procedure {
        let value = document(input);
        let (id, audit) = (task_id(&value)?, object(&value, "audit"));
        let (reason, request_id) = (
            audit.get("reason").and_then(Value::as_str),
            audit.get("requestId").and_then(Value::as_str),
        );
        let rows = self.rows(sql::RUN_TASK_NOW_V1, &[&id, &actor, &reason, &request_id]).await?;
        let row = exactly_one(&rows, "run_task_now_v1")?;
        let status: String = row.try_get("status").map_err(Error::from)?;
        if status == "not_found" {
            return Err(RpcError::not_found("Task not found").into());
        }
        Ok(json!({
            "status": status,
            "id": value.get("id"),
            "state": column::<Option<String>>(row, "state")?,
            "runAt": optional_timestamp(column(row, "run_at")?),
        }))
    }

    async fn cancel_task(&self, input: Value, actor: &str) -> Procedure {
        let value = document(input);
        let id = task_id(&value)?;
        let reason =
            object(&value, "audit").get("reason").and_then(Value::as_str).map(str::to_owned);
        let rows = self.rows(sql::CANCEL_V1, &[&id, &actor, &reason]).await?;
        let row = exactly_one(&rows, "cancel_v1")?;
        let status: String = column(row, "status")?;
        if status == "not_found" {
            return Err(RpcError::not_found("Task not found").into());
        }
        Ok(json!({
            "status": status,
            "taskId": value.get("id"),
            "state": column::<Option<String>>(row, "state")?,
            "currentAttempt": column::<Option<i32>>(row, "current_attempt")?,
            "requestedAt": optional_timestamp(column(row, "requested_at")?),
            "requestedBy": column::<Option<String>>(row, "requested_by")?,
            "reason": column::<Option<String>>(row, "reason")?,
            "finishedAt": optional_timestamp(column(row, "finished_at")?),
        }))
    }

    async fn deliver(&self, input: Value, actor: &str, delivery: Delivery) -> Procedure {
        let value = document(input);
        let (statement, input_key, value_key, at, by, at_key, by_key) = match delivery {
            Delivery::Signal => (
                sql::SEND_SIGNAL_V1,
                "payload",
                "payload",
                "delivered_at",
                "delivered_by",
                "deliveredAt",
                "deliveredBy",
            ),
            Delivery::HumanWait => (
                sql::COMPLETE_HUMAN_WAIT_V1,
                "result",
                "result",
                "completed_at",
                "completed_by",
                "completedAt",
                "completedBy",
            ),
        };
        let id = task_id(&value)?;
        let name = value.get("name").and_then(Value::as_str);
        let document = value.get(input_key).cloned().unwrap_or(Value::Null);
        let key = value.get("idempotencyKey").and_then(Value::as_str);
        let rows = self.rows(statement, &[&id, &name, &document, &key, &actor]).await?;
        let row = rows.first().ok_or_else(|| Error::invalid("delivery returned no row"))?;
        let status: String = column(row, "status")?;
        if status == "not_found" {
            return Err(RpcError::not_found("Task not found").into());
        }
        let mut result = Map::new();
        result.insert("status".into(), status.into());
        result.insert("taskId".into(), value.get("id").cloned().unwrap_or_default());
        result.insert("name".into(), name.into());
        result
            .insert(value_key.into(), column::<Option<Value>>(row, value_key)?.unwrap_or_default());
        result.insert(at_key.into(), optional_timestamp(column(row, at)?));
        result.insert(by_key.into(), column::<Option<String>>(row, by)?.into());
        Ok(result.into())
    }

    async fn redrive_task(&self, input: Value, actor: &str) -> Procedure {
        let value = document(input);
        let result = self.admin.redrive(task_id(&value)?, &audit(&value, actor)).await?;
        if result.status == RedriveStatus::NotFound {
            return Err(RpcError::not_found("Task not found").into());
        }
        Ok(redrive_result(&result))
    }

    async fn redrive_dead_letters(&self, input: Value, actor: &str) -> Procedure {
        let value = document(input);
        let string = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
        // The listing sends tags exactly as an operator selected them, so unlike a policy
        // setting name they cross the boundary unchanged.
        let tags = match value.get("tags") {
            Some(Value::Array(items)) => {
                items.iter().filter_map(Value::as_str).map(str::to_owned).collect()
            }
            _ => Vec::new(),
        };
        let filter = DeadLetterFilter {
            queue: string("queue"),
            task_type: string("taskType"),
            tags,
            ..Default::default()
        };
        let limit =
            value.get("limit").and_then(Value::as_u64).and_then(|limit| u32::try_from(limit).ok());
        let mut options = BulkRedriveOptions { limit: limit.unwrap_or(100), ..Default::default() };
        if let Some(Value::Object(cursor)) = value.get("cursor") {
            let finished_at = cursor
                .get("finishedAt")
                .and_then(Value::as_str)
                .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
                .ok_or_else(|| RpcError::bad_request("Redrive cursor is not a timestamp"))?;
            let task_id = cursor
                .get("taskId")
                .and_then(Value::as_str)
                .and_then(|value| Uuid::parse_str(value).ok())
                .ok_or_else(|| Error::invalid("redrive cursor taskId is not a UUID"))?;
            options.cursor =
                Some(DeadLetterCursor { finished_at: finished_at.with_timezone(&Utc), task_id });
        }
        let page = self.admin.redrive_many(filter, &audit(&value, actor), options).await?;
        let results: Vec<Value> = page.results.iter().map(redrive_result).collect();
        // PostgreSQL returns this cursor as exact microsecond text, and every backend hands back
        // the same characters: a cursor rounded to the millisecond would point just before the
        // page it already redrove, and the next page would redrive that row a second time.
        let next_cursor = page.next_cursor.map(|cursor| {
            json!({
                "finishedAt": cursor.finished_at.format("%Y-%m-%dT%H:%M:%S%.6fZ").to_string(),
                "taskId": cursor.task_id,
            })
        });
        Ok(json!({ "results": results, "nextCursor": next_cursor }))
    }
}

#[derive(Clone, Copy)]
enum Delivery {
    Signal,
    HumanWait,
}

fn found(result: Result<Option<Value>, ProcedureError>, message: &str) -> Procedure {
    match result? {
        None | Some(Value::Null) => Err(RpcError::not_found(message).into()),
        Some(value) => Ok(value),
    }
}

fn document(input: Value) -> Map<String, Value> {
    match input {
        Value::Object(value) => value,
        _ => Map::new(),
    }
}

fn object(value: &Map<String, Value>, key: &str) -> Map<String, Value> {
    match value.get(key) {
        Some(Value::Object(item)) => item.clone(),
        _ => Map::new(),
    }
}

/// A string field, or the text of any other value, as Go's `fmt.Sprint` reads it.
fn text(value: &Map<String, Value>, key: &str) -> String {
    match value.get(key) {
        Some(Value::String(item)) => item.clone(),
        Some(item) => item.to_string(),
        None => String::new(),
    }
}

fn task_id(value: &Map<String, Value>) -> Result<Uuid, Error> {
    Uuid::parse_str(&text(value, "id")).map_err(|_| Error::invalid("task id is not a UUID"))
}

fn integer(value: i64, name: &str) -> Result<i32, Error> {
    i32::try_from(value).map_err(|_| Error::invalid(format!("{name} is out of range")))
}

fn audit(value: &Map<String, Value>, actor: &str) -> AdminAudit {
    let audit = object(value, "audit");
    let field = |key: &str| audit.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
    AdminAudit { actor: actor.to_owned(), reason: field("reason"), request_id: field("requestId") }
}

fn column<'a, T: tokio_postgres::types::FromSql<'a>>(row: &'a Row, name: &str) -> Result<T, Error> {
    Ok(row.try_get(name)?)
}

/// Converts a camelCase setting name to the snake_case column PostgreSQL stores it under.
fn snake(value: &str) -> String {
    let mut result = String::with_capacity(value.len() + 4);
    for character in value.chars() {
        if character.is_ascii_uppercase() {
            result.push('_');
            result.push(character.to_ascii_lowercase());
        } else {
            result.push(character);
        }
    }
    result
}

fn redrive_result(result: &RedriveResult) -> Value {
    json!({
        "status": result.status.as_str(),
        "sourceTaskId": result.source_task_id,
        "targetTaskId": result.target_task_id,
        "sourceState": result.source_state.map(|state| state.as_str()),
        "targetState": result.target_state.map(|state| state.as_str()),
        "requestedAt": optional_timestamp(result.requested_at),
    })
}

/// One instant serializes to one string in every language: UTC with exactly three fractional
/// digits, as JavaScript's `Date.toISOString()` writes it.
fn timestamp(value: DateTime<Utc>) -> String {
    value.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

fn optional_timestamp(value: Option<DateTime<Utc>>) -> Value {
    value.map_or(Value::Null, |value| timestamp(value).into())
}

/// Rewrites every RFC 3339 string in a projection to the dashboard's one timestamp layout.
fn normalize(value: Value) -> Value {
    match value {
        Value::Object(items) => {
            items.into_iter().map(|(key, item)| (key, normalize(item))).collect()
        }
        Value::Array(items) => items.into_iter().map(normalize).collect(),
        Value::String(item) if item.contains('T') => match DateTime::parse_from_rfc3339(&item) {
            Ok(moment) => timestamp(moment.with_timezone(&Utc)).into(),
            Err(_) => item.into(),
        },
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_nested_timestamps_to_milliseconds() {
        let value = json!({ "at": ["2026-01-02T03:04:05.123456+02:00", "2026-01-02T03:04:05Z", "Tuesday"] });
        assert_eq!(
            normalize(value),
            json!({ "at": ["2026-01-02T01:04:05.123Z", "2026-01-02T03:04:05.000Z", "Tuesday"] })
        );
    }

    #[test]
    fn snake_cases_setting_names() {
        assert_eq!(snake("taskEventRetentionDays"), "task_event_retention_days");
    }
}
