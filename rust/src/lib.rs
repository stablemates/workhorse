//! Workhorse Rust client foundation.
//!
//! The client uses `tokio-postgres`: PostgreSQL owns transactions and queue state;
//! this crate only issues the versioned SQL protocol calls. Worker execution is a
//! separate concern and can consume these types without depending on this module's internals.
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use tokio::sync::OnceCell;
use tokio_postgres::{Client, NoTls, Transaction};
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
    compatibility: OnceCell<Result<Compatibility, Refusal>>,
}

/// An answered compatibility refusal. It is cached like a success, because the installed schema
/// does not change under a running process; a driver error is not cached and is retried.
#[derive(Clone, Copy, Debug)]
enum Refusal {
    Protocol { server: i32 },
    Schema(i32),
}

impl From<Refusal> for Error {
    fn from(refusal: Refusal) -> Self {
        match refusal {
            Refusal::Protocol { server } => {
                Error::IncompatibleProtocol { server, client: CLIENT_PROTOCOL_VERSION }
            }
            Refusal::Schema(version) => Error::IncompatibleSchema(version),
        }
    }
}

const ENQUEUE_MANY_SQL: &str = "SELECT ordinal, task_id, outcome, reason FROM workhorse.enqueue_many_v1($1::jsonb) ORDER BY ordinal";

impl Queue {
    pub async fn connect(connection: &str, queue: impl Into<String>) -> Result<Self, Error> {
        let (client, connection_task) = tokio_postgres::connect(connection, NoTls).await?;
        tokio::spawn(async move {
            let _ = connection_task.await;
        });
        Ok(Self::new(client, queue))
    }
    pub fn new(client: Client, queue: impl Into<String>) -> Self {
        Self { client, queue: queue.into(), compatibility: OnceCell::new() }
    }
    pub fn queue_name(&self) -> &str {
        &self.queue
    }

    /// Read the installed protocol and schema versions and refuse an incompatible pair.
    pub async fn check_compatibility(&self) -> Result<Compatibility, Error> {
        Ok(self.read_compatibility().await??)
    }

    async fn read_compatibility(&self) -> Result<Result<Compatibility, Refusal>, Error> {
        let row = self.client.query_one("SELECT max(version) FILTER (WHERE kind='protocol'), max(version) FILTER (WHERE kind='schema') FROM (SELECT 'protocol' kind, version FROM workhorse.protocol_version UNION ALL SELECT 'schema', version FROM workhorse.schema_version) v", &[]).await?;
        let protocol: i32 = row.try_get(0)?;
        let schema: i32 = row.try_get(1)?;
        if protocol != CLIENT_PROTOCOL_VERSION {
            return Ok(Err(Refusal::Protocol { server: protocol }));
        }
        if !(MIN_SCHEMA_VERSION..=MAX_SCHEMA_VERSION).contains(&schema) {
            return Ok(Err(Refusal::Schema(schema)));
        }
        Ok(Ok(Compatibility { protocol_version: protocol, schema_version: schema }))
    }

    /// Refuse an incompatible schema before the first mutation. The answer is cached per `Queue`.
    async fn ensure_compatible(&self) -> Result<(), Error> {
        let answer = self.compatibility.get_or_try_init(|| self.read_compatibility()).await?;
        answer.as_ref().map(|_| ()).map_err(|refusal| Error::from(*refusal))
    }

    /// Enqueue one task and return its id. A repeated idempotency key returns the first task's id.
    pub async fn enqueue(&self, request: EnqueueRequest) -> Result<Uuid, Error> {
        let results = self.enqueue_batch(std::slice::from_ref(&request)).await?;
        Ok(results[0].task_id)
    }
    pub async fn enqueue_batch(
        &self,
        requests: &[EnqueueRequest],
    ) -> Result<Vec<EnqueueResult>, Error> {
        let payload = self.wire_requests(requests)?;
        self.ensure_compatible().await?;
        let rows = self.client.query(ENQUEUE_MANY_SQL, &[&payload]).await?;
        enqueue_results(rows)
    }
    /// Enqueue inside a transaction the caller owns. The tasks commit or roll back with it; this
    /// method never commits, rolls back, or touches the `Queue`'s own connection state.
    pub async fn enqueue_transactional(
        &self,
        transaction: &Transaction<'_>,
        requests: &[EnqueueRequest],
    ) -> Result<Vec<EnqueueResult>, Error> {
        let payload = self.wire_requests(requests)?;
        self.ensure_compatible().await?;
        let rows = transaction.query(ENQUEUE_MANY_SQL, &[&payload]).await?;
        enqueue_results(rows)
    }

    /// Serialize requests to the camelCase JSON array `enqueue_many_v1` reads.
    fn wire_requests(&self, requests: &[EnqueueRequest]) -> Result<Value, Error> {
        if requests.len() > MAX_ENQUEUE_BATCH_SIZE {
            return Err(Error::InvalidRequest(format!("batch exceeds {MAX_ENQUEUE_BATCH_SIZE}")));
        }
        let values = requests
            .iter()
            .map(|request| {
                let queue = if request.queue.is_empty() { &self.queue } else { &request.queue };
                let mut value = serde_json::json!({
                    "queue": queue,
                    "type": request.task_type,
                    "payload": request.payload,
                    "priority": request.priority,
                    "tags": request.tags,
                });
                let fields = value.as_object_mut().expect("request object");
                if let Some(run_at) = request.run_at {
                    fields.insert("runAt".into(), serde_json::json!(run_at));
                }
                if let Some(key) = &request.idempotency_key {
                    fields.insert("idempotency".into(), serde_json::json!({ "key": key }));
                }
                // PostgreSQL treats a present contractVersion key as a claim, so omit it when unset.
                if let Some(version) = &request.contract_version {
                    fields.insert("contractVersion".into(), serde_json::json!(version));
                }
                if let Some(max_attempts) = request.max_attempts {
                    fields.insert("maxAttempts".into(), serde_json::json!(max_attempts));
                }
                if let Some(deadline) = request.deadline {
                    fields.insert("deadline".into(), serde_json::json!(deadline));
                }
                value
            })
            .collect();
        Ok(Value::Array(values))
    }
    pub async fn cancel(
        &self,
        task_id: Uuid,
        requested_by: &str,
        reason: Option<&str>,
    ) -> Result<CancelResult, Error> {
        self.ensure_compatible().await?;
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
        let v = serde_json::to_value(
            definitions.iter().map(|definition| &definition.definition).collect::<Vec<_>>(),
        )
        .map_err(|e| Error::InvalidRequest(e.to_string()))?;
        self.ensure_compatible().await?;
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
        self.ensure_compatible().await?;
        self.client
            .execute(
                "SELECT workhorse.sync_concurrency_policies_v1($1,$2::jsonb,true)",
                &[&name, &v],
            )
            .await?;
        Ok(())
    }
    pub async fn sync_contracts(&self, contracts: &[ContractDefinition]) -> Result<(), Error> {
        let v = contracts
            .iter()
            .map(|contract| {
                serde_json::json!({
                    "taskType": contract.task_type,
                    "currentVersion": contract.version,
                    "versions": { contract.version.clone(): contract.definition }
                })
            })
            .collect::<Vec<_>>();
        let v = serde_json::to_value(v).map_err(|e| Error::InvalidRequest(e.to_string()))?;
        self.ensure_compatible().await?;
        self.client
            .execute("SELECT workhorse.sync_contract_definitions_v1($1::jsonb)", &[&v])
            .await?;
        Ok(())
    }
}

/// Map `enqueue_many_v1` rows to results. A contract mismatch refuses the whole batch in one row.
fn enqueue_results(rows: Vec<tokio_postgres::Row>) -> Result<Vec<EnqueueResult>, Error> {
    rows.into_iter()
        .map(|row| {
            let outcome: String = row.try_get("outcome")?;
            let reason: Option<String> = row.try_get("reason")?;
            if outcome == "contract_mismatch" {
                return Err(Error::Enqueue(format!(
                    "contract mismatch: {}",
                    reason.unwrap_or_default()
                )));
            }
            Ok(EnqueueResult { task_id: row.try_get("task_id")?, outcome, reason })
        })
        .collect()
}

/// Durable handler context primitives. PostgreSQL-backed operations live in `durable_postgres`.
pub mod durable_context;
pub mod durable_postgres;
