//! The count of each `cancel_v1` result in `workhorse.tasks.cancellation`, against a real
//! PostgreSQL schema.
//!
//! TypeScript counts each result of `Queue.cancel`, and its dashboard calls the queue. The Rust
//! dashboard runs `cancel_v1` itself, so it counts the same result. This file is its own test binary
//! with one test, so no other test changes the global meter provider while it runs.
#![cfg(feature = "opentelemetry")]

mod support;

use std::collections::BTreeMap;
use std::convert::Infallible;

use axum::body::Body;
use opentelemetry_sdk::metrics::data::{AggregatedMetrics, MetricData};
use opentelemetry_sdk::metrics::{InMemoryMetricExporter, PeriodicReader, SdkMeterProvider};
use serde_json::json;
use tokio_postgres::NoTls;
use tower::ServiceExt;
use uuid::Uuid;
use workhorse::dashboard::http::{header, Request, StatusCode};
use workhorse::dashboard::{self, Authorization, DashboardOptions, Principal};
use workhorse::{EnqueueOptions, Queue};

#[tokio::test]
async fn each_cancel_result_counts_once_by_its_durable_status() {
    let Some(database) = support::scratch_database("cancellation_metrics").await else { return };
    let queue = Queue::connect(database.url(), "rust-cancellation-metrics").await.unwrap();
    let missing = Uuid::new_v4();

    // The queue is built before the provider is registered, so it reads the provider on use.
    let metrics = InMemoryMetricExporter::default();
    let meter_provider = SdkMeterProvider::builder()
        .with_reader(PeriodicReader::builder(metrics.clone()).build())
        .build();
    opentelemetry::global::set_meter_provider(meter_provider.clone());

    let task = queue.enqueue("cancel-me", &json!({}), EnqueueOptions::default()).await.unwrap();
    queue.cancel(task.task_id, None, None).await.unwrap();
    queue.cancel(missing, None, None).await.unwrap();
    meter_provider.force_flush().unwrap();
    assert_eq!(
        statuses(&metrics),
        BTreeMap::from([("canceled".into(), 1), ("not_found".into(), 1)])
    );

    let manager = deadpool_postgres::Manager::new(database.url().parse().unwrap(), NoTls);
    let pool = deadpool_postgres::Pool::builder(manager).max_size(2).build().unwrap();
    let authorize = dashboard::authorize(|_parts| async {
        Authorization::Principal(Principal { actor: "operator".into() })
    });
    let mut options = DashboardOptions::new(pool, authorize);
    options.environment = "test".into();
    let service = dashboard::handler(options).unwrap();
    let dashboard_task =
        queue.enqueue("cancel-me", &json!({}), EnqueueOptions::default()).await.unwrap();
    for (id, expected) in
        [(dashboard_task.task_id, StatusCode::OK), (missing, StatusCode::NOT_FOUND)]
    {
        let audit = json!({ "actor": "operator", "reason": "test", "requestId": "request-1" });
        let body = json!({ "json": { "id": id, "audit": audit } });
        let request = Request::builder()
            .method("POST")
            .uri("https://example.test/workhorse/rpc/dashboard/cancelTask")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::ORIGIN, "https://example.test")
            .body(Body::from(serde_json::to_vec(&body).unwrap()))
            .unwrap();
        let response = ServiceExt::<Request<Body>>::oneshot(service.clone(), request).await;
        let response: Result<_, Infallible> = response;
        assert_eq!(response.unwrap().status(), expected);
    }
    meter_provider.force_flush().unwrap();
    assert_eq!(
        statuses(&metrics),
        BTreeMap::from([("canceled".into(), 2), ("not_found".into(), 2)])
    );
}

/// The value of each `workhorse.cancellation.status` in the last collection, which holds the
/// cumulative values. It also checks the unit, the description, and the only attribute.
fn statuses(exporter: &InMemoryMetricExporter) -> BTreeMap<String, u64> {
    let mut found = BTreeMap::new();
    let finished = exporter.get_finished_metrics().unwrap();
    let Some(resource) = finished.last() else { return found };
    for scope in resource.scope_metrics() {
        for metric in
            scope.metrics().filter(|metric| metric.name() == "workhorse.tasks.cancellation")
        {
            assert_eq!(metric.unit(), "{request}");
            assert_eq!(metric.description(), "Task cancellation requests by durable result");
            let AggregatedMetrics::U64(MetricData::Sum(sum)) = metric.data() else {
                panic!("workhorse.tasks.cancellation is not an integer sum");
            };
            assert!(sum.is_monotonic());
            for point in sum.data_points() {
                let attributes: Vec<_> = point.attributes().collect();
                assert_eq!(attributes.len(), 1, "{attributes:?}");
                assert_eq!(attributes[0].key.as_str(), "workhorse.cancellation.status");
                *found.entry(attributes[0].value.as_str().into_owned()).or_default() +=
                    point.value();
            }
        }
    }
    found
}
