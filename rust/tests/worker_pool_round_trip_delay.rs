//! SM-1633: eight workers on one pool when each round trip to PostgreSQL takes 80 ms.
//!
//! The test runs 8 workers and a delaying proxy for about 15 s. It has a test binary of its own, so
//! that its load does not change the timing of the tests in `worker_postgres`.
mod support;

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use support::scratch_database;
use tokio::sync::oneshot;
use tokio_postgres::NoTls;
use uuid::Uuid;
use workhorse::{
    Admin, EnqueueOptions, Error, HandlerContext, Queue, TaskState, Worker, WorkerOptions,
    UNWIND_WINDOW,
};

const QUEUE: &str = "rust-worker-pool-delay";

/// A running worker: the sender that starts its shutdown, and its run.
type Running = (oneshot::Sender<()>, tokio::task::JoinHandle<Result<(), Error>>);

/// Runs `worker` in the background; sending on the returned channel starts its shutdown.
fn run(worker: &Worker) -> Running {
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

/// Stops every run at once and waits for each within its grace and unwind window, plus a margin.
async fn stop_all(runs: Vec<Running>, grace: Duration) {
    let bound = grace + UNWIND_WINDOW + Duration::from_secs(5);
    let mut running = Vec::new();
    for (stop, run) in runs {
        stop.send(()).unwrap();
        running.push(run);
    }
    for run in running {
        tokio::time::timeout(bound, run).await.expect("a worker did not stop").unwrap().unwrap();
    }
}

// SM-1633: the rounds of every worker on one pool share one transaction on the heartbeat
// connection. Before, each worker sent its own transaction, so the round trips of a round grew with
// the workers. With 8 workers and 80 ms for each round trip, the rounds could not renew every lease
// in time, and the idle budget of 1/8 was shorter than one round trip.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn many_workers_on_a_small_pool_keep_every_lease_when_each_round_trip_takes_80_ms() {
    const WORKERS: usize = 8;
    const CONCURRENCY: usize = 2;
    const TASKS: usize = 2 * WORKERS * CONCURRENCY;
    let Some(database) = scratch_database("worker_pool_round_trip_delay").await else { return };
    let queue = Queue::connect(database.url(), QUEUE).await.unwrap();
    let admin = Admin::connect(database.url()).await.unwrap();
    let mut config = support::delaying_proxy(&database, Duration::from_millis(80)).await;
    // The test measures round trips, not the disk. Other test databases on the same server can make
    // a WAL flush wait for seconds, so a COMMIT of the workers does not wait for its flush.
    config.options("-c synchronous_commit=off");
    let manager = deadpool_postgres::Manager::new(config, NoTls);
    let pool = deadpool_postgres::Pool::builder(manager).max_size(6).build().unwrap();
    let grace = Duration::from_secs(10);
    // The handler starts of each task, and the handlers that saw a cancellation.
    let starts: Arc<Mutex<BTreeMap<Uuid, usize>>> = Arc::default();
    let cancelled = Arc::new(AtomicUsize::new(0));
    let mut runs = Vec::new();
    for _ in 0..WORKERS {
        let worker = Worker::new(
            pool.clone(),
            WorkerOptions {
                concurrency: CONCURRENCY,
                poll_interval: None,
                lease_duration: Duration::from_secs(3),
                heartbeat_interval: Some(Duration::from_secs(1)),
                maintenance_interval: Duration::from_secs(60),
                disable_registry: true,
                shutdown_grace_period: grace,
                queues: vec![QUEUE.into()],
                worker_id: Some(format!("rust-worker-{}", Uuid::new_v4())),
                polling_only: true,
                ..WorkerOptions::default()
            },
        )
        .unwrap();
        let (starts, cancelled) = (Arc::clone(&starts), Arc::clone(&cancelled));
        worker.handle("rust.slow", move |_: Value, context: HandlerContext| {
            let (starts, cancelled) = (Arc::clone(&starts), Arc::clone(&cancelled));
            async move {
                *starts.lock().unwrap().entry(context.task().id).or_default() += 1;
                // The handler runs longer than the lease, so only renewals keep it.
                let token = context.cancellation();
                tokio::select! {
                    () = tokio::time::sleep(Duration::from_secs(4)) => {}
                    () = token.cancelled() => {
                        cancelled.fetch_add(1, Ordering::SeqCst);
                    }
                }
                Ok(Value::Null)
            }
        });
        runs.push(run(&worker));
    }
    let mut tasks = Vec::new();
    for _ in 0..TASKS {
        tasks.push(
            queue
                .enqueue("rust.slow", &json!({}), EnqueueOptions::default())
                .await
                .unwrap()
                .task_id,
        );
    }
    let settled = tokio::time::timeout(Duration::from_secs(60), async {
        for task in &tasks {
            loop {
                let state = admin.get_task(*task).await.unwrap().expect("task exists").state;
                if state != TaskState::Ready && state != TaskState::Active {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    })
    .await;
    assert!(settled.is_ok(), "the tasks did not settle within 60 s");
    stop_all(runs, grace).await;
    assert_eq!(cancelled.load(Ordering::SeqCst), 0, "a handler lost its lease");
    for task in &tasks {
        let snapshot = admin.get_task(*task).await.unwrap().unwrap();
        assert_eq!(snapshot.state, TaskState::Succeeded, "task {task}");
        assert_eq!(snapshot.current_attempt, 1, "task {task} needed another attempt");
    }
    let starts = starts.lock().unwrap();
    assert_eq!(starts.len(), TASKS);
    assert!(starts.values().all(|count| *count == 1), "a task started twice: {starts:?}");
}
