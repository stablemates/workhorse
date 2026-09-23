//! Enqueue behavior against a real PostgreSQL schema, one scratch database per test.
mod support;

use chrono::{DateTime, Duration, DurationRound, Utc};
use serde_json::json;
use support::scratch_database;
use tokio_postgres::Client;
use uuid::Uuid;
use workhorse::{EnqueueRequest, Error, Queue};

struct StoredTask {
    queue: String,
    task_type: String,
    payload: serde_json::Value,
    priority: i32,
    max_attempts: i32,
    tags: Vec<String>,
    contract_version: Option<String>,
    deadline_at: Option<DateTime<Utc>>,
    run_at: DateTime<Utc>,
    state: String,
}

async fn stored_task(client: &Client, id: Uuid) -> StoredTask {
    let row = client
        .query_one(
            "SELECT task.queue_name, task.task_type, task.payload, task.priority, task.max_attempts,
                    task.tags, task.contract_version, task.deadline_at, runtime.run_at, runtime.state
               FROM workhorse.task task
               JOIN workhorse.task_runtime runtime ON runtime.task_id = task.id
              WHERE task.id = $1",
            &[&id],
        )
        .await
        .expect("stored task");
    StoredTask {
        queue: row.get(0),
        task_type: row.get(1),
        payload: row.get(2),
        priority: row.get(3),
        max_attempts: row.get(4),
        tags: row.get(5),
        contract_version: row.get(6),
        deadline_at: row.get(7),
        run_at: row.get(8),
        state: row.get(9),
    }
}

async fn task_count(client: &Client) -> i64 {
    client.query_one("SELECT count(*) FROM workhorse.task", &[]).await.unwrap().get(0)
}

/// A request that sets every field `EnqueueRequest` carries, with values that differ from the
/// PostgreSQL defaults so a dropped field cannot pass.
fn full_request(key: &str) -> (EnqueueRequest, DateTime<Utc>, DateTime<Utc>) {
    let now = Utc::now().duration_trunc(Duration::milliseconds(1)).unwrap();
    let run_at = now + Duration::minutes(10);
    let deadline = now + Duration::hours(2);
    let mut request = EnqueueRequest::new("rust-enqueue", "email.send", json!({"to": "a@b.c"}));
    request.run_at = Some(run_at);
    request.priority = 7;
    request.tags = vec!["billing".into(), "rust".into()];
    request.idempotency_key = Some(key.into());
    request.contract_version = Some("v3".into());
    request.max_attempts = Some(3);
    request.deadline = Some(deadline);
    (request, run_at, deadline)
}

fn assert_full_fields(task: &StoredTask, run_at: DateTime<Utc>, deadline: DateTime<Utc>) {
    assert_eq!(task.queue, "rust-enqueue");
    assert_eq!(task.task_type, "email.send");
    assert_eq!(task.payload, json!({"to": "a@b.c"}));
    assert_eq!(task.priority, 7, "priority");
    assert_eq!(task.max_attempts, 3, "max_attempts");
    assert_eq!(task.tags, vec!["billing".to_string(), "rust".to_string()], "tags");
    assert_eq!(task.contract_version.as_deref(), Some("v3"), "contract version");
    assert_eq!(task.deadline_at, Some(deadline), "deadline");
    assert_eq!(task.run_at, run_at, "delay");
    assert_eq!(task.state, "scheduled", "a delayed task is scheduled");
}

#[tokio::test]
async fn enqueue_round_trips_every_field_and_dedupes_by_idempotency_key() {
    let Some(database) = scratch_database("enqueue_round_trip").await else { return };
    let queue = Queue::connect(database.url(), "rust-enqueue").await.unwrap();
    let observer = database.connect().await;

    let (request, run_at, deadline) = full_request("single-key");
    let first = queue.enqueue(request.clone()).await.expect("enqueue");
    assert_full_fields(&stored_task(&observer, first).await, run_at, deadline);

    let replay = queue.enqueue(request).await.expect("replayed enqueue");
    assert_eq!(replay, first, "the idempotency key returns the first task");
    assert_eq!(task_count(&observer).await, 1);

    // An unset run_at means now, and an empty queue means the Queue's own.
    let before = Utc::now() - Duration::seconds(5);
    let immediate = queue
        .enqueue(EnqueueRequest::new("", "email.send", json!({})))
        .await
        .expect("immediate enqueue");
    let task = stored_task(&observer, immediate).await;
    assert_eq!(task.queue, "rust-enqueue");
    assert_eq!(task.state, "ready");
    assert!(task.run_at >= before && task.run_at <= Utc::now() + Duration::seconds(5));
    assert_eq!(task.max_attempts, 25, "PostgreSQL owns the default attempt limit");
}

#[tokio::test]
async fn enqueue_batch_round_trips_every_field_and_replays_a_repeated_key() {
    let Some(database) = scratch_database("enqueue_batch_round_trip").await else {
        return;
    };
    let queue = Queue::connect(database.url(), "rust-enqueue").await.unwrap();
    let observer = database.connect().await;

    let (request, run_at, deadline) = full_request("batch-key");
    let results = queue.enqueue_batch(&[request.clone(), request]).await.expect("enqueue batch");
    let outcomes: Vec<&str> = results.iter().map(|result| result.outcome.as_str()).collect();
    assert_eq!(outcomes, ["accepted", "replayed"]);
    assert_eq!(results[0].task_id, results[1].task_id);
    assert_eq!(task_count(&observer).await, 1, "the repeated key writes one task");
    assert_full_fields(&stored_task(&observer, results[0].task_id).await, run_at, deadline);
}

#[tokio::test]
async fn transactional_enqueue_commits_and_rolls_back_with_the_caller() {
    let Some(database) = scratch_database("enqueue_transactional_owner").await else {
        return;
    };
    let queue = Queue::connect(database.url(), "rust-enqueue").await.unwrap();
    let observer = database.connect().await;
    let mut caller = database.connect().await;
    let request = EnqueueRequest::new("rust-enqueue", "email.send", json!({}));

    let transaction = caller.transaction().await.unwrap();
    queue.enqueue_transactional(&transaction, std::slice::from_ref(&request)).await.unwrap();
    transaction.rollback().await.unwrap();
    assert_eq!(task_count(&observer).await, 0, "a caller rollback leaves no task");

    let transaction = caller.transaction().await.unwrap();
    let results =
        queue.enqueue_transactional(&transaction, std::slice::from_ref(&request)).await.unwrap();
    assert_eq!(task_count(&observer).await, 0, "the task is invisible before the caller commits");
    transaction.commit().await.unwrap();
    assert_eq!(task_count(&observer).await, 1);
    assert_eq!(stored_task(&observer, results[0].task_id).await.state, "ready");
}

#[tokio::test]
async fn failed_transactional_enqueue_does_not_poison_the_queue_connection() {
    let Some(database) = scratch_database("enqueue_transactional_failure").await else {
        return;
    };
    let queue = Queue::connect(database.url(), "rust-enqueue").await.unwrap();
    let observer = database.connect().await;
    let mut caller = database.connect().await;

    // PostgreSQL rejects an empty task type inside enqueue_many_v1.
    let invalid = EnqueueRequest::new("rust-enqueue", "", json!({}));
    let transaction = caller.transaction().await.unwrap();
    assert!(queue.enqueue_transactional(&transaction, &[invalid]).await.is_err());
    transaction.rollback().await.unwrap();

    let valid = EnqueueRequest::new("rust-enqueue", "email.send", json!({}));
    queue.enqueue_batch(&[valid]).await.expect("the Queue connection is still usable");
    assert_eq!(task_count(&observer).await, 1);
}

#[tokio::test]
async fn incompatible_schema_refuses_before_the_first_write() {
    let Some(database) = scratch_database("enqueue_incompatible_schema").await else {
        return;
    };
    let observer = database.connect().await;
    observer
        .batch_execute(
            "DELETE FROM workhorse.schema_version;
             INSERT INTO workhorse.schema_version(version) VALUES (17);",
        )
        .await
        .unwrap();
    let queue = Queue::connect(database.url(), "rust-enqueue").await.unwrap();

    let request = EnqueueRequest::new("rust-enqueue", "email.send", json!({}));
    let refusal = queue.enqueue_batch(std::slice::from_ref(&request)).await;
    assert!(matches!(refusal, Err(Error::IncompatibleSchema(17))), "got {refusal:?}");
    assert_eq!(task_count(&observer).await, 0, "the refusal wrote no row");

    // The answer is cached per Queue, so every mutation refuses without asking again.
    observer.batch_execute("UPDATE workhorse.schema_version SET version = 23").await.unwrap();
    let cached = queue.enqueue(request).await;
    assert!(matches!(cached, Err(Error::IncompatibleSchema(17))), "got {cached:?}");
    assert!(matches!(
        queue.cancel(Uuid::nil(), "test", None).await,
        Err(Error::IncompatibleSchema(17))
    ));
    assert_eq!(task_count(&observer).await, 0);
}
