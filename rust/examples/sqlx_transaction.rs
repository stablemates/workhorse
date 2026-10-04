//! Atomically commit an application row and a task through a caller-owned SQLx transaction.
//!
//! Documentation: https://workhorse.run/docs/sqlx
use serde_json::json;
use sqlx::{Connection, PgConnection};
use workhorse::{sqlx, EnqueueClient, EnqueueOptions};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let url = std::env::var("WORKHORSE_DATABASE_URL")?;
    let mut connection = PgConnection::connect(&url).await?;
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS public.sqlx_example_order \
         (id uuid PRIMARY KEY, reference text NOT NULL)",
    )
    .execute(&mut connection)
    .await?;
    let order_id = uuid::Uuid::new_v4();
    // docs:start sqlx-transaction
    let client = EnqueueClient::new("orders");
    let mut transaction = connection.begin().await?;
    sqlx::query("INSERT INTO public.sqlx_example_order (id, reference) VALUES ($1, $2)")
        .bind(order_id)
        .bind("order-42")
        .execute(&mut *transaction)
        .await?;
    let accepted = client
        .enqueue(
            &mut transaction,
            "order.accepted",
            &json!({ "orderId": order_id }),
            EnqueueOptions::default(),
        )
        .await?;
    transaction.commit().await?;
    // docs:end
    println!("order {order_id}, task {}", accepted.task_id);
    Ok(())
}
