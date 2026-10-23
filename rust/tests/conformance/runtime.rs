//! Executors for the `failures` and `runtime` fixtures, which drive the Rust worker.
//!
//! Each fixture runs in its own scratch database and mirrors the Go lane's executor for the same
//! fixture kind. A database stall that PostgreSQL controls stands in for a timing assumption
//! wherever the fixture measures ordering or cadence.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::Instant;
use tokio_postgres::{Client, NoTls};
use uuid::Uuid;
use workhorse::policies::{BudgetDefinition, RateLimit, RateLimitPolicyDefinition};
use workhorse::{
    Admin, AdminAudit, BatchItem, BatchOptions, BatchResult, CancelReason, CancelStatus,
    EnqueueOptions, Error, HandlerContext, HandlerError, Queue, QueueTier, Worker, WorkerOptions,
};

use super::database::describe;
use super::ledger::Outcome;
use crate::support::{scratch_database, ScratchDatabase};

const FIXTURE_TIMEOUT: Duration = Duration::from_secs(30);
const WAIT: Duration = Duration::from_secs(10);

type Checked<T = ()> = Result<T, String>;

/// Runs one fixture from `failures.json` against the envelope the file declares.
pub async fn run_failure(fixture: &Value, envelope: &Value) -> Outcome {
    let name = format!("failure_{}", text(fixture, "id"));
    let Some(database) = scratch(&name).await else { return unset() };
    bounded(&name, failure(&database, fixture, envelope)).await
}

/// Runs one fixture from `runtime.json`.
pub async fn run_runtime(fixture: &Value) -> Outcome {
    let kind = text(fixture, "kind");
    match kind {
        #[cfg(not(feature = "opentelemetry"))]
        "trace-propagation" => {
            return Outcome::Skipped("the opentelemetry feature is off".into());
        }
        _ => {}
    }
    let name = format!("runtime_{}", text(fixture, "id"));
    let Some(database) = scratch(&name).await else { return unset() };
    let database = &database;
    let executor = async move {
        match kind {
            #[cfg(feature = "opentelemetry")]
            "trace-propagation" => trace::propagation(database, fixture).await,
            "suspension-replay" => suspension_replay(database, fixture).await,
            "replay-conflict" => replay_conflict(database, fixture).await,
            "lease-loss" => lease_loss(database, fixture).await,
            "batch" => batch(database, fixture).await,
            "cooperative-cancellation" => cooperative_cancellation(database, fixture).await,
            "expiration" => expiration(database, fixture).await,
            "heartbeat-cadence" => heartbeat_cadence(database, fixture).await,
            "poll-cadence" => poll_cadence(database, fixture).await,
            "subscription-recovery" => subscription_recovery(database, fixture).await,
            "graceful-drain" => graceful_drain(database, fixture).await,
            "slot-refill" => slot_refill(database, fixture).await,
            "budget-admission-race" => budget_admission_race(database, fixture).await,
            "missing-handler" => missing_handler(database, fixture).await,
            "release-wait" => release_wait(database, fixture).await,
            "json-round-trip" => json_round_trip(database, fixture).await,
            "oversized-result" => oversized_result(database, fixture).await,
            "shutdown-cancellation" => shutdown_cancellation(database, fixture).await,
            "heartbeat-failure" => heartbeat_failure(database, fixture).await,
            "heartbeat-busy" => heartbeat_busy(database, fixture).await,
            "maintenance-phase-error" => maintenance_phase_error(database, fixture).await,
            other => Err(format!("the Rust runner does not know runtime kind {other}")),
        }
    };
    bounded(&name, executor).await
}

async fn scratch(name: &str) -> Option<ScratchDatabase> {
    scratch_database(&name.replace('-', "_")).await
}

fn unset() -> Outcome {
    Outcome::Skipped("DATABASE_URL_TEST is unset".into())
}

/// Bounds an executor so a stall fails its fixture instead of hanging the runner.
async fn bounded(name: &str, executor: impl std::future::Future<Output = Checked>) -> Outcome {
    match tokio::time::timeout(FIXTURE_TIMEOUT, executor).await {
        Ok(Ok(())) => Outcome::Passed,
        Ok(Err(reason)) => Outcome::Failed(reason),
        Err(_) => Outcome::Failed(format!("{name} did not finish within {FIXTURE_TIMEOUT:?}")),
    }
}

fn text<'a>(fixture: &'a Value, field: &str) -> &'a str {
    fixture[field].as_str().unwrap_or_else(|| panic!("fixture field {field} is not a string"))
}

fn number(fixture: &Value, field: &str) -> i64 {
    fixture[field].as_i64().unwrap_or_else(|| panic!("fixture field {field} is not an integer"))
}

fn millis(fixture: &Value, field: &str) -> Duration {
    Duration::from_millis(u64::try_from(number(fixture, field)).expect("a positive duration"))
}

fn queue_name(fixture: &Value) -> String {
    format!("runtime-{}", text(fixture, "id"))
}

fn check(condition: bool, message: impl FnOnce() -> String) -> Checked {
    if condition {
        Ok(())
    } else {
        Err(message())
    }
}

fn driver(error: Error) -> String {
    error.to_string()
}

fn sql(error: tokio_postgres::Error) -> String {
    describe(&error)
}

async fn queue(database: &ScratchDatabase, fixture: &Value) -> Checked<Queue<Client>> {
    Queue::connect(database.url(), &queue_name(fixture)).await.map_err(driver)
}

fn worker(database: &ScratchDatabase, pool_size: usize, options: WorkerOptions) -> Checked<Worker> {
    let config = database.url().parse().map_err(sql)?;
    let manager = deadpool_postgres::Manager::new(config, NoTls);
    let pool = deadpool_postgres::Pool::builder(manager)
        .max_size(pool_size)
        .build()
        .map_err(|error| error.to_string())?;
    Worker::new(pool, options).map_err(driver)
}

fn options(fixture: &Value) -> WorkerOptions {
    WorkerOptions {
        queues: vec![queue_name(fixture)],
        worker_id: Some(format!("rust-{}", text(fixture, "id"))),
        polling_only: true,
        disable_registry: true,
        poll_interval: Some(Duration::from_millis(5)),
        ..WorkerOptions::default()
    }
}

fn lease_options(fixture: &Value) -> WorkerOptions {
    WorkerOptions {
        lease_duration: millis(fixture, "leaseMs"),
        heartbeat_interval: Some(millis(fixture, "heartbeatMs")),
        ..options(fixture)
    }
}

/// Runs `worker` in the background; sending on the returned channel starts its shutdown.
fn run(worker: &Worker) -> (oneshot::Sender<()>, tokio::task::JoinHandle<Result<(), Error>>) {
    let (stop, stopped) = oneshot::channel::<()>();
    let worker = worker.clone();
    let running = tokio::spawn(async move {
        worker
            .run(async move {
                let _ = stopped.await;
            })
            .await
    });
    (stop, running)
}

async fn run_once(worker: &Worker, expected: bool) -> Checked {
    let processed = worker.run_once().await.map_err(driver)?;
    check(processed == expected, || format!("run_once() processed={processed}, want {expected}"))
}

async fn eventually<F, Fut>(message: &str, predicate: F) -> Checked
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Checked<bool>>,
{
    eventually_within(WAIT, message, predicate).await
}

async fn eventually_within<F, Fut>(limit: Duration, message: &str, mut predicate: F) -> Checked
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Checked<bool>>,
{
    let deadline = Instant::now() + limit;
    while Instant::now() < deadline {
        if predicate().await? {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    Err(message.to_owned())
}

/// The state, attempt, and error name, wherever the task currently lives.
async fn task_state(client: &Client, task: Uuid) -> Checked<(String, i32, String)> {
    let row = client
        .query_one(
            "SELECT state::text, current_attempt, coalesce(error->>'name', '')
               FROM workhorse.task_runtime WHERE task_id = $1
             UNION ALL
             SELECT state::text, current_attempt, coalesce(error->>'name', '')
               FROM workhorse.task_outcome WHERE task_id = $1",
            &[&task],
        )
        .await
        .map_err(sql)?;
    Ok((row.get(0), row.get(1), row.get(2)))
}

async fn assert_state(client: &Client, task: Uuid, expected: &Value) -> Checked {
    let (state, attempt, error) = task_state(client, task).await?;
    let want_state = text(expected, "state");
    let want_attempt = number(expected, "attempt");
    check(state == want_state && i64::from(attempt) == want_attempt, || {
        format!("task {task} is {state}/{attempt}, want {want_state}/{want_attempt}")
    })?;
    match expected["errorName"].as_str() {
        Some(name) if !name.is_empty() => {
            check(error == name, || format!("task {task} failed with {error:?}, want {name:?}"))
        }
        _ => Ok(()),
    }
}

async fn attempt_outcomes(client: &Client, task: Uuid) -> Checked<Vec<String>> {
    let rows = client
        .query(
            "SELECT outcome::text FROM workhorse.attempt_history WHERE task_id = $1 ORDER BY attempt",
            &[&task],
        )
        .await
        .map_err(sql)?;
    Ok(rows.iter().map(|row| row.get(0)).collect())
}

async fn assert_outcomes(client: &Client, task: Uuid, expected: &[&str]) -> Checked {
    let outcomes = attempt_outcomes(client, task).await?;
    check(outcomes == expected, || format!("attempt outcomes {outcomes:?}, want {expected:?}"))
}

fn strings(value: &Value) -> Vec<&str> {
    value.as_array().into_iter().flatten().filter_map(Value::as_str).collect()
}

async fn failure(database: &ScratchDatabase, fixture: &Value, envelope: &Value) -> Checked {
    let client = database.connect().await;
    let queue = Queue::connect(database.url(), "failures").await.map_err(driver)?;
    let task_type = "protocol.failure";
    let options = EnqueueOptions { max_attempts: 1, ..Default::default() };
    let task = queue.enqueue(task_type, &json!({}), options).await.map_err(driver)?.task_id;
    let redacted = fixture["redactErrorDetails"].as_bool() == Some(true);
    if redacted {
        client
            .execute(
                "UPDATE workhorse.task SET payload_redact_keys = ARRAY['secret'] WHERE id = $1",
                &[&task],
            )
            .await
            .map_err(sql)?;
    }
    let declared = &fixture["error"];
    let message = fixture_message(&declared["message"])?;
    // The stack repeats the message, as a real stack does, so a stack that jsonb refuses fails here.
    let stack = format!("PaymentDeclined: {message}\n    at fixture");
    let mut error = HandlerError::new(message);
    error.name =
        (declared["declaresName"].as_bool() == Some(true)).then(|| "PaymentDeclined".into());
    error.stack = (declared["declaresStack"].as_bool() == Some(true)).then_some(stack);
    let worker = worker(
        database,
        4,
        WorkerOptions { queues: vec!["failures".into()], ..options_without_queue() },
    )?;
    worker.handle(task_type, move |_: Value, _| {
        let error = error.clone();
        async move { Err::<Value, _>(error) }
    });
    run_once(&worker, true).await?;
    let stored: Value = client
        .query_one("SELECT error FROM workhorse.task_outcome WHERE task_id = $1", &[&task])
        .await
        .map_err(sql)?
        .get(0);
    let fields = if redacted { &envelope["redactedFields"] } else { &envelope["fields"] };
    let mut want: Vec<&str> = strings(fields);
    want.sort_unstable();
    let mut keys: Vec<&str> =
        stored.as_object().into_iter().flatten().map(|(key, _)| key.as_str()).collect();
    keys.sort_unstable();
    check(keys == want, || format!("envelope fields {keys:?}, want {want:?}"))?;
    let expected = &fixture["envelope"];
    let mut name = text(expected, "name");
    if name == "$generic" {
        name = text(&envelope["genericName"], "rust");
    }
    check(stored["name"] == name, || format!("envelope name {}, want {name}", stored["name"]))?;
    check(stored["message"] == expected["message"], || {
        format!("envelope message {}, want {}", stored["message"], expected["message"])
    })?;
    match expected["stack"].as_str() {
        Some("string") => {
            check(stored["stack"].as_str().is_some_and(|stack| !stack.is_empty()), || {
                format!("envelope stack {} is not a string", stored["stack"])
            })?
        }
        Some("stringOrNull") => {
            check(stored["stack"].is_null() || stored["stack"].is_string(), || {
                format!("envelope stack {} is neither a string nor null", stored["stack"])
            })?
        }
        _ => {}
    }
    let recorded = stored["name"].as_str().unwrap_or_default();
    for character in strings(&envelope["forbiddenNameCharacters"]) {
        check(!recorded.contains(character), || {
            format!("envelope name {recorded:?} contains {character:?}")
        })?;
    }
    Ok(())
}

/// The message a failures fixture describes. A Rust `String` holds only UTF-8, so an unpaired
/// surrogate becomes the text that `String::from_utf8_lossy` makes from the byte 0xFF, which is the
/// nearest input a Rust handler can produce.
fn fixture_message(message: &Value) -> Checked<String> {
    if let Some(text) = message.as_str() {
        return Ok(text.to_owned());
    }
    let parts = message.as_array().ok_or_else(|| format!("message {message} is not text"))?;
    let mut built = String::new();
    for part in parts {
        match (part.as_str(), part["unpairedSurrogate"].as_str()) {
            (Some(text), _) => built.push_str(text),
            (None, Some(_)) => built.push_str(&String::from_utf8_lossy(&[0xFF])),
            (None, None) => return Err(format!("message part {part} is not text or a surrogate")),
        }
    }
    Ok(built)
}

fn options_without_queue() -> WorkerOptions {
    WorkerOptions {
        worker_id: Some(format!("rust-failure-{}", Uuid::new_v4())),
        polling_only: true,
        disable_registry: true,
        poll_interval: Some(Duration::from_millis(5)),
        ..WorkerOptions::default()
    }
}

#[cfg(feature = "opentelemetry")]
mod trace {
    use std::sync::OnceLock;

    use opentelemetry::context::FutureExt;
    use opentelemetry::trace::{Span, TraceContextExt, Tracer, TracerProvider};
    use opentelemetry::Context;
    use opentelemetry_sdk::trace::{InMemorySpanExporter, SdkTracerProvider};
    use serde_json::{json, Value};
    use tracing_subscriber::layer::SubscriberExt;

    use super::{check, driver, options, queue, run_once, sql, text, worker, Checked};
    use crate::support::ScratchDatabase;

    struct Telemetry {
        provider: SdkTracerProvider,
        exporter: InMemorySpanExporter,
    }

    /// One process-wide subscriber that exports the worker's spans to memory.
    fn telemetry() -> &'static Telemetry {
        static TELEMETRY: OnceLock<Telemetry> = OnceLock::new();
        TELEMETRY.get_or_init(|| {
            let exporter = InMemorySpanExporter::default();
            let provider =
                SdkTracerProvider::builder().with_simple_exporter(exporter.clone()).build();
            let layer = tracing_opentelemetry::layer().with_tracer(provider.tracer("workhorse"));
            tracing::subscriber::set_global_default(tracing_subscriber::registry().with(layer))
                .expect("the conformance runner installs the only global subscriber");
            Telemetry { provider, exporter }
        })
    }

    pub(super) async fn propagation(database: &ScratchDatabase, fixture: &Value) -> Checked {
        let telemetry = telemetry();
        let queue = queue(database, fixture).await?;
        let task_type = text(fixture, "taskType");
        let caller = telemetry.provider.tracer("runtime-fixture").start("caller");
        let caller_context = caller.span_context().clone();
        let context = Context::current_with_span(caller);
        let task = queue
            .enqueue(task_type, &json!({}), Default::default())
            .with_context(context.clone())
            .await
            .map_err(driver)?
            .task_id;
        context.span().end();
        let stored: Option<Value> = database
            .connect()
            .await
            .query_one("SELECT trace_context FROM workhorse.task WHERE id = $1", &[&task])
            .await
            .map_err(sql)?
            .get(0);
        let parent = stored
            .as_ref()
            .and_then(|stored| stored["traceparent"].as_str())
            .ok_or_else(|| format!("the task stored no traceparent: {stored:?}"))?
            .to_owned();
        let parts: Vec<&str> = parent.split('-').collect();
        check(parts.len() == 4, || format!("stored traceparent is invalid: {parent:?}"))?;

        let worker = worker(database, 4, options(fixture))?;
        worker.handle(task_type, |_: Value, _| async { Ok(Value::Null) });
        run_once(&worker, true).await?;
        let spans = telemetry.exporter.get_finished_spans().map_err(|error| error.to_string())?;
        let span = spans
            .iter()
            .find(|span| {
                span.name == "workhorse.handler"
                    && span.span_context.trace_id() == caller_context.trace_id()
            })
            .ok_or("the worker exported no workhorse.handler span in the caller's trace")?;
        check(span.parent_span_id.to_string() == parts[2], || {
            format!(
                "handler parent {} does not match stored span {}",
                span.parent_span_id, parts[2]
            )
        })
    }
}

async fn batch(database: &ScratchDatabase, fixture: &Value) -> Checked {
    let client = database.connect().await;
    let queue = queue(database, fixture).await?;
    let task_type = text(fixture, "taskType");
    let mut tasks = Vec::new();
    for task in fixture["tasks"].as_array().ok_or("the fixture declares no tasks")? {
        let key = text(task, "key").to_owned();
        let mut retry = serde_json::Map::new();
        retry.insert("type".into(), json!("fixed"));
        retry.insert("delayMs".into(), json!(0));
        let options = EnqueueOptions {
            priority: i32::try_from(number(task, "priority")).map_err(|error| error.to_string())?,
            max_attempts: i32::try_from(number(task, "maxAttempts"))
                .map_err(|error| error.to_string())?,
            retry_policy: json!({ "type": "fixed", "delayMs": 0 }).as_object().cloned(),
            ..Default::default()
        };
        let payload = json!({"key": key, "outcome": task["outcome"]});
        let id = queue.enqueue(task_type, &payload, options).await.map_err(driver)?.task_id;
        tasks.push((key, id));
    }
    let concurrency = usize::try_from(number(fixture, "concurrency")).unwrap_or(1);
    let max_size = usize::try_from(number(fixture, "batchMaxSize")).unwrap_or(1);
    let worker = worker(
        database,
        6,
        WorkerOptions { concurrency, lease_duration: Duration::from_secs(1), ..options(fixture) },
    )?;
    let order = Arc::new(Mutex::new(Vec::<String>::new()));
    let stopper = Arc::new(Mutex::new(None::<oneshot::Sender<()>>));
    let (recorded, stop) = (Arc::clone(&order), Arc::clone(&stopper));
    worker.handle_batch(
        task_type,
        BatchOptions { max_size, linger: Duration::from_secs(1) },
        move |items: Vec<BatchItem<Value>>| {
            let results = items
                .iter()
                .map(|item| {
                    let key = item.payload["key"].as_str().unwrap_or_default().to_owned();
                    let succeeds =
                        item.payload["outcome"] == "succeed" || item.context.task().attempt > 1;
                    recorded.lock().unwrap().push(key.clone());
                    if succeeds {
                        BatchResult::Succeeded(json!({"key": key}))
                    } else {
                        BatchResult::Failed(HandlerError::named("BatchFixture", key))
                    }
                })
                .collect::<Vec<_>>();
            if let Some(stop) = stop.lock().unwrap().take() {
                let _ = stop.send(());
            }
            async move { results }
        },
    );
    for expectation in ["expectedAfterFirstRun", "expectedAfterSecondRun"] {
        let (sender, running) = run(&worker);
        *stopper.lock().unwrap() = Some(sender);
        running.await.map_err(|error| error.to_string())?.map_err(driver)?;
        for (key, id) in &tasks {
            assert_state(&client, *id, &fixture[expectation][key.as_str()])
                .await
                .map_err(|error| format!("{expectation} {key}: {error}"))?;
        }
    }
    let order = order.lock().unwrap().clone();
    let expected = strings(&fixture["expectedHandlerOrder"]);
    check(order.len() > expected.len() && order[..expected.len()] == expected[..], || {
        format!("batch handler order {order:?}, want {expected:?} first")
    })
}

async fn cooperative_cancellation(database: &ScratchDatabase, fixture: &Value) -> Checked {
    let client = database.connect().await;
    let queue = queue(database, fixture).await?;
    let task_type = text(fixture, "taskType");
    let task = queue.enqueue(task_type, &json!({}), Default::default()).await.map_err(driver)?;
    let worker = worker(database, 4, lease_options(fixture))?;
    let (started, mut handler_started) = mpsc::unbounded_channel();
    let reason = Arc::new(Mutex::new(None));
    let observed = Arc::clone(&reason);
    worker.handle(task_type, move |_: Value, context: HandlerContext| {
        let (started, observed) = (started.clone(), Arc::clone(&observed));
        async move {
            let _ = started.send(());
            context.cancellation().cancelled().await;
            *observed.lock().unwrap() = context.cancellation().reason();
            Err::<Value, _>(HandlerError::new("cancelled"))
        }
    });
    let running = {
        let worker = worker.clone();
        tokio::spawn(async move { worker.run_once().await })
    };
    handler_started.recv().await.ok_or("the handler never started")?;
    let cancel = queue
        .cancel(task.task_id, Some("rust-runtime-fixture"), Some(text(fixture, "cancelReason")))
        .await
        .map_err(driver)?;
    check(cancel.status == CancelStatus::CancelRequested, || {
        format!("cancel returned {:?}, want CancelRequested", cancel.status)
    })?;
    let processed = running.await.map_err(|error| error.to_string())?.map_err(driver)?;
    check(processed, || "run_once() processed nothing".into())?;
    let reason = *reason.lock().unwrap();
    check(reason == Some(abort_reason(text(fixture, "expectedAbortReason"))?), || {
        format!("the handler observed {reason:?}")
    })?;
    assert_state(&client, task.task_id, &fixture["expectedState"]).await?;
    assert_outcomes(&client, task.task_id, &[text(fixture, "expectedAttemptOutcome")]).await
}

fn abort_reason(name: &str) -> Checked<CancelReason> {
    Ok(match name {
        "CancellationRequestedError" => CancelReason::Requested,
        "DeadlineExceededError" => CancelReason::DeadlineExceeded,
        "ExecutionTimeoutError" => CancelReason::ExecutionTimeout,
        other => return Err(format!("no Rust cancel reason corresponds to {other}")),
    })
}

/// Holds the database's expiry `localClockLeadMs` away from the one the worker was told, so the
/// local timer and PostgreSQL disagree about when the attempt ends.
async fn expiration(database: &ScratchDatabase, fixture: &Value) -> Checked {
    let client = database.connect().await;
    let queue = queue(database, fixture).await?;
    let task_type = text(fixture, "taskType");
    let duration = number(fixture, "durationMs");
    let deadline = text(fixture, "mode") == "deadline";
    let mut retry = serde_json::Map::new();
    retry.insert("type".into(), json!("fixed"));
    retry.insert("delayMs".into(), json!(0));
    let mut options = EnqueueOptions {
        max_attempts: i32::try_from(number(fixture, "maxAttempts")).unwrap_or(1),
        retry_policy: json!({ "type": "fixed", "delayMs": 0 }).as_object().cloned(),
        ..Default::default()
    };
    if deadline {
        // The deadline is anchored to the claim, so the enqueue carries only a distant bound.
        client
            .batch_execute(&format!(
                "CREATE FUNCTION workhorse.test_anchor_deadline_at_claim() RETURNS trigger
                 LANGUAGE plpgsql AS $$
                 BEGIN
                   IF OLD.state = 'ready' AND NEW.state = 'active' THEN
                     NEW.deadline_at := clock_timestamp() + ({duration} * interval '1 millisecond');
                     UPDATE workhorse.task SET deadline_at = NEW.deadline_at WHERE id = NEW.task_id;
                   END IF;
                   RETURN NEW;
                 END
                 $$;
                 CREATE TRIGGER test_anchor_deadline_at_claim BEFORE UPDATE ON workhorse.task_runtime
                   FOR EACH ROW EXECUTE FUNCTION workhorse.test_anchor_deadline_at_claim()"
            ))
            .await
            .map_err(sql)?;
        options.deadline = Some(chrono::Utc::now() + chrono::Duration::hours(1));
    } else {
        options.execution_timeout_ms = Some(duration);
    }
    let task = queue.enqueue(task_type, &json!({}), options).await.map_err(driver)?.task_id;
    let column = if deadline { "deadline_at" } else { "attempt_timeout_at" };
    let lead = number(fixture, "localClockLeadMs") as f64;
    let reasons = Arc::new(Mutex::new(Vec::new()));
    let observed = Arc::clone(&reasons);
    // Whether PostgreSQL's clock had reached the expiry it held when each handler observed its
    // cancellation. Both times come from the database clock.
    let after_expiry = Arc::new(Mutex::new(Vec::new()));
    let compared = Arc::clone(&after_expiry);
    let url = database.url().to_owned();
    // A maintenance tick could settle the expiry first and turn the next heartbeat into `stale`, so
    // only the worker's own request settles it here.
    let options =
        WorkerOptions { maintenance_interval: Duration::from_secs(3600), ..lease_options(fixture) };
    let worker = worker(database, 4, options)?;
    worker.handle(task_type, move |_: Value, context: HandlerContext| {
        let (url, observed, compared) = (url.clone(), Arc::clone(&observed), Arc::clone(&compared));
        async move {
            let (client, connection) = tokio_postgres::connect(&url, NoTls).await?;
            tokio::spawn(connection);
            let statement = format!(
                "UPDATE workhorse.task_runtime SET {column} = {column} + ($2 * interval '1 millisecond')
                  WHERE task_id = $1 RETURNING {column}"
            );
            let expiry: chrono::DateTime<chrono::Utc> =
                client.query_one(&statement, &[&context.task().id, &lead]).await?.get(0);
            context.cancellation().cancelled().await;
            let after: bool =
                client.query_one("SELECT clock_timestamp() >= $1", &[&expiry]).await?.get(0);
            compared.lock().unwrap().push(after);
            observed.lock().unwrap().push(context.cancellation().reason());
            Ok(Value::Null)
        }
    });
    for (run, expected) in fixture["expectedAfterRuns"].as_array().into_iter().flatten().enumerate()
    {
        run_once(&worker, true).await?;
        assert_state(&client, task, expected)
            .await
            .map_err(|error| format!("run {run}: {error}"))?;
    }
    let reasons = reasons.lock().unwrap().clone();
    let expected = strings(&fixture["expectedAbortReasons"])
        .into_iter()
        .map(|name| abort_reason(name).map(Some))
        .collect::<Checked<Vec<_>>>()?;
    check(reasons == expected, || format!("handler abort reasons {reasons:?}, want {expected:?}"))?;
    let after_expiry = after_expiry.lock().unwrap().clone();
    let cancelled_after = fixture["expectedCancelledAfterDatabaseExpiry"] == json!(true);
    check(after_expiry == vec![cancelled_after; reasons.len()], || {
        format!("cancellation after the database expiry {after_expiry:?}")
    })?;
    assert_outcomes(&client, task, &strings(&fixture["expectedAttemptOutcomes"])).await
}

/// Gates the first heartbeat round in PostgreSQL, so a second round could only start concurrently.
async fn heartbeat_cadence(database: &ScratchDatabase, fixture: &Value) -> Checked {
    let client = database.connect().await;
    let heartbeat = number(fixture, "heartbeatMs");
    client
        .batch_execute(&format!(
            "ALTER FUNCTION workhorse.heartbeat_many_v2(text, jsonb) RENAME TO heartbeat_many_v2_inner;
             CREATE SEQUENCE workhorse.runtime_heartbeat_calls;
             CREATE SEQUENCE workhorse.runtime_heartbeat_overlaps;
             CREATE SEQUENCE workhorse.runtime_heartbeat_released;
             CREATE FUNCTION workhorse.heartbeat_many_v2(p_worker_id text, p_leases jsonb)
               RETURNS TABLE (ordinal bigint, task_id uuid, status text)
               LANGUAGE plpgsql AS $$
             DECLARE
               v_call bigint := nextval('workhorse.runtime_heartbeat_calls');
             BEGIN
               IF NOT pg_try_advisory_xact_lock(878878) THEN
                 PERFORM nextval('workhorse.runtime_heartbeat_overlaps');
               END IF;
               IF v_call = 1 THEN
                 WHILE NOT (SELECT is_called FROM workhorse.runtime_heartbeat_released) LOOP
                   PERFORM pg_sleep(0.005);
                 END LOOP;
               ELSE
                 PERFORM pg_sleep({seconds});
               END IF;
               RETURN QUERY SELECT * FROM workhorse.heartbeat_many_v2_inner(p_worker_id, p_leases);
             END
             $$;",
            seconds = 3.0 * heartbeat as f64 / 1000.0
        ))
        .await
        .map_err(sql)?;
    let counter = |sequence: &'static str| {
        let client = &client;
        async move {
            let row = client
                .query_one(&format!(
                        "SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM workhorse.{sequence}"
                    ), &[])
                .await
                .map_err(sql)?;
            Ok::<i64, String>(row.get(0))
        }
    };
    let queue = queue(database, fixture).await?;
    let task_type = text(fixture, "taskType");
    let task = queue.enqueue(task_type, &json!({}), Default::default()).await.map_err(driver)?;
    // A shared round is not bounded by the interval, so the gate holds it the way the TypeScript
    // executor's delayed heartbeatMany does, and only the round loop can keep the next one back.
    let options = WorkerOptions { shared_heartbeats: true, ..lease_options(fixture) };
    let worker = worker(database, 4, options)?;
    let (started, mut handler_started) = mpsc::unbounded_channel();
    let (release, released) = watch::channel(false);
    worker.handle(task_type, move |_: Value, _| {
        let (started, mut released) = (started.clone(), released.clone());
        async move {
            let _ = started.send(());
            let _ = released.wait_for(|released| *released).await;
            Ok(Value::Null)
        }
    });
    let running = {
        let worker = worker.clone();
        tokio::spawn(async move { worker.run_once().await })
    };
    handler_started.recv().await.ok_or("the handler never started")?;
    eventually("no heartbeat round started", || async {
        Ok(counter("runtime_heartbeat_calls").await? >= 1)
    })
    .await?;
    tokio::time::sleep(Duration::from_millis(2 * heartbeat as u64)).await;
    let blocked = counter("runtime_heartbeat_calls").await?;
    let want_blocked = number(fixture, "expectedCallsWhileBlocked");
    check(blocked == want_blocked, || {
        format!("{blocked} heartbeat rounds started while one was blocked, want {want_blocked}")
    })?;
    client
        .execute("SELECT nextval('workhorse.runtime_heartbeat_released')", &[])
        .await
        .map_err(sql)?;
    let minimum = number(fixture, "expectedMinimumCallsBeforeSettlement");
    eventually("the heartbeat rounds did not resume", || async {
        Ok(counter("runtime_heartbeat_calls").await? >= minimum)
    })
    .await?;
    let _ = release.send(true);
    let processed = running.await.map_err(|error| error.to_string())?.map_err(driver)?;
    check(processed, || "run_once() processed nothing".into())?;
    let overlaps = counter("runtime_heartbeat_overlaps").await?;
    let concurrent = 1 + overlaps;
    let maximum = number(fixture, "expectedMaximumOverlap");
    check(concurrent <= maximum, || {
        format!("{concurrent} heartbeat rounds ran at once, want at most {maximum}")
    })?;
    assert_state(&client, task.task_id, &json!({"state": "succeeded", "attempt": 1})).await
}

/// Holds each empty claim in PostgreSQL until the runner has counted it, then measures the
/// worker's backoff after the last empty claim.
///
/// The wrapper stamps each claim with PostgreSQL's clock, and the delay runs from the end of the
/// last empty claim to the start of the next claim. That span is the worker's own cadence. It
/// leaves out the enqueue, the claim that finds the task, and the dispatch to the handler, so a
/// slow runner or a slow database cannot charge that latency to the backoff.
/// Wraps `claim_many_v1` so each call records its start, its end, and whether it found a task in
/// `workhorse.runtime_poll_claims`. If `hold` is true, each empty claim waits at its end until the
/// test advances `workhorse.runtime_poll_released`. `runtime_poll_control` turns the hold off.
async fn record_claims(client: &Client, hold: bool) -> Checked {
    let row = client
        .query_one(
            "SELECT pg_get_function_arguments(oid), pg_get_function_result(oid), pronargs
               FROM pg_proc WHERE oid = 'workhorse.claim_many_v1'::regproc",
            &[],
        )
        .await
        .map_err(sql)?;
    let (arguments, result, count): (String, String, i16) = (row.get(0), row.get(1), row.get(2));
    let forwarded = (1..=count).map(|index| format!("${index}")).collect::<Vec<_>>().join(", ");
    client
        .batch_execute(&format!(
            "CREATE TABLE workhorse.runtime_poll_control (hold_claims boolean NOT NULL);
             INSERT INTO workhorse.runtime_poll_control VALUES ({hold});
             CREATE TABLE workhorse.runtime_poll_claims (
               started timestamptz NOT NULL,
               finished timestamptz NOT NULL,
               found boolean NOT NULL
             );
             CREATE SEQUENCE workhorse.runtime_poll_reached;
             CREATE SEQUENCE workhorse.runtime_poll_released;
             ALTER FUNCTION workhorse.claim_many_v1 RENAME TO claim_many_v1_inner;
             CREATE FUNCTION workhorse.claim_many_v1({arguments}) RETURNS {result}
               LANGUAGE plpgsql AS $$
             #variable_conflict use_column
             DECLARE
               v_started timestamptz := clock_timestamp();
               v_found boolean;
               v_reached bigint;
             BEGIN
               RETURN QUERY SELECT * FROM workhorse.claim_many_v1_inner({forwarded});
               v_found := FOUND;
               IF NOT v_found AND (SELECT hold_claims FROM workhorse.runtime_poll_control) THEN
                 v_reached := nextval('workhorse.runtime_poll_reached');
                 WHILE (SELECT CASE WHEN is_called THEN last_value ELSE 0 END
                          FROM workhorse.runtime_poll_released) < v_reached LOOP
                   PERFORM pg_sleep(0.005);
                 END LOOP;
               END IF;
               INSERT INTO workhorse.runtime_poll_claims
                 VALUES (v_started, clock_timestamp(), v_found);
             END
             $$;"
        ))
        .await
        .map_err(sql)
}

/// Turns the hold of `record_claims` off and releases a held claim.
async fn release_claims(client: &Client) -> Checked {
    client
        .batch_execute(
            "UPDATE workhorse.runtime_poll_control SET hold_claims = false;
             SELECT nextval('workhorse.runtime_poll_released');",
        )
        .await
        .map_err(sql)
}

async fn poll_cadence(database: &ScratchDatabase, fixture: &Value) -> Checked {
    let client = database.connect().await;
    record_claims(&client, true).await?;
    let queue = queue(database, fixture).await?;
    let task_type = text(fixture, "taskType");
    let worker = worker(
        database,
        8,
        WorkerOptions { poll_interval: Some(millis(fixture, "pollMs")), ..options(fixture) },
    )?;
    let (started, mut handler_started) = mpsc::unbounded_channel();
    worker.handle(task_type, move |_: Value, _| {
        let _ = started.send(());
        async { Ok(Value::Null) }
    });
    let (stop, running) = run(&worker);
    let polls = number(fixture, "emptyPollsBeforeEnqueue");
    for poll in 1..=polls {
        eventually(&format!("empty poll {poll} never reached PostgreSQL"), || async {
            let row = client
                .query_one(
                    "SELECT CASE WHEN is_called THEN last_value ELSE 0 END
                       FROM workhorse.runtime_poll_reached",
                    &[],
                )
                .await
                .map_err(sql)?;
            Ok(row.get::<_, i64>(0) >= poll)
        })
        .await?;
        if poll == polls {
            tokio::time::sleep(millis(fixture, "enqueueStallMs")).await;
            queue.enqueue(task_type, &json!({}), Default::default()).await.map_err(driver)?;
            client
                .execute("UPDATE workhorse.runtime_poll_control SET hold_claims = false", &[])
                .await
                .map_err(sql)?;
        }
        client
            .execute("SELECT nextval('workhorse.runtime_poll_released')", &[])
            .await
            .map_err(sql)?;
    }
    tokio::time::timeout(WAIT, handler_started.recv())
        .await
        .map_err(|_| "the worker never claimed the enqueued task".to_owned())?
        .ok_or("the handler never started")?;
    let _ = stop.send(());
    running.await.map_err(|error| error.to_string())?.map_err(driver)?;
    // The claim that found the task, the number of empty claims before it, and the time from the
    // end of the last of those to its start.
    let row = client
        .query_one(
            "WITH claims AS (
               SELECT started, found, lag(finished) OVER (ORDER BY started) AS previous_finished,
                      count(*) FILTER (WHERE NOT found) OVER (ORDER BY started) AS empty_before
                 FROM workhorse.runtime_poll_claims
             )
             SELECT empty_before,
                    (extract(epoch FROM started - previous_finished) * 1000000)::bigint
               FROM claims WHERE found ORDER BY started LIMIT 1",
            &[],
        )
        .await
        .map_err(sql)?;
    let (empty, micros): (i64, Option<i64>) = (row.get(0), row.get(1));
    check(empty == polls, || {
        format!("the worker claimed the task after {empty} empty polls, want {polls}")
    })?;
    let micros = micros.ok_or("the task was claimed without an empty poll before it")?;
    let delay = Duration::from_micros(u64::try_from(micros).map_err(|error| error.to_string())?);
    let (minimum, maximum) =
        (millis(fixture, "expectedMinimumDelayMs"), millis(fixture, "expectedMaximumDelayMs"));
    check(delay >= minimum && delay <= maximum, || {
        format!(
            "the claim after {polls} empty polls waited {delay:?}, want {minimum:?} to {maximum:?}"
        )
    })
}

/// A TCP proxy to the test database that holds each connection while `release` is `false`.
/// While it holds a connection, the proxy accepts it but does not connect to PostgreSQL, so the
/// connect and the `LISTEN` cannot finish. After the release, the proxy connects to PostgreSQL and
/// copies the bytes in both directions. A change of `close` closes both sockets of each connection
/// that it copies, and `closed` then receives one message for each of them.
struct HoldingProxy {
    config: tokio_postgres::Config,
    release: watch::Sender<bool>,
    close: watch::Sender<u64>,
    closed: mpsc::UnboundedReceiver<()>,
}

async fn holding_proxy(database: &ScratchDatabase) -> Checked<HoldingProxy> {
    let upstream: tokio_postgres::Config = database.url().parse().map_err(sql)?;
    let tokio_postgres::config::Host::Tcp(host) = &upstream.get_hosts()[0] else {
        return Err("the test database must be reachable over TCP".into());
    };
    let address = (host.clone(), upstream.get_ports()[0]);
    let proxy =
        tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|error| error.to_string())?;
    let mut config = tokio_postgres::Config::new();
    config.host("127.0.0.1").port(proxy.local_addr().map_err(|error| error.to_string())?.port());
    config.user(upstream.get_user().ok_or("the test database URL names no user")?);
    config.dbname(upstream.get_dbname().ok_or("the test database URL names no database")?);
    if let Some(password) = upstream.get_password() {
        config.password(password);
    }
    let (release, released) = watch::channel(false);
    let (close, closing) = watch::channel(0_u64);
    let (closed_sender, closed) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Ok((mut client, _)) = proxy.accept().await {
            let address = address.clone();
            let mut released = released.clone();
            let mut closing = closing.clone();
            let closed = closed_sender.clone();
            tokio::spawn(async move {
                if released.wait_for(|released| *released).await.is_err() {
                    return;
                }
                let Ok(mut server) = tokio::net::TcpStream::connect(address).await else { return };
                closing.borrow_and_update();
                tokio::select! {
                    _ = tokio::io::copy_bidirectional(&mut client, &mut server) => {}
                    Ok(()) = closing.changed() => {
                        drop((client, server));
                        let _ = closed.send(());
                    }
                }
            });
        }
    });
    Ok(HoldingProxy { config, release, close, closed })
}

/// The time from `earlier` to `later`, in microseconds from a shared origin.
fn gap(earlier: i64, later: i64) -> Duration {
    Duration::from_micros(u64::try_from(later - earlier).unwrap_or(0))
}

/// The shortest wait at the notification base: 5 s less its jitter of 10 %.
const NOTIFICATION_WAIT_MINIMUM: Duration = Duration::from_millis(4_500);

/// The longest wait at the polling-only base after the backoff restarts is 275 ms. A worker that
/// makes no claim for this time after an empty claim waits at the notification base.
const QUIET_BEFORE_LOSS: Duration = Duration::from_secs(1);

/// The bounds after the loss start at events that the runner controls, not at the moment the
/// runner sees them. A loaded runner sees an event late, and the worker's backoff grows in that
/// time. A late observation would thus charge the runner's delay to the worker.
async fn subscription_recovery(database: &ScratchDatabase, fixture: &Value) -> Checked {
    let client = database.connect().await;
    record_claims(&client, false).await?;
    let queue = queue(database, fixture).await?;
    let task_type = text(fixture, "taskType");
    // The worker can listen, but the proxy holds its LISTEN until the test releases it. Until
    // then the worker has no live subscription.
    let HoldingProxy { config: listen_config, release, close, mut closed } =
        holding_proxy(database).await?;
    // The pool has more than one connection and the worker has a listen_config, so the worker
    // expects a listener. The worker has no explicit poll interval.
    let worker = worker(
        database,
        8,
        WorkerOptions {
            concurrency: 1,
            polling_only: false,
            poll_interval: None,
            listen_config: Some(listen_config),
            ..options(fixture)
        },
    )?;
    let (ran, mut handled) = mpsc::unbounded_channel();
    worker.handle(task_type, move |payload: Value, _| {
        let _ = ran.send(payload["task"].as_str().unwrap_or_default().to_owned());
        async { Ok(Value::Null) }
    });
    let (stop, running) = run(&worker);
    let observed = async {
        eventually("the worker made no empty claim before the first enqueue", || async {
            let row = client
                .query_one(
                    "SELECT count(*) FROM workhorse.runtime_poll_claims WHERE NOT found",
                    &[],
                )
                .await
                .map_err(sql)?;
            Ok(row.get::<_, i64>(0) > 0)
        })
        .await?;
        for (task, timeout) in [("first", 5), ("second", 7)] {
            if task == "second" {
                let _ = release.send(true);
                eventually("the listener did not run LISTEN", || async {
                    let row = client
                        .query_one(
                            "SELECT count(*) FROM pg_stat_activity
                              WHERE datname = current_database()
                                AND query = 'LISTEN workhorse_tasks' AND state = 'idle'",
                            &[],
                        )
                        .await
                        .map_err(sql)?;
                    Ok(row.get::<_, i64>(0) > 0)
                })
                .await?;
            }
            queue
                .enqueue(task_type, &json!({ "task": task }), Default::default())
                .await
                .map_err(driver)?;
            let ran = tokio::time::timeout(Duration::from_secs(timeout), handled.recv())
                .await
                .map_err(|_| format!("the worker did not run the {task} task"))?
                .ok_or("the handler channel closed")?;
            check(ran == task, || format!("the worker ran task {ran}, want {task}"))?;
        }
        tokio::time::sleep(millis(fixture, "observeAfterRecoveryMs")).await;
        // The claims recorded until now belong to the live period. Each time is in microseconds
        // on the clock of PostgreSQL, which records the claims.
        let now = "(extract(epoch FROM clock_timestamp()) * 1000000)::bigint";
        let recovery_end: i64 =
            client.query_one(&format!("SELECT {now}"), &[]).await.map_err(sql)?.get(0);

        // The next empty claim starts a new wait at the notification base. Then the proxy closes
        // the live listener connection and holds the next one, so the subscription is lost. The
        // wait is internal to the worker. Thus the runner first waits until the worker has made no
        // claim for QUIET_BEFORE_LOSS after an empty claim. A loss before the worker chose its wait
        // gives the polling base without a wake.
        eventually_within(
            Duration::from_secs(7),
            "the worker made no empty claim after the second task",
            || async {
                let row = client
                    .query_one(
                        "SELECT count(*) FROM workhorse.runtime_poll_claims
                          WHERE NOT found
                            AND (extract(epoch FROM finished) * 1000000)::bigint > $1",
                        &[&recovery_end],
                    )
                    .await
                    .map_err(sql)?;
                Ok(row.get::<_, i64>(0) > 0)
            },
        )
        .await?;
        let quiet = i64::try_from(QUIET_BEFORE_LOSS.as_micros()).unwrap_or(i64::MAX);
        eventually_within(
            Duration::from_secs(7),
            "the worker did not wait at the notification base after the second task",
            || async {
                let row = client
                    .query_one(
                        &format!(
                            "SELECT NOT found AND {now} - (extract(epoch FROM finished) * 1000000)::bigint >= $1
                               FROM workhorse.runtime_poll_claims ORDER BY finished DESC LIMIT 1"
                        ),
                        &[&quiet],
                    )
                    .await
                    .map_err(sql)?;
                Ok(row.get::<_, bool>(0))
            },
        )
        .await?;
        let _ = release.send(false);
        // The loss starts when the proxy closes the connection. From that moment the wrapper holds
        // each empty claim. The first one is the claim that the loss wakes, so the worker cannot
        // advance its backoff before the runner enqueues the third task.
        let lost_at: i64 = client
            .query_one(
                &format!("UPDATE workhorse.runtime_poll_control SET hold_claims = true RETURNING {now}"),
                &[],
            )
            .await
            .map_err(sql)?
            .get(0);
        close.send_modify(|generation| *generation += 1);
        tokio::time::timeout(Duration::from_secs(7), closed.recv())
            .await
            .map_err(|_| "the proxy did not close the listener connection")?
            .ok_or("the proxy stopped")?;
        eventually_within(
            Duration::from_secs(7),
            "the worker made no claim after the subscription was lost",
            || async {
                let row = client
                    .query_one(
                        "SELECT is_called FROM workhorse.runtime_poll_reached",
                        &[],
                    )
                    .await
                    .map_err(sql)?;
                Ok(row.get::<_, bool>(0))
            },
        )
        .await?;
        let enqueued_after_loss: i64 =
            client.query_one(&format!("SELECT {now}"), &[]).await.map_err(sql)?.get(0);
        queue
            .enqueue(task_type, &json!({ "task": "third" }), Default::default())
            .await
            .map_err(driver)?;
        release_claims(&client).await?;
        let ran = tokio::time::timeout(Duration::from_secs(7), handled.recv())
            .await
            .map_err(|_| "the worker did not run the third task")?
            .ok_or("the handler channel closed")?;
        check(ran == "third", || format!("the worker ran task {ran}, want third"))?;
        // Each claim's start and end, in microseconds, and whether it found a task.
        let rows = client
            .query(
                "SELECT (extract(epoch FROM started) * 1000000)::bigint,
                        (extract(epoch FROM finished) * 1000000)::bigint,
                        found
                   FROM workhorse.runtime_poll_claims ORDER BY started",
                &[],
            )
            .await
            .map_err(sql)?;
        let claims = rows
            .iter()
            .map(|row| (row.get::<_, i64>(0), row.get::<_, i64>(1), row.get::<_, bool>(2)))
            .collect::<Vec<_>>();
        Ok::<_, String>((claims, recovery_end, lost_at, enqueued_after_loss))
    }
    .await;
    // A failure above must not leave the LISTEN or a claim held, or the worker running.
    let _ = release.send(true);
    let _ = release_claims(&client).await;
    let _ = stop.send(());
    let stopped = running.await.map_err(|error| error.to_string());
    let (claims, recovery_end, lost_at, enqueued_after_loss) = observed?;
    stopped?.map_err(driver)?;

    let found: Vec<usize> = (0..claims.len()).filter(|&index| claims[index].2).collect();
    check(found.len() == 3, || format!("{} claims found a task, want 3", found.len()))?;
    let (first, third) = (found[0], found[2]);
    check(first > 0, || "no empty claim came before the claim that found the first task".into())?;
    // Without a live subscription, the worker polls at the polling-only base.
    let waited = gap(claims[first - 1].1, claims[first].0);
    let maximum = millis(fixture, "expectedMaximumClaimDelayMs");
    check(waited <= maximum, || {
        format!("the claim that found the first task waited {waited:?} without a live subscription, want at most {maximum:?}")
    })?;
    // With a live subscription, the worker waits the notification base after an empty claim.
    // Only the claims recorded before the loss count, from the last one that found a task.
    let recovered: Vec<_> = claims.iter().filter(|claim| claim.1 <= recovery_end).collect();
    let second = recovered.iter().rposition(|claim| claim.2).unwrap_or(0);
    let empty = recovered[second..].iter().filter(|claim| !claim.2).count() as i64;
    let maximum = number(fixture, "expectedMaximumEmptyClaimsAfterRecovery");
    check(empty <= maximum, || {
        format!("{empty} empty claims after the second task with a live subscription, want at most {maximum}")
    })?;
    // After the loss, the worker claims at once and then polls at the polling-only base again.
    let maximum = millis(fixture, "expectedMaximumClaimDelayAfterLossMs");
    let woken = claims
        .iter()
        .position(|claim| claim.0 >= lost_at)
        .ok_or("no claim started after the subscription was lost")?;
    check(woken > 0, || "no claim after the subscription was lost had a claim before it".into())?;
    let waited = gap(lost_at, claims[woken].0);
    check(waited <= maximum, || {
        format!("the first claim after the subscription was lost waited {waited:?}, want at most {maximum:?}")
    })?;
    // The claim before the woken one found no task. The worker made no claim for
    // QUIET_BEFORE_LOSS after it, so it waited at the notification base. The woken claim started
    // before the shortest wait at that base ended, so the loss started it.
    let before = claims[woken - 1];
    let quiet = gap(before.1, lost_at);
    check(!before.2 && quiet >= QUIET_BEFORE_LOSS, || {
        format!("the claim before the loss returned {quiet:?} before it, want an empty claim at least {QUIET_BEFORE_LOSS:?} before")
    })?;
    let since = gap(before.1, claims[woken].0);
    check(since < NOTIFICATION_WAIT_MINIMUM, || {
        format!("the first claim after the subscription was lost started {since:?} after the claim before it, so the wait at the notification base, not the loss, started it")
    })?;
    let waited = gap(enqueued_after_loss, claims[third].0);
    check(waited <= maximum, || {
        format!("the claim that found the third task waited {waited:?} after the subscription was lost, want at most {maximum:?}")
    })?;
    Ok(())
}

async fn graceful_drain(database: &ScratchDatabase, fixture: &Value) -> Checked {
    let client = database.connect().await;
    let queue = queue(database, fixture).await?;
    let task_type = text(fixture, "taskType");
    let mut tasks = Vec::new();
    for _ in 0..number(fixture, "taskCount") {
        tasks.push(
            queue.enqueue(task_type, &json!({}), Default::default()).await.map_err(driver)?.task_id,
        );
    }
    let concurrency = usize::try_from(number(fixture, "concurrency")).unwrap_or(1);
    let worker = worker(
        database,
        6,
        WorkerOptions { concurrency, lease_duration: Duration::from_secs(1), ..options(fixture) },
    )?;
    let active = Arc::new(AtomicUsize::new(0));
    let (release, released) = watch::channel(false);
    let counted = Arc::clone(&active);
    worker.handle(task_type, move |_: Value, _| {
        let (counted, mut released) = (Arc::clone(&counted), released.clone());
        counted.fetch_add(1, Ordering::SeqCst);
        async move {
            let _ = released.wait_for(|released| *released).await;
            Ok(Value::Null)
        }
    });
    let (stop, running) = run(&worker);
    let want_active = usize::try_from(number(fixture, "expectedActiveAtStop")).unwrap_or(0);
    eventually("the worker never filled its slots", || async {
        Ok(active.load(Ordering::SeqCst) >= want_active)
    })
    .await?;
    let _ = stop.send(());
    tokio::time::sleep(millis(fixture, "settleCheckMs")).await;
    check(!running.is_finished(), || "the drain returned before its handlers finished".into())?;
    let at_stop = active.load(Ordering::SeqCst);
    check(at_stop == want_active, || {
        format!("{at_stop} handlers ran at stop, want {want_active}")
    })?;
    let _ = release.send(true);
    running.await.map_err(|error| error.to_string())?.map_err(driver)?;
    let mut counts = std::collections::BTreeMap::<String, i64>::new();
    for task in tasks {
        *counts.entry(task_state(&client, task).await?.0).or_default() += 1;
    }
    let succeeded = counts.get("succeeded").copied().unwrap_or(0);
    let ready = counts.get("ready").copied().unwrap_or(0);
    let (want_succeeded, want_ready) =
        (number(fixture, "expectedSucceeded"), number(fixture, "expectedReady"));
    check(succeeded == want_succeeded && ready == want_ready, || {
        format!(
            "after the drain {counts:?}, want {want_succeeded} succeeded and {want_ready} ready"
        )
    })
}

/// Holds each handler until the runner finishes it, in the order the handlers started.
#[derive(Default)]
struct HandlerGate(Mutex<(bool, std::collections::VecDeque<oneshot::Sender<()>>)>);

impl HandlerGate {
    fn lock(
        &self,
    ) -> std::sync::MutexGuard<'_, (bool, std::collections::VecDeque<oneshot::Sender<()>>)> {
        self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Returns what the handler waits on, or `None` once the gate is open.
    fn enter(&self) -> Option<oneshot::Receiver<()>> {
        let mut state = self.lock();
        if state.0 {
            return None;
        }
        let (finish, finished) = oneshot::channel();
        state.1.push_back(finish);
        Some(finished)
    }

    fn waiting(&self) -> usize {
        self.lock().1.len()
    }

    fn finish_next(&self) {
        if let Some(finish) = self.lock().1.pop_front() {
            let _ = finish.send(());
        }
    }

    /// Finishes every waiting handler and lets later ones run straight through.
    fn open(&self) {
        let mut state = self.lock();
        state.0 = true;
        for finish in state.1.drain(..) {
            let _ = finish.send(());
        }
    }
}

/// The claims the `slot-refill` wrapper records the limit of.
const RECORDED_CLAIMS: usize = 8;

async fn sequence_value(client: &Client, sequence: &str) -> Checked<i64> {
    let row = client
        .query_one(
            &format!(
                "SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM workhorse.{sequence}"
            ),
            &[],
        )
        .await
        .map_err(sql)?;
    Ok(row.get(0))
}

/// Wraps `claim_many_v1` so every claim records its limit and in-flight count in sequences, which
/// the runner reads while a claim is still open, and can be held before it claims anything.
async fn slot_refill(database: &ScratchDatabase, fixture: &Value) -> Checked {
    let client = database.connect().await;
    let row = client
        .query_one(
            "SELECT pg_get_function_arguments(oid), pg_get_function_result(oid), pronargs
               FROM pg_proc WHERE oid = 'workhorse.claim_many_v1'::regproc",
            &[],
        )
        .await
        .map_err(sql)?;
    let (arguments, result, count): (String, String, i16) = (row.get(0), row.get(1), row.get(2));
    let forwarded = (1..=count).map(|index| format!("${index}")).collect::<Vec<_>>().join(", ");
    let limit_sequences = (1..=RECORDED_CLAIMS)
        .map(|claim| format!("CREATE SEQUENCE workhorse.runtime_slot_limit_{claim};"))
        .collect::<String>();
    client
        .batch_execute(&format!(
            "CREATE TABLE workhorse.runtime_slot_control (hold_claims boolean NOT NULL);
             INSERT INTO workhorse.runtime_slot_control VALUES (false);
             CREATE SEQUENCE workhorse.runtime_slot_entered;
             CREATE SEQUENCE workhorse.runtime_slot_left;
             CREATE SEQUENCE workhorse.runtime_slot_most_in_flight;
             CREATE SEQUENCE workhorse.runtime_slot_with_tasks;
             {limit_sequences}
             ALTER FUNCTION workhorse.claim_many_v1 RENAME TO claim_many_v1_inner;
             CREATE FUNCTION workhorse.claim_many_v1({arguments}) RETURNS {result}
               LANGUAGE plpgsql AS $$
             #variable_conflict use_column
             DECLARE
               v_claim bigint;
               v_in_flight bigint;
               v_rows bigint;
             BEGIN
               PERFORM pg_advisory_lock(909);
               v_claim := nextval('workhorse.runtime_slot_entered');
               v_in_flight := v_claim - (SELECT CASE WHEN is_called THEN last_value ELSE 0 END
                                           FROM workhorse.runtime_slot_left);
               IF v_in_flight > (SELECT CASE WHEN is_called THEN last_value ELSE 0 END
                                   FROM workhorse.runtime_slot_most_in_flight) THEN
                 PERFORM setval('workhorse.runtime_slot_most_in_flight', v_in_flight);
               END IF;
               PERFORM pg_advisory_unlock(909);
               IF v_claim <= {RECORDED_CLAIMS} THEN
                 PERFORM setval(format('workhorse.runtime_slot_limit_%s', v_claim)::regclass, $3);
               END IF;
               WHILE (SELECT hold_claims FROM workhorse.runtime_slot_control) LOOP
                 PERFORM pg_sleep(0.005);
               END LOOP;
               RETURN QUERY SELECT * FROM workhorse.claim_many_v1_inner({forwarded});
               GET DIAGNOSTICS v_rows = ROW_COUNT;
               IF v_rows > 0 THEN
                 PERFORM nextval('workhorse.runtime_slot_with_tasks');
               END IF;
               PERFORM nextval('workhorse.runtime_slot_left');
             END
             $$;"
        ))
        .await
        .map_err(sql)?;
    let hold = |held: bool| {
        let client = &client;
        async move {
            client
                .execute("UPDATE workhorse.runtime_slot_control SET hold_claims = $1", &[&held])
                .await
                .map(drop)
                .map_err(sql)
        }
    };

    let queue = queue(database, fixture).await?;
    let task_type = text(fixture, "taskType");
    let task_count = number(fixture, "taskCount");
    let mut tasks = Vec::new();
    for sequence in 0..task_count {
        let payload = json!({"sequence": sequence});
        tasks.push(
            queue.enqueue(task_type, &payload, Default::default()).await.map_err(driver)?.task_id,
        );
    }
    let concurrency = usize::try_from(number(fixture, "concurrency")).unwrap_or(1);
    let worker = worker(database, 16, WorkerOptions { concurrency, ..options(fixture) })?;
    let gate = Arc::new(HandlerGate::default());
    let waiting = Arc::clone(&gate);
    worker.handle(task_type, move |_: Value, _| {
        let waiting = Arc::clone(&waiting);
        async move {
            if let Some(finished) = waiting.enter() {
                let _ = finished.await;
            }
            Ok(Value::Null)
        }
    });
    let claims_received = |want: i64| {
        let client = &client;
        async move {
            eventually(&format!("claim {want} never reached PostgreSQL"), || async {
                Ok(sequence_value(client, "runtime_slot_entered").await? >= want)
            })
            .await
        }
    };

    let (stop, running) = run(&worker);
    let outcome = async {
        eventually("the worker never filled its slots", || async {
            Ok(gate.waiting() == concurrency)
        })
        .await?;
        hold(true).await?;
        for finished in 1..=3 {
            gate.finish_next();
            if finished == 2 {
                // One more free slot is below the refill batch while the first refill is held.
                tokio::time::sleep(millis(fixture, "settleCheckMs")).await;
                let claims = sequence_value(&client, "runtime_slot_entered").await?;
                check(claims == 2, || {
                    format!("{claims} claims after one refill and one free slot, want 2")
                })?;
            } else {
                claims_received(if finished == 1 { 2 } else { 3 }).await?;
            }
        }
        let claims = sequence_value(&client, "runtime_slot_entered").await?;
        let recorded = usize::try_from(claims).unwrap_or(0).min(RECORDED_CLAIMS);
        let mut limits = Vec::new();
        for claim in 1..=recorded {
            limits.push(sequence_value(&client, &format!("runtime_slot_limit_{claim}")).await?);
        }
        let want_limits: Vec<i64> = fixture["expectedClaimLimits"]
            .as_array()
            .ok_or("fixture field expectedClaimLimits is not an array")?
            .iter()
            .filter_map(Value::as_i64)
            .collect();
        check(limits == want_limits, || {
            format!("the worker claimed with limits {limits:?}, want {want_limits:?}")
        })?;
        let overlapping = sequence_value(&client, "runtime_slot_most_in_flight").await?;
        let want_overlapping = number(fixture, "expectedOverlappingClaims");
        check(overlapping == want_overlapping, || {
            format!("{overlapping} claims were in flight at once, want {want_overlapping}")
        })?;

        hold(false).await?;
        gate.open();
        eventually("the worker never ran every task", || async {
            for task in &tasks {
                if task_state(&client, *task).await?.0 != "succeeded" {
                    return Ok(false);
                }
            }
            Ok(true)
        })
        .await?;
        let with_tasks = sequence_value(&client, "runtime_slot_with_tasks").await?;
        let per_task = with_tasks as f64 / task_count as f64;
        let maximum = fixture["expectedMaximumClaimsPerTask"]
            .as_f64()
            .ok_or("fixture field expectedMaximumClaimsPerTask is not a number")?;
        check(per_task <= maximum, || {
            format!("{with_tasks} claims leased {task_count} tasks ({per_task} per task), want at most {maximum}")
        })
    }
    .await;
    let _ = hold(false).await;
    gate.open();
    let _ = stop.send(());
    let stopped = running.await.map_err(|error| error.to_string())?.map_err(driver);
    outcome?;
    stopped
}

const CLAIM: &str = "SELECT * FROM workhorse.claim_v1($1::text, $2::text, $3::integer)";

async fn claims(client: &Client, queue: &str, worker: &str, lease: i32) -> Checked<usize> {
    Ok(client.query(CLAIM, &[&queue, &worker, &lease]).await.map_err(sql)?.len())
}

async fn waits_on_lock(client: &Client, pid: i32, lock: Option<&str>) -> Checked<bool> {
    let row = client
        .query_one(
            "SELECT EXISTS (
               SELECT 1 FROM pg_stat_activity
                WHERE pid = $1 AND wait_event_type = 'Lock' AND ($2::text IS NULL OR wait_event = $2)
             )",
            &[&pid, &lock],
        )
        .await
        .map_err(sql)?;
    Ok(row.get(0))
}

/// Commits a budgeted task on one queue while that queue's claim is past its first read, and holds
/// a second claim of the same budget open on another queue until the first admits or waits.
async fn budget_admission_race(database: &ScratchDatabase, fixture: &Value) -> Checked {
    let name = queue_name(fixture);
    let (late_queue, holder_queue) = (format!("{name}-late"), format!("{name}-holder"));
    let lease = i32::try_from(number(fixture, "leaseMs")).map_err(|error| error.to_string())?;
    let queue = queue(database, fixture).await?;
    let max_active = i32::try_from(number(fixture, "maxActive")).ok();
    let budget = BudgetDefinition { name: name.clone(), max_active, rate: None };
    queue.sync_budgets(&name, &[budget], false).await.map_err(driver)?;
    let rate = &fixture["queueRate"];
    let rate = RateLimit {
        limit: i32::try_from(number(rate, "limit")).unwrap_or(1),
        interval_ms: i32::try_from(number(rate, "intervalMs")).unwrap_or(1),
        burst: i32::try_from(number(rate, "burst")).unwrap_or(1),
    };
    let policy = RateLimitPolicyDefinition { queue: late_queue.clone(), rate, per_key: None };
    queue.sync_rate_limit_policies(&name, &[policy], false).await.map_err(driver)?;
    let task_type = text(fixture, "taskType");
    let on = |queue: &str, budget: Option<&str>| EnqueueOptions {
        queue: Some(queue.into()),
        budget: budget.map(Into::into),
        ..Default::default()
    };
    // One unbudgeted start proves the late queue admits before the blocker parks its claim.
    queue
        .enqueue(task_type, &json!({"role": "bucket"}), on(&late_queue, None))
        .await
        .map_err(driver)?;
    let observer = database.connect().await;
    let bucket = claims(&observer, &late_queue, &format!("{name}-bucket"), lease).await?;
    check(bucket == 1, || "the late queue did not admit its unbudgeted start".into())?;
    queue
        .enqueue(task_type, &json!({"role": "holder"}), on(&holder_queue, Some(&name)))
        .await
        .map_err(driver)?;

    let blocker = database.connect().await;
    let late = database.connect().await;
    let holder = database.connect().await;
    let late_pid: i32 = late.query_one("SELECT pg_backend_pid()", &[]).await.map_err(sql)?.get(0);
    blocker.batch_execute("BEGIN").await.map_err(sql)?;
    blocker
        .execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(
                      'workhorse:admission-shard:' || $1 || ':' || shard, 0))
               FROM generate_series(0, 7) AS shard",
            &[&late_queue],
        )
        .await
        .map_err(sql)?;
    let late_worker = format!("{name}-late");
    let late_claim = {
        let late_queue = late_queue.clone();
        tokio::spawn(async move { claims(&late, &late_queue, &late_worker, lease).await })
    };
    eventually("the late claim never reached the admission shards", || {
        waits_on_lock(&observer, late_pid, None)
    })
    .await?;
    queue
        .enqueue(task_type, &json!({"role": "late"}), on(&late_queue, Some(&name)))
        .await
        .map_err(driver)?;
    holder.batch_execute("BEGIN").await.map_err(sql)?;
    let holder_claims = claims(&holder, &holder_queue, &format!("{name}-holder"), lease).await?;
    blocker.batch_execute("COMMIT").await.map_err(sql)?;
    eventually("the late claim neither finished nor waited for the budget", || async {
        Ok(late_claim.is_finished() || waits_on_lock(&observer, late_pid, Some("advisory")).await?)
    })
    .await?;
    holder.batch_execute("COMMIT").await.map_err(sql)?;
    let late_claims = late_claim.await.map_err(|error| error.to_string())??;
    let active: i32 = observer
        .query_one(
            "SELECT count(*)::integer FROM workhorse.task_runtime
              WHERE state = 'active' AND budget_name = $1",
            &[&name],
        )
        .await
        .map_err(sql)?
        .get(0);
    let expected = (
        number(fixture, "expectedHolderClaims"),
        number(fixture, "expectedLateClaims"),
        number(fixture, "expectedActive"),
    );
    let received = (holder_claims as i64, late_claims as i64, i64::from(active));
    check(received == expected, || {
        format!("budget admission (holder, late, active) = {received:?}, want {expected:?}")
    })
}

async fn missing_handler(database: &ScratchDatabase, fixture: &Value) -> Checked {
    let client = database.connect().await;
    let queue = queue(database, fixture).await?;
    let task_type = text(fixture, "taskType");
    let task =
        queue.enqueue(task_type, &json!({}), Default::default()).await.map_err(driver)?.task_id;
    let worker = worker(
        database,
        4,
        WorkerOptions {
            lease_duration: millis(fixture, "leaseMs"),
            poll_interval: Some(millis(fixture, "pollMs")),
            ..options(fixture)
        },
    )?;
    worker.handle(text(fixture, "registeredTaskType"), |_: Value, _| async { Ok(Value::Null) });
    // A pass that released each task that it claimed made no progress, so it returns false.
    let released_pass_progress = text(fixture, "expectedReleasedPassOutcome") != "unprocessed";
    run_once(&worker, released_pass_progress).await?;
    assert_state(&client, task, &fixture["expectedAfterRelease"]).await?;
    let evidence = release_evidence(&client, task).await?;
    let expected = (number(fixture, "expectedAttempts"), number(fixture, "expectedReleaseEvents"));
    check(evidence == expected, || {
        format!("(attempts, release events) = {evidence:?}, want {expected:?}")
    })?;
    // The worker keeps no state between calls. The next call claims the ready task again at once,
    // inside the poll interval, releases it, and returns false again.
    run_once(&worker, released_pass_progress).await?;
    let evidence = release_evidence(&client, task).await?;
    let expected = (
        number(fixture, "expectedAttempts"),
        number(fixture, "expectedReleaseEventsAfterNextPass"),
    );
    check(evidence == expected, || {
        format!("after the next pass (attempts, release events) = {evidence:?}, want {expected:?}")
    })?;
    assert_state(&client, task, &fixture["expectedAfterRelease"]).await?;
    worker.handle(task_type, |_: Value, _| async { Ok(Value::Null) });
    run_once(&worker, true).await?;
    assert_state(&client, task, &fixture["expectedAfterHandled"]).await
}

/// Counts the attempts and the `released` events of a task.
async fn release_evidence(client: &Client, task: Uuid) -> Checked<(i64, i64)> {
    let row = client
        .query_one(
            "SELECT
               (SELECT count(*) FROM workhorse.attempt_history WHERE task_id = $1),
               (SELECT count(*) FROM workhorse.task_event
                 WHERE task_id = $1 AND event_type = 'released')",
            &[&task],
        )
        .await
        .map_err(sql)?;
    Ok((row.get(0), row.get(1)))
}

/// Runs a listening worker that has no handler for the one ready task. Each release wakes the
/// worker, so the gap between two releases shows its bound.
async fn release_wait(database: &ScratchDatabase, fixture: &Value) -> Checked {
    let client = database.connect().await;
    let queue = queue(database, fixture).await?;
    let task = queue
        .enqueue(text(fixture, "taskType"), &json!({}), Default::default())
        .await
        .map_err(driver)?
        .task_id;
    let worker = worker(
        database,
        4,
        WorkerOptions {
            polling_only: false,
            listen_config: Some(database.url().parse().map_err(sql)?),
            lease_duration: millis(fixture, "leaseMs"),
            poll_interval: Some(millis(fixture, "pollMs")),
            ..options(fixture)
        },
    )?;
    worker.handle(text(fixture, "registeredTaskType"), |_: Value, _| async { Ok(Value::Null) });
    let (stop, running) = run(&worker);
    tokio::time::sleep(millis(fixture, "runMs")).await;
    // Without a listener, the worker gets no notification, and the fixture proves nothing.
    let listeners = client
        .query_one(
            "SELECT count(*) FROM pg_stat_activity
              WHERE datname = current_database() AND query = 'LISTEN workhorse_tasks'",
            &[],
        )
        .await
        .map(|row| row.get::<_, i64>(0));
    let _ = stop.send(());
    running.await.map_err(|error| error.to_string())?.map_err(driver)?;
    let listeners = listeners.map_err(sql)?;
    check(listeners > 0, || "no session listened while the worker ran".into())?;
    let times: Vec<f64> = client
        .query(
            "SELECT (extract(epoch FROM occurred_at) * 1000)::float8 FROM workhorse.task_event
              WHERE task_id = $1 AND event_type = 'released' ORDER BY occurred_at",
            &[&task],
        )
        .await
        .map_err(sql)?
        .iter()
        .map(|row| row.get(0))
        .collect();
    let releases = i64::try_from(times.len()).unwrap_or(i64::MAX);
    let (least, most) =
        (number(fixture, "expectedMinimumReleases"), number(fixture, "expectedMaximumReleases"));
    check((least..=most).contains(&releases), || {
        format!("the worker released the task {releases} times while it ran")
    })?;
    let least_gap = fixture["expectedMinimumReleaseGapMs"].as_f64().unwrap_or(f64::MAX);
    for pair in times.windows(2) {
        let gap = pair[1] - pair[0];
        check(gap >= least_gap, || {
            format!("the worker released the task again after {gap:.0} ms")
        })?;
    }
    Ok(())
}

async fn json_round_trip(database: &ScratchDatabase, fixture: &Value) -> Checked {
    let client = database.connect().await;
    let queue = queue(database, fixture).await?;
    let task_type = text(fixture, "taskType");
    let payload = &fixture["payload"];
    let task = queue.enqueue(task_type, payload, Default::default()).await.map_err(driver)?.task_id;
    let worker = worker(database, 4, options(fixture))?;
    let received = Arc::new(Mutex::new(None));
    let observed = Arc::clone(&received);
    worker.handle(task_type, move |payload: Value, _| {
        *observed.lock().unwrap() = Some(payload.clone());
        async move { Ok(payload) }
    });
    run_once(&worker, true).await?;
    let received = received.lock().unwrap().clone();
    check(received.as_ref() == Some(payload), || format!("the handler received {received:?}"))?;
    let row = client
        .query_one(
            "SELECT t.payload, o.result FROM workhorse.task t
               JOIN workhorse.task_outcome o ON o.task_id = t.id WHERE t.id = $1",
            &[&task],
        )
        .await
        .map_err(sql)?;
    let (stored, result): (Value, Value) = (row.get(0), row.get(1));
    check(&stored == payload && &result == payload, || {
        format!("stored payload {stored} and result {result} differ from {payload}")
    })?;
    assert_state(&client, task, &fixture["expectedState"]).await?;
    assert_outcomes(&client, task, &[text(fixture, "expectedAttemptOutcome")]).await
}

/// A result over the task's size limit fails its attempt through the retry policy. The handler
/// returns an array of zeros, whose jsonb text is longer than its compact JSON.
async fn oversized_result(database: &ScratchDatabase, fixture: &Value) -> Checked {
    let admin = Admin::connect(database.url()).await.map_err(driver)?;
    if text(fixture, "tier") == "fast" {
        let audit = AdminAudit {
            actor: "runtime-fixture".into(),
            reason: text(fixture, "id").into(),
            request_id: text(fixture, "id").into(),
        };
        admin
            .set_queue_tier(&queue_name(fixture), QueueTier::Fast, &audit)
            .await
            .map_err(driver)?;
    }
    let queue = queue(database, fixture).await?;
    let task_type = text(fixture, "taskType");
    let retried = EnqueueOptions {
        max_attempts: i32::try_from(number(fixture, "maxAttempts")).map_err(|e| e.to_string())?,
        retry_policy: json!({ "type": "fixed", "delayMs": 0 }).as_object().cloned(),
        ..Default::default()
    };
    let oversized = &fixture["oversizedZeros"];
    let task = queue.enqueue(task_type, oversized, retried).await.map_err(driver)?.task_id;
    let worker = worker(database, 4, options(fixture))?;
    worker.handle(task_type, |zeros: usize, _| async move { Ok(json!(vec![0; zeros])) });
    let settled = &fixture["expectedSettled"];
    let (want_state, want_attempt) = (text(settled, "state"), number(settled, "attempt"));
    // One pass may also run the immediate retry, so the runner passes until the task settles.
    for _ in 0..number(fixture, "maxAttempts") {
        let snapshot = admin.get_task(task).await.map_err(driver)?.ok_or("the task is gone")?;
        if snapshot.state.as_str() == want_state {
            break;
        }
        run_once(&worker, true).await?;
    }
    let snapshot = admin.get_task(task).await.map_err(driver)?.ok_or("the task is gone")?;
    let (state, attempt) = (snapshot.state.as_str(), i64::from(snapshot.current_attempt));
    let name = snapshot.error.as_ref().and_then(|error| error["name"].as_str());
    let error_name = text(&fixture["expectedErrorNames"], "rust");
    check(state == want_state && attempt == want_attempt && name == Some(error_name), || {
        format!(
            "task {task} is {state}/{attempt} with error {name:?}, \
             want {want_state}/{want_attempt} with {error_name:?}"
        )
    })?;
    let fitting = &fixture["fittingZeros"];
    let task = queue.enqueue(task_type, fitting, Default::default()).await.map_err(driver)?.task_id;
    run_once(&worker, true).await?;
    let snapshot = admin.get_task(task).await.map_err(driver)?.ok_or("the task is gone")?;
    let expected = &fixture["expectedFitting"];
    let (state, attempt) = (snapshot.state.as_str(), i64::from(snapshot.current_attempt));
    check(state == text(expected, "state") && attempt == number(expected, "attempt"), || {
        format!("the fitting result left task {task} {state}/{attempt}: {:?}", snapshot.error)
    })
}

/// Stops the worker while its handler runs. Once the shutdown grace cancels the handler, it returns
/// an error or a value, as `handlerResult` says. One attempt makes a charged attempt fail the task
/// for good.
async fn shutdown_cancellation(database: &ScratchDatabase, fixture: &Value) -> Checked {
    let behavior = text(&fixture["shutdownBehavior"], "rust");
    check(behavior == "cancel", || {
        format!("the fixture expects Rust shutdown behavior {behavior}")
    })?;
    let client = database.connect().await;
    let queue = queue(database, fixture).await?;
    let task_type = text(fixture, "taskType");
    let attempts = EnqueueOptions {
        max_attempts: i32::try_from(number(fixture, "maxAttempts")).map_err(|e| e.to_string())?,
        ..Default::default()
    };
    let task = queue.enqueue(task_type, &json!({}), attempts).await.map_err(driver)?.task_id;
    let worker = worker(
        database,
        4,
        WorkerOptions {
            shutdown_grace_period: millis(fixture, "shutdownGraceMs"),
            ..options(fixture)
        },
    )?;
    let returns_value = text(fixture, "handlerResult") == "value";
    let (started, mut handler_started) = watch::channel(false);
    let reasons = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&reasons);
    worker.handle(task_type, move |_: Value, context: HandlerContext| {
        let (started, seen) = (started.clone(), Arc::clone(&seen));
        async move {
            let _ = started.send(true);
            context.cancellation().cancelled().await;
            seen.lock().unwrap().push(context.cancellation().reason());
            if returns_value {
                return Ok(json!({ "finished": true }));
            }
            Err(HandlerError::named("Cancelled", "the worker is shutting down"))
        }
    });
    let (stop, running) = run(&worker);
    handler_started.wait_for(|started| *started).await.map_err(|error| error.to_string())?;
    let _ = stop.send(());
    running.await.map_err(|error| error.to_string())?.map_err(driver)?;
    let reasons = reasons.lock().unwrap().clone();
    check(reasons == [Some(CancelReason::Shutdown)], || {
        format!("the handler saw cancellation reasons {reasons:?}")
    })?;
    let expected = &fixture["expectedCancelled"];
    let (state, attempt, _) = task_state(&client, task).await?;
    let (want_state, want_attempt) = (text(expected, "state"), number(expected, "attempt"));
    check(state == want_state && i64::from(attempt) == want_attempt, || {
        format!("the stopped task is {state}/{attempt}, want {want_state}/{want_attempt}")
    })?;
    let events: Vec<String> = client
        .query(
            "SELECT event_type FROM workhorse.task_event WHERE task_id = $1
              ORDER BY occurred_at, event_id",
            &[&task],
        )
        .await
        .map_err(sql)?
        .iter()
        .map(|row| row.get(0))
        .collect();
    let want_events: Vec<&str> =
        expected["events"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    check(events == want_events, || {
        format!("the stopped task recorded events {events:?}, want {want_events:?}")
    })
}

/// Replaces one installed function with a raising body; the returned definition restores it.
async fn inject_failure(client: &Client, injection: &Value) -> Checked<String> {
    let original: String = client
        .query_one(
            "SELECT pg_get_functiondef($1::text::regprocedure)",
            &[&text(injection, "function")],
        )
        .await
        .map_err(sql)?
        .get(0);
    let mut count = String::new();
    if let Some(sequence) = injection["counterSequence"].as_str() {
        client
            .batch_execute(&format!("CREATE SEQUENCE {sequence} MINVALUE 0 START 0"))
            .await
            .map_err(sql)?;
        // The exception rolls the call back, so only a sequence carries the count out of it.
        count = format!("PERFORM nextval('{sequence}');");
    }
    client
        .batch_execute(&format!(
            "CREATE OR REPLACE FUNCTION {header} LANGUAGE plpgsql AS $injected$
             BEGIN
               {count}
               RAISE EXCEPTION '{message}' USING ERRCODE = '{code}';
             END;
             $injected$",
            header = text(injection, "header"),
            message = text(injection, "message"),
            code = text(injection, "errorCode"),
        ))
        .await
        .map_err(sql)?;
    Ok(original)
}

async fn lease_expiry(client: &Client, task: Uuid) -> Checked<chrono::DateTime<chrono::Utc>> {
    let row = client
        .query_one("SELECT expires_at FROM workhorse.task_runtime WHERE task_id = $1", &[&task])
        .await
        .map_err(sql)?;
    Ok(row.get(0))
}

async fn wait_for_renewal(
    client: &Client,
    task: Uuid,
    after: chrono::DateTime<chrono::Utc>,
    within: Duration,
) -> Checked<chrono::DateTime<chrono::Utc>> {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        let expiry = lease_expiry(client, task).await?;
        if expiry > after {
            return Ok(expiry);
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    Err(format!("the lease on {task} never renewed past {after}"))
}

async fn heartbeat_failure(database: &ScratchDatabase, fixture: &Value) -> Checked {
    let client = database.connect().await;
    let queue = queue(database, fixture).await?;
    let task_type = text(fixture, "taskType");
    let task = queue.enqueue(task_type, &Value::Null, Default::default()).await.map_err(driver)?;
    let task = task.task_id;
    let worker = worker(database, 4, lease_options(fixture))?;
    let (started, mut handler_started) = mpsc::unbounded_channel();
    let (release, released) = watch::channel(false);
    let cancellations = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&cancellations);
    worker.handle(task_type, move |_: Value, context: HandlerContext| {
        let (started, mut released, counted) =
            (started.clone(), released.clone(), Arc::clone(&counted));
        async move {
            let _ = started.send(());
            let _ = released.wait_for(|released| *released).await;
            if context.cancellation().is_cancelled() {
                counted.fetch_add(1, Ordering::SeqCst);
            }
            Ok(Value::Null)
        }
    });
    let running = {
        let worker = worker.clone();
        tokio::spawn(async move { worker.run_once().await })
    };
    handler_started.recv().await.ok_or("the handler never started")?;
    let renewed = wait_for_renewal(&client, task, lease_expiry(&client, task).await?, WAIT).await?;
    let injection = &fixture["injection"];
    let original = inject_failure(&client, injection).await?;
    let sequence = text(injection, "counterSequence");
    let minimum = number(fixture, "expectedMinimumFailedRounds");
    let failed = eventually("too few heartbeat rounds failed", || async {
        let row = client
            .query_one(&format!("SELECT last_value FROM {sequence}"), &[])
            .await
            .map_err(sql)?;
        Ok(row.get::<_, i64>(0) >= minimum)
    })
    .await;
    let renewed = lease_expiry(&client, task).await.unwrap_or(renewed);
    client.batch_execute(&original).await.map_err(sql)?;
    client.batch_execute(&format!("DROP SEQUENCE {sequence}")).await.map_err(sql)?;
    failed?;
    // Once the rounds answer again the lease renews, so the failures cost the attempt nothing.
    wait_for_renewal(&client, task, renewed, WAIT).await?;
    let _ = release.send(true);
    let processed = running.await.map_err(|error| error.to_string())?.map_err(driver)?;
    check(processed, || "run_once() processed nothing".into())?;
    let cancelled = cancellations.load(Ordering::SeqCst) as i64;
    let expected = number(fixture, "expectedCancellations");
    check(cancelled == expected, || {
        format!("failed heartbeat rounds cancelled {cancelled} handlers")
    })?;
    assert_state(&client, task, &fixture["expectedState"]).await?;
    assert_outcomes(&client, task, &[text(fixture, "expectedAttemptOutcome")]).await
}

/// Replaces the heartbeat function with the fixture's body, which answers the first rounds `busy`.
/// The busy retries must send only the busy lease, sooner than the next regular round, and the
/// attempt must keep running until a later round renews its lease.
async fn heartbeat_busy(database: &ScratchDatabase, fixture: &Value) -> Checked {
    let client = database.connect().await;
    let queue = queue(database, fixture).await?;
    let task_type = text(fixture, "taskType");
    let task = queue.enqueue(task_type, &json!({}), Default::default()).await.map_err(driver)?;
    let task = task.task_id;
    let worker = worker(database, 4, lease_options(fixture))?;
    let (started, mut handler_started) = mpsc::unbounded_channel();
    let (release, released) = watch::channel(false);
    let cancellations = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&cancellations);
    worker.handle(task_type, move |_: Value, context: HandlerContext| {
        let (started, mut released, counted) =
            (started.clone(), released.clone(), Arc::clone(&counted));
        async move {
            let _ = started.send(());
            let _ = released.wait_for(|released| *released).await;
            if context.cancellation().is_cancelled() {
                counted.fetch_add(1, Ordering::SeqCst);
            }
            Ok(Value::Null)
        }
    });
    let running = {
        let worker = worker.clone();
        tokio::spawn(async move { worker.run_once().await })
    };
    let observed = async {
        handler_started.recv().await.ok_or("the handler never started")?;
        let within = millis(fixture, "renewalTimeoutMs");
        wait_for_renewal(&client, task, lease_expiry(&client, task).await?, within).await?;
        with_injected_body(&client, &fixture["injection"], busy_rounds(&client, task, fixture))
            .await
    }
    .await;
    let _ = release.send(true);
    let rounds = observed?;
    let processed = running.await.map_err(|error| error.to_string())?.map_err(driver)?;
    check(processed, || "run_once() processed nothing".into())?;

    let expected = usize::try_from(number(fixture, "expectedBusyRounds")).expect("a count");
    let busy = &rounds[..expected];
    // Each retry sent only the busy lease, and came sooner than the next regular round.
    check(busy.iter().all(|(_, leases)| *leases == 1), || {
        format!("busy rounds sent {busy:?} leases, want 1 each")
    })?;
    let maximum = number(fixture, "maximumRetryGapMs") as f64;
    for pair in busy.windows(2) {
        let gap = pair[1].0 - pair[0].0;
        check(gap < maximum, || format!("a busy retry came {gap} ms later, want < {maximum}"))?;
    }
    let cancelled = cancellations.load(Ordering::SeqCst) as i64;
    let expected = number(fixture, "expectedCancellations");
    check(cancelled == expected, || {
        format!("busy heartbeat rounds cancelled {cancelled} handlers")
    })?;
    assert_state(&client, task, &fixture["expectedState"]).await?;
    assert_outcomes(&client, task, &[text(fixture, "expectedAttemptOutcome")]).await
}

/// Waits for the fixture's busy rounds, then for a later round to renew the lease. Returns each
/// recorded round as its time in milliseconds and its lease count.
async fn busy_rounds(client: &Client, task: Uuid, fixture: &Value) -> Checked<Vec<(f64, i32)>> {
    let within = millis(fixture, "renewalTimeoutMs");
    let expected = usize::try_from(number(fixture, "expectedBusyRounds")).expect("a count");
    let query = text(&fixture["injection"], "roundsQuery");
    let deadline = Instant::now() + within;
    let rounds = loop {
        let rows = client.query(query, &[]).await.map_err(sql)?;
        let rounds: Vec<(f64, i32)> =
            rows.iter().map(|row| (row.get("round_at_ms"), row.get("lease_count"))).collect();
        if rounds.len() >= expected {
            break rounds;
        }
        if Instant::now() >= deadline {
            return Err(format!("{} busy heartbeat rounds, want {expected}", rounds.len()));
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    };
    // The busy rounds renewed nothing. The next round reaches the real function and renews.
    wait_for_renewal(client, task, lease_expiry(client, task).await?, within).await?;
    Ok(rounds)
}

/// Replaces one installed function with the fixture's body while `observe` runs. Afterwards it
/// restores the definition PostgreSQL reported and runs the teardown statements, whatever
/// `observe` returned.
async fn with_injected_body<T>(
    client: &Client,
    injection: &Value,
    observe: impl std::future::Future<Output = Checked<T>>,
) -> Checked<T> {
    let original: String = client
        .query_one(
            "SELECT pg_get_functiondef($1::text::regprocedure)",
            &[&text(injection, "function")],
        )
        .await
        .map_err(sql)?
        .get(0);
    let mut setup = Ok(());
    for statement in strings(&injection["setup"]) {
        setup = client.batch_execute(statement).await.map_err(sql);
        if setup.is_err() {
            break;
        }
    }
    let observed = match setup {
        Err(error) => Err(error),
        Ok(()) => {
            let replaced = client
                .batch_execute(&format!(
                    "CREATE OR REPLACE FUNCTION {header} LANGUAGE plpgsql AS $injected$ {body} $injected$",
                    header = text(injection, "header"),
                    body = text(injection, "body"),
                ))
                .await
                .map_err(sql);
            match replaced {
                Ok(()) => observe.await,
                Err(error) => Err(error),
            }
        }
    };
    let restored = client.batch_execute(&original).await.map_err(sql);
    let mut torn_down = Ok(());
    for statement in strings(&injection["teardown"]) {
        if let Err(error) = client.batch_execute(statement).await.map_err(sql) {
            torn_down = torn_down.and(Err(error));
        }
    }
    let observed = observed?;
    restored?;
    torn_down?;
    Ok(observed)
}

async fn attempt_count(client: &Client, task: Uuid) -> Checked<i64> {
    Ok(attempt_outcomes(client, task).await?.len() as i64)
}

async fn move_run_at(client: &Client, task: Uuid, offset: &str) -> Checked {
    let statement = format!(
        "UPDATE workhorse.task_runtime SET run_at = clock_timestamp() + interval '{offset}' \
         WHERE task_id = $1"
    );
    client.execute(&statement, &[&task]).await.map_err(sql).map(drop)
}

async fn suspension_replay(database: &ScratchDatabase, fixture: &Value) -> Checked {
    let client = database.connect().await;
    let queue = queue(database, fixture).await?;
    let (task_type, following_type) =
        (text(fixture, "taskType"), text(fixture, "followingTaskType"));
    let suspending =
        queue.enqueue(task_type, &Value::Null, Default::default()).await.map_err(driver)?;
    let following =
        queue.enqueue(following_type, &Value::Null, Default::default()).await.map_err(driver)?;
    let (suspending, following) = (suspending.task_id, following.task_id);
    let worker = worker(database, 4, WorkerOptions { concurrency: 1, ..options(fixture) })?;
    let order = Arc::new(Mutex::new(Vec::new()));
    let (runs, operations) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
    let checkpoint = text(fixture, "checkpointName").to_owned();
    let wait = text(fixture, "waitName").to_owned();
    let wait_for = millis(fixture, "waitMs");
    let (seen, counted, operated) =
        (Arc::clone(&order), Arc::clone(&runs), Arc::clone(&operations));
    worker.handle(task_type, move |_: Value, context: HandlerContext| {
        let (seen, counted, operated) =
            (Arc::clone(&seen), Arc::clone(&counted), Arc::clone(&operated));
        let (checkpoint, wait) = (checkpoint.clone(), wait.clone());
        async move {
            counted.fetch_add(1, Ordering::SeqCst);
            seen.lock().unwrap().push(format!("suspension:{}", context.task().attempt));
            let prepared: Value = context
                .checkpoint(&checkpoint, || async move {
                    Ok(json!({ "operation": operated.fetch_add(1, Ordering::SeqCst) + 1 }))
                })
                .await?;
            context.sleep(&wait, wait_for).await?;
            Ok(prepared)
        }
    });
    let seen = Arc::clone(&order);
    worker.handle(following_type, move |_: Value, context: HandlerContext| {
        let seen = Arc::clone(&seen);
        async move {
            seen.lock().unwrap().push(format!("following:{}", context.task().attempt));
            Ok(Value::Null)
        }
    });
    run_once(&worker, true).await?;
    move_run_at(&client, suspending, "30 seconds").await?;
    let expected = &fixture["expectedAfterSuspension"];
    assert_state(&client, suspending, &expected["suspension"]).await?;
    assert_state(&client, following, &expected["following"]).await?;
    let attempts = attempt_count(&client, suspending).await?;
    let want = number(fixture, "expectedAttemptsAfterSuspension");
    check(attempts == want, || format!("{attempts} attempts after suspension, want {want}"))?;
    // The suspension released the only slot, so the next pass runs the following task.
    run_once(&worker, true).await?;
    let expected = &fixture["expectedAfterSlotRelease"];
    assert_state(&client, suspending, &expected["suspension"]).await?;
    assert_state(&client, following, &expected["following"]).await?;
    move_run_at(&client, suspending, "-1 millisecond").await?;
    run_once(&worker, true).await?;
    let expected = &fixture["expectedAfterReplay"];
    assert_state(&client, suspending, &expected["suspension"]).await?;
    assert_state(&client, following, &expected["following"]).await?;
    let order = order.lock().unwrap().clone();
    let want = strings(&fixture["expectedHandlerOrder"]);
    check(order == want, || format!("handler order {order:?}, want {want:?}"))?;
    let runs = runs.load(Ordering::SeqCst) as i64;
    let want = number(fixture, "expectedHandlerRuns");
    check(runs == want, || format!("{runs} handler runs, want {want}"))?;
    let operations = operations.load(Ordering::SeqCst) as i64;
    let want = number(fixture, "expectedCheckpointOperations");
    check(operations == want, || format!("{operations} checkpoint operations, want {want}"))?;
    let attempts = attempt_count(&client, suspending).await?;
    let want = number(fixture, "expectedAttemptsAfterReplay");
    check(attempts == want, || format!("{attempts} attempts after replay, want {want}"))
}

/// Tries every portable durable write after the lease is lost and names those it rejected.
async fn late_writes(context: &HandlerContext) -> Vec<&'static str> {
    let lost = |error: &Error| matches!(error, Error::LeaseLost { .. });
    let child = || workhorse::ChildTaskRequest::new("too-late", "protocol.child", &Value::Null);
    let late = json!({ "late": true });
    let checkpoint = context.checkpoint("too-late", || async { Ok(json!({ "late": true })) }).await;
    let writes = [
        (
            "checkpoint",
            checkpoint.err().and_then(|error| error.name).as_deref() == Some("LeaseLostError"),
        ),
        (
            "sleep",
            context.sleep("too-late", Duration::from_millis(1)).await.is_err_and(|e| lost(&e)),
        ),
        (
            "sleepUntil",
            context
                .sleep_until("too-late-until", chrono::Utc::now())
                .await
                .is_err_and(|e| lost(&e)),
        ),
        (
            "waitForSignal",
            context.wait_for_signal::<Value>("too-late", None).await.is_err_and(|e| lost(&e)),
        ),
        (
            "waitForHuman",
            context
                .wait_for_human::<_, Value>("too-late", &late, None)
                .await
                .is_err_and(|e| lost(&e)),
        ),
        (
            "runChild",
            context
                .run_child::<_, Value>(
                    "too-late",
                    "protocol.child",
                    &Value::Null,
                    Default::default(),
                )
                .await
                .is_err_and(|e| lost(&e)),
        ),
        (
            "runChildren",
            context.run_children(vec![child().unwrap()]).await.is_err_and(|e| lost(&e)),
        ),
    ];
    writes.into_iter().filter(|(_, rejected)| *rejected).map(|(name, _)| name).collect()
}

async fn lease_loss(database: &ScratchDatabase, fixture: &Value) -> Checked {
    let client = database.connect().await;
    let queue = queue(database, fixture).await?;
    let task_type = text(fixture, "taskType");
    let options = EnqueueOptions {
        max_attempts: i32::try_from(number(fixture, "maxAttempts")).map_err(|e| e.to_string())?,
        retry_policy: json!({ "type": "fixed", "delayMs": 0 }).as_object().cloned(),
        ..Default::default()
    };
    let task = queue.enqueue(task_type, &Value::Null, options).await.map_err(driver)?.task_id;
    let worker = worker(database, 4, lease_options(fixture))?;
    let (started, mut handler_started) = mpsc::unbounded_channel();
    let (report, mut reported) = mpsc::unbounded_channel();
    worker.handle(task_type, move |_: Value, context: HandlerContext| {
        let (started, report) = (started.clone(), report.clone());
        async move {
            let _ = started.send(());
            context.cancellation().cancelled().await;
            let reason = context.cancellation().reason();
            let _ = report.send((reason, late_writes(&context).await));
            Ok(json!({ "mustNotSettle": true }))
        }
    });
    let running = {
        let worker = worker.clone();
        tokio::spawn(async move { worker.run_once().await })
    };
    handler_started.recv().await.ok_or("the handler never started")?;
    let row = client
        .query_one("SELECT fence_token FROM workhorse.task_runtime WHERE task_id = $1", &[&task])
        .await
        .map_err(sql)?;
    let stale_fence: i64 = row.get(0);
    // One implicit transaction holds the row lock, so no heartbeat renews between the two.
    client
        .batch_execute(&format!(
            "UPDATE workhorse.task_runtime SET expires_at = clock_timestamp() - interval '1 millisecond' \
               WHERE task_id = '{task}';
             SELECT * FROM workhorse.recover_expired_telemetry_v1(100, NULL);"
        ))
        .await
        .map_err(sql)?;
    let processed = running.await.map_err(|error| error.to_string())?.map_err(driver)?;
    check(processed, || "run_once() processed nothing".into())?;
    let (reason, rejected) = reported.recv().await.ok_or("the handler never reported")?;
    check(reason == Some(CancelReason::LeaseLost), || format!("cancellation reason {reason:?}"))?;
    let want = strings(&fixture["portableRejectedWrites"]);
    check(rejected == want, || format!("rejected writes {rejected:?}, want {want:?}"))?;
    assert_state(&client, task, &fixture["expectedState"]).await?;
    assert_outcomes(&client, task, &[text(fixture, "expectedAttemptOutcome")]).await?;
    let worker_id = format!("rust-{}", text(fixture, "id"));
    let accepted: bool = client
        .query_one(
            "SELECT workhorse.complete_v1($1, $2, $3, $4)",
            &[&task, &worker_id, &stale_fence, &json!({ "stale": true })],
        )
        .await
        .map_err(sql)?
        .get(0);
    check(!accepted, || "PostgreSQL accepted settlement under the stale fence".into())
}

async fn maintenance_phase_error(database: &ScratchDatabase, fixture: &Value) -> Checked {
    let client = database.connect().await;
    let injection = &fixture["injection"];
    let original = inject_failure(&client, injection).await?;
    let observed = async {
        // tick_v1 catches a phase failure and returns it as data, so a raising promote_v1 models a
        // lock timeout inside the promote phase.
        let phase = text(fixture, "expectedPhase");
        let row = client
            .query_one("SELECT error::text FROM workhorse.tick_v1() WHERE phase = $1", &[&phase])
            .await
            .map_err(sql)?;
        let error: Option<String> = row.get(0);
        let message = text(injection, "message");
        check(error.as_deref().is_some_and(|error| error.contains(message)), || {
            format!("the {phase} phase reported {error:?}")
        })?;
        let queue = queue(database, fixture).await?;
        let task_type = text(fixture, "taskType");
        let task =
            queue.enqueue(task_type, &Value::Null, Default::default()).await.map_err(driver)?;
        let worker = worker(
            database,
            4,
            WorkerOptions { maintenance_interval: Duration::from_millis(100), ..options(fixture) },
        )?;
        worker.handle(task_type, |_: Value, _| async { Ok(Value::Null) });
        // The failing phase runs on this pass, and the pass still claims and settles the task.
        run_once(&worker, true).await?;
        assert_state(&client, task.task_id, &fixture["expectedState"]).await
    }
    .await;
    client.batch_execute(&original).await.map_err(sql)?;
    observed
}

/// A plain handler error with a cause, for the `wrapped-checkpoint` conflict case.
#[derive(Debug)]
struct WrappedError(Error);

impl std::fmt::Display for WrappedError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("handler")
    }
}

impl std::error::Error for WrappedError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.0)
    }
}

async fn replay_conflict(database: &ScratchDatabase, fixture: &Value) -> Checked {
    let client = database.connect().await;
    for entry in fixture["cases"].as_array().unwrap() {
        let queue_name = format!("{}-{}", queue_name(fixture), text(entry, "errorKind"));
        let queue = Queue::connect(database.url(), &queue_name).await.map_err(driver)?;
        let task_type = text(fixture, "taskType");
        let task = queue
            .enqueue(
                task_type,
                &json!({}),
                EnqueueOptions {
                    max_attempts: number(fixture, "maxAttempts") as i32,
                    ..Default::default()
                },
            )
            .await
            .map_err(driver)?
            .task_id;
        if entry["redactErrorDetails"] == true {
            client
                .execute(
                    "UPDATE workhorse.task SET payload_redact_keys = ARRAY['secret'] WHERE id=$1",
                    &[&task],
                )
                .await
                .map_err(sql)?;
        }
        let delay_calls = Arc::new(AtomicUsize::new(0));
        let calls = Arc::clone(&delay_calls);
        let subject = worker(
            database,
            4,
            WorkerOptions {
                queues: vec![queue_name],
                retry_delay: Some(Arc::new(move |_, _| {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Some(Duration::from_secs(60))
                })),
                ..options(fixture)
            },
        )?;
        let kind = text(entry, "errorKind").to_owned();
        subject.handle(task_type, move |_: Value, _| {
            let kind = kind.clone();
            async move {
                let operation = match kind.as_str() {
                    "checkpoint" | "wrapped-checkpoint" => workhorse::Operation::Checkpoint,
                    "wait" => workhorse::Operation::Sleep,
                    "child" | "redacted-child" | "child-limit" => workhorse::Operation::RunChild,
                    "child-set" => workhorse::Operation::RunChildren,
                    "human" => workhorse::Operation::WaitForHuman,
                    _ => workhorse::Operation::WaitForSignal,
                };
                let error = match kind.as_str() {
                    "transient" => HandlerError::new("transient"),
                    "child-limit" => {
                        Error::LimitExceeded { operation, name: "saved".into() }.into()
                    }
                    "signal-wait" => {
                        Error::AlreadyWaiting { operation, name: "saved".into() }.into()
                    }
                    "wrapped-checkpoint" => {
                        WrappedError(Error::Conflict { operation, name: "saved".into() }).into()
                    }
                    _ => Error::Conflict { operation, name: "saved".into() }.into(),
                };
                Err::<Value, _>(error)
            }
        });
        run_once(&subject, true).await?;
        let actual = task_state(&client, task).await?;
        let expected = (
            text(entry, "expectedState").to_owned(),
            number(entry, "expectedAttempt") as i32,
            text(&entry["expectedErrorNames"], "rust").to_owned(),
        );
        check(actual == expected, || format!("conflict state {actual:?}, want {expected:?}"))?;
        let terminal = entry["expectedState"] == "failed";
        check(delay_calls.load(Ordering::SeqCst) == if terminal { 0 } else { 1 }, || {
            "retry callback called for a terminal conflict".into()
        })?;
        let rows = client
            .query("SELECT outcome FROM workhorse.attempt_history WHERE task_id=$1", &[&task])
            .await
            .map_err(sql)?;
        let outcomes: Vec<String> = rows.iter().map(|row| row.get(0)).collect();
        check(outcomes == vec![if terminal { "failed" } else { "retry" }], || {
            format!("attempt outcomes {outcomes:?}")
        })?;
    }
    Ok(())
}
