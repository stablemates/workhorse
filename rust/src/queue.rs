//! The client: a sealed executor abstraction and the `Queue` that issues protocol calls.
use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard};

use chrono::{DateTime, Duration, Utc};
use serde::Serialize;
use serde_json::{json, Map, Value};
use tokio::sync::OnceCell;
use tokio_postgres::types::ToSql;
use tokio_postgres::{Client, NoTls, Row};
use uuid::Uuid;

use crate::compatibility::{check_compatibility, read_compatibility_state, CompatibilityCode};
use crate::contracts::{
    load_contract, serialize_contracts, ContractCache, PayloadContract, TaskTypeContracts,
};
use crate::policies::{
    self, Budget, BudgetDefinition, ConcurrencyPolicy, ConcurrencyPolicyDefinition,
    RateLimitPolicy, RateLimitPolicyDefinition,
};
use crate::sql_catalogue_generated as sql;
use crate::types::*;
use crate::{Error, Operation};

const DEFAULT_MAX_ATTEMPTS: i32 = 25;
const MAX_TASK_DEPENDENCIES: usize = 100;
const MAX_EXTERNAL_VALUE_BYTES: usize = 65_536;

mod private {
    pub trait Sealed {}
}

/// A PostgreSQL connection, pool or transaction the client can issue protocol calls through.
///
/// Implemented for `tokio_postgres` clients and transactions and for `deadpool_postgres`
/// pools, pooled clients and transactions. A transaction executor makes every call part of
/// the caller's transaction; the caller commits or rolls it back.
pub trait Executor: private::Sealed + Send + Sync {
    #[doc(hidden)]
    fn rows(
        &self,
        statement: &str,
        params: &[&(dyn ToSql + Sync)],
    ) -> impl Future<Output = Result<Vec<Row>, Error>> + Send;
}

macro_rules! client_executor {
    ($($ty:ty),+) => {$(
        impl private::Sealed for $ty {}
        impl Executor for $ty {
            async fn rows(&self, statement: &str, params: &[&(dyn ToSql + Sync)]) -> Result<Vec<Row>, Error> {
                Ok(self.query(statement, params).await?)
            }
        }
    )+};
}

client_executor!(
    Client,
    tokio_postgres::Transaction<'_>,
    deadpool_postgres::Object,
    deadpool_postgres::Transaction<'_>
);

impl private::Sealed for deadpool_postgres::Pool {}
impl Executor for deadpool_postgres::Pool {
    async fn rows(
        &self,
        statement: &str,
        params: &[&(dyn ToSql + Sync)],
    ) -> Result<Vec<Row>, Error> {
        let client = self.get().await?;
        Ok(client.query(statement, params).await?)
    }
}

impl<T: Executor + ?Sized> private::Sealed for &T {}
impl<T: Executor + ?Sized> Executor for &T {
    fn rows(
        &self,
        statement: &str,
        params: &[&(dyn ToSql + Sync)],
    ) -> impl Future<Output = Result<Vec<Row>, Error>> + Send {
        (**self).rows(statement, params)
    }
}

/// The Workhorse client. It checks schema compatibility before its first mutation.
pub struct Queue<E: Executor> {
    executor: E,
    default_queue: String,
    compatibility: OnceCell<Result<(), CompatibilityCode>>,
    contracts: Mutex<ContractCache>,
}

impl Queue<Client> {
    /// Connects without TLS and drives the connection on the current Tokio runtime.
    pub async fn connect(url: &str, default_queue: impl Into<String>) -> Result<Self, Error> {
        let (client, connection) = tokio_postgres::connect(url, NoTls).await?;
        tokio::spawn(connection);
        Ok(Self::new(client, default_queue))
    }
}

impl<E: Executor> Queue<E> {
    /// A client that sends tasks without an explicit queue to `default_queue`.
    pub fn new(executor: E, default_queue: impl Into<String>) -> Self {
        Self {
            executor,
            default_queue: default_queue.into(),
            compatibility: OnceCell::new(),
            contracts: Mutex::default(),
        }
    }

    pub fn default_queue(&self) -> &str {
        &self.default_queue
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

    /// Submits one task.
    pub async fn enqueue<P: Serialize + ?Sized>(
        &self,
        task_type: &str,
        payload: &P,
        options: EnqueueOptions,
    ) -> Result<EnqueueResult, Error> {
        let request = EnqueueRequest {
            task_type: task_type.into(),
            payload: serde_json::to_value(payload)?,
            options,
        };
        let mut results = self.enqueue_many(vec![request]).await?;
        Ok(results.remove(0))
    }

    /// Submits one atomic batch and returns PostgreSQL's results in request order.
    pub async fn enqueue_many(
        &self,
        requests: Vec<EnqueueRequest>,
    ) -> Result<Vec<EnqueueResult>, Error> {
        if requests.is_empty() {
            return Ok(Vec::new());
        }
        if requests.len() > sql::MAX_ENQUEUE_BATCH_SIZE {
            return Err(Error::invalid("enqueue batch exceeds the shared limit"));
        }
        for attempt in 0.. {
            let rows = self.enqueue_attempt(&requests).await?;
            let Some(task_types) = contract_mismatch(&rows)? else {
                return enqueue_results(&rows, requests.len());
            };
            for task_type in task_types {
                let contract = load_contract(&self.executor, &task_type).await?;
                self.contracts().definitions.insert(task_type, contract);
            }
            if attempt > 0 {
                break;
            }
        }
        Err(Error::ContractPolicyChanged)
    }

    async fn enqueue_attempt(&self, requests: &[EnqueueRequest]) -> Result<Vec<Row>, Error> {
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
        self.assert_compatible().await?;
        for (input, request) in inputs.iter_mut().zip(requests) {
            self.apply_contract(input, request).await?;
        }
        let document = Value::Array(inputs.into_iter().map(Value::Object).collect());
        self.executor.rows(sql::ENQUEUE_MANY_V1, &[&document]).await.map_err(|error| match error {
            Error::Postgres(error) => Error::translate_enqueue(error),
            error => error,
        })
    }

    fn contracts(&self) -> MutexGuard<'_, ContractCache> {
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
        let mut input = self.task_input(
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

    /// The fields an enqueued task and a scheduled task share.
    #[allow(clippy::too_many_arguments)]
    fn task_input(
        &self,
        task_type: &str,
        payload: &Value,
        queue: Option<&str>,
        priority: i32,
        concurrency_key: Option<&str>,
        max_attempts: i32,
        retry_policy: Option<&RetryPolicy>,
    ) -> Map<String, Value> {
        let queue = queue.filter(|queue| !queue.is_empty()).unwrap_or(&self.default_queue);
        let max_attempts = if max_attempts == 0 { DEFAULT_MAX_ATTEMPTS } else { max_attempts };
        let Value::Object(input) = json!({
            "queue": queue,
            "type": task_type,
            "payload": payload,
            "priority": priority,
            "concurrencyKey": non_empty(concurrency_key),
            "maxAttempts": max_attempts,
            "retryPolicy": retry_policy,
            "contractVersion": null,
            "payloadMaxBytes": sql::DEFAULT_TASK_VALUE_MAX_BYTES,
            "resultMaxBytes": sql::DEFAULT_TASK_VALUE_MAX_BYTES,
            "sensitivePayloadKeys": [],
            "sensitiveResultKeys": [],
        }) else {
            unreachable!("json! object literal")
        };
        input
    }

    /// Validates a contracted payload and stamps the contract fields PostgreSQL enforces.
    async fn apply_contract(
        &self,
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
                let loaded = load_contract(&self.executor, task_type).await?;
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

    /// Requests cancellation; an active task stops at its next PostgreSQL-owned checkpoint.
    pub async fn cancel(
        &self,
        task_id: Uuid,
        requested_by: Option<&str>,
        reason: Option<&str>,
    ) -> Result<CancelResult, Error> {
        self.assert_compatible().await?;
        let rows = self.executor.rows(sql::CANCEL_V1, &[&task_id, &requested_by, &reason]).await?;
        let row = exactly_one(&rows, "cancel_v1")?;
        let status: &str = row.try_get("status")?;
        let state: Option<&str> = row.try_get("state")?;
        Ok(CancelResult {
            status: parse_status(Operation::Cancel, status)?,
            task_id,
            state: state.map(|state| parse_status(Operation::Cancel, state)).transpose()?,
            current_attempt: row.try_get("current_attempt")?,
            requested_at: row.try_get("requested_at")?,
            requested_by: row.try_get("requested_by")?,
            reason: row.try_get("reason")?,
            finished_at: row.try_get("finished_at")?,
        })
    }

    /// Delivers a named signal to a task waiting for it.
    pub async fn send_signal<P: Serialize + ?Sized>(
        &self,
        task_id: Uuid,
        name: &str,
        payload: &P,
        options: DeliveryOptions,
    ) -> Result<SignalDeliveryResult, Error> {
        let payload = serde_json::to_value(payload)?;
        validate_delivery("signal", "signal payload", name, &payload, &options)?;
        let row = self
            .deliver(sql::SEND_SIGNAL_V1, "send_signal_v1", task_id, name, &payload, &options)
            .await?;
        let status: &str = row.try_get("status")?;
        if status == "conflict" {
            return Err(Error::SignalIdempotencyConflict { task_id, name: name.into() });
        }
        Ok(SignalDeliveryResult {
            status: parse_status(Operation::SendSignal, status)?,
            task_id,
            name: name.into(),
            payload: row.try_get("payload")?,
            delivered_at: row.try_get("delivered_at")?,
            delivered_by: row.try_get("delivered_by")?,
        })
    }

    /// Records a human decision for a task waiting on it.
    pub async fn complete_human_wait<R: Serialize + ?Sized>(
        &self,
        task_id: Uuid,
        name: &str,
        result: &R,
        options: DeliveryOptions,
    ) -> Result<HumanWaitCompletionResult, Error> {
        let result = serde_json::to_value(result)?;
        validate_delivery("human wait", "human wait result", name, &result, &options)?;
        let row = self
            .deliver(
                sql::COMPLETE_HUMAN_WAIT_V1,
                "complete_human_wait_v1",
                task_id,
                name,
                &result,
                &options,
            )
            .await?;
        let status: &str = row.try_get("status")?;
        if status == "conflict" {
            return Err(Error::HumanWaitIdempotencyConflict { task_id, name: name.into() });
        }
        Ok(HumanWaitCompletionResult {
            status: parse_status(Operation::CompleteHumanWait, status)?,
            task_id,
            name: name.into(),
            payload: row.try_get("result")?,
            completed_at: row.try_get("completed_at")?,
            completed_by: row.try_get("completed_by")?,
        })
    }

    async fn deliver(
        &self,
        statement: &str,
        function: &str,
        task_id: Uuid,
        name: &str,
        value: &Value,
        options: &DeliveryOptions,
    ) -> Result<Row, Error> {
        self.assert_compatible().await?;
        let mut rows = self
            .executor
            .rows(
                statement,
                &[&task_id, &name, value, &options.idempotency_key, &options.requested_by],
            )
            .await?;
        exactly_one(&rows, function)?;
        Ok(rows.remove(0))
    }

    /// PostgreSQL's queue health snapshot over the last day.
    pub async fn health(&self) -> Result<QueueHealth, Error> {
        self.assert_compatible().await?;
        let since = Utc::now() - Duration::hours(24);
        let rows = self.executor.rows(sql::QUEUE_HEALTH_V1, &[&since]).await?;
        match exactly_one(&rows, "queue_health_v1")?.try_get("snapshot")? {
            Value::Object(snapshot) => Ok(snapshot),
            _ => Err(Error::invalid("workhorse.queue_health_v1 returned a non-object snapshot")),
        }
    }

    /// Makes `definitions` the namespace's schedules; `prune` removes the rest.
    pub async fn sync_schedules(
        &self,
        namespace: &str,
        definitions: Vec<ScheduleDefinition>,
        prune: bool,
    ) -> Result<(), Error> {
        let document = definitions
            .iter()
            .enumerate()
            .map(|(index, definition)| {
                if !(0..=100).contains(&definition.task.priority) {
                    return Err(Error::invalid(format!(
                        "schedule definition {}: invalid schedule definition: priority must be between 0 and 100",
                        index + 1
                    )));
                }
                let task = &definition.task;
                let mut input = self.task_input(
                    &task.task_type,
                    &task.payload,
                    task.queue.as_deref(),
                    task.priority,
                    task.concurrency_key.as_deref(),
                    task.max_attempts,
                    task.retry_policy.as_ref(),
                );
                input.insert("name".into(), json!(definition.name));
                input.insert("schedule".into(), json!(definition.schedule));
                input.insert("timezone".into(), json!(definition.timezone));
                input.insert("catchupPolicy".into(), json!(definition.catchup_policy));
                input.insert("enabled".into(), json!(definition.enabled));
                Ok(Value::Object(input))
            })
            .collect::<Result<Value, Error>>()?;
        self.assert_compatible().await?;
        self.executor
            .rows(sql::SYNC_SCHEDULE_DEFINITIONS_V2, &[&namespace, &document, &prune])
            .await?;
        Ok(())
    }

    /// Makes `contracts` PostgreSQL's contract definitions and validates later enqueues against them.
    pub async fn sync_contracts(
        &self,
        contracts: &BTreeMap<String, TaskTypeContracts>,
    ) -> Result<(), Error> {
        let document = serialize_contracts(contracts)?;
        self.assert_compatible().await?;
        self.executor.rows(sql::SYNC_CONTRACT_DEFINITIONS_V1, &[&document]).await?;
        let mut cache = self.contracts();
        cache.definitions.clear();
        cache.enabled = true;
        Ok(())
    }

    pub async fn sync_concurrency_policies(
        &self,
        namespace: &str,
        definitions: &[ConcurrencyPolicyDefinition],
        prune: bool,
    ) -> Result<Vec<ConcurrencyPolicy>, Error> {
        let document = policies::concurrency_document(definitions);
        self.sync_policies(
            sql::SYNC_CONCURRENCY_POLICIES_V1,
            namespace,
            document,
            prune,
            policies::concurrency_policy,
        )
        .await
    }

    pub async fn sync_rate_limit_policies(
        &self,
        namespace: &str,
        definitions: &[RateLimitPolicyDefinition],
        prune: bool,
    ) -> Result<Vec<RateLimitPolicy>, Error> {
        let document = policies::rate_limit_document(definitions);
        self.sync_policies(
            sql::SYNC_RATE_LIMIT_POLICIES_V1,
            namespace,
            document,
            prune,
            policies::rate_limit_policy,
        )
        .await
    }

    pub async fn sync_budgets(
        &self,
        namespace: &str,
        definitions: &[BudgetDefinition],
        prune: bool,
    ) -> Result<Vec<Budget>, Error> {
        let document = policies::budget_document(definitions);
        self.sync_policies(sql::SYNC_BUDGETS_V1, namespace, document, prune, policies::budget).await
    }

    async fn sync_policies<T>(
        &self,
        statement: &str,
        namespace: &str,
        document: Value,
        prune: bool,
        decode: fn(&Row) -> Result<T, tokio_postgres::Error>,
    ) -> Result<Vec<T>, Error> {
        self.assert_compatible().await?;
        let rows = self.executor.rows(statement, &[&namespace, &document, &prune]).await?;
        Ok(rows.iter().map(decode).collect::<Result<_, _>>()?)
    }

    /// Lists concurrency policies for `queues`, or all of them when `queues` is empty.
    pub async fn list_concurrency_policies(
        &self,
        queues: &[&str],
    ) -> Result<Vec<ConcurrencyPolicy>, Error> {
        self.list(sql::LIST_CONCURRENCY_POLICIES, queues, policies::concurrency_policy).await
    }

    /// Lists rate limit policies for `queues`, or all of them when `queues` is empty.
    pub async fn list_rate_limit_policies(
        &self,
        queues: &[&str],
    ) -> Result<Vec<RateLimitPolicy>, Error> {
        self.list(sql::LIST_RATE_LIMIT_POLICIES, queues, policies::rate_limit_policy).await
    }

    /// Lists budgets named in `names`, or all of them when `names` is empty.
    pub async fn list_budgets(&self, names: &[&str]) -> Result<Vec<Budget>, Error> {
        self.list(sql::LIST_BUDGETS, names, policies::budget).await
    }

    async fn list<T>(
        &self,
        statement: &str,
        names: &[&str],
        decode: fn(&Row) -> Result<T, tokio_postgres::Error>,
    ) -> Result<Vec<T>, Error> {
        let rows = self.executor.rows(statement, &[&names]).await?;
        Ok(rows.iter().map(decode).collect::<Result<_, _>>()?)
    }
}

fn validate_options(options: &EnqueueOptions) -> Result<(), &'static str> {
    let keyed =
        [options.idempotency.is_some(), options.debounce.is_some(), options.throttle.is_some()];
    if keyed.iter().filter(|present| **present).count() > 1 {
        return Err("cannot combine idempotency, debounce, or throttle");
    }
    if !(0..=100).contains(&options.priority) {
        return Err("priority must be between 0 and 100");
    }
    if options.max_attempts < 0 {
        return Err("max attempts must be positive");
    }
    if options.debounce.is_some() && options.run_at.is_some() {
        return Err("debounced enqueue uses its PostgreSQL-owned window instead of run at");
    }
    let Some(dependencies) = &options.dependencies else {
        return Ok(());
    };
    if options.debounce.is_some() || options.throttle.is_some() {
        return Err("cannot combine debounce or throttle with dependencies");
    }
    let ids = &dependencies.prerequisite_task_ids;
    if ids.is_empty() || ids.iter().collect::<BTreeSet<_>>().len() != ids.len() {
        return Err("dependencies must contain unique prerequisite task IDs");
    }
    if ids.len() > MAX_TASK_DEPENDENCIES {
        return Err("dependencies accepts at most 100 prerequisite task IDs");
    }
    Ok(())
}

fn validate_delivery(
    label: &str,
    value_label: &str,
    name: &str,
    value: &Value,
    options: &DeliveryOptions,
) -> Result<(), Error> {
    let characters = |text: &str| text.chars().count();
    if name.trim() != name || !(1..=200).contains(&characters(name)) {
        return Err(Error::invalid(format!(
            "{label} name must contain between 1 and 200 characters without surrounding whitespace"
        )));
    }
    if serde_json::to_vec(value)?.len() > MAX_EXTERNAL_VALUE_BYTES {
        return Err(Error::invalid(format!("{value_label} must be at most 65536 bytes of JSON")));
    }
    if !(1..=512).contains(&options.idempotency_key.len()) {
        return Err(Error::invalid(format!(
            "{label} idempotency key must contain between 1 and 512 UTF-8 bytes"
        )));
    }
    if !(1..=200).contains(&characters(&options.requested_by)) {
        return Err(Error::invalid(format!(
            "{label} requested by must contain between 1 and 200 characters"
        )));
    }
    Ok(())
}

fn stamp_contract(input: &mut Map<String, Value>, contract: &Arc<PayloadContract>) {
    input.insert("contractVersion".into(), json!(contract.version));
    input.insert("payloadMaxBytes".into(), json!(contract.payload_max_bytes));
    input.insert("resultMaxBytes".into(), json!(contract.result_max_bytes));
    input.insert("sensitivePayloadKeys".into(), json!(contract.payload_redact_keys));
    input.insert("sensitiveResultKeys".into(), json!(contract.result_redact_keys));
}

/// The task types PostgreSQL named when a batch carried a stale contract.
fn contract_mismatch(rows: &[Row]) -> Result<Option<Vec<String>>, Error> {
    for row in rows {
        if row.try_get::<_, &str>("outcome")? != "contract_mismatch" {
            continue;
        }
        let reason: Option<&str> = row.try_get("reason")?;
        let detail: Value = reason
            .and_then(|reason| serde_json::from_str(reason).ok())
            .ok_or_else(invalid_result)?;
        let task_types = detail
            .get("taskTypes")
            .and_then(|types| serde_json::from_value(types.clone()).ok())
            .ok_or_else(invalid_result)?;
        return Ok(Some(task_types));
    }
    Ok(None)
}

fn enqueue_results(rows: &[Row], count: usize) -> Result<Vec<EnqueueResult>, Error> {
    if rows.len() != count {
        return Err(invalid_result());
    }
    let mut results: Vec<Option<EnqueueResult>> = vec![None; count];
    for row in rows {
        let ordinal: i32 = row.try_get("ordinal")?;
        let slot = usize::try_from(ordinal)
            .ok()
            .and_then(|ordinal| ordinal.checked_sub(1))
            .and_then(|index| results.get_mut(index))
            .filter(|slot| slot.is_none())
            .ok_or_else(invalid_result)?;
        let outcome = EnqueueOutcome::parse(row.try_get("outcome")?).ok_or_else(invalid_result)?;
        let reason: Option<&str> = row.try_get("reason")?;
        let reason = match (outcome, reason) {
            (EnqueueOutcome::NonReplaceable, Some(reason)) => {
                Some(EnqueueNonReplaceableReason::parse(reason).ok_or_else(invalid_result)?)
            }
            (EnqueueOutcome::NonReplaceable, None) | (_, Some(_)) => return Err(invalid_result()),
            (_, None) => None,
        };
        *slot = Some(EnqueueResult { task_id: row.try_get("task_id")?, outcome, reason });
    }
    Ok(results.into_iter().flatten().collect())
}

fn invalid_result() -> Error {
    Error::invalid("PostgreSQL returned an invalid enqueue result")
}

fn exactly_one<'a>(rows: &'a [Row], function: &str) -> Result<&'a Row, Error> {
    match rows {
        [row] => Ok(row),
        _ => Err(Error::invalid(format!(
            "workhorse.{function} returned {} rows; expected one",
            rows.len()
        ))),
    }
}

fn parse_status<T: serde::de::DeserializeOwned>(
    operation: Operation,
    status: &str,
) -> Result<T, Error> {
    serde_json::from_value(Value::String(status.into()))
        .map_err(|_| Error::UnexpectedStatus { operation, status: status.into() })
}

fn timestamp(value: DateTime<Utc>) -> Value {
    Value::String(value.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
}

fn non_empty(value: Option<&str>) -> Value {
    value.filter(|value| !value.is_empty()).map_or(Value::Null, Value::from)
}

fn default_scope(scope: String) -> String {
    if scope.is_empty() {
        "default".into()
    } else {
        scope
    }
}

/// The current OpenTelemetry span as a W3C carrier, or `None` when it would exceed 1 KiB.
#[cfg(feature = "opentelemetry")]
fn trace_context() -> Option<Value> {
    use opentelemetry::trace::TraceContextExt;
    let context = opentelemetry::Context::current();
    let span = context.span();
    let span_context = span.span_context();
    if !span_context.is_valid() {
        return None;
    }
    let mut carrier = Map::new();
    carrier.insert(
        "traceparent".into(),
        format!(
            "00-{}-{}-{:02x}",
            span_context.trace_id(),
            span_context.span_id(),
            span_context.trace_flags().to_u8()
        )
        .into(),
    );
    let state = span_context.trace_state().header();
    if !state.is_empty() {
        carrier.insert("tracestate".into(), state.into());
    }
    let carrier = Value::Object(carrier);
    (carrier.to_string().len() <= 1024).then_some(carrier)
}

#[cfg(not(feature = "opentelemetry"))]
fn trace_context() -> Option<Value> {
    None
}
