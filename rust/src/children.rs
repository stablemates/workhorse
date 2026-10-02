//! Durable child tasks: the parent suspends until PostgreSQL has settled every child it created.
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio_postgres::Row;
use uuid::Uuid;

use crate::context::{status, validate_name};
use crate::contracts::{load_contract, load_contract_version, PayloadContract};
use crate::queue::{non_empty, stamp_contract, task_input, timestamp, validate_options, Executor};
use crate::sql_catalogue_generated as sql;
use crate::{ClaimedTask, EnqueueOptions, Error, HandlerContext, Operation};

const MAX_CHILDREN: usize = 100;

/// The contract version to stamp on a child, by child name. A child absent from the map takes its
/// type's current contract, and a `None` version stamps no contract.
type Versions = HashMap<String, Option<String>>;

/// How the children of one call are sent: one bare request, or a set of named requests.
#[derive(Clone, Copy)]
enum Shape {
    Single,
    Set,
}

/// One named child of a set passed to [`HandlerContext::run_children`].
#[derive(Clone, Debug)]
pub struct ChildTaskRequest {
    pub name: String,
    pub task_type: String,
    pub payload: Value,
    pub options: EnqueueOptions,
}

impl ChildTaskRequest {
    pub fn new(
        name: impl Into<String>,
        task_type: impl Into<String>,
        payload: &impl Serialize,
    ) -> Result<Self, Error> {
        Ok(Self {
            name: name.into(),
            task_type: task_type.into(),
            payload: serde_json::to_value(payload)?,
            options: EnqueueOptions::default(),
        })
    }
}

/// How one child of a settled set ended.
#[non_exhaustive]
#[derive(Clone, Debug, PartialEq)]
pub enum ChildOutcome {
    Succeeded(Value),
    Failed(FailureEnvelope),
    Canceled,
}

/// The persisted error a failed child ended with.
#[non_exhaustive]
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct FailureEnvelope {
    pub name: String,
    pub message: String,
    pub stack: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
enum SettledChild {
    Succeeded {
        #[serde(default)]
        result: Value,
    },
    Failed {
        #[serde(default)]
        error: FailureEnvelope,
    },
    Canceled,
}

impl HandlerContext {
    /// Creates one named child and returns its result, suspending until the child succeeds.
    pub async fn run_child<P: Serialize, R: DeserializeOwned>(
        &self,
        name: &str,
        task_type: &str,
        payload: &P,
        options: EnqueueOptions,
    ) -> Result<R, Error> {
        self.fast_tier_guard("child tasks")?;
        validate_name(name, "child")?;
        validate_child_options(&options)?;
        let child = ChildTaskRequest {
            name: name.into(),
            task_type: task_type.into(),
            payload: serde_json::to_value(payload)?,
            options,
        };
        let children = std::slice::from_ref(&child);
        // A canceled handler unwinds before the contract lookups can wait on PostgreSQL.
        self.check(Operation::RunChild)?;
        let request = self.initial(children, Shape::Single).await?;
        let identity = self.identity(children, Shape::Single)?;
        let key = format!("child:{name}");
        let value = self
            .shared(Operation::RunChild, &key, identity.to_string(), || async {
                self.check(Operation::RunChild)?;
                let mut row =
                    self.call(sql::CREATE_CHILD_V2, "create_child_v2", &[&name, &request]).await?;
                if let Some(accepted) =
                    self.replayed(&row, &request, children, Shape::Single).await?
                {
                    row = self
                        .call(sql::CREATE_CHILD_V2, "create_child_v2", &[&name, &accepted])
                        .await?;
                }
                match status(&row)?.as_str() {
                    "completed" => {
                        Ok(row.try_get::<_, Option<Value>>("result")?.unwrap_or_default())
                    }
                    "created" => Err(self.suspend()),
                    "conflict" => {
                        let stored: Option<String> = row.try_get("stored_child_name")?;
                        let diagnosis = match stored {
                            Some(stored) if stored != name => {
                                format!("stored child {stored:?}, requested child {name:?}")
                            }
                            _ => name.to_owned(),
                        };
                        Err(self.refusal(Operation::RunChild, &diagnosis, "conflict"))
                    }
                    other => Err(self.refusal(Operation::RunChild, name, other)),
                }
            })
            .await?;
        Ok(serde_json::from_value(value)?)
    }

    /// Creates a set of children and returns how each one ended, by name.
    pub async fn run_children(
        &self,
        children: Vec<ChildTaskRequest>,
    ) -> Result<BTreeMap<String, ChildOutcome>, Error> {
        let results = self.create_children(children, "settled").await?;
        results
            .into_iter()
            .map(|(name, value)| {
                let outcome = match serde_json::from_value(value)? {
                    SettledChild::Succeeded { result } => ChildOutcome::Succeeded(result),
                    SettledChild::Failed { error } => ChildOutcome::Failed(error),
                    SettledChild::Canceled => ChildOutcome::Canceled,
                };
                Ok((name, outcome))
            })
            .collect()
    }

    /// Creates a set of children and returns their results, by name, once all of them succeed.
    ///
    /// A failed or canceled child fails or cancels the parent through its dependency policy.
    pub async fn run_children_all(
        &self,
        children: Vec<ChildTaskRequest>,
    ) -> Result<BTreeMap<String, Value>, Error> {
        self.create_children(children, "all_success").await
    }

    async fn create_children(
        &self,
        children: Vec<ChildTaskRequest>,
        mode: &'static str,
    ) -> Result<BTreeMap<String, Value>, Error> {
        self.fast_tier_guard("child tasks")?;
        if children.len() > MAX_CHILDREN {
            let name = "children".to_owned();
            return Err(Error::LimitExceeded { operation: Operation::RunChildren, name });
        }
        let mut names = HashSet::new();
        for child in &children {
            validate_name(&child.name, "child")?;
            if !names.insert(child.name.as_str()) {
                return Err(Error::invalid("child names must be unique"));
            }
            validate_child_options(&child.options)?;
        }
        self.check(Operation::RunChildren)?;
        let requests = self.initial(&children, Shape::Set).await?;
        let identity = format!("{mode}:{}", self.identity(&children, Shape::Set)?);
        let value = self
            .shared(Operation::RunChildren, "children", identity, || async {
                self.check(Operation::RunChildren)?;
                let mut row = self
                    .call(sql::CREATE_CHILDREN_V1, "create_children_v1", &[&requests, &mode])
                    .await?;
                if let Some(accepted) =
                    self.replayed(&row, &requests, &children, Shape::Set).await?
                {
                    row = self
                        .call(sql::CREATE_CHILDREN_V1, "create_children_v1", &[&accepted, &mode])
                        .await?;
                }
                match status(&row)?.as_str() {
                    "completed" => {
                        Ok(row.try_get::<_, Option<Value>>("results")?.unwrap_or_default())
                    }
                    "created" => Err(self.suspend()),
                    "result_too_large" => Err(Error::ChildResultLimitExceeded {
                        result_bytes: row
                            .try_get::<_, Option<i32>>("result_bytes")?
                            .unwrap_or(0)
                            .into(),
                        limit_bytes: row
                            .try_get::<_, Option<i32>>("result_limit_bytes")?
                            .unwrap_or(0)
                            .into(),
                    }),
                    other => Err(self.refusal(Operation::RunChildren, "children", other)),
                }
            })
            .await?;
        match value {
            Value::Object(results) => Ok(results.into_iter().collect()),
            Value::Null => Ok(BTreeMap::new()),
            _ => Err(Error::invalid("workhorse.create_children_v1 returned invalid results")),
        }
    }
}

impl HandlerContext {
    /// Builds the request under each child type's current contract. A replayed request that the
    /// current contract rejects builds again with each existing child at the version it was created
    /// under; PostgreSQL still rejects a request that differs from the accepted one.
    async fn initial(&self, children: &[ChildTaskRequest], shape: Shape) -> Result<Value, Error> {
        let error = match self.child_document(children, shape, &Versions::new()).await {
            Err(error @ Error::ContractValidation { .. }) => error,
            built => return built,
        };
        let versions = self.accepted_contract_versions().await?;
        if versions.is_empty() {
            return Err(error);
        }
        match self.child_document(children, shape, &versions).await {
            Err(Error::ContractValidation { .. }) => Err(error),
            built => built,
        }
    }

    /// PostgreSQL compares a replayed child request with the one it accepted, contract stamp
    /// included. After a contract change, a `conflict` retries once with each existing child
    /// stamped with the contract version it was created under; this returns that request.
    async fn replayed(
        &self,
        row: &Row,
        sent: &Value,
        children: &[ChildTaskRequest],
        shape: Shape,
    ) -> Result<Option<Value>, Error> {
        if status(row)? != "conflict" {
            return Ok(None);
        }
        let versions = self.accepted_contract_versions().await?;
        if versions.is_empty() {
            return Ok(None);
        }
        match self.child_document(children, shape, &versions).await {
            Ok(accepted) if accepted != *sent => Ok(Some(accepted)),
            Ok(_) | Err(Error::ContractValidation { .. }) => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// Renders the children's requests, each validated against and stamped with its contract.
    async fn child_document(
        &self,
        children: &[ChildTaskRequest],
        shape: Shape,
        versions: &Versions,
    ) -> Result<Value, Error> {
        let mut contracts = HashMap::new();
        let mut requests = Vec::with_capacity(children.len());
        for child in children {
            let version = versions.get(&child.name);
            let key = (child.task_type.as_str(), version);
            let contract: Option<Arc<PayloadContract>> = match contracts.get(&key) {
                Some(contract) => Option::clone(contract),
                None => {
                    let loaded = match version {
                        None => load_contract(self.pool(), &child.task_type).await?,
                        Some(None) => None,
                        Some(Some(version)) => {
                            load_contract_version(self.pool(), &child.task_type, Some(version))
                                .await?
                        }
                    };
                    contracts.insert(key, loaded.clone());
                    loaded
                }
            };
            requests.push(child_request(self.task(), child, contract.as_ref())?);
        }
        shaped(children, shape, requests)
    }

    /// What identical concurrent calls share one call under: the requests without their contract
    /// stamps. A contract change between two such calls must not make them conflict, since the
    /// call that reaches PostgreSQL reconciles its stamps with the accepted ones.
    fn identity(&self, children: &[ChildTaskRequest], shape: Shape) -> Result<Value, Error> {
        let requests = children.iter().map(|child| child_request(self.task(), child, None));
        shaped(children, shape, requests.collect::<Result<_, _>>()?)
    }

    /// The contract version of each child this task created, by child name.
    async fn accepted_contract_versions(&self) -> Result<Versions, Error> {
        let task_id = self.task().id;
        let limit = MAX_CHILDREN as i32 + 1;
        let edges = self.pool().rows(sql::TASK_CHILD, &[&task_id, &limit]).await?;
        let mut versions = Versions::new();
        for edge in edges {
            if edge.try_get::<_, Uuid>("parent_task_id")? != task_id {
                continue;
            }
            let child: Uuid = edge.try_get("child_task_id")?;
            let rows = self.pool().rows(sql::GET_TASK, &[&child]).await?;
            let version = match rows.first() {
                Some(row) => row.try_get::<_, Option<String>>("contract_version")?,
                None => None,
            };
            versions.insert(edge.try_get("child_name")?, version);
        }
        Ok(versions)
    }
}

/// Puts one request per child into the document `shape` sends.
fn shaped(
    children: &[ChildTaskRequest],
    shape: Shape,
    requests: Vec<Value>,
) -> Result<Value, Error> {
    match shape {
        Shape::Single => {
            let mut requests = requests;
            requests.pop().ok_or_else(|| Error::invalid("a child call has no child"))
        }
        Shape::Set => Ok(Value::Array(
            children
                .iter()
                .zip(requests)
                .map(|(child, request)| json!({ "name": child.name, "request": request }))
                .collect(),
        )),
    }
}

/// Refuses child options a child cannot use before any statement.
fn validate_child_options(options: &EnqueueOptions) -> Result<(), Error> {
    validate_options(options)
        .map_err(|message| Error::invalid(format!("invalid child options: {message}")))?;
    if options.idempotency.is_some()
        || options.debounce.is_some()
        || options.throttle.is_some()
        || options.dependencies.is_some()
    {
        return Err(Error::invalid(
            "child options cannot use idempotency, debounce, throttle or dependencies",
        ));
    }
    Ok(())
}

/// The enqueue request PostgreSQL creates a child from, which inherits the parent's trace and
/// carries the child's contract stamp.
fn child_request(
    parent: &ClaimedTask,
    child: &ChildTaskRequest,
    contract: Option<&Arc<PayloadContract>>,
) -> Result<Value, Error> {
    let options = &child.options;
    let mut input: Map<String, Value> = task_input(
        "default",
        &child.task_type,
        &child.payload,
        options.queue.as_deref(),
        options.priority,
        options.concurrency_key.as_deref(),
        options.max_attempts,
        options.retry_policy.as_ref(),
    );
    input.insert("deadline".into(), options.deadline.map_or(Value::Null, timestamp));
    input.insert("budget".into(), non_empty(options.budget.as_deref()));
    input.insert(
        "executionTimeoutMs".into(),
        options.execution_timeout_ms.filter(|value| *value != 0).into(),
    );
    input.insert("prerequisiteTaskId".into(), Value::Null);
    input.insert("dependencies".into(), Value::Null);
    input.insert("tags".into(), json!(options.tags));
    if let Some(trace) = &parent.trace_context {
        input.insert("traceContext".into(), trace.clone());
    }
    if let Some(run_at) = options.run_at {
        input.insert("runAt".into(), timestamp(run_at));
    }
    if let Some(contract) = contract {
        if !contract.validator.is_valid(&child.payload) {
            return Err(Error::ContractValidation {
                task_type: child.task_type.clone(),
                version: contract.version.clone(),
            });
        }
        stamp_contract(&mut input, contract);
    }
    Ok(Value::Object(input))
}

#[cfg(test)]
mod tests {
    use chrono::Utc;

    use super::*;

    fn parent() -> ClaimedTask {
        ClaimedTask {
            id: uuid::Uuid::new_v4(),
            task_type: "order.process".into(),
            queue: "orders".into(),
            priority: 0,
            payload: json!({}),
            contract_version: None,
            result_max_bytes: None,
            redact_error_details: false,
            trace_context: None,
            attempt: 1,
            max_attempts: 1,
            retry_policy: json!({}),
            deadline_at: None,
            execution_timeout: None,
            attempt_timeout_at: None,
            fence_token: 1,
            lease_expires_at: Utc::now(),
            claim_sent_at: tokio::time::Instant::now(),
            fast_tier: false,
        }
    }

    #[test]
    fn a_child_goes_to_default_unless_its_options_name_a_queue() {
        let queue = |options: &EnqueueOptions| {
            let child = ChildTaskRequest {
                options: options.clone(),
                ..ChildTaskRequest::new("invoice", "invoice.create", &json!({})).unwrap()
            };
            child_request(&parent(), &child, None).unwrap()["queue"].clone()
        };
        assert_eq!(queue(&EnqueueOptions::default()), json!("default"));
        let orders = EnqueueOptions { queue: Some("orders".into()), ..Default::default() };
        assert_eq!(queue(&orders), json!("orders"));
    }
}
