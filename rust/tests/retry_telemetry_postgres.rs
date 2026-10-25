//! The retry telemetry of the Rust worker against a real PostgreSQL schema (SM-1734).
//!
//! Each settlement that starts another attempt records one `workhorse.retry` span and one
//! `workhorse.tasks.retried` count, on both tiers, as the TypeScript worker does. This file is its
//! own test binary, so no other test changes the global meter provider while it runs.
#![cfg(feature = "opentelemetry")]

mod support;

use std::time::Duration;

use opentelemetry::trace::TracerProvider;
use opentelemetry_sdk::metrics::data::{AggregatedMetrics, MetricData};
use opentelemetry_sdk::metrics::{InMemoryMetricExporter, PeriodicReader, SdkMeterProvider};
use opentelemetry_sdk::trace::{InMemorySpanExporter, SdkTracerProvider, SpanData};
use serde_json::{json, Value};
use support::scratch_database;
use tokio_postgres::NoTls;
use tracing_subscriber::layer::SubscriberExt;
use workhorse::{
    Admin, AdminAudit, EnqueueOptions, HandlerContext, HandlerError, Queue, QueueTier, Worker,
    WorkerOptions,
};

/// One attempt that fails or reaches its attempt timeout. The name is also the queue and the task
/// type. With `last`, the attempt is the last one.
struct RetryCase {
    name: &'static str,
    tier: QueueTier,
    timeout: bool,
    last: bool,
}

const CASES: [RetryCase; 7] = [
    RetryCase { name: "full-failure", tier: QueueTier::Full, timeout: false, last: false },
    RetryCase { name: "fast-failure", tier: QueueTier::Fast, timeout: false, last: false },
    RetryCase { name: "full-timeout", tier: QueueTier::Full, timeout: true, last: false },
    RetryCase { name: "fast-timeout", tier: QueueTier::Fast, timeout: true, last: false },
    RetryCase { name: "full-final-failure", tier: QueueTier::Full, timeout: false, last: true },
    RetryCase { name: "full-final-timeout", tier: QueueTier::Full, timeout: true, last: true },
    RetryCase { name: "fast-final-timeout", tier: QueueTier::Fast, timeout: true, last: true },
];

/// Each `fail_v1` write records one `workhorse.retry` span. An attempt timeout records one only when
/// `expire_owned_telemetry_v1` starts another attempt. Each retry adds one `workhorse.tasks.retried`
/// count.
#[tokio::test]
async fn each_retry_records_one_retry_span_and_one_retried_count() {
    let Some(database) = scratch_database("worker_retry_telemetry").await else { return };
    let metrics = InMemoryMetricExporter::default();
    let meter_provider = SdkMeterProvider::builder()
        .with_reader(PeriodicReader::builder(metrics.clone()).build())
        .build();
    // The worker binds its instruments to the global provider when it is built.
    opentelemetry::global::set_meter_provider(meter_provider.clone());
    let spans = InMemorySpanExporter::default();
    let tracer_provider = SdkTracerProvider::builder().with_simple_exporter(spans.clone()).build();
    let layer = tracing_opentelemetry::layer().with_tracer(tracer_provider.tracer("workhorse"));
    // The test runtime has one thread, so the worker's tasks see this subscriber.
    let _subscriber = tracing::subscriber::set_default(tracing_subscriber::registry().with(layer));
    let admin = Admin::connect(database.url()).await.unwrap();
    let audit =
        AdminAudit { actor: "ops".into(), reason: "test".into(), request_id: "req-1".into() };

    let mut task_ids = Vec::new();
    for case in &CASES {
        if case.tier == QueueTier::Fast {
            admin.set_queue_tier(case.name, QueueTier::Fast, &audit).await.unwrap();
        }
        let queue = Queue::connect(database.url(), case.name).await.unwrap();
        let options = EnqueueOptions {
            max_attempts: if case.last { 1 } else { 3 },
            execution_timeout_ms: case.timeout.then_some(300),
            ..Default::default()
        };
        task_ids.push(queue.enqueue(case.name, &json!({}), options).await.unwrap().task_id);
        let manager = deadpool_postgres::Manager::new(database.url().parse().unwrap(), NoTls);
        let pool = deadpool_postgres::Pool::builder(manager).max_size(4).build().unwrap();
        let worker = Worker::new(
            pool,
            WorkerOptions {
                queues: vec![case.name.into()],
                worker_id: Some(case.name.into()),
                polling_only: true,
                disable_registry: true,
                lease_duration: Duration::from_secs(10),
                // Only the tick before the claim runs, so maintenance cannot settle the timeout.
                maintenance_interval: Duration::from_secs(3600),
                ..WorkerOptions::default()
            },
        )
        .unwrap();
        let timeout = case.timeout;
        worker.handle(case.name, move |_: Value, context: HandlerContext| async move {
            if timeout {
                context.cancellation().cancelled().await;
            }
            Err::<Value, _>(HandlerError::new("the handler failed"))
        });
        let worked = tokio::time::timeout(Duration::from_secs(30), worker.run_once()).await;
        assert!(worked.unwrap().unwrap(), "{}: the worker claimed no task", case.name);
    }

    meter_provider.force_flush().unwrap();
    let finished = spans.get_finished_spans().unwrap();
    let mut failures = Vec::new();
    for (case, task_id) in CASES.iter().zip(&task_ids) {
        let task_id = task_id.to_string();
        let of_task = |name: &str| -> Vec<&SpanData> {
            finished
                .iter()
                .filter(|span| {
                    span.name == name
                        && attribute(span, "workhorse.task.id") == Some(task_id.clone())
                })
                .collect()
        };
        let handler = of_task("workhorse.handler");
        let retries = of_task("workhorse.retry");
        // A last attempt timeout starts no attempt, so retry_state is null and no span starts.
        let want_spans = usize::from(!(case.timeout && case.last));
        if retries.len() != want_spans {
            failures.push(format!(
                "{}: {} workhorse.retry spans, want {want_spans}",
                case.name,
                retries.len()
            ));
        } else if want_spans == 1 {
            let retry = retries[0];
            if retry.parent_span_id != handler[0].span_context.span_id() {
                failures.push(format!(
                    "{}: the retry span is not a child of the handler span",
                    case.name
                ));
            }
            // The tracing-opentelemetry layer adds its own keys, such as code.file.path.
            let mut keys: Vec<&str> = retry
                .attributes
                .iter()
                .map(|value| value.key.as_str())
                .filter(|key| key.starts_with("workhorse."))
                .collect();
            keys.sort_unstable();
            if keys
                != [
                    "workhorse.retry.outcome",
                    "workhorse.task.attempt",
                    "workhorse.task.id",
                    "workhorse.task.type",
                ]
            {
                failures.push(format!("{}: retry span attributes {keys:?}", case.name));
            }
            if attribute(retry, "workhorse.task.type").as_deref() != Some(case.name)
                || attribute(retry, "workhorse.task.attempt").as_deref() != Some("1")
            {
                failures
                    .push(format!("{}: retry span attributes {:?}", case.name, retry.attributes));
            }
            let outcome = attribute(retry, "workhorse.retry.outcome");
            let expected = if case.last {
                matches!(outcome.as_deref(), Some("failed"))
            } else {
                matches!(outcome.as_deref(), Some("ready" | "scheduled"))
            };
            if !expected {
                failures.push(format!("{}: workhorse.retry.outcome = {outcome:?}", case.name));
            }
        }
        let retried = retried_count(&metrics, case.name);
        let want_retried = u64::from(!case.last);
        if retried != want_retried {
            failures.push(format!(
                "{}: workhorse.tasks.retried = {retried}, want {want_retried}",
                case.name
            ));
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

/// The value of one attribute of `span`, as text.
fn attribute(span: &SpanData, key: &str) -> Option<String> {
    span.attributes
        .iter()
        .find(|value| value.key.as_str() == key)
        .map(|value| value.value.as_str().into_owned())
}

/// The `workhorse.tasks.retried` count of one queue.
fn retried_count(exporter: &InMemoryMetricExporter, queue: &str) -> u64 {
    let mut total = 0;
    // The exporter keeps every collection, so the last one holds the cumulative count.
    if let Some(resource) = exporter.get_finished_metrics().unwrap().last() {
        for scope in resource.scope_metrics() {
            for metric in
                scope.metrics().filter(|metric| metric.name() == "workhorse.tasks.retried")
            {
                if let AggregatedMetrics::U64(MetricData::Sum(sum)) = metric.data() {
                    total += sum
                        .data_points()
                        .filter(|point| {
                            point.attributes().any(|value| {
                                value.key.as_str() == "workhorse.queue.name"
                                    && value.value.as_str() == queue
                            })
                        })
                        .map(|point| point.value())
                        .sum::<u64>();
                }
            }
        }
    }
    total
}
