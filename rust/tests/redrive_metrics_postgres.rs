//! The count of each `redrive_v1` and `redrive_many_v1` result in `workhorse.tasks.redrive`,
//! against a real PostgreSQL schema.
//!
//! TypeScript counts each result of `Admin.redrive` and `Admin.redriveMany`, and its dashboard
//! calls the admin. The Rust dashboard calls its admin too, so it counts the same result. This file
//! is its own test binary with one test, so no other test changes the global meter provider while
//! it runs.
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
use workhorse::{Admin, AdminAudit, BulkRedriveOptions, DeadLetterFilter, EnqueueOptions, Queue};

/// `redrive_many_v1` answers two rows of a known status and one of a status of a newer protocol,
/// and `redrive_v1` answers a status of a newer protocol. Only a failed task gives real rows.
const SCRIPTED_REDRIVE_FUNCTIONS: &str = r"
CREATE OR REPLACE FUNCTION workhorse.redrive_many_v1(
  p_filter jsonb, p_limit integer, p_dry_run boolean, p_requested_by text, p_reason text,
  p_request_id text, p_cursor_finished_at timestamptz DEFAULT NULL,
  p_cursor_task_id uuid DEFAULT NULL
) RETURNS TABLE (
  ordinal integer, status text, source_task_id uuid, target_task_id uuid, source_state text,
  target_state text, requested_at timestamptz, source_finished_at_cursor text, has_more boolean
) LANGUAGE sql AS $body$
  SELECT row.ordinal, row.status, gen_random_uuid(), NULL::uuid, NULL::text, NULL::text,
         NULL::timestamptz, NULL::text, false
  FROM (VALUES (1, 'redriven'), (2, 'future_status'), (3, 'redriven')) AS row(ordinal, status)
$body$;
CREATE OR REPLACE FUNCTION workhorse.redrive_v1(
  p_source_task_id uuid, p_requested_by text, p_reason text, p_request_id text
) RETURNS TABLE (
  status text, source_task_id uuid, target_task_id uuid, source_state text, target_state text,
  requested_at timestamptz
) LANGUAGE sql AS $body$
  SELECT 'future_status'::text, p_source_task_id, NULL::uuid, NULL::text, NULL::text,
         NULL::timestamptz
$body$;
";

fn audit() -> AdminAudit {
    AdminAudit {
        actor: "operator".into(),
        reason: "redrive metric".into(),
        request_id: Uuid::new_v4().to_string(),
    }
}

#[tokio::test]
async fn each_redrive_result_counts_by_its_durable_status() {
    let Some(database) = support::scratch_database("redrive_metrics").await else { return };
    let queue = Queue::connect(database.url(), "rust-redrive-metrics").await.unwrap();
    let admin = Admin::connect(database.url()).await.unwrap();
    let missing = Uuid::new_v4();

    // The admin is built before the provider is registered, so it reads the provider on use.
    let metrics = InMemoryMetricExporter::default();
    let meter_provider = SdkMeterProvider::builder()
        .with_reader(PeriodicReader::builder(metrics.clone()).build())
        .build();
    opentelemetry::global::set_meter_provider(meter_provider.clone());

    let task = queue.enqueue("redrive-me", &json!({}), EnqueueOptions::default()).await.unwrap();
    admin.redrive(missing, &audit()).await.unwrap();
    admin.redrive(task.task_id, &audit()).await.unwrap();
    let mut filter = DeadLetterFilter::default();
    filter.queue = Some("rust-redrive-metrics".into());
    // A page without a failed task counts nothing.
    let empty = admin.redrive_many(filter, &audit(), BulkRedriveOptions::default()).await.unwrap();
    assert!(empty.results.is_empty());
    meter_provider.force_flush().unwrap();
    assert_eq!(
        statuses(&metrics),
        BTreeMap::from([("not_failed".into(), 1), ("not_found".into(), 1)])
    );

    let manager = deadpool_postgres::Manager::new(database.url().parse().unwrap(), NoTls);
    let pool = deadpool_postgres::Pool::builder(manager).max_size(2).build().unwrap();
    let authorize = dashboard::authorize(|_parts| async {
        Authorization::Principal(Principal { actor: "operator".into() })
    });
    let mut options = DashboardOptions::new(pool, authorize);
    options.environment = "test".into();
    let service = dashboard::handler(options).unwrap();
    let audit_input = json!({ "actor": "operator", "reason": "test", "requestId": "request-1" });
    let body = json!({ "json": { "id": missing, "audit": audit_input } });
    let request = Request::builder()
        .method("POST")
        .uri("https://example.test/workhorse/rpc/dashboard/redriveTask")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ORIGIN, "https://example.test")
        .body(Body::from(serde_json::to_vec(&body).unwrap()))
        .unwrap();
    let response: Result<_, Infallible> =
        ServiceExt::<Request<Body>>::oneshot(service, request).await;
    assert_eq!(response.unwrap().status(), StatusCode::NOT_FOUND);

    // As in TypeScript, the count takes the raw status before the result is checked, so a status
    // of a newer protocol is also counted. A dry run counts its rows too.
    database.connect().await.batch_execute(SCRIPTED_REDRIVE_FUNCTIONS).await.unwrap();
    let mut dry_run = BulkRedriveOptions::default();
    dry_run.dry_run = true;
    assert!(admin.redrive_many(DeadLetterFilter::default(), &audit(), dry_run).await.is_err());
    assert!(admin.redrive(missing, &audit()).await.is_err());
    meter_provider.force_flush().unwrap();
    assert_eq!(
        statuses(&metrics),
        BTreeMap::from([
            ("future_status".into(), 2),
            ("not_failed".into(), 1),
            ("not_found".into(), 2),
            ("redriven".into(), 2),
        ])
    );
}

/// The value of each `workhorse.redrive.status` in the last collection, which holds the cumulative
/// values. It also checks the unit, the description, and the only attribute.
fn statuses(exporter: &InMemoryMetricExporter) -> BTreeMap<String, u64> {
    let mut found = BTreeMap::new();
    let finished = exporter.get_finished_metrics().unwrap();
    let Some(resource) = finished.last() else { return found };
    for scope in resource.scope_metrics() {
        for metric in scope.metrics().filter(|metric| metric.name() == "workhorse.tasks.redrive") {
            assert_eq!(metric.unit(), "{request}");
            assert_eq!(metric.description(), "Task redrive requests by durable result");
            let AggregatedMetrics::U64(MetricData::Sum(sum)) = metric.data() else {
                panic!("workhorse.tasks.redrive is not an integer sum");
            };
            assert!(sum.is_monotonic());
            for point in sum.data_points() {
                let attributes: Vec<_> = point.attributes().collect();
                assert_eq!(attributes.len(), 1, "{attributes:?}");
                assert_eq!(attributes[0].key.as_str(), "workhorse.redrive.status");
                *found.entry(attributes[0].value.as_str().into_owned()).or_default() +=
                    point.value();
            }
        }
    }
    found
}
