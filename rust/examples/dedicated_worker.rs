//! Runs a dedicated worker process until SIGINT or SIGTERM, then drains its active tasks.
use std::time::Duration;

use serde_json::{json, Value};
use workhorse::deadpool_postgres::tokio_postgres::NoTls;
use workhorse::deadpool_postgres::{Manager, Pool};
use workhorse::{run_worker_process, HandlerContext, HandlerError, Worker, WorkerOptions};

async fn accept_order(payload: Value, context: HandlerContext) -> Result<Value, HandlerError> {
    if let Some(reason) = context.cancellation().reason() {
        return Err(workhorse::Error::Cancelled(reason).into());
    }
    Ok(json!({ "payload": payload, "prepared": true }))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let url = std::env::var("WORKHORSE_DATABASE_URL")?;
    let pool = Pool::builder(Manager::new(url.parse()?, NoTls)).max_size(10).build()?;

    let worker = Worker::new(
        pool,
        WorkerOptions {
            queues: vec!["orders".into()],
            worker_id: Some("orders-worker".into()),
            concurrency: 8,
            shutdown_grace_period: Duration::from_secs(20),
            ..Default::default()
        },
    )?;
    worker.handle("order.accepted", accept_order);
    run_worker_process(&worker).await?;
    Ok(())
}
