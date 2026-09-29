//! The Rust worker process the Workhorse demo runs beside its TypeScript, Python, and Go workers.
use std::future::Future;
use std::time::Duration;

use serde_json::{json, Value};
use workhorse::compatibility::{assert_schema_compatible, CompatibilityCode};
use workhorse::deadpool_postgres::tokio_postgres::NoTls;
use workhorse::deadpool_postgres::{Manager, Pool};
use workhorse::{Error, HandlerContext, HandlerError, Worker, WorkerOptions};

pub const LANGUAGE_TASK_TYPE: &str = "demo.language-worker";
pub const SHARED_TASK_TYPE: &str = "demo.shared-worker";
pub const RUST_QUEUE: &str = "demo-rust";
pub const RUST_FAST_QUEUE: &str = "demo-rust-fast";
pub const SHARED_QUEUE: &str = "demo-shared";
pub const SCHEDULE_NAMESPACE: &str = "workhorse-demo";
pub const FAST_TIER_SCHEDULE_NAMESPACE: &str = "workhorse-demo-fast-tier";
pub const WORKER_CONCURRENCY: usize = 3;
pub const DEFAULT_POLL_MILLISECONDS: u64 = 15_000;
const SCHEMA_RETRY: Duration = Duration::from_millis(500);

/// Names the process the way the Go and Python demo workers do.
pub fn worker_id() -> String {
    let hostname = std::fs::read_to_string("/proc/sys/kernel/hostname")
        .ok()
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
        .or_else(|| std::env::var("HOSTNAME").ok())
        .unwrap_or_else(|| "localhost".into());
    let random = uuid::Uuid::new_v4().simple().to_string();
    format!("demo-rust-{hostname}-{}-{}", std::process::id(), &random[..8])
}

/// Reads `WORKHORSE_WORKER_POLL_MS`; zero leaves the SDK default in place.
pub fn poll_interval(value: Option<&str>) -> Result<Option<Duration>, Error> {
    let milliseconds = match value {
        None | Some("") => DEFAULT_POLL_MILLISECONDS,
        Some(value) => value.parse::<u64>().map_err(|_| {
            Error::InvalidArgument("WORKHORSE_WORKER_POLL_MS must be a non-negative integer".into())
        })?,
    };
    Ok((milliseconds > 0).then(|| Duration::from_millis(milliseconds)))
}

pub fn connection_pool(url: &str) -> Result<Pool, Box<dyn std::error::Error>> {
    let config = url.parse()?;
    Ok(Pool::builder(Manager::new(config, NoTls)).max_size(WORKER_CONCURRENCY + 4).build()?)
}

async fn language_task(payload: Value, context: HandlerContext) -> Result<Value, HandlerError> {
    if payload.get("language").and_then(Value::as_str) != Some("rust") {
        return Err(HandlerError::new("rust worker received a task for another language"));
    }
    Ok(json!({ "language": "rust", "runtime": "rust", "attempt": context.task().attempt }))
}

async fn shared_task(payload: Value, context: HandlerContext) -> Result<Value, HandlerError> {
    let Some(source) = payload.get("source").and_then(Value::as_str) else {
        return Err(HandlerError::new("shared worker requires a source"));
    };
    Ok(json!({ "source": source, "runtime": "rust", "attempt": context.task().attempt }))
}

/// Builds the worker that serves the Rust queues, the fast-tier Rust queue, and the shared queue.
pub fn build_worker(
    pool: Pool,
    worker_id: String,
    poll_interval: Option<Duration>,
    listen_config: Option<workhorse::deadpool_postgres::tokio_postgres::Config>,
) -> Result<Worker, Error> {
    let worker = Worker::new(
        pool,
        WorkerOptions {
            queues: vec![RUST_QUEUE.into(), SHARED_QUEUE.into(), RUST_FAST_QUEUE.into()],
            worker_id: Some(worker_id),
            concurrency: WORKER_CONCURRENCY,
            poll_interval,
            schedule_namespaces: vec![
                SCHEDULE_NAMESPACE.into(),
                FAST_TIER_SCHEDULE_NAMESPACE.into(),
            ],
            maintenance_interval: Duration::from_secs(1),
            registry_interval: Duration::from_millis(250),
            shutdown_grace_period: Duration::from_secs(25),
            polling_only: listen_config.is_none(),
            listen_config,
            ..Default::default()
        },
    )?;
    worker.handle(LANGUAGE_TASK_TYPE, language_task);
    worker.handle(SHARED_TASK_TYPE, shared_task);
    Ok(worker)
}

/// Waits while the demo server has not installed the schema yet.
///
/// In development the server installs the schema on first start, so a worker that starts beside it
/// can see an empty database. Every other compatibility refusal fails at once. Returns `false` when shutdown
/// arrives first.
pub async fn wait_for_schema<F: Future<Output = ()>>(
    pool: &Pool,
    shutdown: F,
) -> Result<bool, Error> {
    tokio::pin!(shutdown);
    let mut logged = false;
    loop {
        let client = pool.get().await?;
        match assert_schema_compatible(&client).await {
            Ok(()) => return Ok(true),
            Err(Error::Compatibility { code: CompatibilityCode::SchemaNotInstalled }) => {
                if !logged {
                    tracing::info!("Waiting for the demo server to install the Workhorse schema");
                    logged = true;
                }
            }
            Err(error) => return Err(error),
        }
        drop(client);
        tokio::select! {
            () = &mut shutdown => return Ok(false),
            () = tokio::time::sleep(SCHEMA_RETRY) => {}
        }
    }
}
