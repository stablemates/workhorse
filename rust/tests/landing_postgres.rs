//! Runs the Rust landing page snippets that `examples/landing.rs` holds against PostgreSQL.
//!
//! `cargo clippy --all-targets` only compiles the example, so a snippet that sends a value the
//! database refuses compiles and still fails for the reader who copies it. This file includes the
//! example as a module and calls its regions on a scratch database.
mod support;

#[path = "../examples/landing.rs"]
mod landing;

use chrono::{Duration, Utc};
use serde_json::{json, Value};
use support::scratch_database;
use tokio_postgres::NoTls;
use workhorse::deadpool_postgres::{Manager, Pool};
use workhorse::{EnqueueOutcome, Queue};

#[tokio::test]
async fn the_retries_snippet_stores_its_retry_policy() {
    let Some(database) = scratch_database("landing_retries").await else { return };
    let pool = Pool::builder(Manager::new(database.url().parse().unwrap(), NoTls))
        .max_size(2)
        .build()
        .unwrap();
    let queue = Queue::new(pool, "default");
    let kickoff = Utc::now() + Duration::hours(2);

    let result = landing::landing_retries::remind(&queue, "match-1", kickoff).await.unwrap();

    assert_eq!(result.outcome, EnqueueOutcome::Accepted);
    let client = database.connect().await;
    let row = client
        .query_one(
            "SELECT retry_policy, max_attempts, execution_timeout_ms FROM workhorse.task \
             WHERE id = $1",
            &[&result.task_id],
        )
        .await
        .unwrap();
    let retry_policy: Value = row.get(0);
    assert_eq!(
        retry_policy,
        json!({
            "type": "exponential",
            "initialDelayMs": 1_000,
            "multiplier": 2,
            "maxDelayMs": 60_000,
        })
    );
    assert_eq!(row.get::<_, i32>(1), 5);
    assert_eq!(row.get::<_, Option<i64>>(2), Some(30_000));
}
