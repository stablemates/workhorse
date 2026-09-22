//! Workhorse Rust client foundation.
//!
//! The client uses `tokio-postgres`: PostgreSQL owns transactions and queue state;
//! this crate only issues the versioned SQL protocol calls. Worker execution is a
//! separate concern and can consume these types without depending on this module's internals.
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use tokio_postgres::{error::DbError, Client, GenericClient, NoTls, Transaction};
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
    #[error("contract validation failed for {task_type} {version}: {message}")]
    ContractValidation {
        task_type: String,
        version: String,
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DatabaseError {
    pub code: String,
    pub message: String,
    pub detail: Option<String>,
    pub hint: Option<String>,
}
impl From<&DbError> for DatabaseError {
    fn from(error: &DbError) -> Self {
        Self {
            code: error.code().code().to_owned(),
            message: error.message().to_owned(),
            detail: error.detail().map(str::to_owned),
            hint: error.hint().map(str::to_owned),
        }
    }
}
impl Error {
    pub fn database_error(&self) -> Option<DatabaseError> {
        match self {
            Self::Postgres(error) => error.as_db_error().map(DatabaseError::from),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub concurrency_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotency: Option<Idempotency>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contract_version: Option<String>,
    #[serde(default = "default_max_attempts")]
    pub max_attempts: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_policy: Option<Value>,
    #[serde(default)]
    pub deadline: Option<DateTime<Utc>>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Idempotency {
    pub scope: String,
    pub key: String,
    pub ttl_ms: i64,
}
fn default_max_attempts() -> i32 {
    25
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
            concurrency_key: None,
            budget: None,
            idempotency: None,
            contract_version: None,
            max_attempts: default_max_attempts(),
            retry_policy: None,
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
    contracts: Vec<ContractDefinition>,
}

/// Execute a batch using a transaction owned by the caller. This function never commits or rolls back.
pub async fn enqueue_in_transaction(
    transaction: &Transaction<'_>,
    requests: &[EnqueueRequest],
) -> Result<Vec<EnqueueResult>, Error> {
    enqueue_batch_with(transaction, requests).await
}

async fn enqueue_batch_with<C: GenericClient>(
    client: &C,
    requests: &[EnqueueRequest],
) -> Result<Vec<EnqueueResult>, Error> {
    if requests.len() > MAX_ENQUEUE_BATCH_SIZE {
        return Err(Error::InvalidRequest(format!(
            "batch exceeds {MAX_ENQUEUE_BATCH_SIZE}"
        )));
    }
    let payload =
        serde_json::to_value(requests).map_err(|error| Error::InvalidRequest(error.to_string()))?;
    let rows = client
        .query(
            "SELECT ordinal, task_id, outcome, reason FROM workhorse.enqueue_many_v1($1::jsonb) ORDER BY ordinal",
            &[&payload],
        )
        .await?;
    rows.into_iter()
        .map(|row| {
            Ok(EnqueueResult {
                task_id: row.try_get("task_id")?,
                outcome: row.try_get("outcome")?,
                reason: row.try_get("reason")?,
            })
        })
        .collect()
}

impl Queue {
    pub async fn connect(connection: &str, queue: impl Into<String>) -> Result<Self, Error> {
        let (client, connection_task) = tokio_postgres::connect(connection, NoTls).await?;
        tokio::spawn(async move {
            let _ = connection_task.await;
        });
        Ok(Self {
            client,
            queue: queue.into(),
            contracts: Vec::new(),
        })
    }
    pub fn new(client: Client, queue: impl Into<String>) -> Self {
        Self {
            client,
            queue: queue.into(),
            contracts: Vec::new(),
        }
    }
    pub fn queue_name(&self) -> &str {
        &self.queue
    }
    pub fn with_contracts(mut self, contracts: Vec<ContractDefinition>) -> Self {
        self.contracts = contracts;
        self
    }

    pub async fn check_compatibility(&self) -> Result<Compatibility, Error> {
        let rows = self.client.query("SELECT kind, version FROM (SELECT 'protocol' AS kind, version FROM workhorse.protocol_version UNION ALL SELECT 'schema', version FROM workhorse.schema_version) versions ORDER BY kind, version", &[]).await?;
        let mut protocol_versions = Vec::new();
        let mut schema = None;
        for row in rows {
            let kind: &str = row.try_get("kind")?;
            let version: i32 = row.try_get("version")?;
            if kind == "protocol" {
                protocol_versions.push(version);
            } else {
                schema = Some(version);
            }
        }
        let protocol = *protocol_versions
            .iter()
            .max()
            .ok_or(Error::IncompatibleProtocol {
                server: 0,
                client: CLIENT_PROTOCOL_VERSION,
            })?;
        if !schema
            .map(|value| (MIN_SCHEMA_VERSION..=MAX_SCHEMA_VERSION).contains(&value))
            .unwrap_or(false)
        {
            return Err(Error::IncompatibleSchema(schema.unwrap_or(0)));
        }
        if !protocol_versions.is_empty() && !protocol_versions.contains(&CLIENT_PROTOCOL_VERSION) {
            return Err(Error::IncompatibleProtocol {
                server: protocol,
                client: CLIENT_PROTOCOL_VERSION,
            });
        }
        Ok(Compatibility {
            protocol_version: protocol,
            schema_version: schema.unwrap_or(0),
        })
    }

    pub async fn enqueue(&self, mut request: EnqueueRequest) -> Result<Uuid, Error> {
        if request.queue.is_empty() {
            request.queue = self.queue.clone();
        }
        let result = enqueue_batch_with(&self.client, &[request]).await?;
        result
            .into_iter()
            .next()
            .map(|item| item.task_id)
            .ok_or_else(|| Error::InvalidRequest("enqueue returned no result".into()))
    }
    pub async fn enqueue_batch(
        &self,
        requests: &[EnqueueRequest],
    ) -> Result<Vec<EnqueueResult>, Error> {
        for request in requests {
            self.validate_contract(request)?;
        }
        enqueue_batch_with(&self.client, requests).await
    }
    pub async fn enqueue_transactional(
        &self,
        transaction: &Transaction<'_>,
        requests: &[EnqueueRequest],
    ) -> Result<Vec<EnqueueResult>, Error> {
        enqueue_batch_with(transaction, requests).await
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
                &[&name, &v, &true],
            )
            .await?;
        Ok(())
    }
    fn validate_contract(&self, request: &EnqueueRequest) -> Result<(), Error> {
        let Some(version) = request.contract_version.as_deref() else {
            return Ok(());
        };
        let Some(contract) = self.contracts.iter().find(|contract| {
            contract.task_type == request.task_type && contract.version == version
        }) else {
            return Ok(());
        };
        Self::validate_json_schema(&contract.definition, &request.payload).map_err(|message| {
            Error::ContractValidation {
                task_type: request.task_type.clone(),
                version: version.to_owned(),
                message,
            }
        })
    }

    pub async fn sync_contracts(&self, contracts: &[ContractDefinition]) -> Result<(), Error> {
        let v =
            serde_json::to_value(contracts).map_err(|e| Error::InvalidRequest(e.to_string()))?;
        self.client
            .execute(
                "SELECT workhorse.sync_contract_definitions_v1($1::jsonb)",
                &[&v],
            )
            .await?;
        Ok(())
    }

    fn validate_json_schema(schema: &Value, value: &Value) -> Result<(), String> {
        let schema = schema.as_object().ok_or("schema must be an object")?;
        if let Some(kind) = schema.get("type").and_then(Value::as_str) {
            let valid = match kind {
                "object" => value.is_object(),
                "array" => value.is_array(),
                "string" => value.is_string(),
                "integer" => value.as_i64().is_some() || value.as_u64().is_some(),
                "number" => value.is_number(),
                "boolean" => value.is_boolean(),
                "null" => value.is_null(),
                _ => true,
            };
            if !valid {
                return Err(format!("expected {kind}"));
            }
        }
        if let Some(required) = schema.get("required").and_then(Value::as_array) {
            let object = value.as_object().ok_or("expected object")?;
            for field in required.iter().filter_map(Value::as_str) {
                if !object.contains_key(field) {
                    return Err(format!("missing required property {field}"));
                }
            }
        }
        if let Some(properties) = schema.get("properties").and_then(Value::as_object) {
            let object = value.as_object().ok_or("expected object")?;
            for (name, child_schema) in properties {
                if let Some(child) = object.get(name) {
                    Self::validate_json_schema(child_schema, child)?;
                }
            }
            if schema.get("additionalProperties").and_then(Value::as_bool) == Some(false) {
                if let Some(extra) = object.keys().find(|name| !properties.contains_key(*name)) {
                    return Err(format!("additional property {extra}"));
                }
            }
        }
        Ok(())
    }
}
