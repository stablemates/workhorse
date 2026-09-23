//! Execute every `dashboard/v1/conformance.json` exchange through the Rust dashboard service.
//!
//! The Go, Python and TypeScript hosts execute the same fixture. The seed steps run first in one
//! scratch database, then every exchange travels through [`DashboardService`] as an HTTP request.
//! A normal host serves the exchanges without a mode; a read-only host serves the `read-only`
//! ones. Without `DATABASE_URL_TEST` a local run skips and says so on standard error.

#[allow(dead_code)]
mod conformance;
mod support;

use std::collections::HashMap;

use serde_json::{json, Value};
use tokio_postgres::NoTls;
use tower::ServiceExt;
use workhorse::dashboard::http_body_util::{BodyExt, Full};
use workhorse::dashboard::{
    self, Authorization, DashboardOptions, DashboardService, Principal, ProcedureError, RpcError,
};
use workhorse::dashboard::{bytes, http};
use workhorse::{EnqueueOptions, Queue};

use conformance::database;
use conformance::matcher::{assert_value, read_pointer, resolve, References};

type Pool = deadpool_postgres::Pool;

const SET_SCHEDULE_PAUSED: &str = "SELECT workhorse.set_schedule_paused_v1(
$1::text, $2::text, $3::boolean, $4::text, $5::text) AS paused";

fn fixture() -> Value {
    let path = database::repository().join("dashboard/v1/conformance.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("parse {}: {error}", path.display()))
}

fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_owned()
}

fn service(harness: &Value, pool: &Pool, read_only: bool) -> DashboardService<Pool> {
    let actor = text(harness, "authenticatedActor");
    let authorize = dashboard::authorize(move |_parts| {
        let actor = actor.clone();
        async move { Authorization::Principal(Principal { actor }) }
    });
    let mut options = DashboardOptions::new(pool.clone(), authorize);
    options.path = text(harness, "basePath");
    options.environment = text(harness, "environment");
    options.read_only = read_only;
    options.configured_workers = harness["configuredWorkers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|worker| worker.as_str().unwrap().to_owned())
        .collect();
    options.maintenance_loops = Some(harness["maintenanceLoops"].clone());
    options.allowed_hosts = vec![text(harness, "origin").trim_start_matches("http://").to_owned()];
    if !read_only {
        options.procedures = extensions(pool);
    }
    dashboard::handler(options).expect("dashboard service")
}

/// The two optional procedures the fixture exercises, implemented as the Go harness does.
fn extensions(pool: &Pool) -> HashMap<String, dashboard::Procedure> {
    let queue = std::sync::Arc::new(Queue::new(pool.clone(), "conformance-demo"));
    let enqueue = dashboard::procedure(move |input: Value, _actor: String| {
        let queue = queue.clone();
        async move {
            let options = EnqueueOptions {
                priority: input["priority"].as_i64().unwrap_or_default() as i32,
                ..EnqueueOptions::default()
            };
            let task_type = format!("conformance.demo-{}", text(&input, "kind"));
            let task_id = queue.enqueue(&task_type, &json!({}), options).await?.task_id;
            Ok(json!({"taskId": task_id.to_string()}))
        }
    });
    let pool = pool.clone();
    let pause = dashboard::procedure(move |input: Value, actor: String| {
        let pool = pool.clone();
        async move {
            let client = pool.get().await.map_err(|error| internal(error.to_string()))?;
            let rows = client
                .query(
                    SET_SCHEDULE_PAUSED,
                    &[
                        &text(&input, "namespace"),
                        &text(&input, "name"),
                        &input["paused"].as_bool(),
                        &actor,
                        &"Dashboard operator request",
                    ],
                )
                .await
                .map_err(|error| internal(error.to_string()))?;
            match rows.as_slice() {
                [row] => Ok(json!({"paused": row.get::<_, bool>("paused")})),
                _ => Err(internal(format!("setSchedulePaused updated {} schedules", rows.len()))),
            }
        }
    });
    HashMap::from([("enqueueTest".to_owned(), enqueue), ("setSchedulePaused".to_owned(), pause)])
}

fn internal(message: String) -> ProcedureError {
    RpcError::new(500, "INTERNAL_SERVER_ERROR", message).into()
}

async fn seed(pool: &Pool, scenario: &str, step: &Value, references: &mut References) {
    let location = format!("{scenario}/{}", text(step, "id"));
    let client = pool.get().await.unwrap();
    let statement = client
        .prepare(step["sql"].as_str().unwrap())
        .await
        .unwrap_or_else(|error| panic!("{location}: {}", database::describe(&error)));
    let values = resolve(&step.get("parameters").cloned().unwrap_or(json!([])), references)
        .unwrap_or_else(|error| panic!("{location}: {error}"));
    let parameters = database::parameters(&statement, values.as_array().unwrap())
        .unwrap_or_else(|error| panic!("{location}: {error}"));
    let rows = client
        .query(&statement, &database::borrow(&parameters))
        .await
        .unwrap_or_else(|error| panic!("{location}: {}", database::describe(&error)));
    let actual = database::rows(&rows).unwrap_or_else(|error| panic!("{location}: {error}"));
    assert_value(&step["expect"]["rows"], &actual, references, &format!("{location}.rows"))
        .unwrap_or_else(|error| panic!("{error}"));
    capture(step, &actual, references, &location);
}

fn capture(step: &Value, actual: &Value, references: &mut References, location: &str) {
    for (name, pointer) in step.get("capture").and_then(Value::as_object).into_iter().flatten() {
        let value = read_pointer(actual, pointer.as_str().unwrap())
            .unwrap_or_else(|error| panic!("{location} capture {name}: {error}"));
        references.insert(name.clone(), value);
    }
}

async fn exchange(
    service: &DashboardService<Pool>,
    harness: &Value,
    exchange: &Value,
    references: &References,
) -> Result<(u16, Value), String> {
    let request = resolve(exchange.get("request").unwrap_or(&Value::Null), references)?;
    let base = match exchange.get("host").and_then(Value::as_str) {
        Some("foreign") => text(harness, "crossOrigin"),
        _ => text(harness, "origin"),
    };
    let uri = format!(
        "{base}{}/rpc/dashboard/{}",
        text(harness, "basePath"),
        text(exchange, "procedure")
    );
    let mut builder = http::Request::builder()
        .method(exchange.get("method").and_then(Value::as_str).unwrap_or("POST"))
        .uri(uri)
        .header(http::header::CONTENT_TYPE, "application/json");
    match exchange.get("origin").and_then(Value::as_str) {
        Some("none") => {}
        Some("cross") => {
            builder = builder.header(http::header::ORIGIN, text(harness, "crossOrigin"))
        }
        _ => builder = builder.header(http::header::ORIGIN, text(harness, "origin")),
    }
    let body = Full::new(bytes::Bytes::from(serde_json::to_vec(&request).unwrap()));
    let response = service.clone().oneshot(builder.body(body).unwrap()).await.unwrap();
    let status = response.status().as_u16();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let body = serde_json::from_slice(&bytes).map_err(|error| {
        format!("decode response ({error}): {}", String::from_utf8_lossy(&bytes))
    })?;
    Ok((status, body))
}

#[tokio::test(flavor = "multi_thread")]
async fn dashboard_satisfies_every_shared_http_scenario() {
    let Some(database) = support::scratch_database("dashboard_conformance").await else {
        return;
    };
    let manager = deadpool_postgres::Manager::new(database.url().parse().unwrap(), NoTls);
    let pool = deadpool_postgres::Pool::builder(manager).max_size(4).build().unwrap();
    let fixture = fixture();
    let harness = &fixture["harness"];
    let scenarios = fixture["scenarios"].as_array().unwrap();
    let mut references = References::new();
    for scenario in scenarios {
        for step in scenario.get("seed").and_then(Value::as_array).into_iter().flatten() {
            seed(&pool, &text(scenario, "id"), step, &mut references).await;
        }
    }

    let host = service(harness, &pool, false);
    let read_only_host = service(harness, &pool, true);
    let mut failures = Vec::new();
    let mut executed = 0;
    for scenario in scenarios {
        for item in scenario.get("exchanges").and_then(Value::as_array).into_iter().flatten() {
            executed += 1;
            let location = format!("{}/{}", text(scenario, "id"), text(item, "id"));
            let selected = match item.get("mode").and_then(Value::as_str) {
                Some("read-only") => &read_only_host,
                _ => &host,
            };
            let outcome =
                exchange(selected, harness, item, &references).await.and_then(|(status, body)| {
                    let expected = item["expect"]["status"].as_u64().unwrap() as u16;
                    if status != expected {
                        return Err(format!(
                            "status: expected {expected}, received {status}: {body}"
                        ));
                    }
                    assert_value(&item["expect"]["body"], &body, &references, "body")?;
                    Ok(body)
                });
            match outcome {
                Ok(body) => capture(item, &body, &mut references, &location),
                Err(error) => failures.push(format!("{location}: {error}")),
            }
        }
    }
    assert!(executed > 0, "the fixture declares no exchanges");
    assert!(failures.is_empty(), "{} exchanges failed:\n{}", failures.len(), failures.join("\n"));
}
