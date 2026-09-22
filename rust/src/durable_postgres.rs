//! PostgreSQL-backed durable handler context.
//!
//! The worker owns the lease identity and passes it to every SQL operation. PostgreSQL is the
//! authority for replay, idempotency, waits, child joins, and latest progress. This module is the
//! adapter behind the worker settlement seam; it does not claim tasks or own worker lifecycle.

use serde_json::Value;
use tokio_postgres::{Client, Error as PostgresError};
use uuid::Uuid;

#[derive(Debug)]
pub enum DurableError {
    Postgres(PostgresError),
    MissingRow(&'static str),
    Rejected { operation: &'static str, status: String },
    InvalidValue(String),
}
impl From<PostgresError> for DurableError {
    fn from(error: PostgresError) -> Self {
        Self::Postgres(error)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct StoredProgress {
    pub value: Value,
    pub revision: i64,
}
#[derive(Clone, Debug, PartialEq)]
pub struct StoredWait {
    pub name: String,
    pub mode: String,
    pub payload: Option<Value>,
}
#[derive(Clone, Debug, PartialEq)]
pub enum WaitState {
    Waiting,
    Delivered(Value),
    Completed(Value),
    Elapsed,
}

/// The narrow persistence seam used by a handler activation. The worker supplies task identity,
/// fence, and client; every mutation is fenced by `worker_id` and `fence` in PostgreSQL.
pub struct PostgresDurableContext {
    client: Client,
    task_id: Uuid,
    worker_id: String,
    fence: i64,
}
impl PostgresDurableContext {
    pub fn new(client: Client, task_id: Uuid, worker_id: impl Into<String>, fence: i64) -> Self {
        Self { client, task_id, worker_id: worker_id.into(), fence }
    }
    pub fn task_id(&self) -> Uuid {
        self.task_id
    }

    pub async fn checkpoint(&self, name: &str) -> Result<Option<Value>, DurableError> {
        let row = self.client.query_opt(
            "SELECT checkpoint_value FROM workhorse.task_checkpoint WHERE task_id=$1 AND checkpoint_name=$2",
            &[&self.task_id, &name],
        ).await?;
        Ok(row.map(|r| r.get("checkpoint_value")))
    }
    pub async fn save_checkpoint(&self, name: &str, value: &Value) -> Result<Value, DurableError> {
        let row = self.client.query_one(
            "SELECT status, checkpoint_value FROM workhorse.save_checkpoint_v1($1,$2,$3,$4,$5::jsonb)",
            &[&self.task_id, &self.worker_id, &self.fence, &name, value],
        ).await?;
        let status: String = row.get("status");
        if status != "saved" && status != "existing" {
            return Err(DurableError::Rejected { operation: "checkpoint", status });
        }
        Ok(row.get("checkpoint_value"))
    }
    pub async fn replay_or_save<F, Fut>(
        &self,
        name: &str,
        producer: F,
    ) -> Result<Value, DurableError>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<Value, DurableError>>,
    {
        if let Some(value) = self.checkpoint(name).await? {
            return Ok(value);
        }
        self.save_checkpoint(name, &producer().await?).await
    }

    pub async fn schedule_timer(
        &self,
        name: &str,
        duration_ms: i64,
    ) -> Result<WaitState, DurableError> {
        let row = self
            .client
            .query_one(
                "SELECT status FROM workhorse.schedule_wait_v1($1,$2,$3,$4,$5,NULL)",
                &[&self.task_id, &self.worker_id, &self.fence, &name, &duration_ms],
            )
            .await?;
        match row.get::<_, String>("status").as_str() {
            "scheduled" => Ok(WaitState::Waiting),
            "elapsed" => Ok(WaitState::Elapsed),
            status => Err(DurableError::Rejected { operation: "timer", status: status.into() }),
        }
    }
    pub async fn wait_for_signal(
        &self,
        name: &str,
        timeout_ms: i64,
    ) -> Result<WaitState, DurableError> {
        let row = self
            .client
            .query_one(
                "SELECT status,payload FROM workhorse.wait_for_signal_v1($1,$2,$3,$4,$5)",
                &[&self.task_id, &self.worker_id, &self.fence, &name, &timeout_ms],
            )
            .await?;
        let status: String = row.get("status");
        match status.as_str() {
            "waiting" => Ok(WaitState::Waiting),
            "delivered" => Ok(WaitState::Delivered(row.get("payload"))),
            _ => Err(DurableError::Rejected { operation: "signal", status }),
        }
    }
    pub async fn wait_for_human(
        &self,
        name: &str,
        context: &Value,
        timeout_ms: i64,
    ) -> Result<WaitState, DurableError> {
        let row = self
            .client
            .query_one(
                "SELECT status,result FROM workhorse.wait_for_human_v1($1,$2,$3,$4,$5::jsonb,$6)",
                &[&self.task_id, &self.worker_id, &self.fence, &name, context, &timeout_ms],
            )
            .await?;
        let status: String = row.get("status");
        match status.as_str() {
            "waiting" => Ok(WaitState::Waiting),
            "completed" => Ok(WaitState::Completed(row.get("result"))),
            _ => Err(DurableError::Rejected { operation: "human_wait", status }),
        }
    }
    pub async fn progress(&self) -> Result<Option<StoredProgress>, DurableError> {
        let row = self.client.query_opt("SELECT progress_value,revision::bigint FROM workhorse.task_progress WHERE task_id=$1", &[&self.task_id]).await?;
        Ok(row.map(|r| StoredProgress {
            value: r.get("progress_value"),
            revision: r.get("revision"),
        }))
    }
    pub async fn publish_progress(&self, value: &Value) -> Result<StoredProgress, DurableError> {
        let row = self.client.query_one(
            "SELECT status,progress_value,revision::bigint FROM workhorse.update_progress_v1($1,$2,$3,$4::jsonb)",
            &[&self.task_id, &self.worker_id, &self.fence, value],
        ).await?;
        let status: String = row.get("status");
        if status != "updated" && status != "unchanged" {
            return Err(DurableError::Rejected { operation: "progress", status });
        }
        Ok(StoredProgress { value: row.get("progress_value"), revision: row.get("revision") })
    }
    pub async fn fan_out(
        &self,
        children: &Value,
        mode: &str,
    ) -> Result<Option<Value>, DurableError> {
        let row = self
            .client
            .query_one(
                "SELECT status,results FROM workhorse.create_children_v1($1,$2,$3,$4::jsonb,$5)",
                &[&self.task_id, &self.worker_id, &self.fence, children, &mode],
            )
            .await?;
        let status: String = row.get("status");
        match status.as_str() {
            "created" => Ok(None),
            "completed" => Ok(row.get("results")),
            _ => Err(DurableError::Rejected { operation: "children", status }),
        }
    }
}
