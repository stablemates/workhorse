//! The status of the `workhorse.handler` span of the Rust worker against a real PostgreSQL schema.
//!
//! The span gets the error status only for a handler error that the worker sends to `fail_v1`,
//! and for a failed statement, as in the TypeScript worker. The worker records a handler error
//! before the write, so the span keeps the error status when PostgreSQL then reports a lost lease.
//! A lost lease, a refused acknowledgement, a cancellation, a timeout, a deadline, and a release
//! give no error status. This file is its own test binary, so no other test changes the global
//! subscriber while it runs.
#![cfg(feature = "opentelemetry")]

mod support;

use std::sync::Arc;
use std::time::Duration;

use opentelemetry::trace::{Status, TracerProvider};
use opentelemetry_sdk::trace::{InMemorySpanExporter, SdkTracerProvider, SpanData};
use serde_json::{json, Value};
use support::scratch_database;
use tokio_postgres::{Client, NoTls};
use tracing_subscriber::layer::SubscriberExt;
use workhorse::{EnqueueOptions, HandlerContext, HandlerError, Queue, Worker, WorkerOptions};

/// What the handler of one case does.
#[derive(Clone, Copy)]
enum Handler {
    /// No handler is registered for the task type, so the worker releases the task.
    Missing,
    Succeeds,
    Fails,
    /// Moves the fence, so the settlement write answers `stale`. Then it fails or returns a value.
    MovesTheFence {
        fails: bool,
    },
    /// Asks to cancel its own task, then returns a value, so `complete_v1` refuses it.
    CancelsItself,
    /// Waits for its cancellation token, then fails.
    WaitsForTheCancellation,
}

struct Case {
    name: &'static str,
    handler: Handler,
    deadline: bool,
    timeout: bool,
    /// SQL that runs before the case. Each later case keeps it.
    inject: Option<&'static str>,
    /// Whether the pass ends with an error, because a statement failed.
    statement_fails: bool,
    error_status: bool,
}

const fn case(name: &'static str, handler: Handler, error_status: bool) -> Case {
    Case {
        name,
        handler,
        deadline: false,
        timeout: false,
        inject: None,
        statement_fails: false,
        error_status,
    }
}

const REFUSE_ACKNOWLEDGEMENT: &str = r"
    CREATE OR REPLACE FUNCTION workhorse.acknowledge_cancel_v1(
      p_task_id uuid, p_worker_id text, p_fence_token bigint)
      RETURNS boolean LANGUAGE sql AS $body$ SELECT false $body$;
";
const FAIL_RELEASE: &str = r"
    CREATE OR REPLACE FUNCTION workhorse.release_owned_v1(
      p_task_id uuid, p_worker_id text, p_fence_token bigint)
      RETURNS text LANGUAGE plpgsql AS $body$
      BEGIN RAISE EXCEPTION 'injected release failure'; END $body$;
";
const FAIL_FAILURE_WRITE: &str = r"
    CREATE OR REPLACE FUNCTION workhorse.fail_v2(
      p_task_id uuid, p_worker_id text, p_fence_token bigint, p_error jsonb,
      p_retry_delay_ms integer DEFAULT NULL)
      RETURNS text LANGUAGE plpgsql AS $body$
      BEGIN RAISE EXCEPTION 'injected failure write failure'; END $body$;
";
const FAIL_COMPLETION: &str = r"
    CREATE OR REPLACE FUNCTION workhorse.complete_v1(
      p_task_id uuid, p_worker_id text, p_fence_token bigint,
      p_result jsonb DEFAULT 'null'::jsonb)
      RETURNS boolean LANGUAGE plpgsql AS $body$
      BEGIN RAISE EXCEPTION 'injected completion failure'; END $body$;
";

/// The cases in order. The cases that inject SQL come last, because each injection stays.
fn cases() -> Vec<Case> {
    vec![
        case("succeeds", Handler::Succeeds, false),
        case("fails", Handler::Fails, true),
        // fail_v1 answers stale, and the reconciliation settles no cause. The handler error came
        // first, so the span keeps the error status.
        case("fails-after-a-lost-lease", Handler::MovesTheFence { fails: true }, true),
        case("lost-lease", Handler::MovesTheFence { fails: false }, false),
        case("canceled", Handler::CancelsItself, false),
        Case { timeout: true, ..case("timeout", Handler::WaitsForTheCancellation, false) },
        Case { deadline: true, ..case("deadline", Handler::WaitsForTheCancellation, false) },
        case("missing-handler", Handler::Missing, false),
        // complete_v1 refuses, and PostgreSQL refuses the acknowledgement of the cancellation.
        Case {
            inject: Some(REFUSE_ACKNOWLEDGEMENT),
            ..case("refused-acknowledgement", Handler::CancelsItself, false)
        },
        Case {
            inject: Some(FAIL_RELEASE),
            statement_fails: true,
            ..case("missing-handler-release-fails", Handler::Missing, true)
        },
        Case {
            inject: Some(FAIL_FAILURE_WRITE),
            statement_fails: true,
            ..case("failure-write-fails", Handler::Fails, true)
        },
        Case {
            inject: Some(FAIL_COMPLETION),
            statement_fails: true,
            ..case("completion-fails", Handler::Succeeds, true)
        },
    ]
}

#[tokio::test]
async fn the_handler_span_gets_the_error_status_only_for_a_handler_error_or_a_failed_statement() {
    let Some(database) = scratch_database("handler_span_status").await else { return };
    let spans = InMemorySpanExporter::default();
    let tracer_provider = SdkTracerProvider::builder().with_simple_exporter(spans.clone()).build();
    let layer = tracing_opentelemetry::layer().with_tracer(tracer_provider.tracer("workhorse"));
    // The test runtime has one thread, so the worker's tasks see this subscriber.
    let _subscriber = tracing::subscriber::set_default(tracing_subscriber::registry().with(layer));
    let (client, connection) = tokio_postgres::connect(database.url(), NoTls).await.unwrap();
    tokio::spawn(connection);
    let client = Arc::new(client);

    let mut failures = Vec::new();
    for case in cases() {
        if let Some(statement) = case.inject {
            client.batch_execute(statement).await.unwrap();
        }
        let queue = Arc::new(Queue::connect(database.url(), case.name).await.unwrap());
        let mut options = EnqueueOptions::default();
        options.max_attempts = 1;
        options.execution_timeout_ms = case.timeout.then_some(300);
        // The deadline runs from the enqueue, so it also covers the start of the worker and the
        // maintenance tick before the claim. The attempt timeout runs from the claim.
        options.deadline =
            case.deadline.then(|| chrono::Utc::now() + chrono::Duration::milliseconds(1_500));
        let task_id = queue.enqueue(case.name, &json!({}), options).await.unwrap().task_id;
        let worker = worker_on(database.url(), case.name);
        register(&worker, &case, &queue, &client);
        let worked = tokio::time::timeout(Duration::from_secs(30), worker.run_once())
            .await
            .unwrap_or_else(|_| panic!("{}: the pass did not end", case.name));
        match (&worked, case.statement_fails) {
            (Ok(_), false) | (Err(_), true) => {}
            _ => failures.push(format!("{}: the pass returned {worked:?}", case.name)),
        }

        let finished = spans.get_finished_spans().unwrap();
        let handler: Vec<&SpanData> = finished
            .iter()
            .filter(|span| {
                span.name == "workhorse.handler"
                    && attribute(span, "workhorse.task.id") == Some(task_id.to_string())
            })
            .collect();
        let [span] = handler.as_slice() else {
            failures.push(format!("{}: {} handler spans, want 1", case.name, handler.len()));
            continue;
        };
        let error_status = matches!(span.status, Status::Error { .. });
        if error_status != case.error_status {
            failures.push(format!(
                "{}: span status {:?}, want the error status: {}",
                case.name, span.status, case.error_status
            ));
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

fn register(worker: &Worker, case: &Case, queue: &Arc<Queue<Client>>, client: &Arc<Client>) {
    let (queue, client) = (Arc::clone(queue), Arc::clone(client));
    let handler = case.handler;
    let handled = match handler {
        Handler::Missing => {
            // The worker claims the task, but it has no handler for the task type.
            worker.handle("other", |_: Value, _| async { Ok(json!(null)) });
            return;
        }
        _ => case.name,
    };
    worker.handle(handled, move |_: Value, context: HandlerContext| {
        let (queue, client) = (Arc::clone(&queue), Arc::clone(&client));
        async move {
            match handler {
                Handler::Missing | Handler::Succeeds => Ok(json!("done")),
                Handler::Fails => Err(HandlerError::new("the handler failed")),
                Handler::MovesTheFence { fails } => {
                    client
                        .execute(
                            "UPDATE workhorse.task_runtime SET fence_token = fence_token + 1
                              WHERE task_id = $1",
                            &[&context.task().id],
                        )
                        .await
                        .unwrap();
                    if fails {
                        Err(HandlerError::new("the handler failed"))
                    } else {
                        Ok(json!("done"))
                    }
                }
                Handler::CancelsItself => {
                    queue.cancel(context.task().id, Some("ops"), None).await.unwrap();
                    Ok(json!("done"))
                }
                Handler::WaitsForTheCancellation => {
                    context.cancellation().cancelled().await;
                    Err(HandlerError::new("the cancellation stopped the handler"))
                }
            }
        }
    });
}

fn worker_on(url: &str, queue: &str) -> Worker {
    let manager = deadpool_postgres::Manager::new(url.parse().unwrap(), NoTls);
    let pool = deadpool_postgres::Pool::builder(manager).max_size(4).build().unwrap();
    Worker::new(pool, {
        let mut options = WorkerOptions::default();
        options.queues = vec![queue.into()];
        options.worker_id = Some(queue.into());
        options.polling_only = true;
        options.disable_registry = true;
        options.lease_duration = Duration::from_secs(15);
        // Only the tick before the claim runs, so maintenance cannot settle a boundary.
        options.maintenance_interval = Duration::from_secs(3600);
        options
    })
    .unwrap()
}

/// The value of one attribute of `span`, as text.
fn attribute(span: &SpanData, key: &str) -> Option<String> {
    span.attributes
        .iter()
        .find(|attribute| attribute.key.as_str() == key)
        .map(|attribute| attribute.value.as_str().into_owned())
}
