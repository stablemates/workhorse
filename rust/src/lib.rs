//! Workhorse Rust client foundation.
//!
//! The client uses `tokio-postgres`: PostgreSQL owns transactions and queue state;
//! this crate only issues the versioned SQL protocol calls. Worker execution is a
//! separate concern and can consume these types without depending on this module's internals.
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use tokio_postgres::{Client, NoTls};
use uuid::Uuid;

pub const CLIENT_PROTOCOL_VERSION: i32 = 4;
pub const MIN_SCHEMA_VERSION: i32 = 18;
pub const MAX_SCHEMA_VERSION: i32 = 23;
pub const MAX_ENQUEUE_BATCH_SIZE: usize = 1000;

#[derive(Debug, Error)]
pub enum Error {
    #[error("postgres: {0}")]
    Postgres(#[from] tokio_postgres::Error),
    #[error("invalid request: {0}")]
    InvalidRequest(String),
    #[error("incompatible protocol (server {server}, client {client})")]
    IncompatibleProtocol { server: i32, client: i32 },
    #[error("incompatible schema version {0}")]
    IncompatibleSchema(i32),
    #[error("enqueue failed: {0}")]
    Enqueue(String),
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct EnqueueRequest {
    pub queue: String,
    #[serde(rename = "type")]
    pub task_type: String,
    pub payload: Value,
    #[serde(default)]
    pub run_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub priority: i32,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub idempotency_key: Option<String>,
    #[serde(default)]
    pub contract_version: Option<String>,
    #[serde(default)]
    pub max_attempts: Option<i32>,
    #[serde(default)]
    pub deadline: Option<DateTime<Utc>>,
}
impl EnqueueRequest {
    pub fn new(queue: impl Into<String>, task_type: impl Into<String>, payload: Value) -> Self {
        Self {
            queue: queue.into(),
            task_type: task_type.into(),
            payload,
            run_at: None,
            priority: 0,
            tags: vec![],
            idempotency_key: None,
            contract_version: None,
            max_attempts: None,
            deadline: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct EnqueueResult {
    pub task_id: Uuid,
    pub outcome: String,
    pub reason: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct CancelResult {
    pub task_id: Uuid,
    pub status: String,
    pub state: String,
    pub reason: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Compatibility {
    pub protocol_version: i32,
    pub schema_version: i32,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ScheduleDefinition {
    pub namespace: String,
    pub name: String,
    pub definition: Value,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Policy {
    pub name: String,
    pub definition: Value,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ContractDefinition {
    pub task_type: String,
    pub version: String,
    pub definition: Value,
}

pub struct Queue {
    client: Client,
    queue: String,
}

impl Queue {
    pub async fn connect(connection: &str, queue: impl Into<String>) -> Result<Self, Error> {
        let (client, connection_task) = tokio_postgres::connect(connection, NoTls).await?;
        tokio::spawn(async move {
            let _ = connection_task.await;
        });
        Ok(Self { client, queue: queue.into() })
    }
    pub fn new(client: Client, queue: impl Into<String>) -> Self {
        Self { client, queue: queue.into() }
    }
    pub fn queue_name(&self) -> &str {
        &self.queue
    }

    pub async fn check_compatibility(&self) -> Result<Compatibility, Error> {
        let row = self.client.query_one("SELECT max(version) FILTER (WHERE kind='protocol'), max(version) FILTER (WHERE kind='schema') FROM (SELECT 'protocol' kind, version FROM workhorse.protocol_version UNION ALL SELECT 'schema', version FROM workhorse.schema_version) v", &[]).await?;
        let protocol: i32 = row.try_get(0)?;
        let schema: i32 = row.try_get(1)?;
        if protocol != CLIENT_PROTOCOL_VERSION {
            return Err(Error::IncompatibleProtocol {
                server: protocol,
                client: CLIENT_PROTOCOL_VERSION,
            });
        }
        if !(MIN_SCHEMA_VERSION..=MAX_SCHEMA_VERSION).contains(&schema) {
            return Err(Error::IncompatibleSchema(schema));
        }
        Ok(Compatibility { protocol_version: protocol, schema_version: schema })
    }

    pub async fn enqueue(&self, mut request: EnqueueRequest) -> Result<Uuid, Error> {
        if request.queue.is_empty() {
            request.queue = self.queue.clone();
        }
        let row = self.client.query_one("SELECT workhorse.enqueue_v1($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,$11,$12) AS task_id", &[&request.queue, &request.task_type, &request.payload, &request.run_at, &request.priority, &request.tags, &request.idempotency_key, &request.contract_version, &"rust-client", &request.max_attempts.unwrap_or(1), &1048576i32, &Vec::<String>::new()]).await?;
        Ok(row.try_get("task_id")?)
    }
    pub async fn enqueue_batch(
        &self,
        requests: &[EnqueueRequest],
    ) -> Result<Vec<EnqueueResult>, Error> {
        if requests.len() > MAX_ENQUEUE_BATCH_SIZE {
            return Err(Error::InvalidRequest(format!("batch exceeds {MAX_ENQUEUE_BATCH_SIZE}")));
        }
        let payload =
            serde_json::to_value(requests).map_err(|e| Error::InvalidRequest(e.to_string()))?;
        let rows = self.client.query("SELECT ordinal, task_id, outcome, reason FROM workhorse.enqueue_many_v1($1::jsonb) ORDER BY ordinal", &[&payload]).await?;
        rows.into_iter()
            .map(|r| {
                Ok(EnqueueResult {
                    task_id: r.try_get("task_id")?,
                    outcome: r.try_get("outcome")?,
                    reason: r.try_get("reason")?,
                })
            })
            .collect()
    }
    pub async fn enqueue_transactional(
        &self,
        requests: &[EnqueueRequest],
    ) -> Result<Vec<EnqueueResult>, Error> {
        self.client.batch_execute("BEGIN").await?;
        let payload =
            serde_json::to_value(requests).map_err(|e| Error::InvalidRequest(e.to_string()))?;
        let rows = self.client.query("SELECT ordinal, task_id, outcome, reason FROM workhorse.enqueue_many_v1($1::jsonb) ORDER BY ordinal", &[&payload]).await?;
        let out = rows
            .into_iter()
            .map(|r| {
                Ok(EnqueueResult {
                    task_id: r.try_get("task_id")?,
                    outcome: r.try_get("outcome")?,
                    reason: r.try_get("reason")?,
                })
            })
            .collect::<Result<Vec<_>, Error>>()?;
        self.client.batch_execute("COMMIT").await?;
        Ok(out)
    }
    pub async fn cancel(
        &self,
        task_id: Uuid,
        requested_by: &str,
        reason: Option<&str>,
    ) -> Result<CancelResult, Error> {
        let row = self
            .client
            .query_one(
                "SELECT status,state,reason FROM workhorse.cancel_v1($1,$2,$3)",
                &[&task_id, &requested_by, &reason],
            )
            .await?;
        Ok(CancelResult {
            task_id,
            status: row.try_get("status")?,
            state: row.try_get("state")?,
            reason: row.try_get("reason")?,
        })
    }
    pub async fn sync_schedule(
        &self,
        namespace: &str,
        definitions: &[ScheduleDefinition],
        replace: bool,
    ) -> Result<(), Error> {
        let v =
            serde_json::to_value(definitions).map_err(|e| Error::InvalidRequest(e.to_string()))?;
        self.client
            .execute(
                "SELECT workhorse.sync_schedule_definitions_v2($1,$2::jsonb,$3)",
                &[&namespace, &v, &replace],
            )
            .await?;
        Ok(())
    }
    pub async fn sync_policy(&self, name: &str, policy: &Policy) -> Result<(), Error> {
        let v = serde_json::to_value(&policy.definition)
            .map_err(|e| Error::InvalidRequest(e.to_string()))?;
        self.client
            .execute(
                "SELECT workhorse.sync_concurrency_policies_v1($1,$2::jsonb,true)",
                &[&name, &v],
            )
            .await?;
        Ok(())
    }
    pub async fn sync_contracts(&self, contracts: &[ContractDefinition]) -> Result<(), Error> {
        let v =
            serde_json::to_value(contracts).map_err(|e| Error::InvalidRequest(e.to_string()))?;
        self.client
            .execute("SELECT workhorse.sync_contract_definitions_v1($1::jsonb)", &[&v])
            .await?;
        Ok(())
    }
}
