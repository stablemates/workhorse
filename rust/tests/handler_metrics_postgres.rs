//! The handler metrics of an attempt whose settlement failed, and of the release of a task without
//! a handler, against a real PostgreSQL schema.
//!
//! The TypeScript worker records the duration of an attempt without an outcome with the outcome
//! `unknown`, and `workhorse.handler.executions` does not count it. It records the metrics of a
//! release with the outcome `released`. This file is its own test binary with one test, so no
//! other test changes the global meter provider while it runs.
#![cfg(feature = "opentelemetry")]

mod support;

use std::time::Duration;

use opentelemetry::KeyValue;
use opentelemetry_sdk::metrics::data::{AggregatedMetrics, MetricData};
use opentelemetry_sdk::metrics::{InMemoryMetricExporter, PeriodicReader, SdkMeterProvider};
use serde_json::{json, Value};
use support::scratch_database;
use tokio_postgres::NoTls;
use workhorse::{EnqueueOptions, Queue, Worker, WorkerOptions};

#[tokio::test]
async fn the_handler_metrics_of_a_failed_settlement_and_of_a_release() {
    let Some(database) = scratch_database("handler_metrics_unsettled").await else { return };
    let metrics = InMemoryMetricExporter::default();
    let meter_provider = SdkMeterProvider::builder()
        .with_reader(PeriodicReader::builder(metrics.clone()).build())
        .build();
    // The worker binds its instruments to the global provider when it is built.
    opentelemetry::global::set_meter_provider(meter_provider.clone());
    let (client, connection) = tokio_postgres::connect(database.url(), NoTls).await.unwrap();
    tokio::spawn(connection);
    // Each completion fails, so the attempt does not settle.
    client
        .batch_execute(
            r"
            CREATE OR REPLACE FUNCTION workhorse.complete_v1(
              p_task_id uuid, p_worker_id text, p_fence_token bigint,
              p_result jsonb DEFAULT 'null'::jsonb)
              RETURNS boolean LANGUAGE plpgsql AS $body$
              BEGIN RAISE EXCEPTION 'injected completion failure'; END $body$;
            ",
        )
        .await
        .unwrap();
    let queue_name = "rust-unsettled-metrics";
    let queue = Queue::connect(database.url(), queue_name).await.unwrap();
    queue.enqueue("unsettled", &json!({}), EnqueueOptions::default()).await.unwrap();
    let worker = worker_on(database.url(), queue_name);
    worker.handle("unsettled", |_: Value, _| async { Ok(json!("done")) });
    let worked = tokio::time::timeout(Duration::from_secs(30), worker.run_once()).await.unwrap();
    assert!(worked.is_err(), "the failed completion did not end the pass");

    // A task without a handler goes back to its queue through release_owned_v1.
    let missing_queue = "rust-missing-handler-metrics";
    let missing = Queue::connect(database.url(), missing_queue).await.unwrap();
    missing.enqueue("missing", &json!({}), EnqueueOptions::default()).await.unwrap();
    let releasing = worker_on(database.url(), missing_queue);
    releasing.handle("other", |_: Value, _| async { Ok(json!("done")) });
    tokio::time::timeout(Duration::from_secs(30), releasing.run_once()).await.unwrap().unwrap();

    meter_provider.force_flush().unwrap();
    assert_eq!(
        outcomes(&metrics, "workhorse.handler.executions", queue_name),
        Vec::<String>::new()
    );
    assert_eq!(outcomes(&metrics, "workhorse.handler.duration", queue_name), vec!["unknown"]);
    assert_eq!(outcomes(&metrics, "workhorse.handler.executions", missing_queue), vec!["released"]);
    assert_eq!(outcomes(&metrics, "workhorse.handler.duration", missing_queue), vec!["released"]);
}

/// A polling worker of `queue` without a registry row or a due maintenance pass.
fn worker_on(url: &str, queue: &str) -> Worker {
    let manager = deadpool_postgres::Manager::new(url.parse().unwrap(), NoTls);
    let pool = deadpool_postgres::Pool::builder(manager).max_size(4).build().unwrap();
    Worker::new(pool, {
        let mut options = WorkerOptions::default();
        options.queues = vec![queue.into()];
        options.worker_id = Some(queue.into());
        options.polling_only = true;
        options.disable_registry = true;
        options.maintenance_interval = Duration::from_secs(3600);
        options
    })
    .unwrap()
}

/// The `workhorse.handler.outcome` of each point of the metric `name` for `queue`, in the last
/// collection, which holds the cumulative values.
fn outcomes(exporter: &InMemoryMetricExporter, name: &str, queue: &str) -> Vec<String> {
    let mut found = Vec::new();
    let finished = exporter.get_finished_metrics().unwrap();
    let Some(resource) = finished.last() else {
        return found;
    };
    let mut take = |attributes: Vec<KeyValue>| {
        let of_queue = attributes.iter().any(|value| {
            value.key.as_str() == "workhorse.queue.name" && value.value.as_str() == queue
        });
        if of_queue {
            if let Some(outcome) =
                attributes.iter().find(|value| value.key.as_str() == "workhorse.handler.outcome")
            {
                found.push(outcome.value.as_str().into_owned());
            }
        }
    };
    for scope in resource.scope_metrics() {
        for metric in scope.metrics().filter(|metric| metric.name() == name) {
            match metric.data() {
                AggregatedMetrics::F64(MetricData::Sum(sum)) => {
                    sum.data_points().for_each(|point| take(point.attributes().cloned().collect()));
                }
                AggregatedMetrics::U64(MetricData::Sum(sum)) => {
                    sum.data_points().for_each(|point| take(point.attributes().cloned().collect()));
                }
                AggregatedMetrics::F64(MetricData::Histogram(histogram)) => histogram
                    .data_points()
                    .for_each(|point| take(point.attributes().cloned().collect())),
                _ => {}
            }
        }
    }
    found
}
