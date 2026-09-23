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
    BatchItem, BatchOptions, BatchResult, CancelReason, CancelStatus, EnqueueOptions, Error,
    HandlerContext, HandlerError, Queue, Worker, WorkerOptions,
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

/// Runs one fixture from `runtime.json`; the durable-context kinds belong to SM-879.
pub async fn run_runtime(fixture: &Value) -> Outcome {
    let kind = text(fixture, "kind");
    match kind {
        "suspension-replay" => {
            return Outcome::Unsupported(
                "no Rust durable handler context suspends a task and replays its checkpoints"
                    .into(),
            )
        }
        "lease-loss" => {
            return Outcome::Unsupported(
                "the writes a lost lease rejects are durable-context APIs the Rust worker lacks"
                    .into(),
            )
        }
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
            "batch" => batch(database, fixture).await,
            "cooperative-cancellation" => cooperative_cancellation(database, fixture).await,
            "expiration" => expiration(database, fixture).await,
            "heartbeat-cadence" => heartbeat_cadence(database, fixture).await,
            "poll-cadence" => poll_cadence(database, fixture).await,
            "graceful-drain" => graceful_drain(database, fixture).await,
            "budget-admission-race" => budget_admission_race(database, fixture).await,
            "missing-handler" => missing_handler(database, fixture).await,
            "json-round-trip" => json_round_trip(database, fixture).await,
            "heartbeat-failure" => heartbeat_failure(database, fixture).await,
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

async fn eventually<F, Fut>(message: &str, mut predicate: F) -> Checked
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Checked<bool>>,
{
    let deadline = Instant::now() + WAIT;
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
    let message = text(declared, "message").to_owned();
    let error = HandlerError {
        name: (declared["declaresName"].as_bool() == Some(true)).then(|| "PaymentDeclined".into()),
        message,
        stack: (declared["declaresStack"].as_bool() == Some(true))
            .then(|| "PaymentDeclined: card declined\n    at fixture".into()),
    };
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
            retry_policy: Some(retry),
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
        retry_policy: Some(retry),
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
    let url = database.url().to_owned();
    let worker = worker(database, 4, lease_options(fixture))?;
    worker.handle(task_type, move |_: Value, context: HandlerContext| {
        let (url, observed) = (url.clone(), Arc::clone(&observed));
        async move {
            let (client, connection) = tokio_postgres::connect(&url, NoTls).await?;
            tokio::spawn(connection);
            let statement = format!(
                "UPDATE workhorse.task_runtime SET {column} = {column} + ($2 * interval '1 millisecond')
                  WHERE task_id = $1"
            );
            client.execute(&statement, &[&context.task().id, &lead]).await?;
            context.cancellation().cancelled().await;
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
    assert_outcomes(&client, task, &strings(&fixture["expectedAttemptOutcomes"])).await
}

/// Gates the first heartbeat round in PostgreSQL, so a second round could only start concurrently.
async fn heartbeat_cadence(database: &ScratchDatabase, fixture: &Value) -> Checked {
    let client = database.connect().await;
    let heartbeat = number(fixture, "heartbeatMs");
    client
        .batch_execute(&format!(
            "ALTER FUNCTION workhorse.heartbeat_many_v1(text, jsonb) RENAME TO heartbeat_many_v1_inner;
             CREATE SEQUENCE workhorse.runtime_heartbeat_calls;
             CREATE SEQUENCE workhorse.runtime_heartbeat_overlaps;
             CREATE SEQUENCE workhorse.runtime_heartbeat_released;
             CREATE FUNCTION workhorse.heartbeat_many_v1(p_worker_id text, p_leases jsonb)
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
               RETURN QUERY SELECT * FROM workhorse.heartbeat_many_v1_inner(p_worker_id, p_leases);
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

/// Holds each empty claim in PostgreSQL until the runner has counted it, then measures the delay
/// between the enqueue after the last empty claim and the handler start.
async fn poll_cadence(database: &ScratchDatabase, fixture: &Value) -> Checked {
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
    client
        .batch_execute(&format!(
            "CREATE TABLE workhorse.runtime_poll_control (hold_claims boolean NOT NULL);
             INSERT INTO workhorse.runtime_poll_control VALUES (true);
             CREATE SEQUENCE workhorse.runtime_poll_reached;
             CREATE SEQUENCE workhorse.runtime_poll_released;
             ALTER FUNCTION workhorse.claim_many_v1 RENAME TO claim_many_v1_inner;
             CREATE FUNCTION workhorse.claim_many_v1({arguments}) RETURNS {result}
               LANGUAGE plpgsql AS $$
             #variable_conflict use_column
             DECLARE
               v_reached bigint;
             BEGIN
               RETURN QUERY SELECT * FROM workhorse.claim_many_v1_inner({forwarded});
               IF NOT FOUND AND (SELECT hold_claims FROM workhorse.runtime_poll_control) THEN
                 v_reached := nextval('workhorse.runtime_poll_reached');
                 WHILE (SELECT CASE WHEN is_called THEN last_value ELSE 0 END
                          FROM workhorse.runtime_poll_released) < v_reached LOOP
                   PERFORM pg_sleep(0.005);
                 END LOOP;
               END IF;
             END
             $$;"
        ))
        .await
        .map_err(sql)?;
    let queue = queue(database, fixture).await?;
    let task_type = text(fixture, "taskType");
    let worker = worker(
        database,
        8,
        WorkerOptions { poll_interval: Some(millis(fixture, "pollMs")), ..options(fixture) },
    )?;
    let (started, mut handler_started) = mpsc::unbounded_channel();
    worker.handle(task_type, move |_: Value, _| {
        let _ = started.send(Instant::now());
        async { Ok(Value::Null) }
    });
    let (stop, running) = run(&worker);
    let polls = number(fixture, "emptyPollsBeforeEnqueue");
    let mut enqueued = None;
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
            enqueued = Some(Instant::now());
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
    let handled = tokio::time::timeout(WAIT, handler_started.recv())
        .await
        .map_err(|_| "the worker never claimed the enqueued task".to_owned())?
        .ok_or("the handler never started")?;
    let _ = stop.send(());
    running.await.map_err(|error| error.to_string())?.map_err(driver)?;
    let delay = handled.duration_since(enqueued.ok_or("the fixture enqueued nothing")?);
    let (minimum, maximum) =
        (millis(fixture, "expectedMinimumDelayMs"), millis(fixture, "expectedMaximumDelayMs"));
    check(delay >= minimum && delay <= maximum, || {
        format!(
            "the claim after {polls} empty polls waited {delay:?}, want {minimum:?} to {maximum:?}"
        )
    })
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
    // One unbudgeted start creates the late queue's token-bucket row for the blocker to lock.
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
            "SELECT 1 FROM workhorse.rate_limit_bucket
              WHERE queue_name = $1 AND bucket_scope = 'queue' FOR UPDATE",
            &[&late_queue],
        )
        .await
        .map_err(sql)?;
    let late_worker = format!("{name}-late");
    let late_claim = {
        let late_queue = late_queue.clone();
        tokio::spawn(async move { claims(&late, &late_queue, &late_worker, lease).await })
    };
    eventually("the late claim never reached the bucket row", || {
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
    run_once(&worker, false).await?;
    assert_state(&client, task, &fixture["expectedAfterRelease"]).await?;
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
    let evidence: (i64, i64) = (row.get(0), row.get(1));
    let expected = (number(fixture, "expectedAttempts"), number(fixture, "expectedReleaseEvents"));
    check(evidence == expected, || {
        format!("(attempts, release events) = {evidence:?}, want {expected:?}")
    })?;
    worker.handle(task_type, |_: Value, _| async { Ok(Value::Null) });
    run_once(&worker, true).await?;
    assert_state(&client, task, &fixture["expectedAfterHandled"]).await
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
) -> Checked<chrono::DateTime<chrono::Utc>> {
    let deadline = Instant::now() + WAIT;
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
    let renewed = wait_for_renewal(&client, task, lease_expiry(&client, task).await?).await?;
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
    wait_for_renewal(&client, task, renewed).await?;
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
