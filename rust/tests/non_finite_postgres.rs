//! Checkpoint and progress writes refuse `NaN` and the infinities before any write.
//!
//! `serde_json` encodes a non-finite float as `null`, so a stored value typed as a number would
//! fail to decode on every replay. Each test checks the refusal and that PostgreSQL holds nothing.
mod support;

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use support::{scratch_database, ScratchDatabase};
use tokio_postgres::Client;
use uuid::Uuid;
use workhorse::{
    Admin, BatchItem, BatchOptions, BatchResult, EnqueueOptions, Error, HandlerContext,
    HandlerError, Queue, Worker,
};

const QUEUE: &str = "rust-non-finite";

#[derive(Deserialize, Serialize)]
struct Reading {
    name: String,
    value: f64,
}

struct Harness {
    database: ScratchDatabase,
    queue: Queue<Client>,
    admin: Admin<Client>,
    worker: Worker,
}

async fn harness(name: &str) -> Option<Harness> {
    let database = scratch_database(name).await?;
    let queue = Queue::connect(database.url(), QUEUE).await.unwrap();
    let admin = Admin::connect(database.url()).await.unwrap();
    let worker = support::worker(&database, QUEUE);
    Some(Harness { database, queue, admin, worker })
}

impl Harness {
    async fn enqueue(&self, task_type: &str) -> Uuid {
        let options = EnqueueOptions::default();
        self.queue.enqueue(task_type, &Value::Null, options).await.unwrap().task_id
    }

    async fn result(&self, task: Uuid) -> Option<Value> {
        self.admin.get_task(task).await.unwrap().expect("task exists").result
    }

    /// Asserts that the task has no progress and no checkpoint but `kept`.
    async fn assert_nothing_written(&self, task: Uuid, kept: &str) {
        assert!(self.admin.get_progress(task).await.unwrap().is_none(), "progress was written");
        let names: Vec<String> = self
            .database
            .connect()
            .await
            .query(
                "SELECT checkpoint_name FROM workhorse.task_checkpoint WHERE task_id = $1",
                &[&task],
            )
            .await
            .unwrap()
            .iter()
            .map(|row| row.get(0))
            .collect();
        assert_eq!(names, [kept], "a refused checkpoint was written");
    }
}

/// Whether `error` is the refusal of a non-finite number in a `label` value.
fn refused(message: &str, label: &str) -> bool {
    message == format!("{label} value must contain only finite numbers")
}

fn checkpoint_refused(result: Result<impl Sized, HandlerError>) -> bool {
    result.is_err_and(|error| refused(&error.message, "Checkpoint"))
}

fn progress_refused(result: Result<(), Error>) -> bool {
    matches!(result, Err(Error::InvalidArgument(message)) if refused(&message, "Progress"))
}

/// Tries each write with a non-finite float at the top level, in a struct field and in a `Vec`,
/// then saves `kept` under the name the first refused checkpoint used.
macro_rules! refuse_each {
    ($context:expr) => {{
        let context = $context;
        let field = Reading { name: "load".into(), value: f64::INFINITY };
        let refusals = [
            checkpoint_refused(context.checkpoint("step", || async { Ok(f64::NAN) }).await),
            checkpoint_refused(context.checkpoint("field", || async { Ok(field) }).await),
            checkpoint_refused(
                context.checkpoint("list", || async { Ok(vec![1.0, f64::NEG_INFINITY]) }).await,
            ),
            progress_refused(context.set_progress(&f64::NAN).await),
            progress_refused(
                context.set_progress(&Reading { name: "load".into(), value: f64::INFINITY }).await,
            ),
            progress_refused(context.set_progress(&vec![1.0, f64::NEG_INFINITY]).await),
        ];
        // Checkpoints are immutable, so a stored `null` would come back instead of this value.
        let kept: f64 = context.checkpoint("step", || async { Ok(2.5) }).await?;
        json!({ "refusals": refusals, "kept": kept })
    }};
}

fn expected() -> Value {
    json!({ "refusals": vec![true; 6], "kept": 2.5 })
}

#[tokio::test]
async fn a_handler_cannot_write_a_non_finite_checkpoint_or_progress() {
    let Some(harness) = harness("non_finite_handler").await else { return };
    let task = harness.enqueue("measure").await;
    harness.worker.handle("measure", |_: Value, context: HandlerContext| async move {
        Ok(refuse_each!(&context))
    });
    assert!(harness.worker.run_once().await.unwrap(), "run_once() processed nothing");
    assert_eq!(harness.result(task).await, Some(expected()));
    harness.assert_nothing_written(task, "step").await;
}

#[tokio::test]
async fn a_batch_member_cannot_write_a_non_finite_checkpoint_or_progress() {
    let Some(harness) = harness("non_finite_batch").await else { return };
    let task = harness.enqueue("measure").await;
    let options = BatchOptions { max_size: 1, linger: Duration::from_millis(50) };
    harness.worker.handle_batch("measure", options, |items: Vec<BatchItem<Value>>| async move {
        let mut results = Vec::new();
        for item in items {
            let measured = async { Ok::<_, HandlerError>(refuse_each!(&item.context)) };
            results.push(match measured.await {
                Ok(value) => BatchResult::Succeeded(value),
                Err(error) => BatchResult::Failed(error),
            });
        }
        results
    });
    assert!(harness.worker.run_once().await.unwrap(), "run_once() processed nothing");
    assert_eq!(harness.result(task).await, Some(expected()));
    harness.assert_nothing_written(task, "step").await;
}
