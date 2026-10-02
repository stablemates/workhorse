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

    #[cfg(feature = "sqlx")]
    let task_id = if std::env::args().nth(2).as_deref() == Some("sqlx") {
        sqlx_enqueue(&url).await?
    } else {
        tokio_enqueue(&url).await?
    };
    #[cfg(not(feature = "sqlx"))]
    let task_id = tokio_enqueue(&url).await?;

    let manager = deadpool_postgres::Manager::new(url.parse()?, NoTls);
    let pool = deadpool_postgres::Pool::builder(manager).max_size(4).build()?;
    let worker =
        Worker::new(pool, WorkerOptions { queues: vec![QUEUE.into()], ..Default::default() })?;
    worker.handle(TASK_TYPE, |payload: Value, _| async move { Ok(json!({ "echo": payload })) });
    if !worker.run_once().await? {
        return Err("the worker ran no handler".into());
    }
    println!("{task_id}");
    Ok(())
}

async fn tokio_enqueue(url: &str) -> Result<String, Box<dyn std::error::Error>> {
    let (client, connection) = tokio_postgres::connect(url, NoTls).await?;
    let connection = tokio::spawn(connection);
    let queue = Queue::new(client, QUEUE);
    let result =
        queue.enqueue(TASK_TYPE, &json!({ "packaged": true }), EnqueueOptions::default()).await?;
    drop(queue);
    connection.await??;
    Ok(result.task_id.to_string())
}

#[cfg(feature = "sqlx")]
async fn sqlx_enqueue(url: &str) -> Result<String, Box<dyn std::error::Error>> {
    use workhorse::sqlx::{self, Connection, PgConnection};
    use workhorse::EnqueueClient;

    let mut caller = PgConnection::connect(url).await?;
    let mut observer = PgConnection::connect(url).await?;
    sqlx::query("CREATE TABLE public.packaged_business (id integer PRIMARY KEY)")
        .execute(&mut caller)
        .await?;
    let client = EnqueueClient::new(QUEUE);
    let mut transaction = caller.begin().await?;
    sqlx::query("INSERT INTO public.packaged_business VALUES (1)")
        .execute(&mut *transaction)
        .await?;
    client
        .enqueue(
            &mut transaction,
            TASK_TYPE,
            &json!({ "packaged": true }),
            EnqueueOptions::default(),
        )
        .await?;
    transaction.rollback().await?;
    let rolled_back: (i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM public.packaged_business), (SELECT count(*) FROM workhorse.task)",
    )
    .fetch_one(&mut observer)
    .await?;
    assert_eq!(rolled_back, (0, 0));
    let mut transaction = caller.begin().await?;
    sqlx::query("INSERT INTO public.packaged_business VALUES (2)")
        .execute(&mut *transaction)
        .await?;
    let result = client
        .enqueue(
            &mut transaction,
            TASK_TYPE,
            &json!({ "packaged": true }),
            EnqueueOptions::default(),
        )
        .await?;
    let before_commit: (i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM public.packaged_business), (SELECT count(*) FROM workhorse.task)",
    )
    .fetch_one(&mut observer)
    .await?;
    assert_eq!(before_commit, (0, 0));
    transaction.commit().await?;
    let after_commit: (i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM public.packaged_business), (SELECT count(*) FROM workhorse.task)",
    )
    .fetch_one(&mut observer)
    .await?;
    assert_eq!(after_commit, (1, 1));
    Ok(result.task_id.to_string())
}
