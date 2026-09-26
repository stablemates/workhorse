//! Durable child tasks: the parent suspends until PostgreSQL has settled every child it created.
use std::collections::BTreeMap;
use std::collections::HashSet;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::context::{status, validate_name};
use crate::queue::{non_empty, task_input, timestamp, validate_options};
use crate::sql_catalogue_generated as sql;
use crate::{ClaimedTask, EnqueueOptions, Error, HandlerContext, Operation};

const MAX_CHILDREN: usize = 100;

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
        let request =
            child_request(self.task(), task_type, serde_json::to_value(payload)?, &options)?;
        let key = format!("child:{name}");
        let value = self
            .shared(Operation::RunChild, &key, request.to_string(), || async {
                self.check(Operation::RunChild)?;
                let row =
                    self.call(sql::CREATE_CHILD_V1, "create_child_v1", &[&name, &request]).await?;
                match status(&row)?.as_str() {
                    "completed" => {
                        Ok(row.try_get::<_, Option<Value>>("result")?.unwrap_or_default())
                    }
                    "created" => Err(self.suspend()),
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
        let mut requests = Vec::with_capacity(children.len());
        for child in children {
            validate_name(&child.name, "child")?;
            if !names.insert(child.name.clone()) {
                return Err(Error::invalid("child names must be unique"));
            }
            let request =
                child_request(self.task(), &child.task_type, child.payload, &child.options)?;
            requests.push(json!({ "name": child.name, "request": request }));
        }
        let requests = Value::Array(requests);
        let value = self
            .shared(Operation::RunChildren, "children", format!("{mode}:{requests}"), || async {
                self.check(Operation::RunChildren)?;
                let row = self
                    .call(sql::CREATE_CHILDREN_V1, "create_children_v1", &[&requests, &mode])
                    .await?;
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

/// The enqueue request PostgreSQL creates a child from, which inherits the parent's trace.
fn child_request(
    parent: &ClaimedTask,
    task_type: &str,
    payload: Value,
    options: &EnqueueOptions,
) -> Result<Value, Error> {
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
    let mut input: Map<String, Value> = task_input(
        "default",
        task_type,
        &payload,
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
    Ok(Value::Object(input))
}
