//! Shared enqueue preparation over a caller-owned, mutable transport.
use std::collections::BTreeMap;
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard};

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{json, Map, Value};
use tokio::sync::OnceCell;
use tokio_postgres::types::ToSql;
use uuid::Uuid;

use crate::compatibility::{check_compatibility, CompatibilityCode, CompatibilityState};
use crate::contracts::{
    compile_contract_schema, serialize_contracts, ContractCache, PayloadContract, TaskTypeContracts,
};
use crate::queue::{
    default_scope, non_empty, stamp_contract, task_input, timestamp, trace_context,
    validate_options, Executor,
};
use crate::sql_catalogue_generated as sql;
use crate::{
    EnqueueNonReplaceableReason, EnqueueOptions, EnqueueOutcome, EnqueueRequest, EnqueueResult,
    Error,
};

/// A protocol bind. SQL types are explicit even when the value is null.
#[derive(Clone, Copy, Debug)]
pub enum EnqueueBind<'a> {
    Json(&'a Value),
    Text(Option<&'a str>),
}

/// The PostgreSQL types an enqueue transport must decode without coercion.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EnqueueColumnType {
    Int,
    Text,
    TextArray,
    Json,
    Uuid,
}

/// One required named result column. Null is permitted only when declared here.
#[derive(Clone, Copy, Debug)]
pub struct EnqueueColumn {
    pub name: &'static str,
    pub kind: EnqueueColumnType,
    pub nullable: bool,
}

/// A decoded PostgreSQL value. Missing columns and SQL null are distinct.
#[derive(Clone, Debug, PartialEq)]
pub enum EnqueueValue {
    Null,
    Int(i32),
    Text(String),
    TextArray(Vec<String>),
    Json(Value),
    Uuid(Uuid),
}

/// Driver-neutral values keyed by PostgreSQL column name.
pub type EnqueueRow = BTreeMap<String, EnqueueValue>;

/// A core-prepared query. Adapters execute its SQL and binds, not their own protocol copy.
#[derive(Debug)]
pub struct EnqueueQuery<'a> {
    statement: &'static str,
    binds: Vec<EnqueueBind<'a>>,
    columns: &'static [EnqueueColumn],
}

impl<'a> EnqueueQuery<'a> {
    pub fn statement(&self) -> &'static str {
        self.statement
    }

    pub fn binds(&self) -> &[EnqueueBind<'a>] {
        &self.binds
    }

    pub fn columns(&self) -> &'static [EnqueueColumn] {
        self.columns
    }
}

/// Executes only shared enqueue queries on the exact borrowed connection or transaction.
///
/// Implementations preserve bind/result types and structured SQLSTATE/DETAIL via
/// [Error::database]. They must not acquire another connection, begin, commit, roll back,
/// close the caller's connection, or spawn a detached query. Dropping the returned future
/// must release its Rust borrow; database cancellation remains driver/caller-specific.
/// A mutable borrow supports transaction drivers without requiring Sync or a static lifetime.
///
/// An in-flight operation cannot coexist with another mutable use of its transport:
///
/// ```compile_fail
/// use workhorse::{EnqueueClient, EnqueueTransport};
/// async fn overlapping<T: EnqueueTransport>(client: &EnqueueClient, transport: &mut T) {
///     let first = client.assert_compatible(transport);
///     let second = client.assert_compatible(transport);
///     first.await.unwrap();
///     second.await.unwrap();
/// }
/// ```
pub trait EnqueueTransport: Send {
    fn query(
        &mut self,
        query: EnqueueQuery<'_>,
    ) -> impl Future<Output = Result<Vec<EnqueueRow>, Error>> + Send;
}

/// The single owner of enqueue validation, preparation, compatibility and contract caches.
///
/// Reuse it only for one logical database/schema. A transport is borrowed for each operation;
/// the client never owns a connection or a transaction lifecycle. Workers still use deadpool.
pub struct EnqueueClient {
    default_queue: String,
    compatibility: OnceCell<Result<(), CompatibilityCode>>,
    contracts: Mutex<ContractCache>,
}

impl EnqueueClient {
    pub fn new(default_queue: impl Into<String>) -> Self {
        Self {
            default_queue: default_queue.into(),
            compatibility: OnceCell::new(),
            contracts: Mutex::default(),
        }
    }

    pub fn default_queue(&self) -> &str {
        &self.default_queue
    }

    /// Checks once; refusals are cached but transport failures are retryable.
    pub async fn assert_compatible<T: EnqueueTransport>(
        &self,
        transport: &mut T,
    ) -> Result<(), Error> {
        let outcome = self
            .compatibility
            .get_or_try_init(|| async {
                let state = read_compatibility(transport).await?;
                Ok::<_, Error>(check_compatibility(
                    state.installed_schema_version,
                    sql::CLIENT_PROTOCOL_VERSION,
                    &state.served_protocol_versions,
                ))
            })
            .await?;
        outcome.map_err(|code| Error::Compatibility { code })
    }

    pub async fn enqueue<T: EnqueueTransport, P: Serialize + ?Sized>(
        &self,
        transport: &mut T,
        task_type: &str,
        payload: &P,
        options: EnqueueOptions,
    ) -> Result<EnqueueResult, Error> {
        let request = EnqueueRequest {
            task_type: task_type.into(),
            payload: serde_json::to_value(payload)?,
            options,
        };
        let mut results = self.enqueue_many(transport, vec![request]).await?;
        Ok(results.remove(0))
    }

    /// Enqueues one atomic batch and restores request order from validated ordinals.
    pub async fn enqueue_many<T: EnqueueTransport>(
        &self,
        transport: &mut T,
        requests: Vec<EnqueueRequest>,
    ) -> Result<Vec<EnqueueResult>, Error> {
        if requests.is_empty() {
            return Ok(Vec::new());
        }
        if requests.len() > sql::MAX_ENQUEUE_BATCH_SIZE {
            return Err(Error::invalid("enqueue batch exceeds the shared limit"));
        }
        for attempt in 0.. {
            let rows = self.enqueue_attempt(transport, &requests).await?;
            let Some(task_types) = contract_mismatch(&rows)? else {
                return enqueue_results(&rows, requests.len());
            };
            if task_types
                .iter()
                .any(|task_type| !requests.iter().any(|request| &request.task_type == task_type))
            {
                return Err(invalid_result());
            }
            for task_type in task_types {
                let contract = load_contract(transport, &task_type).await?;
                self.contracts().definitions.insert(task_type, contract);
            }
            if attempt > 0 {
                break;
            }
        }
        Err(Error::ContractPolicyChanged)
    }

    async fn enqueue_attempt<T: EnqueueTransport>(
        &self,
        transport: &mut T,
        requests: &[EnqueueRequest],
    ) -> Result<Vec<EnqueueRow>, Error> {
        let now = Utc::now();
        let trace_context = trace_context();
        let mut inputs = requests
            .iter()
            .enumerate()
            .map(|(index, request)| {
                self.serialize_request(request, now, trace_context.as_ref()).map_err(|message| {
                    Error::invalid(format!("enqueue request {}: {message}", index + 1))
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        self.assert_compatible(transport).await?;
        for (input, request) in inputs.iter_mut().zip(requests) {
            self.apply_contract(transport, input, request).await?;
        }
        let document = Value::Array(inputs.into_iter().map(Value::Object).collect());
        query(
            transport,
            EnqueueQuery {
                statement: sql::ENQUEUE_MANY_V1,
                binds: vec![EnqueueBind::Json(&document)],
                columns: ENQUEUE_COLUMNS,
            },
        )
        .await
        .map_err(Error::translate_enqueue_error)
    }

    /// Stores contracts and enables payload validation for subsequent enqueues.
    pub async fn sync_contracts<T: EnqueueTransport>(
        &self,
        transport: &mut T,
        contracts: &BTreeMap<String, TaskTypeContracts>,
    ) -> Result<(), Error> {
        let document = serialize_contracts(contracts)?;
        self.assert_compatible(transport).await?;
        query(
            transport,
            EnqueueQuery {
                statement: sql::SYNC_CONTRACT_DEFINITIONS_V1,
                binds: vec![EnqueueBind::Json(&document)],
                columns: &[],
            },
        )
        .await?;
        let mut cache = self.contracts();
        cache.definitions.clear();
        cache.enabled = true;
        Ok(())
    }

    pub(crate) fn contracts(&self) -> MutexGuard<'_, ContractCache> {
        self.contracts.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn serialize_request(
        &self,
        request: &EnqueueRequest,
        now: DateTime<Utc>,
        trace_context: Option<&Value>,
    ) -> Result<Map<String, Value>, String> {
        let options = &request.options;
        validate_options(options)
            .map_err(|message| format!("invalid enqueue options: {message}"))?;
        let mut input = task_input(
            &self.default_queue,
            &request.task_type,
            &request.payload,
            options.queue.as_deref(),
            options.priority,
            options.concurrency_key.as_deref(),
            options.max_attempts,
            options.retry_policy.as_ref(),
        );
        let keyed = options.idempotency.is_some()
            || options.debounce.is_some()
            || options.throttle.is_some();
        if options.run_at.is_some() || !keyed {
            input.insert("runAt".into(), timestamp(options.run_at.unwrap_or(now)));
        }
        input.insert("deadline".into(), options.deadline.map_or(Value::Null, timestamp));
        input.insert("budget".into(), non_empty(options.budget.as_deref()));
        input.insert(
            "executionTimeoutMs".into(),
            options.execution_timeout_ms.filter(|value| *value != 0).into(),
        );
        input.insert("prerequisiteTaskId".into(), Value::Null);
        let dependencies = options.dependencies.as_ref().map(|dependencies| {
            let mut sorted = dependencies.clone();
            sorted.prerequisite_task_ids.sort();
            sorted
        });
        input.insert("dependencies".into(), json!(dependencies));
        input.insert("tags".into(), json!(options.tags));
        if let Some(idempotency) = &options.idempotency {
            let mut idempotency = idempotency.clone();
            idempotency.scope = default_scope(idempotency.scope);
            if idempotency.ttl_ms == 0 {
                idempotency.ttl_ms = 86_400_000;
            }
            input.insert("idempotency".into(), json!(idempotency));
        }
        if let Some(debounce) = &options.debounce {
            let mut debounce = debounce.clone();
            debounce.scope = default_scope(debounce.scope);
            input.insert("debounce".into(), json!(debounce));
        }
        if let Some(throttle) = &options.throttle {
            let mut throttle = throttle.clone();
            throttle.scope = default_scope(throttle.scope);
            input.insert("throttle".into(), json!(throttle));
        }
        if let Some(trace_context) = trace_context {
            input.insert("traceContext".into(), trace_context.clone());
        }
        Ok(input)
    }

    /// Validates a contracted payload and stamps the contract fields PostgreSQL enforces.
    async fn apply_contract<T: EnqueueTransport>(
        &self,
        transport: &mut T,
        input: &mut Map<String, Value>,
        request: &EnqueueRequest,
    ) -> Result<(), Error> {
        let task_type = &request.task_type;
        let (known, enabled) = {
            let cache = self.contracts();
            (cache.definitions.get(task_type).cloned(), cache.enabled)
        };
        let contract = match known {
            Some(contract) => contract,
            None if enabled => {
                let loaded = load_contract(transport, task_type).await?;
                self.contracts().definitions.insert(task_type.clone(), loaded.clone());
                loaded
            }
            None => None,
        };
        let Some(contract) = contract else {
            return Ok(());
        };
        if !contract.validator.is_valid(&request.payload) {
            return Err(Error::ContractValidation {
                task_type: task_type.clone(),
                version: contract.version.clone(),
            });
        }
        stamp_contract(input, &contract);
        Ok(())
    }
}

const COMPATIBILITY_COLUMNS: &[EnqueueColumn] = &[
    EnqueueColumn { name: "kind", kind: EnqueueColumnType::Text, nullable: false },
    EnqueueColumn { name: "version", kind: EnqueueColumnType::Int, nullable: false },
];
const ENQUEUE_COLUMNS: &[EnqueueColumn] = &[
    EnqueueColumn { name: "ordinal", kind: EnqueueColumnType::Int, nullable: false },
    EnqueueColumn { name: "task_id", kind: EnqueueColumnType::Uuid, nullable: true },
    EnqueueColumn { name: "outcome", kind: EnqueueColumnType::Text, nullable: false },
    EnqueueColumn { name: "reason", kind: EnqueueColumnType::Text, nullable: true },
];
const CONTRACT_COLUMNS: &[EnqueueColumn] = &[
    EnqueueColumn { name: "schema", kind: EnqueueColumnType::Json, nullable: false },
    EnqueueColumn { name: "version", kind: EnqueueColumnType::Text, nullable: false },
    EnqueueColumn { name: "payload_max_bytes", kind: EnqueueColumnType::Int, nullable: false },
    EnqueueColumn { name: "result_max_bytes", kind: EnqueueColumnType::Int, nullable: false },
    EnqueueColumn {
        name: "payload_redact_keys",
        kind: EnqueueColumnType::TextArray,
        nullable: false,
    },
    EnqueueColumn {
        name: "result_redact_keys",
        kind: EnqueueColumnType::TextArray,
        nullable: false,
    },
];

async fn query<T: EnqueueTransport>(
    transport: &mut T,
    query: EnqueueQuery<'_>,
) -> Result<Vec<EnqueueRow>, Error> {
    let columns = query.columns;
    let rows = transport.query(query).await?;
    for row in &rows {
        for column in columns {
            let valid = match row.get(column.name) {
                Some(EnqueueValue::Null) => column.nullable,
                Some(EnqueueValue::Int(_)) => column.kind == EnqueueColumnType::Int,
                Some(EnqueueValue::Text(_)) => column.kind == EnqueueColumnType::Text,
                Some(EnqueueValue::TextArray(_)) => column.kind == EnqueueColumnType::TextArray,
                Some(EnqueueValue::Json(_)) => column.kind == EnqueueColumnType::Json,
                Some(EnqueueValue::Uuid(_)) => column.kind == EnqueueColumnType::Uuid,
                None => false,
            };
            if !valid {
                return Err(invalid_result());
            }
        }
    }
    Ok(rows)
}

pub(crate) async fn read_compatibility<T: EnqueueTransport>(
    transport: &mut T,
) -> Result<CompatibilityState, Error> {
    let rows = match query(
        transport,
        EnqueueQuery {
            statement: sql::COMPATIBILITY_STATE,
            binds: vec![],
            columns: COMPATIBILITY_COLUMNS,
        },
    )
    .await
    {
        Ok(rows) => rows,
        Err(error) if matches!(error.sqlstate(), Some("42P01" | "3F000")) => {
            return Ok(CompatibilityState::default())
        }
        Err(error) => return Err(error),
    };
    let mut schema = Vec::new();
    let mut state = CompatibilityState::default();
    for row in rows {
        let version = integer(&row, "version")?;
        match text(&row, "kind")? {
            "schema" => schema.push(version),
            "protocol" => state.served_protocol_versions.push(version),
            _ => {}
        }
    }
    if let [version] = schema[..] {
        state.installed_schema_version = Some(version);
    }
    Ok(state)
}

pub(crate) async fn load_contract<T: EnqueueTransport>(
    transport: &mut T,
    task_type: &str,
) -> Result<Option<Arc<PayloadContract>>, Error> {
    load_contract_version(transport, task_type, None).await
}

pub(crate) async fn load_contract_version<T: EnqueueTransport>(
    transport: &mut T,
    task_type: &str,
    version: Option<&str>,
) -> Result<Option<Arc<PayloadContract>>, Error> {
    let rows = query(
        transport,
        EnqueueQuery {
            statement: sql::GET_CONTRACT_DEFINITION_V1,
            binds: vec![EnqueueBind::Text(Some(task_type)), EnqueueBind::Text(version)],
            columns: CONTRACT_COLUMNS,
        },
    )
    .await?;
    let row = match rows.as_slice() {
        [] => return Ok(None),
        [row] => row,
        _ => return Err(invalid_result()),
    };
    let Some(EnqueueValue::Json(schema)) = row.get("schema") else {
        return Err(invalid_result());
    };
    let validator =
        schema.get("payload").ok_or_else(invalid_result).and_then(compile_contract_schema)?;
    Ok(Some(Arc::new(PayloadContract {
        version: text(row, "version")?.into(),
        validator,
        payload_max_bytes: integer(row, "payload_max_bytes")?,
        result_max_bytes: integer(row, "result_max_bytes")?,
        payload_redact_keys: text_array(row, "payload_redact_keys")?,
        result_redact_keys: text_array(row, "result_redact_keys")?,
    })))
}

fn contract_mismatch(rows: &[EnqueueRow]) -> Result<Option<Vec<String>>, Error> {
    let mismatches: Vec<_> = rows.iter().filter(|row| matches!(row.get("outcome"), Some(EnqueueValue::Text(outcome)) if outcome == "contract_mismatch")).collect();
    if mismatches.is_empty() {
        return Ok(None);
    }
    if rows.len() != 1
        || integer(mismatches[0], "ordinal")? != 0
        || mismatches[0].get("task_id") != Some(&EnqueueValue::Null)
    {
        return Err(invalid_result());
    }
    let detail: Value = optional_text(mismatches[0], "reason")?
        .and_then(|reason| serde_json::from_str(reason).ok())
        .ok_or_else(invalid_result)?;
    let task_types: Vec<String> = detail
        .get("taskTypes")
        .and_then(|types| serde_json::from_value(types.clone()).ok())
        .ok_or_else(invalid_result)?;
    if task_types.is_empty()
        || task_types.iter().any(|task_type| task_type.is_empty())
        || task_types.iter().collect::<std::collections::BTreeSet<_>>().len() != task_types.len()
    {
        return Err(invalid_result());
    }
    Ok(Some(task_types))
}

fn enqueue_results(rows: &[EnqueueRow], count: usize) -> Result<Vec<EnqueueResult>, Error> {
    if rows.len() != count {
        return Err(invalid_result());
    }
    let mut results: Vec<Option<EnqueueResult>> = vec![None; count];
    for row in rows {
        let ordinal = integer(row, "ordinal")?;
        let slot = usize::try_from(ordinal)
            .ok()
            .and_then(|ordinal| ordinal.checked_sub(1))
            .and_then(|index| results.get_mut(index))
            .filter(|slot| slot.is_none())
            .ok_or_else(invalid_result)?;
        let outcome = EnqueueOutcome::parse(text(row, "outcome")?).ok_or_else(invalid_result)?;
        let reason = match (outcome, optional_text(row, "reason")?) {
            (EnqueueOutcome::NonReplaceable, Some(reason)) => {
                Some(EnqueueNonReplaceableReason::parse(reason).ok_or_else(invalid_result)?)
            }
            (EnqueueOutcome::NonReplaceable, None) | (_, Some(_)) => return Err(invalid_result()),
            (_, None) => None,
        };
        let Some(EnqueueValue::Uuid(task_id)) = row.get("task_id") else {
            return Err(invalid_result());
        };
        *slot = Some(EnqueueResult { task_id: *task_id, outcome, reason });
    }
    Ok(results.into_iter().flatten().collect())
}

fn text<'a>(row: &'a EnqueueRow, name: &str) -> Result<&'a str, Error> {
    match row.get(name) {
        Some(EnqueueValue::Text(value)) => Ok(value),
        _ => Err(invalid_result()),
    }
}
fn optional_text<'a>(row: &'a EnqueueRow, name: &str) -> Result<Option<&'a str>, Error> {
    match row.get(name) {
        Some(EnqueueValue::Null) => Ok(None),
        Some(EnqueueValue::Text(value)) => Ok(Some(value)),
        _ => Err(invalid_result()),
    }
}
fn integer(row: &EnqueueRow, name: &str) -> Result<i32, Error> {
    match row.get(name) {
        Some(EnqueueValue::Int(value)) => Ok(*value),
        _ => Err(invalid_result()),
    }
}
fn text_array(row: &EnqueueRow, name: &str) -> Result<Vec<String>, Error> {
    match row.get(name) {
        Some(EnqueueValue::TextArray(value)) => Ok(value.clone()),
        _ => Err(invalid_result()),
    }
}
fn invalid_result() -> Error {
    Error::invalid("PostgreSQL returned an invalid enqueue result")
}

pub(crate) struct TokioTransport<'a, E>(pub &'a E);

impl<E: Executor> EnqueueTransport for TokioTransport<'_, E> {
    async fn query(&mut self, query: EnqueueQuery<'_>) -> Result<Vec<EnqueueRow>, Error> {
        let params: Vec<&(dyn ToSql + Sync)> = query
            .binds
            .iter()
            .map(|bind| match bind {
                EnqueueBind::Json(value) => *value as &(dyn ToSql + Sync),
                EnqueueBind::Text(value) => value as &(dyn ToSql + Sync),
            })
            .collect();
        self.0
            .rows(query.statement, &params)
            .await?
            .iter()
            .map(|row| {
                query
                    .columns
                    .iter()
                    .map(|column| {
                        let value = match column.kind {
                            EnqueueColumnType::Int => {
                                row.try_get::<_, Option<i32>>(column.name)?.map(EnqueueValue::Int)
                            }
                            EnqueueColumnType::Text => row
                                .try_get::<_, Option<String>>(column.name)?
                                .map(EnqueueValue::Text),
                            EnqueueColumnType::TextArray => row
                                .try_get::<_, Option<Vec<String>>>(column.name)?
                                .map(EnqueueValue::TextArray),
                            EnqueueColumnType::Json => row
                                .try_get::<_, Option<Value>>(column.name)?
                                .map(EnqueueValue::Json),
                            EnqueueColumnType::Uuid => {
                                row.try_get::<_, Option<Uuid>>(column.name)?.map(EnqueueValue::Uuid)
                            }
                        }
                        .unwrap_or(EnqueueValue::Null);
                        Ok((column.name.into(), value))
                    })
                    .collect()
            })
            .collect()
    }
}
