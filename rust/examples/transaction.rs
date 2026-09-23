//! Enqueues a task inside a caller-owned transaction, so it exists only if the caller commits.
use serde_json::json;
use tokio_postgres::NoTls;
use workhorse::{EnqueueOptions, Queue};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let url = std::env::var("WORKHORSE_DATABASE_URL")?;
    let (mut client, connection) = tokio_postgres::connect(&url, NoTls).await?;
    tokio::spawn(connection);

    let transaction = client.transaction().await?;
    // Application writes can use the transaction here. The task becomes visible only if the
    // caller commits the same transaction.
    let retry_policy = json!({
        "type": "exponential", "initialDelayMs": 1_000, "multiplier": 2, "maxDelayMs": 60_000,
    });
    let result = Queue::new(&transaction, "orders")
        .enqueue(
            "order.accepted",
            &json!({ "orderId": "order-42" }),
            EnqueueOptions {
                max_attempts: 3,
                retry_policy: retry_policy.as_object().cloned(),
                ..Default::default()
            },
        )
        .await?;
    transaction.commit().await?;
    println!("{}", result.task_id);
    Ok(())
}
