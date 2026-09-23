//! The dashboard service's HTTP behavior inside a host application.
//!
//! Requests refused before the compatibility check run against a pool whose database is never
//! reached. The rest run in a scratch database, as the other PostgreSQL tests do.
mod support;

use std::convert::Infallible;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::body::{Body, HttpBody};
use axum::routing::get;
use axum::Router;
use serde_json::{json, Value};
use tokio_postgres::NoTls;
use tower::ServiceExt;
use workhorse::dashboard::http::{self, header, Request, StatusCode};
use workhorse::dashboard::http_body_util::BodyExt;
use workhorse::dashboard::{self, Authorization, DashboardOptions, Principal};
use workhorse::{EnqueueOptions, EnqueueRequest, Queue};

type Pool = deadpool_postgres::Pool;

fn pool(url: &str) -> Pool {
    let manager = deadpool_postgres::Manager::new(url.parse().unwrap(), NoTls);
    Pool::builder(manager).max_size(2).build().unwrap()
}

/// A pool that fails if a request reaches PostgreSQL.
fn unreachable_pool() -> Pool {
    pool("postgresql://nobody@127.0.0.1:1/unreachable?connect_timeout=1")
}

fn principal(actor: &str) -> dashboard::Authorize {
    let actor = actor.to_owned();
    dashboard::authorize(move |_parts| {
        let actor = actor.clone();
        async move { Authorization::Principal(Principal { actor }) }
    })
}

fn options(pool: Pool, actor: &str) -> DashboardOptions<Pool> {
    let mut options = DashboardOptions::new(pool, principal(actor));
    options.environment = "test".into();
    options
}

/// A `meta` extension that reports the actor the service attributed the request to.
fn reporting_meta(options: &mut DashboardOptions<Pool>) {
    let meta = dashboard::procedure(|_input: Value, actor: String| async move {
        Ok(json!({ "environment": "test", "actor": actor }))
    });
    options.procedures.insert("meta".into(), meta);
}

fn request(method: &str, uri: &str, body: Value) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_vec(&body).unwrap()))
        .unwrap()
}

fn mutation(uri: &str, origin: &str, body: Value) -> Request<Body> {
    let mut request = request("POST", uri, body);
    request.headers_mut().insert(header::ORIGIN, origin.parse().unwrap());
    request
}

async fn send<S, B>(service: S, request: Request<Body>) -> (StatusCode, String)
where
    S: tower::Service<Request<Body>, Response = http::Response<B>, Error = Infallible>,
    B: HttpBody,
    B::Error: std::fmt::Debug,
{
    let response = service.oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, String::from_utf8(bytes.to_vec()).unwrap())
}

async fn send_json<S, B>(service: S, request: Request<Body>) -> (StatusCode, Value)
where
    S: tower::Service<Request<Body>, Response = http::Response<B>, Error = Infallible>,
    B: HttpBody,
    B::Error: std::fmt::Debug,
{
    let (status, body) = send(service, request).await;
    (status, serde_json::from_str(&body).unwrap_or_else(|_| panic!("not JSON: {body}")))
}

fn location<B>(response: &http::Response<B>) -> &str {
    response.headers()[header::LOCATION].to_str().unwrap()
}

/// Procedures that change state, in contract order.
const MUTATIONS: [&str; 15] = [
    "enqueueTest",
    "setSchedulePaused",
    "setQueuePaused",
    "purgeQueue",
    "setWorkerPaused",
    "overrideMaintenancePolicy",
    "revertMaintenancePolicy",
    "overrideRetentionPolicy",
    "revertRetentionPolicy",
    "runTaskNow",
    "cancelTask",
    "signalTask",
    "completeHumanWait",
    "redriveTask",
    "redriveDeadLetters",
];

fn audit() -> Value {
    json!({ "actor": "forged", "reason": "incident 42", "requestId": "request-1" })
}

#[tokio::test]
async fn a_nested_service_falls_through_to_the_host_routes() {
    let Some(database) = support::scratch_database("dashboard_http_nest").await else {
        return;
    };
    let dashboard = dashboard::handler(options(pool(database.url()), "operator@example.test"))
        .expect("dashboard service");
    let app = Router::new()
        .route("/health", get(|| async { "host health" }))
        .nest_service("/workhorse", dashboard)
        .fallback(|| async { (StatusCode::NOT_FOUND, "host fallback") });

    let redirect = app.clone().oneshot(request("GET", "/workhorse", Value::Null)).await.unwrap();
    assert_eq!(redirect.status(), StatusCode::FOUND);
    assert_eq!(location(&redirect), "/workhorse/tasks");

    let (status, page) = send(app.clone(), request("GET", "/workhorse/tasks", Value::Null)).await;
    assert_eq!(status, StatusCode::OK);
    assert!(page.contains(r#""auditActor":"operator@example.test""#), "{page}");
    assert!(page.contains(r#""basePath":"/workhorse""#), "{page}");
    let version = format!(r#""workhorseVersion":"{}""#, env!("CARGO_PKG_VERSION"));
    assert!(page.contains(&version), "{page}");

    let asset = page
        .split('"')
        .find_map(|part| part.strip_prefix("./assets/").filter(|name| name.ends_with(".js")))
        .map(|name| format!("/workhorse/assets/{name}"))
        .expect("the shell names a script asset");
    let response = app.clone().oneshot(request("GET", &asset, Value::Null)).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "text/javascript; charset=utf-8");
    assert!(response.headers()[header::CACHE_CONTROL].to_str().unwrap().contains("immutable"));

    let (status, body) =
        send(app.clone(), request("POST", "/workhorse/rpc/dashboard/meta", json!({}))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body.contains(r#""environment":"test""#), "{body}");

    assert_eq!(send(app.clone(), request("GET", "/health", Value::Null)).await.1, "host health");
    let (status, body) = send(app.clone(), request("GET", "/elsewhere", Value::Null)).await;
    assert_eq!((status, body.as_str()), (StatusCode::NOT_FOUND, "host fallback"));
    let (status, body) = send(app, request("GET", "/workhorsex", Value::Null)).await;
    assert_eq!((status, body.as_str()), (StatusCode::NOT_FOUND, "host fallback"));
}

#[tokio::test]
async fn a_root_mount_redirects_to_its_tasks_page() {
    let Some(database) = support::scratch_database("dashboard_http_root").await else {
        return;
    };
    let mut options = options(pool(database.url()), "operator@example.test");
    options.path = "/".into();
    let dashboard = dashboard::handler(options).unwrap();
    let response = dashboard.oneshot(request("GET", "https://example.test/", Value::Null)).await;
    let response = response.unwrap();
    assert_eq!(response.status(), StatusCode::FOUND);
    assert_eq!(location(&response), "/tasks");
}

#[tokio::test]
async fn authorization_runs_before_dispatch() {
    let unauthenticated = dashboard::authorize(|_parts| async { Authorization::Unauthenticated });
    let dashboard =
        dashboard::handler(DashboardOptions::new(unreachable_pool(), unauthenticated)).unwrap();
    let uri = "https://example.test/workhorse/rpc/dashboard/meta";
    let (status, body) = send_json(dashboard, request("POST", uri, json!({}))).await;
    assert_eq!((status, body), (StatusCode::UNAUTHORIZED, json!({ "error": "Unauthorized" })));

    let sign_in = dashboard::authorize(|_parts| async {
        let mut response = dashboard::Response::default();
        *response.status_mut() = StatusCode::SEE_OTHER;
        response.headers_mut().insert(header::LOCATION, "/sign-in".parse().unwrap());
        Authorization::Response(response)
    });
    let dashboard = dashboard::handler(DashboardOptions::new(unreachable_pool(), sign_in)).unwrap();
    let response =
        dashboard.oneshot(request("GET", "https://example.test/workhorse", Value::Null)).await;
    let response = response.unwrap();
    assert_eq!(response.status(), StatusCode::SEE_OTHER);
    assert_eq!(response.headers()[header::LOCATION], "/sign-in");
}

#[tokio::test]
async fn a_foreign_host_is_refused_before_authorization() {
    let authorized = Arc::new(AtomicUsize::new(0));
    let counter = authorized.clone();
    let authorize = dashboard::authorize(move |_parts| {
        counter.fetch_add(1, Ordering::SeqCst);
        async { Authorization::Unauthenticated }
    });
    let mut options = DashboardOptions::new(unreachable_pool(), authorize);
    options.allowed_hosts = vec!["127.0.0.1:4100".into(), "Dashboard.Example:80".into()];
    let dashboard = dashboard::handler(options).unwrap();

    let uri = "http://rebound.example:4100/workhorse/rpc/dashboard/queues";
    let (status, body) = send_json(dashboard.clone(), request("POST", uri, json!({}))).await;
    assert_eq!(status, StatusCode::MISDIRECTED_REQUEST);
    assert_eq!(body, json!({ "error": "Misdirected Request" }));
    assert_eq!(authorized.load(Ordering::SeqCst), 0);

    // A request without an absolute URI names its host in the Host header.
    let mut relative = request("GET", "/workhorse", Value::Null);
    relative.headers_mut().insert(header::HOST, "rebound.example".parse().unwrap());
    assert_eq!(send(dashboard.clone(), relative).await.0, StatusCode::MISDIRECTED_REQUEST);
    assert_eq!(authorized.load(Ordering::SeqCst), 0);

    for target in [
        "http://127.0.0.1:4100/workhorse",
        "http://DASHBOARD.example/workhorse",
        "http://dashboard.example:80/workhorse",
    ] {
        let status = send(dashboard.clone(), request("GET", target, Value::Null)).await.0;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{target}");
    }
    let mut listed = request("GET", "/workhorse", Value::Null);
    listed.headers_mut().insert(header::HOST, "127.0.0.1:4100".parse().unwrap());
    assert_eq!(send(dashboard, listed).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(authorized.load(Ordering::SeqCst), 4);
}

#[test]
fn an_allowed_host_must_be_a_bare_host() {
    for entry in ["http://127.0.0.1:4100/", "user@example.test", "example.test/path", ""] {
        let mut options = DashboardOptions::new(unreachable_pool(), principal("operator"));
        options.allowed_hosts = vec![entry.into()];
        let error = dashboard::handler(options).err().expect("a rejected allowed host");
        assert!(error.to_string().contains("host"), "{entry:?}: {error}");
    }
}

#[tokio::test]
async fn a_mutation_requires_the_same_origin() {
    let Some(database) = support::scratch_database("dashboard_http_origin").await else {
        return;
    };
    let dashboard = dashboard::handler(options(pool(database.url()), "operator")).unwrap();
    let uri = "https://example.test/workhorse/rpc/dashboard/purgeQueue";
    let input = json!({ "json": { "queue": "default", "audit": audit() } });
    for origin in ["https://attacker.test", "http://example.test"] {
        let request = mutation(uri, origin, input.clone());
        let (status, body) = send_json(dashboard.clone(), request).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{origin}");
        assert_eq!(body, json!({ "error": "A same-origin mutation request is required" }));
    }
    let (status, _) = send_json(dashboard, request("POST", uri, input)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "a mutation without an Origin header");
}

#[tokio::test]
async fn an_unconfigured_optional_procedure_is_forbidden() {
    let Some(database) = support::scratch_database("dashboard_http_optional").await else {
        return;
    };
    let dashboard = dashboard::handler(options(pool(database.url()), "operator")).unwrap();
    for procedure in ["enqueueTest", "setSchedulePaused"] {
        let uri = format!("https://example.test/workhorse/rpc/dashboard/{procedure}");
        let request = mutation(&uri, "https://example.test", json!({}));
        let (status, body) = send_json(dashboard.clone(), request).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{procedure}");
        assert_eq!(body["json"]["code"], "FORBIDDEN", "{procedure}");
        assert_eq!(body["json"]["message"], "This procedure is not available", "{procedure}");
    }
    let uri = "https://example.test/workhorse/rpc/dashboard/unknown";
    let (status, body) = send_json(dashboard, request("POST", uri, json!({}))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["json"]["message"], "Procedure not found");
}

#[tokio::test]
async fn the_audit_actor_comes_from_the_host_never_the_browser() {
    let Some(database) = support::scratch_database("dashboard_http_audit").await else {
        return;
    };
    let uri = "https://example.test/workhorse/rpc/dashboard/meta";

    // A blank audit actor option attributes requests to the authenticated principal.
    let mut principal_options = options(pool(database.url()), "operator@example.test");
    reporting_meta(&mut principal_options);
    let dashboard = dashboard::handler(principal_options).unwrap();
    let (status, body) = send_json(dashboard.clone(), request("POST", uri, json!({}))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["json"]["actor"], "operator@example.test");
    let (_, page) =
        send(dashboard, request("GET", "https://example.test/workhorse/tasks", Value::Null)).await;
    assert!(page.contains(r#""auditActor":"operator@example.test""#), "{page}");

    // A configured audit actor replaces the principal's.
    let mut configured = options(pool(database.url()), "operator@example.test");
    configured.audit_actor = "service-account".into();
    reporting_meta(&mut configured);
    let dashboard = dashboard::handler(configured).unwrap();
    let (_, body) = send_json(dashboard.clone(), request("POST", uri, json!({}))).await;
    assert_eq!(body["json"]["actor"], "service-account");

    // The service overwrites the actor a browser sends with the host's attribution.
    let queue = Queue::new(pool(database.url()), "audited");
    queue.enqueue("audit.probe", &json!({}), EnqueueOptions::default()).await.unwrap();
    let purge = "https://example.test/workhorse/rpc/dashboard/setQueuePaused";
    let input = json!({ "json": { "queue": "audited", "paused": true, "audit": audit() } });
    let request = mutation(purge, "https://example.test", input);
    let (status, body) = send_json(dashboard, request).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let client = database.connect().await;
    let actor: String = client
        .query_one(
            "SELECT updated_by FROM workhorse.queue_control WHERE queue_name = 'audited'",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(actor, "service-account");

    // A principal without an actor cannot attribute a control action, so it is refused.
    let dashboard = dashboard::handler(options(pool(database.url()), "")).unwrap();
    let input = json!({ "json": { "queue": "audited", "paused": false, "audit": audit() } });
    let request = mutation(purge, "https://example.test", input);
    let (status, body) = send_json(dashboard, request).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["json"]["code"], "BAD_REQUEST");
    assert_eq!(body["json"]["message"], "actor must contain between 1 and 200 characters");
}

#[tokio::test]
async fn a_read_only_dashboard_reads_and_refuses_every_mutation() {
    let Some(database) = support::scratch_database("dashboard_http_read_only").await else {
        return;
    };
    let mut read_only = options(pool(database.url()), "operator");
    read_only.read_only = true;
    let dashboard = dashboard::handler(read_only).unwrap();

    let queues = "https://example.test/workhorse/rpc/dashboard/queues";
    let (status, body) = send_json(dashboard.clone(), request("POST", queues, json!({}))).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    for procedure in MUTATIONS {
        assert!(dashboard::PROCEDURES.contains(&procedure), "{procedure}");
        let uri = format!("https://example.test/workhorse/rpc/dashboard/{procedure}");
        let request = mutation(&uri, "https://example.test", json!({}));
        let (status, body) = send_json(dashboard.clone(), request).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{procedure}");
        assert_eq!(body["json"]["message"], "This dashboard is read-only", "{procedure}");
    }
}

#[tokio::test]
async fn a_task_cursor_round_trips_without_losing_precision() {
    let Some(database) = support::scratch_database("dashboard_http_cursor").await else {
        return;
    };
    let queue = Queue::new(pool(database.url()), "cursor");
    let requests = (0..26)
        .map(|index| EnqueueRequest::new("cursor.page", json!({ "index": index })))
        .collect();
    queue.enqueue_many(requests).await.unwrap();
    let dashboard = dashboard::handler(options(pool(database.url()), "operator")).unwrap();
    let uri = "https://example.test/workhorse/rpc/dashboard/tasksCursor";

    let first = json!({ "json": { "pageSize": 25 } });
    let (status, page) = send_json(dashboard.clone(), request("POST", uri, first)).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    let cursor = page["json"]["nextCursor"].clone();
    let updated_at = cursor["updatedAt"].as_str().expect("a cursor timestamp").to_owned();
    assert!(updated_at.split('.').nth(1).is_some_and(|fraction| fraction.len() == 7), "{cursor}");

    let second = json!({ "json": { "pageSize": 25, "cursor": cursor } });
    let (status, next) = send_json(dashboard, request("POST", uri, second)).await;
    assert_eq!(status, StatusCode::OK, "{next}");
    let ids = |page: &Value| -> Vec<String> {
        let items = page["json"]["tasks"].as_array().expect("a page of tasks");
        items.iter().map(|item| item["id"].as_str().unwrap().to_owned()).collect()
    };
    let mut seen = ids(&page);
    seen.extend(ids(&next));
    seen.sort();
    seen.dedup();
    assert_eq!(seen.len(), 26, "the second page repeated or skipped a task");
}
