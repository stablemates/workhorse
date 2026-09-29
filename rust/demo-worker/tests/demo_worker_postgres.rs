//! The Rust demo worker against a real PostgreSQL schema, one scratch database per test.
#[path = "../../tests/support/mod.rs"]
mod support;

use std::time::Duration;

use serde_json::{json, Value};
use support::{scratch_database, ScratchDatabase};
use tokio::sync::oneshot;
use tokio_postgres::Client;
use uuid::Uuid;
use workhorse::{Admin, AdminAudit, EnqueueOptions, Queue, QueueTier, TaskState};
use workhorse_demo_worker::{
    build_worker, connection_pool, wait_for_schema, waits_for_schema, LANGUAGE_TASK_TYPE,
    RUST_FAST_QUEUE, RUST_QUEUE, SHARED_QUEUE, SHARED_TASK_TYPE,
};

const WAIT: Duration = Duration::from_secs(15);

fn on(queue: &str) -> EnqueueOptions {
    EnqueueOptions { queue: Some(queue.into()), ..Default::default() }
}

async fn enqueue(queue: &Queue<Client>, task_type: &str, payload: Value, on_queue: &str) -> Uuid {
    queue.enqueue(task_type, &payload, on(on_queue)).await.unwrap().task_id
}

async fn full_result(admin: &Admin<Client>, task: Uuid) -> Value {
    tokio::time::timeout(WAIT, async {
        loop {
            let found = admin.get_task(task).await.unwrap().expect("task exists");
            if found.state == TaskState::Succeeded {
                return found.result.expect("a succeeded task has a result");
            }
            assert_ne!(found.state, TaskState::Failed, "task {task} failed");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("task {task} never succeeded"))
}

async fn fast_outcome(database: &ScratchDatabase, task: Uuid) -> (String, Value) {
    let client = database.connect().await;
    tokio::time::timeout(WAIT, async {
        loop {
            let row = client
                .query_opt(
                    "SELECT state, result FROM workhorse.fast_task_outcome WHERE task_id = $1",
                    &[&task],
                )
                .await
                .unwrap();
            if let Some(row) = row {
                return (row.get(0), row.get(1));
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("fast task {task} never settled"))
}

#[tokio::test]
async fn the_rust_demo_worker_completes_tasks_on_its_full_and_fast_queues() {
    let Some(database) = scratch_database("rust_demo_worker").await else { return };
    let admin = Admin::connect(database.url()).await.unwrap();
    let audit = AdminAudit {
        actor: "workhorse-demo-seed".into(),
        reason: "test".into(),
        request_id: "rust-demo-worker".into(),
    };
    admin.set_queue_tier(RUST_FAST_QUEUE, QueueTier::Fast, &audit).await.unwrap();

    let queue = Queue::connect(database.url(), RUST_QUEUE).await.unwrap();
    let language =
        enqueue(&queue, LANGUAGE_TASK_TYPE, json!({"language": "rust"}), RUST_QUEUE).await;
    let shared = enqueue(&queue, SHARED_TASK_TYPE, json!({"source": "test"}), SHARED_QUEUE).await;
    let fast =
        enqueue(&queue, LANGUAGE_TASK_TYPE, json!({"language": "rust"}), RUST_FAST_QUEUE).await;
    let foreign = queue
        .enqueue(
            LANGUAGE_TASK_TYPE,
            &json!({"language": "go"}),
            EnqueueOptions {
                queue: Some(RUST_QUEUE.into()),
                max_attempts: 1,
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .task_id;

    let worker = build_worker(
        connection_pool(database.url()).unwrap(),
        format!("demo-rust-test-{}", Uuid::new_v4()),
        Some(Duration::from_millis(20)),
        None,
    )
    .unwrap();
    let (stop, stopped) = oneshot::channel::<()>();
    let running = tokio::spawn(async move {
        worker
            .run(async move {
                let _ = stopped.await;
            })
            .await
    });

    assert_eq!(
        full_result(&admin, language).await,
        json!({"language": "rust", "runtime": "rust", "attempt": 1})
    );
    assert_eq!(
        full_result(&admin, shared).await,
        json!({"source": "test", "runtime": "rust", "attempt": 1})
    );
    assert_eq!(
        fast_outcome(&database, fast).await,
        ("succeeded".into(), json!({"language": "rust", "runtime": "rust", "attempt": 1}))
    );
    tokio::time::timeout(WAIT, async {
        while admin.get_task(foreign).await.unwrap().unwrap().state != TaskState::Failed {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("a task for another language fails");

    stop.send(()).unwrap();
    tokio::time::timeout(WAIT, running).await.unwrap().unwrap().unwrap();
}

#[tokio::test]
async fn the_rust_demo_worker_waits_for_a_missing_schema_until_shutdown() {
    let Some(database) = scratch_database("rust_demo_worker_schema").await else { return };
    let pool = connection_pool(database.url()).unwrap();
    assert!(wait_for_schema(&pool, std::future::pending()).await.unwrap());

    database.connect().await.batch_execute("DROP SCHEMA workhorse CASCADE").await.unwrap();
    let (stop, stopped) = oneshot::channel::<()>();
    let waiting = tokio::spawn({
        let pool = pool.clone();
        async move {
            wait_for_schema(&pool, async move {
                let _ = stopped.await;
            })
            .await
        }
    });
    tokio::time::sleep(Duration::from_millis(1_200)).await;
    assert!(!waiting.is_finished(), "the worker stopped waiting for a missing schema");
    stop.send(()).unwrap();
    assert!(!tokio::time::timeout(WAIT, waiting).await.unwrap().unwrap().unwrap());
}

#[test]
fn only_the_development_demo_waits_for_the_schema() {
    assert!(waits_for_schema(Some("development")).unwrap());
    assert!(!waits_for_schema(Some("production")).unwrap());
    assert!(!waits_for_schema(None).unwrap());
    assert!(waits_for_schema(Some("staging")).is_err());
}
