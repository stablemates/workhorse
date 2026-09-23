//! Enqueues one task, runs the worker once, and prints the task's outcome.
// docs:start quickstart-program
use serde_json::{json, Value};
use workhorse::deadpool_postgres::tokio_postgres::NoTls;
use workhorse::deadpool_postgres::{Manager, Pool};
use workhorse::{Admin, EnqueueOptions, Queue, Worker, WorkerOptions};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let url = std::env::var("DATABASE_URL")?;
    let queue = Queue::connect(&url, "default").await?;
    let enqueued = queue
        .enqueue("email.welcome", &json!({ "to": "ada@example.com" }), EnqueueOptions::default())
        .await?;

    let pool = Pool::builder(Manager::new(url.parse()?, NoTls)).max_size(4).build()?;
    let worker = Worker::new(pool, WorkerOptions::default())?;
    worker.handle("email.welcome", |payload: Value, _context| async move {
        Ok(json!({ "deliveredTo": payload["to"] }))
    });
    worker.run_once().await?; // production uses run_worker_process(&worker)

    let admin = Admin::connect(&url).await?;
    if let Some(task) = admin.get_task(enqueued.task_id).await? {
        println!("{:?} {}", task.state, task.result.unwrap_or_default());
    }
    Ok(())
}
// docs:end
