//! The clean consumer that `scripts/check-rust-release.ts` builds from the packaged crate.
//!
//! It depends on the crate by registry version, and the script patches that version to the
//! unpacked `.crate` archive. It therefore compiles against exactly the files crates.io would
//! serve. It uses the public API the way an application does, so a commit that changes that API
//! updates this file too.
//!
//! Without an argument it only proves the crate links. With a PostgreSQL URL it enqueues one task,
//! runs it through a worker, and prints the task id for the script to verify.

use serde_json::json;
use serde_json::Value;
use tokio_postgres::NoTls;
use workhorse::{deadpool_postgres, EnqueueOptions, Queue, Worker, WorkerOptions};

const QUEUE: &str = "release-consumer";
const TASK_TYPE: &str = "release.consumer";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let Some(url) = std::env::args().nth(1) else {
        println!("linked workhorse protocol {}", workhorse::CLIENT_PROTOCOL_VERSION);
        return Ok(());
    };

    let (client, connection) = tokio_postgres::connect(&url, NoTls).await?;
    let connection = tokio::spawn(connection);

    let queue = Queue::new(client, QUEUE);
    let result =
        queue.enqueue(TASK_TYPE, &json!({ "packaged": true }), EnqueueOptions::default()).await?;

    let manager = deadpool_postgres::Manager::new(url.parse()?, NoTls);
    let pool = deadpool_postgres::Pool::builder(manager).max_size(4).build()?;
    let worker =
        Worker::new(pool, WorkerOptions { queues: vec![QUEUE.into()], ..Default::default() })?;
    worker.handle(TASK_TYPE, |payload: Value, _| async move { Ok(json!({ "echo": payload })) });
    if !worker.run_once().await? {
        return Err("the worker ran no handler".into());
    }
    println!("{}", result.task_id);

    drop(queue);
    connection.await??;
    Ok(())
}
