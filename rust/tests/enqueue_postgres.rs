//! Enqueue behavior against a real PostgreSQL schema, one scratch database per test.
mod support;

use chrono::{DateTime, Duration, DurationRound, Utc};
use serde_json::{json, Value};
use support::scratch_database;
use tokio_postgres::{Client, NoTls};
use uuid::Uuid;
use workhorse::compatibility::CompatibilityCode;
use workhorse::{
    Debounce, DebounceSchedule, Dependencies, DependencyTerminalPolicy, EnqueueOptions,
    EnqueueOutcome, EnqueueRequest, Error, Idempotency, Queue, Throttle,
};

struct StoredTask {
    queue: String,
    task_type: String,
    payload: Value,
    priority: i32,
    max_attempts: i32,
    tags: Vec<String>,
    retry_policy: Option<Value>,
    deadline_at: Option<DateTime<Utc>>,
    execution_timeout_ms: Option<i64>,
    concurrency_key: Option<String>,
    budget: Option<String>,
    trace_context: Option<Value>,
    run_at: DateTime<Utc>,
    state: String,
}

async fn stored_task(client: &Client, id: Uuid) -> StoredTask {
    let row = client
        .query_one(
            "SELECT task.queue_name, task.task_type, task.payload, task.priority, task.max_attempts,
                    task.tags, task.retry_policy, task.deadline_at, task.execution_timeout_ms,
                    task.concurrency_key, task.budget_name, task.trace_context,
                    runtime.run_at, runtime.state
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
        retry_policy: row.get(6),
        deadline_at: row.get(7),
        execution_timeout_ms: row.get(8),
        concurrency_key: row.get(9),
        budget: row.get(10),
        trace_context: row.get(11),
        run_at: row.get(12),
        state: row.get(13),
    }
}

async fn task_count(client: &Client) -> i64 {
    client.query_one("SELECT count(*) FROM workhorse.task", &[]).await.unwrap().get(0)
}

fn now_ms() -> DateTime<Utc> {
    Utc::now().duration_trunc(Duration::milliseconds(1)).unwrap()
}

#[tokio::test]
async fn enqueue_persists_run_at_priority_tags_and_max_attempts() {
    let Some(database) = scratch_database("enqueue_scheduling_fields").await else { return };
    let queue = Queue::connect(database.url(), "rust-enqueue").await.unwrap();
    let observer = database.connect().await;

    let run_at = now_ms() + Duration::minutes(10);
    let options = EnqueueOptions {
        queue: Some("rust-other".into()),
        run_at: Some(run_at),
        priority: 7,
        tags: vec!["billing".into(), "rust".into()],
        max_attempts: 3,
        ..EnqueueOptions::default()
    };
    let result = queue.enqueue("email.send", &json!({"to": "a@b.c"}), options).await.unwrap();
    assert_eq!(result.outcome, EnqueueOutcome::Accepted);
    let task = stored_task(&observer, result.task_id).await;
    assert_eq!(task.queue, "rust-other");
    assert_eq!(task.task_type, "email.send");
    assert_eq!(task.payload, json!({"to": "a@b.c"}));
    assert_eq!(task.priority, 7);
    assert_eq!(task.max_attempts, 3);
    assert_eq!(task.tags, ["billing", "rust"]);
    assert_eq!(task.run_at, run_at);
    assert_eq!(task.state, "scheduled", "a delayed task is scheduled");

    // Defaults: the Queue's own queue, ready now, and 25 attempts.
    let before = Utc::now() - Duration::seconds(5);
    let result = queue.enqueue("email.send", &json!({}), EnqueueOptions::default()).await.unwrap();
    let task = stored_task(&observer, result.task_id).await;
    assert_eq!(task.queue, "rust-enqueue");
    assert_eq!(task.state, "ready");
    assert!(task.run_at >= before && task.run_at <= Utc::now() + Duration::seconds(5));
    assert_eq!(task.max_attempts, 25);
    assert_eq!(task.priority, 0);
    assert_eq!(task.trace_context, None, "no current span stores no trace context");
}

#[tokio::test]
async fn enqueue_persists_retry_policy_deadline_and_execution_timeout() {
    let Some(database) = scratch_database("enqueue_retry_and_time_limits").await else {
        return;
    };
    let queue = Queue::connect(database.url(), "rust-enqueue").await.unwrap();
    let observer = database.connect().await;

    let deadline = now_ms() + Duration::hours(2);
    let retry_policy =
        json!({"type": "exponential", "initialDelayMs": 100, "multiplier": 2, "maxDelayMs": 5000});
    let options = EnqueueOptions {
        retry_policy: retry_policy.as_object().cloned(),
        deadline: Some(deadline),
        execution_timeout_ms: Some(30_000),
        ..EnqueueOptions::default()
    };
    let result = queue.enqueue("report.build", &json!({}), options).await.unwrap();
    let task = stored_task(&observer, result.task_id).await;
    assert_eq!(task.retry_policy, Some(retry_policy));
    assert_eq!(task.deadline_at, Some(deadline));
    assert_eq!(task.execution_timeout_ms, Some(30_000));

    let invalid = EnqueueOptions {
        retry_policy: json!({"type": "fixed"}).as_object().cloned(),
        ..EnqueueOptions::default()
    };
    let refusal = queue.enqueue("report.build", &json!({}), invalid).await;
    assert!(matches!(refusal, Err(Error::Postgres(_))), "got {refusal:?}");
    assert_eq!(task_count(&observer).await, 1, "PostgreSQL rejects an invalid retry policy");
}

#[tokio::test]
async fn enqueue_persists_concurrency_key_and_budget() {
    let Some(database) = scratch_database("enqueue_concurrency_key").await else { return };
    let queue = Queue::connect(database.url(), "rust-enqueue").await.unwrap();
    let observer = database.connect().await;

    let options = EnqueueOptions {
        concurrency_key: Some("tenant-1".into()),
        budget: Some("openai".into()),
        ..EnqueueOptions::default()
    };
    let result = queue.enqueue("llm.call", &json!({}), options).await.unwrap();
    let task = stored_task(&observer, result.task_id).await;
    assert_eq!(task.concurrency_key.as_deref(), Some("tenant-1"));
    assert_eq!(task.budget.as_deref(), Some("openai"));

    // An empty key or budget means none.
    let options = EnqueueOptions {
        concurrency_key: Some(String::new()),
        budget: Some(String::new()),
        ..EnqueueOptions::default()
    };
    let result = queue.enqueue("llm.call", &json!({}), options).await.unwrap();
    let task = stored_task(&observer, result.task_id).await;
    assert_eq!(task.concurrency_key, None);
    assert_eq!(task.budget, None);
}

#[tokio::test]
async fn enqueue_many_writes_an_atomic_batch_in_request_order() {
    let Some(database) = scratch_database("enqueue_atomic_batch").await else { return };
    let queue = Queue::connect(database.url(), "rust-enqueue").await.unwrap();
    let observer = database.connect().await;

    assert!(queue.enqueue_many(Vec::new()).await.unwrap().is_empty());

    let requests = vec![
        EnqueueRequest::new("first", json!({"n": 1})),
        EnqueueRequest::new("second", json!({"n": 2})),
    ];
    let results = queue.enqueue_many(requests).await.unwrap();
    assert_eq!(results.len(), 2);
    assert_eq!(stored_task(&observer, results[0].task_id).await.task_type, "first");
    assert_eq!(stored_task(&observer, results[1].task_id).await.task_type, "second");

    // PostgreSQL rejects the second request, so the first is not written either.
    let bad_policy = EnqueueOptions {
        retry_policy: json!({"type": "fixed"}).as_object().cloned(),
        ..EnqueueOptions::default()
    };
    let requests = vec![
        EnqueueRequest::new("third", json!({})),
        EnqueueRequest::new("fourth", json!({})).with_options(bad_policy),
    ];
    assert!(queue.enqueue_many(requests).await.is_err());
    assert_eq!(task_count(&observer).await, 2, "a rejected batch writes nothing");

    let oversized =
        vec![EnqueueRequest::new("t", json!({})); workhorse::MAX_ENQUEUE_BATCH_SIZE + 1];
    let refusal = queue.enqueue_many(oversized).await;
    assert!(matches!(refusal, Err(Error::InvalidArgument(_))), "got {refusal:?}");
}

#[tokio::test]
async fn enqueue_validation_rejects_invalid_options_before_postgres() {
    let Some(database) = scratch_database("enqueue_validation").await else { return };
    let queue = Queue::connect(database.url(), "rust-enqueue").await.unwrap();
    let observer = database.connect().await;

    let invalid = [
        EnqueueOptions {
            idempotency: Some(Idempotency::new("a")),
            throttle: Some(Throttle::new("a", 1000)),
            ..EnqueueOptions::default()
        },
        EnqueueOptions { priority: 101, ..EnqueueOptions::default() },
        EnqueueOptions { max_attempts: -1, ..EnqueueOptions::default() },
        EnqueueOptions {
            run_at: Some(Utc::now()),
            debounce: Some(Debounce::new("a", 1000, DebounceSchedule::Reset)),
            ..EnqueueOptions::default()
        },
        EnqueueOptions {
            dependencies: Some(Dependencies {
                prerequisite_task_ids: Vec::new(),
                on_success: DependencyTerminalPolicy::Release,
                on_failure: DependencyTerminalPolicy::Cancel,
                on_cancellation: DependencyTerminalPolicy::Cancel,
            }),
            ..EnqueueOptions::default()
        },
    ];
    for options in invalid {
        let refusal = queue.enqueue("t", &json!({}), options.clone()).await;
        let Err(Error::InvalidArgument(message)) = refusal else {
            panic!("{options:?} was not rejected: {refusal:?}");
        };
        assert!(message.starts_with("enqueue request 1: invalid enqueue options:"), "{message}");
    }
    assert_eq!(task_count(&observer).await, 0);
}

#[tokio::test]
async fn enqueue_idempotency_replays_and_rejects_a_conflicting_request() {
    let Some(database) = scratch_database("enqueue_idempotency").await else { return };
    let queue = Queue::connect(database.url(), "rust-enqueue").await.unwrap();
    let observer = database.connect().await;
    let options = EnqueueOptions {
        idempotency: Some(Idempotency::new("order-42")),
        ..EnqueueOptions::default()
    };

    let first = queue.enqueue("order.ship", &json!({"id": 42}), options.clone()).await.unwrap();
    let replay = queue.enqueue("order.ship", &json!({"id": 42}), options.clone()).await.unwrap();
    assert_eq!(first.outcome, EnqueueOutcome::Accepted);
    assert_eq!(replay.outcome, EnqueueOutcome::Replayed);
    assert_eq!(replay.task_id, first.task_id);

    let results = queue
        .enqueue_many(vec![
            EnqueueRequest::new("order.ship", json!({"id": 43})).with_options(EnqueueOptions {
                idempotency: Some(Idempotency::new("order-43")),
                ..EnqueueOptions::default()
            }),
            EnqueueRequest::new("order.ship", json!({"id": 43})).with_options(EnqueueOptions {
                idempotency: Some(Idempotency::new("order-43")),
                ..EnqueueOptions::default()
            }),
        ])
        .await
        .unwrap();
    assert_eq!(results[1].outcome, EnqueueOutcome::Replayed);
    assert_eq!(results[0].task_id, results[1].task_id);
    assert_eq!(task_count(&observer).await, 2);

    let conflict = queue.enqueue("order.ship", &json!({"id": 99}), options).await;
    let Err(Error::EnqueueIdempotencyConflict { details }) = conflict else {
        panic!("expected an idempotency conflict, got {conflict:?}");
    };
    assert_eq!(details.scope, "default");
    assert_eq!(details.existing_task_id, first.task_id.to_string());
    assert!(details.conflicting_fields.contains(&"payload".to_string()), "{details:?}");
}

#[tokio::test]
async fn debounce_replaces_a_pending_task_inside_its_window() {
    let Some(database) = scratch_database("enqueue_debounce").await else { return };
    let queue = Queue::connect(database.url(), "rust-enqueue").await.unwrap();
    let observer = database.connect().await;
    let options = EnqueueOptions {
        debounce: Some(Debounce::new("search-index", 60_000, DebounceSchedule::Reset)),
        ..EnqueueOptions::default()
    };

    let first = queue.enqueue("index.rebuild", &json!({"v": 1}), options.clone()).await.unwrap();
    let task = stored_task(&observer, first.task_id).await;
    assert_eq!(task.state, "scheduled", "the debounce window delays the task");
    assert!(task.run_at > Utc::now() + Duration::seconds(50));

    let second = queue.enqueue("index.rebuild", &json!({"v": 2}), options).await.unwrap();
    assert_eq!(second.outcome, EnqueueOutcome::Replaced);
    assert_eq!(second.task_id, first.task_id);
    assert_eq!(stored_task(&observer, first.task_id).await.payload, json!({"v": 2}));
    assert_eq!(task_count(&observer).await, 1);
}

#[tokio::test]
async fn throttle_coalesces_requests_inside_its_window() {
    let Some(database) = scratch_database("enqueue_throttle").await else { return };
    let queue = Queue::connect(database.url(), "rust-enqueue").await.unwrap();
    let observer = database.connect().await;
    let options = EnqueueOptions {
        throttle: Some(Throttle::new("digest", 60_000)),
        ..EnqueueOptions::default()
    };

    let first = queue.enqueue("digest.send", &json!({}), options.clone()).await.unwrap();
    assert_eq!(first.outcome, EnqueueOutcome::Accepted);
    assert_eq!(stored_task(&observer, first.task_id).await.state, "ready");

    let second = queue.enqueue("digest.send", &json!({}), options).await.unwrap();
    assert_eq!(second.outcome, EnqueueOutcome::Coalesced);
    assert_eq!(second.task_id, first.task_id);
    assert_eq!(task_count(&observer).await, 1);
}

#[tokio::test]
async fn dependencies_block_a_task_with_its_terminal_policies() {
    let Some(database) = scratch_database("enqueue_dependencies").await else { return };
    let queue = Queue::connect(database.url(), "rust-enqueue").await.unwrap();
    let observer = database.connect().await;

    let first = queue.enqueue("extract", &json!({}), EnqueueOptions::default()).await.unwrap();
    let second = queue.enqueue("extract", &json!({}), EnqueueOptions::default()).await.unwrap();
    let dependencies = Dependencies {
        prerequisite_task_ids: vec![second.task_id, first.task_id],
        on_success: DependencyTerminalPolicy::Release,
        on_failure: DependencyTerminalPolicy::Fail,
        on_cancellation: DependencyTerminalPolicy::Cancel,
    };
    let options = EnqueueOptions { dependencies: Some(dependencies), ..EnqueueOptions::default() };
    let dependent = queue.enqueue("load", &json!({}), options).await.unwrap();
    assert_eq!(stored_task(&observer, dependent.task_id).await.state, "blocked");

    let rows = observer
        .query(
            "SELECT prerequisite_task_id, on_success, on_failure, on_cancellation
               FROM workhorse.task_dependency WHERE dependent_task_id = $1
              ORDER BY prerequisite_task_id",
            &[&dependent.task_id],
        )
        .await
        .unwrap();
    let mut expected = vec![first.task_id, second.task_id];
    expected.sort();
    let stored: Vec<Uuid> = rows.iter().map(|row| row.get(0)).collect();
    assert_eq!(stored, expected);
    for row in &rows {
        let policies: (String, String, String) = (row.get(1), row.get(2), row.get(3));
        assert_eq!(policies, ("release".into(), "fail".into(), "cancel".into()));
    }

    let missing = Dependencies {
        prerequisite_task_ids: vec![Uuid::new_v4()],
        on_success: DependencyTerminalPolicy::Release,
        on_failure: DependencyTerminalPolicy::Cancel,
        on_cancellation: DependencyTerminalPolicy::Cancel,
    };
    let options = EnqueueOptions { dependencies: Some(missing), ..EnqueueOptions::default() };
    assert!(queue.enqueue("load", &json!({}), options).await.is_err());
    assert_eq!(task_count(&observer).await, 3, "an unknown prerequisite writes nothing");
}

#[tokio::test]
async fn transactional_enqueue_commits_and_rolls_back_with_the_caller() {
    let Some(database) = scratch_database("enqueue_transactional_owner").await else {
        return;
    };
    let observer = database.connect().await;
    let mut caller = database.connect().await;

    let transaction = caller.transaction().await.unwrap();
    let queue = Queue::new(&transaction, "rust-enqueue");
    queue.enqueue("email.send", &json!({}), EnqueueOptions::default()).await.unwrap();
    drop(queue);
    transaction.rollback().await.unwrap();
    assert_eq!(task_count(&observer).await, 0, "a caller rollback leaves no task");

    let transaction = caller.transaction().await.unwrap();
    let queue = Queue::new(transaction, "rust-enqueue");
    let result = queue.enqueue("email.send", &json!({}), EnqueueOptions::default()).await.unwrap();
    assert_eq!(task_count(&observer).await, 0, "the task is invisible before the caller commits");
    queue.into_inner().commit().await.unwrap();
    assert_eq!(task_count(&observer).await, 1);
    assert_eq!(stored_task(&observer, result.task_id).await.state, "ready");
}

#[tokio::test]
async fn pool_executor_enqueues_through_a_deadpool_pool() {
    let Some(database) = scratch_database("enqueue_pool_executor").await else { return };
    let observer = database.connect().await;
    let manager = deadpool_postgres::Manager::new(database.url().parse().unwrap(), NoTls);
    let pool = deadpool_postgres::Pool::builder(manager).max_size(2).build().unwrap();

    let queue = Queue::new(pool.clone(), "rust-pool");
    let results = queue
        .enqueue_many(vec![
            EnqueueRequest::new("a", json!({})),
            EnqueueRequest::new("b", json!({})),
        ])
        .await
        .unwrap();
    assert_eq!(results.len(), 2);

    let mut object = pool.get().await.unwrap();
    let transaction = object.transaction().await.unwrap();
    Queue::new(&transaction, "rust-pool")
        .enqueue("c", &json!({}), EnqueueOptions::default())
        .await
        .unwrap();
    transaction.commit().await.unwrap();
    assert_eq!(task_count(&observer).await, 3);
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

    let refusal = queue.enqueue("email.send", &json!({}), EnqueueOptions::default()).await;
    let expected = CompatibilityCode::SchemaTooOld;
    assert!(
        matches!(refusal, Err(Error::Compatibility { code }) if code == expected),
        "got {refusal:?}"
    );
    assert_eq!(task_count(&observer).await, 0, "the refusal wrote no row");

    // The refusal is cached per Queue, so every mutation refuses without asking again.
    observer.batch_execute("UPDATE workhorse.schema_version SET version = 25").await.unwrap();
    let cached = queue.enqueue("email.send", &json!({}), EnqueueOptions::default()).await;
    assert!(matches!(cached, Err(Error::Compatibility { code }) if code == expected));
    assert!(matches!(
        queue.cancel(Uuid::nil(), None, None).await,
        Err(Error::Compatibility { code }) if code == expected
    ));
    assert_eq!(task_count(&observer).await, 0);

    // A new Queue asks again.
    let fresh = Queue::connect(database.url(), "rust-enqueue").await.unwrap();
    fresh.assert_compatible().await.expect("the repaired schema is compatible");
}

#[cfg(feature = "opentelemetry")]
#[tokio::test]
async fn enqueue_propagates_the_current_trace_context() {
    use opentelemetry::context::FutureExt;
    use opentelemetry::trace::{
        SpanContext, SpanId, TraceContextExt, TraceFlags, TraceId, TraceState,
    };

    let Some(database) = scratch_database("enqueue_trace_context").await else { return };
    let queue = Queue::connect(database.url(), "rust-enqueue").await.unwrap();
    let observer = database.connect().await;

    let untraced = queue.enqueue("traced", &json!({}), EnqueueOptions::default()).await.unwrap();
    assert_eq!(stored_task(&observer, untraced.task_id).await.trace_context, None);

    let span = SpanContext::new(
        TraceId::from_hex("4bf92f3577b34da6a3ce929d0e0e4736").unwrap(),
        SpanId::from_hex("00f067aa0ba902b7").unwrap(),
        TraceFlags::SAMPLED,
        true,
        TraceState::from_key_value([("vendor", "value")]).unwrap(),
    );
    let context = opentelemetry::Context::new().with_remote_span_context(span);
    let traced = queue
        .enqueue("traced", &json!({}), EnqueueOptions::default())
        .with_context(context)
        .await
        .unwrap();
    assert_eq!(
        stored_task(&observer, traced.task_id).await.trace_context,
        Some(json!({
            "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
            "tracestate": "vendor=value",
        }))
    );
}
