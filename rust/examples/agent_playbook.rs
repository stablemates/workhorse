//! The end-to-end integration the agent playbook page shows: a transactional enqueue, a handler
//! whose external send is a checkpoint, and a durable read of the settled task.
// docs:start agent-playbook
use serde_json::{json, Value};
use workhorse::deadpool_postgres::tokio_postgres::NoTls;
use workhorse::deadpool_postgres::{Manager, Pool};
use workhorse::{Admin, EnqueueOptions, HandlerError, Queue, Worker, WorkerOptions};

async fn send_confirmation_email(order_id: &str) -> Result<String, HandlerError> {
    Ok(format!("receipt-for-{order_id}"))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let url = std::env::var("DATABASE_URL")?;
    let pool = Pool::builder(Manager::new(url.parse()?, NoTls)).max_size(4).build()?;

    let mut client = pool.get().await?;
    let transaction = client.transaction().await?;
    transaction
        .execute("INSERT INTO orders (id, status) VALUES ($1, $2)", &[&"order-42", &"new"])
        .await?;
    let retry_policy = json!({ "type": "fixed", "delayMs": 1_000 });
    let enqueued = Queue::new(&transaction, "default")
        .enqueue(
            "order.created",
            &json!({ "orderId": "order-42" }),
            EnqueueOptions {
                max_attempts: 5,
                retry_policy: retry_policy.as_object().cloned(),
                ..Default::default()
            },
        )
        .await?;
    transaction.commit().await?; // Dropping an uncommitted transaction rolls it back.
    drop(client);

    let worker =
        Worker::new(pool.clone(), WorkerOptions { polling_only: true, ..Default::default() })?;
    worker.handle("order.created", |payload: Value, context| async move {
        let order_id = payload["orderId"].as_str().unwrap_or_default().to_owned();
        // The send runs once. A replay reuses the recorded receipt.
        let receipt: String =
            context.checkpoint("confirmation-email", || send_confirmation_email(&order_id)).await?;
        Ok(json!({ "processedOrderId": order_id, "receipt": receipt }))
    });
    worker.run_once().await?; // Production workers call run_worker_process(&worker).

    let admin = Admin::connect(&url).await?;
    if let Some(task) = admin.get_task(enqueued.task_id).await? {
        println!("{:?} {}", task.state, task.result.unwrap_or_default());
    }
    Ok(())
}
// docs:end
