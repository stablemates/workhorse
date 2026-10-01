//! Runs an order handler that fans out two child tasks, then waits for a signal and a human decision.
use serde_json::{json, Value};
use workhorse::deadpool_postgres::tokio_postgres::NoTls;
use workhorse::deadpool_postgres::{Manager, Pool};
use workhorse::{
    run_worker_process, ChildTaskRequest, EnqueueOptions, HandlerContext, HandlerError, Worker,
    WorkerOptions,
};

const QUEUE: &str = "orders";

/// A child omitted from any queue goes to `default`, which this worker does not serve.
fn child(name: &str, task_type: &str, payload: &Value) -> Result<ChildTaskRequest, HandlerError> {
    let mut request = ChildTaskRequest::new(name, task_type, payload)?;
    request.options = EnqueueOptions { queue: Some(QUEUE.into()), ..Default::default() };
    Ok(request)
}

async fn process_order(payload: Value, context: HandlerContext) -> Result<Value, HandlerError> {
    let children = context
        .run_children_all(vec![
            child("invoice", "invoice.create", &payload)?,
            child("receipt", "receipt.send", &payload)?,
        ])
        .await?;
    let approval: Value = context.wait_for_signal("approval", None).await?.payload;
    let review = json!({ "payload": payload, "approval": approval });
    let decision: Value = context.wait_for_human("review", &review, None).await?.result;
    Ok(json!({ "children": children, "approval": approval, "decision": decision }))
}

async fn complete_child(payload: Value, _context: HandlerContext) -> Result<Value, HandlerError> {
    Ok(json!({ "completed": true, "payload": payload }))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let url = std::env::var("WORKHORSE_DATABASE_URL")?;
    let pool = Pool::builder(Manager::new(url.parse()?, NoTls)).max_size(10).build()?;

    let worker =
        Worker::new(pool, WorkerOptions { queues: vec![QUEUE.into()], ..Default::default() })?;
    worker.handle("order.process", process_order);
    worker.handle("invoice.create", complete_child);
    worker.handle("receipt.send", complete_child);
    run_worker_process(&worker).await?;
    Ok(())
}
