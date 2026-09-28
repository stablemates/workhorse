//! Runs several Rust workers against one fast-tier queue until a deadline.
//!
//! `pnpm benchmark:fast-claim-deadlock` seeds the queue, builds this binary, and counts the
//! deadlocks PostgreSQL resolves while it runs. The SDK path matters: its fused claim overlaps
//! with batched completions and heartbeats from the same worker, which is what closed the
//! SM-934 cycle. Nothing in CI runs this binary.
use std::time::Duration;

use serde_json::{json, Value};
use workhorse::deadpool_postgres::tokio_postgres::NoTls;
use workhorse::deadpool_postgres::{Manager, Pool};
use workhorse::{Worker, WorkerOptions};

const QUEUE: &str = "benchmark-fast-claim-deadlock";
const TASK_TYPE: &str = "benchmark.work";

fn setting(name: &str, fallback: u64) -> Result<u64, Box<dyn std::error::Error>> {
    match std::env::var(name) {
        Ok(value) => Ok(value.parse().map_err(|_| format!("{name} must be an integer"))?),
        Err(_) => Ok(fallback),
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let url = std::env::var("DATABASE_URL")?;
    let workers = setting("WORKERS", 8)?;
    let concurrency = setting("CONCURRENCY", 16)? as usize;
    let seconds = setting("SECONDS", 30)?;
    let heartbeat = setting("HEARTBEAT_MS", 100)?;
    let work = setting("WORK_MS", 20)?;

    let (stop, _) = tokio::sync::broadcast::channel::<()>(1);
    let mut handles = Vec::new();
    for index in 1..=workers {
        // One pool per worker, as separate worker processes would have.
        let pool =
            Pool::builder(Manager::new(url.parse()?, NoTls)).max_size(concurrency + 4).build()?;
        let worker = Worker::new(
            pool,
            WorkerOptions {
                queues: vec![QUEUE.into()],
                worker_id: Some(format!("benchmark-fast-claim-deadlock-{index}")),
                concurrency,
                heartbeat_interval: Some(Duration::from_millis(heartbeat)),
                ..WorkerOptions::default()
            },
        )?;
        worker.handle(TASK_TYPE, move |_payload: Value, _context| async move {
            tokio::time::sleep(Duration::from_millis(jitter(work))).await;
            Ok(json!({}))
        });
        let mut receiver = stop.subscribe();
        handles.push(tokio::spawn(async move {
            worker
                .run(async move {
                    let _ = receiver.recv().await;
                })
                .await
        }));
    }
    tokio::time::sleep(Duration::from_secs(seconds)).await;
    let _ = stop.send(());
    for handle in handles {
        handle.await??;
    }
    Ok(())
}

/// A handler duration below `max` milliseconds, varied so completions do not arrive in step.
fn jitter(max: u64) -> u64 {
    if max == 0 {
        return 0;
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| u64::from(elapsed.subsec_nanos()));
    nanos % max
}
