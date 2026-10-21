//! Runs several Rust workers on one pool. A task whose payload has `handlerMs` returns after that
//! time; any other task holds its slot until SIGTERM. Every handler returns at SIGTERM, so the stop
//! time measures the SDK.
//!
//! `pnpm benchmark:connection-budget` builds this binary, starts it for each cell, and reads the
//! `WH_BENCH_*` variables below. Each worker gets a `listen_config`, so it listens as in
//! production; that connection carries the same `application_name` as the pool. Nothing in CI
//! runs this binary.
use std::io::Write;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::watch;
use workhorse::deadpool_postgres::tokio_postgres::{Config, NoTls};
use workhorse::deadpool_postgres::{Manager, Pool};
use workhorse::{HandlerContext, HandlerError, Worker, WorkerOptions};

type Failure = Box<dyn std::error::Error + Send + Sync>;

fn setting(name: &str) -> Result<String, Failure> {
    std::env::var(name).map_err(|_| format!("{name} is required").into())
}

fn count(name: &str) -> Result<u64, Failure> {
    match setting(name)?.parse::<u64>() {
        Ok(value) if value > 0 => Ok(value),
        _ => Err(format!("{name} must be a positive integer").into()),
    }
}

/// A positive integer from an optional variable, or `None` when the variable is empty.
fn optional_count(name: &str) -> Result<Option<u64>, Failure> {
    match std::env::var(name) {
        Ok(value) if !value.is_empty() => count(name).map(Some),
        _ => Ok(None),
    }
}

fn emit(event: &Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{event}");
    let _ = out.flush();
}

async fn released(mut receiver: watch::Receiver<bool>) {
    let _ = receiver.wait_for(|stopped| *stopped).await;
}

#[tokio::main]
async fn main() -> Result<(), Failure> {
    let mut config: Config = setting("WH_BENCH_DATABASE_URL")?.parse()?;
    config.application_name(setting("WH_BENCH_APPLICATION_NAME")?);
    let pool_size = usize::try_from(count("WH_BENCH_POOL_SIZE")?)?;
    let pool = Pool::builder(Manager::new(config.clone(), NoTls)).max_size(pool_size).build()?;
    let queue = setting("WH_BENCH_QUEUE")?;
    let task_type = setting("WH_BENCH_TASK_TYPE")?;
    let workers = count("WH_BENCH_WORKERS")?;
    let concurrency = usize::try_from(count("WH_BENCH_CONCURRENCY")?)?;
    let heartbeat = Duration::from_millis(count("WH_BENCH_HEARTBEAT_MS")?);
    let lease = Duration::from_millis(count("WH_BENCH_LEASE_MS")?);
    let poll_ms = optional_count("WH_BENCH_POLL_MS")?;
    let shutdown_grace_ms = count("WH_BENCH_SHUTDOWN_GRACE_MS")?;

    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let (stop, stopped) = watch::channel(false);
    let mut handles = Vec::new();
    for index in 0..workers {
        let worker = match Worker::new(
            pool.clone(),
            WorkerOptions {
                queues: vec![queue.clone()],
                worker_id: Some(format!("wh-bench-rust-{}-{index}", std::process::id())),
                concurrency,
                heartbeat_interval: Some(heartbeat),
                lease_duration: lease,
                // `None` keeps the default polling interval.
                poll_interval: poll_ms.map(Duration::from_millis),
                shutdown_grace_period: Duration::from_millis(shutdown_grace_ms),
                listen_config: Some(config.clone()),
                ..WorkerOptions::default()
            },
        ) {
            Ok(worker) => worker,
            Err(error) => {
                emit(
                    &json!({"event": "worker_error", "worker": index, "error": error.to_string()}),
                );
                continue;
            }
        };
        let release = stopped.clone();
        // A handler returns when the probe stops or the worker cancels the attempt. A handler with
        // a time also returns after it.
        worker.handle(&task_type, move |payload: Value, context: HandlerContext| {
            let release = release.clone();
            let handler_ms = payload.get("handlerMs").and_then(Value::as_u64);
            async move {
                match handler_ms {
                    Some(ms) => tokio::select! {
                        () = tokio::time::sleep(Duration::from_millis(ms)) => {}
                        () = released(release) => {}
                        () = context.cancellation().cancelled() => {}
                    },
                    None => tokio::select! {
                        () = released(release) => {}
                        () = context.cancellation().cancelled() => {}
                    },
                }
                Ok::<Value, HandlerError>(Value::Null)
            }
        });
        let shutdown = stopped.clone();
        handles.push(tokio::spawn(async move {
            if let Err(error) = worker.run(released(shutdown)).await {
                emit(
                    &json!({"event": "worker_error", "worker": index, "error": error.to_string()}),
                );
            }
        }));
    }
    emit(&json!({
        "event": "started",
        "sdk": "rust",
        "workers": workers,
        "pollMs": poll_ms,
        "shutdownGraceMs": shutdown_grace_ms,
        "grace": "shutdown_grace_period",
    }));

    // The pool state, seen from inside the process. The listener connections are outside the
    // pool, so the pool does not count them.
    let reporter_pool = pool.clone();
    let reporter_stop = stopped.clone();
    let reporter = tokio::spawn(async move {
        let mut ticks = tokio::time::interval(Duration::from_millis(250));
        loop {
            tokio::select! {
                () = released(reporter_stop.clone()) => break,
                _ = ticks.tick() => {
                    let status = reporter_pool.status();
                    emit(&json!({
                        "event": "pool",
                        "total": status.size,
                        "idle": status.available,
                        "checkedOut": status.size.saturating_sub(status.available),
                        "waiting": status.waiting,
                        "max": status.max_size,
                    }));
                }
            }
        }
    });

    terminate.recv().await;
    let _ = stop.send(true);
    reporter.await?;
    for handle in handles {
        handle.await?;
    }
    emit(&json!({"event": "stopped"}));
    Ok(())
}
