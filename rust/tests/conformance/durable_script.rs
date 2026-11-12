//! The executor of the `durable-script` fixtures (SM-1950).
//!
//! A handler runs the fixture's script through its handler context, and the runner drives the task
//! through the fixture's steps. `protocol/README.md` describes the operations and the steps. The
//! phase `suspend` runs the steps before `handOff`, and `replay` runs the steps after it, so two
//! SDKs can share one task. `all` runs every step and resets the counters at `handOff`.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde_json::{json, Map, Value};
use tokio::sync::Notify;
use tokio::time::Instant;
use tokio_postgres::NoTls;
use uuid::Uuid;
use workhorse::{
    ChildOutcome, ChildTaskRequest, EnqueueOptions, HandlerContext, HandlerError, Queue, Worker,
    WorkerOptions,
};

type Checked<T = ()> = Result<T, String>;

/// A bound on the claims of one `run` step, so a defect cannot loop for ever. The `run_once` of
/// each SDK can claim more than one task, so a step names the work that ends, not a count of
/// claims.
const MAXIMUM_DRAIN_PASSES: usize = 20;

#[derive(Default)]
struct Counters {
    handler_runs: AtomicUsize,
    checkpoint_operations: AtomicUsize,
    caught_suspensions: AtomicUsize,
    /// Handler runs that reached the end of the script. A run that suspends never does.
    completed_scripts: AtomicUsize,
    /// Timer, wait, and child calls that returned. A call that suspends never returns.
    returned_suspending_calls: AtomicUsize,
}

/// The operations that can suspend the task.
const SUSPENDING: &[&str] = &["sleep", "sleepUntil", "waitForSignal", "waitForHuman", "runChild"];

fn text<'a>(value: &'a Value, field: &str) -> Checked<&'a str> {
    value[field].as_str().ok_or_else(|| format!("the field {field} is not text"))
}

fn queue_name(fixture: &Value) -> Checked<String> {
    Ok(format!("runtime-{}", text(fixture, "id")?))
}

fn worker(url: &str, queue: &str, worker_id: String) -> Checked<Worker> {
    let config = url.parse().map_err(|error: tokio_postgres::Error| error.to_string())?;
    let manager = deadpool_postgres::Manager::new(config, NoTls);
    let pool = deadpool_postgres::Pool::builder(manager)
        .max_size(4)
        .build()
        .map_err(|error| error.to_string())?;
    let mut options = WorkerOptions::default();
    options.queues = vec![queue.to_owned()];
    options.worker_id = Some(worker_id);
    options.concurrency = 1;
    options.polling_only = true;
    options.disable_registry = true;
    options.poll_interval = Some(Duration::from_millis(5));
    Worker::new(pool, options).map_err(|error| error.to_string())
}

/// Runs the steps of `phase` against the database at `url`.
pub async fn run_phase(url: &str, fixture: &Value, phase: &str) -> Checked {
    let id = text(fixture, "id")?.to_owned();
    let steps = fixture["steps"].as_array().ok_or("steps is not an array")?;
    let hand_off = steps.iter().position(|step| step["action"] == "handOff");
    let steps: &[Value] = match (phase, hand_off) {
        ("all", _) => steps,
        ("suspend", Some(index)) => &steps[..index],
        ("replay", Some(index)) => &steps[index + 1..],
        _ => return Err(format!("{id} cannot run the phase {phase}")),
    };
    let (client, connection) =
        tokio_postgres::connect(url, NoTls).await.map_err(|error| error.to_string())?;
    tokio::spawn(connection);
    let task_type = text(fixture, "taskType")?.to_owned();
    let task_id: Uuid = if phase == "replay" {
        let rows = client
            .query("SELECT id FROM workhorse.task WHERE task_type = $1", &[&task_type])
            .await
            .map_err(|error| error.to_string())?;
        match rows.as_slice() {
            [row] => row.get(0),
            _ => return Err(format!("expected one {task_type} task, found {}", rows.len())),
        }
    } else {
        let payload = match fixture["payloadSql"].as_str() {
            Some(statement) => {
                let row =
                    client.query_one(statement, &[]).await.map_err(|error| error.to_string())?;
                serde_json::from_str::<Value>(&row.get::<_, String>(0))
                    .map_err(|error| error.to_string())?
            }
            None => json!({}),
        };
        let queue = Queue::connect(url, &queue_name(fixture)?).await.map_err(|e| e.to_string())?;
        queue
            .enqueue(&task_type, &payload, EnqueueOptions::default())
            .await
            .map_err(|error| error.to_string())?
            .task_id
    };

    let counters = Arc::new(Counters::default());
    let task_worker = worker(url, &queue_name(fixture)?, format!("rust-{id}"))?;
    let (script, handled) = (Arc::new(fixture.clone()), Arc::clone(&counters));
    task_worker.handle(&task_type, move |payload: Value, context: HandlerContext| {
        let (script, counters) = (Arc::clone(&script), Arc::clone(&handled));
        async move { run_script(&script, payload, &context, &counters).await }
    });
    let child_worker = match (fixture["childTaskType"].as_str(), fixture["childQueue"].as_str()) {
        (Some(child_type), Some(child_queue)) => {
            let children = worker(url, child_queue, format!("rust-{id}-children"))?;
            children.handle(child_type, |payload: Value, _: HandlerContext| async move {
                Ok::<_, HandlerError>(json!({ "echo": payload }))
            });
            Some(children)
        }
        _ => None,
    };

    for (index, step) in steps.iter().enumerate() {
        let action = text(step, "action")?;
        let place = format!("{id} step {} ({action})", index + 1);
        match action {
            "run" => {
                let selected = match step["worker"].as_str().unwrap_or("task") {
                    "child" => child_worker.as_ref().ok_or("the fixture has no child queue")?,
                    _ => &task_worker,
                };
                drain(selected, &place).await?;
            }
            "sql" => {
                client
                    .execute(text(step, "sql")?, &[&task_id])
                    .await
                    .map_err(|error| format!("{place}: {error}"))?;
            }
            "handOff" => {
                counters.handler_runs.store(0, Ordering::SeqCst);
                counters.checkpoint_operations.store(0, Ordering::SeqCst);
                counters.caught_suspensions.store(0, Ordering::SeqCst);
                counters.completed_scripts.store(0, Ordering::SeqCst);
                counters.returned_suspending_calls.store(0, Ordering::SeqCst);
            }
            "expect" => {
                let statement = text(fixture, "observe")?;
                let row = client
                    .query_one(statement, &[&task_id])
                    .await
                    .map_err(|error| format!("{place}: {error}"))?;
                let observed: Value = serde_json::from_str(&row.get::<_, String>(0))
                    .map_err(|error| error.to_string())?;
                let mut expected = step["observed"].clone();
                // The runner puts the error name of its SDK into the observed value it expects.
                if let Some(names) = step.get("errorNames") {
                    let name = names["rust"].clone();
                    let Some(object) = expected.as_object_mut().filter(|_| name.is_string()) else {
                        return Err(format!(
                            "{place}: errorNames needs an observed object and a name for rust"
                        ));
                    };
                    object.insert("errorName".to_owned(), name);
                }
                if observed != expected {
                    return Err(format!("{place}: observed {observed}, expected {expected}"));
                }
                for (name, counter) in [
                    ("handlerRuns", &counters.handler_runs),
                    ("checkpointOperations", &counters.checkpoint_operations),
                    ("caughtSuspensions", &counters.caught_suspensions),
                    ("completedScripts", &counters.completed_scripts),
                    ("returnedSuspendingCalls", &counters.returned_suspending_calls),
                ] {
                    let actual = counter.load(Ordering::SeqCst) as u64;
                    if let Some(expected) = step[name].as_u64() {
                        if actual != expected {
                            return Err(format!(
                                "{place}: {name} is {actual}, expected {expected}"
                            ));
                        }
                    }
                }
            }
            other => return Err(format!("{place}: unknown action {other}")),
        }
    }
    Ok(())
}

async fn drain(worker: &Worker, place: &str) -> Checked {
    for pass in 0..=MAXIMUM_DRAIN_PASSES {
        let processed = worker.run_once().await.map_err(|error| format!("{place}: {error}"))?;
        if !processed {
            return if pass == 0 {
                Err(format!("{place}: the worker claimed no task"))
            } else {
                Ok(())
            };
        }
    }
    Err(format!("{place}: the queue did not drain"))
}

async fn run_script(
    fixture: &Value,
    payload: Value,
    context: &HandlerContext,
    counters: &Counters,
) -> Result<Value, HandlerError> {
    counters.handler_runs.fetch_add(1, Ordering::SeqCst);
    let mut result = Map::new();
    for operation in fixture["script"].as_array().into_iter().flatten() {
        let key = operation["key"].as_str().map(str::to_owned);
        if operation["op"] == "catchSuspension" {
            let caught = run_operation(fixture, &operation["step"], &payload, context, counters)
                .await
                .is_err();
            if caught {
                // The handler catches the suspension and returns. The worker must suspend the task
                // anyway.
                counters.caught_suspensions.fetch_add(1, Ordering::SeqCst);
                return Ok(json!({ key.unwrap_or_default(): true }));
            }
            result.insert(key.unwrap_or_default(), json!(false));
            continue;
        }
        let value = run_operation(fixture, operation, &payload, context, counters).await?;
        if let Some(key) = key {
            result.insert(key, value);
        }
    }
    counters.completed_scripts.fetch_add(1, Ordering::SeqCst);
    Ok(Value::Object(result))
}

fn payload_time(payload: &Value, field: &str) -> Result<DateTime<Utc>, HandlerError> {
    let value = payload[field]
        .as_str()
        .ok_or_else(|| HandlerError::new(format!("the payload field {field} is not text")))?;
    DateTime::parse_from_rfc3339(value)
        .map(|time| time.with_timezone(&Utc))
        .map_err(|error| HandlerError::new(error.to_string()))
}

fn child_queue(fixture: &Value) -> Option<String> {
    fixture["childQueue"].as_str().map(str::to_owned)
}

fn child_type(fixture: &Value) -> Result<&str, HandlerError> {
    fixture["childTaskType"].as_str().ok_or_else(|| HandlerError::new("no childTaskType"))
}

async fn run_operation(
    fixture: &Value,
    operation: &Value,
    payload: &Value,
    context: &HandlerContext,
    counters: &Counters,
) -> Result<Value, HandlerError> {
    let value = run_operation_once(fixture, operation, payload, context, counters).await?;
    if SUSPENDING.contains(&operation["op"].as_str().unwrap_or_default()) {
        counters.returned_suspending_calls.fetch_add(1, Ordering::SeqCst);
    }
    Ok(value)
}

async fn run_operation_once(
    fixture: &Value,
    operation: &Value,
    payload: &Value,
    context: &HandlerContext,
    counters: &Counters,
) -> Result<Value, HandlerError> {
    let name = operation["name"].as_str().unwrap_or_default();
    match operation["op"].as_str().unwrap_or_default() {
        "checkpoint" => {
            let value = operation["value"].clone();
            let run = || async move {
                counters.checkpoint_operations.fetch_add(1, Ordering::SeqCst);
                Ok(value)
            };
            if operation.get("input").is_some() {
                context.checkpoint_with_input(name, &operation["input"], run).await
            } else {
                context.checkpoint(name, run).await
            }
        }
        "sleep" => {
            let millis = operation["durationMs"].as_u64().unwrap_or_default();
            context.sleep(name, Duration::from_millis(millis)).await?;
            Ok(Value::Null)
        }
        "sleepUntil" => {
            let wake_at =
                payload_time(payload, text(operation, "wakeAtField").unwrap_or_default())?;
            context.sleep_until(name, wake_at).await?;
            Ok(Value::Null)
        }
        "waitForSignal" => Ok(context.wait_for_signal::<Value>(name, None).await?.payload),
        "waitForHuman" => Ok(context
            .wait_for_human::<Value, Value>(name, &operation["context"], None)
            .await?
            .result),
        "runChild" => {
            let mut options = {
                let mut enqueue_options = EnqueueOptions::default();
                enqueue_options.queue = child_queue(fixture);
                enqueue_options
            };
            if let Some(field) = operation["deadlineField"].as_str() {
                options.deadline = Some(payload_time(payload, field)?);
            }
            if let Some(field) = operation["runAtField"].as_str() {
                options.run_at = Some(payload_time(payload, field)?);
            }
            let child = child_type(fixture)?;
            Ok(context
                .run_child::<Value, Value>(name, child, &operation["payload"], options)
                .await?)
        }
        "runChildren" => {
            let child = child_type(fixture)?;
            let requests = operation["children"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|request| {
                    let mut child_request = ChildTaskRequest::new(
                        request["name"].as_str().unwrap_or_default(),
                        child,
                        &request["payload"],
                    )?;
                    child_request.options.queue = child_queue(fixture);
                    Ok(child_request)
                })
                .collect::<Result<Vec<_>, workhorse::Error>>()?;
            let outcomes = context.run_children(requests).await?;
            // The set join counts as returned before the runner reads its outcomes, so a wrong
            // value still counts.
            counters.returned_suspending_calls.fetch_add(1, Ordering::SeqCst);
            Ok(Value::Object(
                outcomes
                    .into_iter()
                    .map(|(name, outcome)| {
                        let outcome = match outcome {
                            ChildOutcome::Succeeded(result) => {
                                json!({ "status": "succeeded", "result": result })
                            }
                            ChildOutcome::Failed(_) => json!({ "status": "failed" }),
                            ChildOutcome::Canceled => json!({ "status": "canceled" }),
                            other => json!({ "status": format!("{other:?}") }),
                        };
                        (name, outcome)
                    })
                    .collect(),
            ))
        }
        "overlappingCheckpoints" => {
            let window =
                Duration::from_millis(operation["overlapWindowMs"].as_u64().unwrap_or_default());
            overlapping_checkpoints(name, window, context, counters).await
        }
        other => Err(HandlerError::new(format!("unknown durable-script operation {other}"))),
    }
}

/// Starts a second call with one name while the operation of the first call runs. The operation
/// waits until a second operation starts or the window ends, so a call that does not join the call
/// in flight runs the operation again.
async fn overlapping_checkpoints(
    name: &str,
    window: Duration,
    context: &HandlerContext,
    counters: &Counters,
) -> Result<Value, HandlerError> {
    let started = Notify::new();
    let operation = || async {
        let ordinal = counters.checkpoint_operations.fetch_add(1, Ordering::SeqCst) + 1;
        started.notify_one();
        let deadline = Instant::now() + window;
        while counters.checkpoint_operations.load(Ordering::SeqCst) < 2 && Instant::now() < deadline
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        Ok(json!({ "operation": ordinal }))
    };
    let (first, second) = tokio::join!(context.checkpoint::<Value, _, _>(name, operation), async {
        started.notified().await;
        context.checkpoint::<Value, _, _>(name, operation).await
    });
    Ok(json!([first?, second?]))
}
