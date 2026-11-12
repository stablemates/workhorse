//! An operator pause, observed through the claims in flight of the dispatch loop.
//!
//! A claim that started before the pause can still lease a task. The test waits until those claims
//! end, and the count of claims in flight is private to the crate. `worker_postgres.rs` checks the
//! same pause through PostgreSQL alone.

use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::oneshot;
use tokio_postgres::{Client, NoTls};
use uuid::Uuid;

use crate::{Admin, AdminAudit, EnqueueOptions, Error, Queue, TaskState, Worker, WorkerOptions};

use super::support::{scratch_database, ScratchDatabase};

const QUEUE: &str = "rust-worker";
const WAIT: Duration = Duration::from_secs(10);

struct Harness {
    database: ScratchDatabase,
    queue: Queue<Client>,
    admin: Admin<Client>,
}

async fn harness(name: &str) -> Option<Harness> {
    let database = scratch_database(name).await?;
    let queue = Queue::connect(database.url(), QUEUE).await.unwrap();
    let admin = Admin::connect(database.url()).await.unwrap();
    Some(Harness { database, queue, admin })
}

impl Harness {
    fn worker(&self, options: WorkerOptions) -> Worker {
        let manager = deadpool_postgres::Manager::new(self.database.url().parse().unwrap(), NoTls);
        let pool = deadpool_postgres::Pool::builder(manager).max_size(6).build().unwrap();
        Worker::new(pool, options).unwrap()
    }

    async fn enqueue(&self, task_type: &str, payload: Value, options: EnqueueOptions) -> Uuid {
        self.queue.enqueue(task_type, &payload, options).await.unwrap().task_id
    }

    async fn state(&self, task: Uuid) -> TaskState {
        self.admin.get_task(task).await.unwrap().expect("task exists").state
    }

    async fn wait_for(&self, task: Uuid, state: TaskState) {
        tokio::time::timeout(WAIT, async {
            while self.state(task).await != state {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("task {task} never reached {state:?}"));
    }
}

fn options() -> WorkerOptions {
    WorkerOptions {
        queues: vec![QUEUE.into()],
        worker_id: Some(format!("rust-worker-{}", Uuid::new_v4())),
        polling_only: true,
        poll_interval: Some(Duration::from_millis(20)),
        ..WorkerOptions::default()
    }
}

fn audit() -> AdminAudit {
    AdminAudit { actor: "ops".into(), reason: "test".into(), request_id: "req-1".into() }
}

/// Runs `worker` in the background; sending on the returned channel starts its shutdown.
fn run(worker: &Worker) -> (oneshot::Sender<()>, tokio::task::JoinHandle<Result<(), Error>>) {
    let (stop, stopped) = oneshot::channel::<()>();
    let worker = worker.clone();
    let running = tokio::spawn(async move {
        worker
            .run(async move {
                let _ = stopped.await;
            })
            .await
    });
    (stop, running)
}

#[tokio::test]
async fn a_paused_worker_starts_no_claim_after_its_claims_in_flight_end() {
    let Some(harness) = harness("worker_paused").await else { return };
    let options = WorkerOptions { registry_interval: Duration::from_millis(100), ..options() };
    let worker_id = options.worker_id.clone().unwrap();
    let worker = harness.worker(options);
    worker.handle("rust.echo", |payload: Value, _| async move { Ok(payload) });
    let (stop, running) = run(&worker);
    tokio::time::timeout(WAIT, async {
        while harness.admin.list_workers().await.unwrap().is_empty() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the worker registers");
    harness.admin.set_worker_paused(&worker_id, true, &audit()).await.unwrap().unwrap();
    // The registry loop stores the pause after its refresh statement returns, and it starts the
    // next refresh after that store. So a refresh after the first refresh that read the pause
    // proves the store. A run writes no other heartbeat to its registry row.
    let (client, connection) =
        tokio_postgres::connect(harness.database.url(), NoTls).await.unwrap();
    tokio::spawn(connection);
    tokio::time::timeout(WAIT, async {
        let mut pause_read = None;
        loop {
            let row = client
                .query_one(
                    "SELECT last_heartbeat_at::text, last_heartbeat_at > paused_at \
                     FROM workhorse.worker_registry WHERE worker_id = $1",
                    &[&worker_id],
                )
                .await
                .unwrap();
            let (refreshed_at, after_pause): (String, bool) = (row.get(0), row.get(1));
            match &pause_read {
                None if after_pause => pause_read = Some(refreshed_at),
                Some(read) if *read != refreshed_at => break,
                _ => {}
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the worker never stored the pause");
    // A claim that started before the pause can still lease a task. With the pause stored, the
    // loop starts no claim, so zero claims in flight means none can start.
    tokio::time::timeout(WAIT, async {
        while worker.claims_in_flight_for_test() != 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("a claim from before the pause never ended");
    let task = harness.enqueue("rust.echo", json!({}), EnqueueOptions::default()).await;
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(harness.state(task).await, TaskState::Ready, "a paused worker claimed");
    assert_eq!(worker.claims_in_flight_for_test(), 0, "a paused worker started a claim");
    harness.admin.set_worker_paused(&worker_id, false, &audit()).await.unwrap().unwrap();
    harness.wait_for(task, TaskState::Succeeded).await;
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
}
