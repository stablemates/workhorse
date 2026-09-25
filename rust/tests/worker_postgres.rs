//! The worker runtime against a real PostgreSQL schema, one scratch database per test.
//!
//! The first seven tests each failed against the interim `workhorse-worker` crate that SM-878
//! replaced. The rest cover the bounded drain and the capabilities `docs/parity.md` cites.
mod support;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use support::{scratch_database, ScratchDatabase};
use tokio::sync::{mpsc, oneshot};
use tokio_postgres::{Client, NoTls};
use uuid::Uuid;
use workhorse::{
    Admin, AdminAudit, BatchItem, BatchOptions, BatchResult, CancelReason, EnqueueOptions, Error,
    HandlerContext, HandlerError, Queue, ScheduleCatchupPolicy, ScheduleDefinition, ScheduledTask,
    TaskState, Worker, WorkerOptions,
};

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
async fn a_failed_attempt_settles_through_fail_v1() {
    let Some(harness) = harness("worker_fail").await else { return };
    let task = harness
        .enqueue("rust.fail", json!({}), EnqueueOptions { max_attempts: 1, ..Default::default() })
        .await;
    let worker = harness.worker(options());
    worker.handle("rust.fail", |_: Value, _| async {
        Err::<Value, _>(HandlerError::named("Boom", "handler failed"))
    });
    assert!(worker.run_once().await.unwrap());
    let snapshot = harness.admin.get_task(task).await.unwrap().unwrap();
    assert_eq!(snapshot.state, TaskState::Failed);
    assert_eq!(snapshot.error.unwrap()["name"], "Boom");
}

#[tokio::test]
async fn maintenance_passes_its_timestamp_and_an_unregistered_worker_runs() {
    let Some(harness) = harness("worker_maintenance").await else { return };
    // No registry row exists yet, and run_once runs one maintenance pass before claiming.
    assert!(!harness.worker(options()).run_once().await.unwrap());
}

#[tokio::test]
async fn an_operator_pause_stops_claims_until_it_is_cleared() {
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
    tokio::time::sleep(Duration::from_millis(300)).await;
    let task = harness.enqueue("rust.echo", json!({}), EnqueueOptions::default()).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(harness.state(task).await, TaskState::Ready, "a paused worker claimed");
    harness.admin.set_worker_paused(&worker_id, false, &audit()).await.unwrap().unwrap();
    harness.wait_for(task, TaskState::Succeeded).await;
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
}

#[tokio::test]
async fn the_registry_row_names_the_worker_process() {
    let Some(harness) = harness("worker_registry").await else { return };
    let options = options();
    let worker_id = options.worker_id.clone().unwrap();
    let worker = harness.worker(options);
    let url = harness.database.url().to_owned();
    worker.handle("rust.pid", move |_: Value, _| {
        let (url, worker_id) = (url.clone(), worker_id.clone());
        async move {
            let (client, connection) = tokio_postgres::connect(&url, NoTls).await.unwrap();
            tokio::spawn(connection);
            let row = client
                .query_one(
                    "SELECT pid FROM workhorse.worker_registry WHERE worker_id = $1",
                    &[&worker_id],
                )
                .await
                .unwrap();
            Ok(row.get::<_, i32>(0))
        }
    });
    let task = harness.enqueue("rust.pid", json!({}), EnqueueOptions::default()).await;
    assert!(worker.run_once().await.unwrap());
    let result = harness.admin.get_task(task).await.unwrap().unwrap().result;
    assert_eq!(result, Some(json!(std::process::id())));
}

#[tokio::test]
async fn the_handler_result_reaches_the_task_outcome() {
    let Some(harness) = harness("worker_result").await else { return };
    let task = harness.enqueue("rust.echo", json!({"echo": 1}), EnqueueOptions::default()).await;
    let worker = harness.worker(options());
    worker.handle("rust.echo", |payload: Value, _| async move { Ok(payload) });
    assert!(worker.run_once().await.unwrap());
    let result: Value = harness
        .database
        .connect()
        .await
        .query_one("SELECT result FROM workhorse.task_outcome WHERE task_id = $1", &[&task])
        .await
        .unwrap()
        .get(0);
    assert_eq!(result, json!({"echo": 1}));
}

#[tokio::test]
async fn dispatch_follows_the_task_type_and_releases_an_unhandled_task() {
    let Some(harness) = harness("worker_task_type").await else { return };
    let unhandled = harness
        .enqueue("rust.unhandled", json!({}), EnqueueOptions { priority: 90, ..Default::default() })
        .await;
    let handled = harness.enqueue("rust.handled", json!({}), EnqueueOptions::default()).await;
    let worker = harness.worker(WorkerOptions { concurrency: 2, ..options() });
    let seen = Arc::new(Mutex::new(Vec::new()));
    let record = Arc::clone(&seen);
    worker.handle("rust.handled", move |_: Value, context: HandlerContext| {
        record.lock().unwrap().push(context.task().id);
        async { Ok(Value::Null) }
    });
    let (stop, running) = run(&worker);
    harness.wait_for(handled, TaskState::Succeeded).await;
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
    assert_eq!(*seen.lock().unwrap(), vec![handled]);
    assert_eq!(harness.state(unhandled).await, TaskState::Ready);
}

#[tokio::test]
async fn a_stuck_handler_is_abandoned_when_grace_ends() {
    let Some(harness) = harness("worker_abandon").await else { return };
    let task = harness.enqueue("rust.stuck", json!({}), EnqueueOptions::default()).await;
    let options = WorkerOptions { shutdown_grace_period: Duration::from_millis(200), ..options() };
    let worker = harness.worker(options);
    let (started, mut running_handlers) = mpsc::unbounded_channel();
    worker.handle("rust.stuck", move |_: Value, _| {
        let _ = started.send(());
        // Ignores its cancellation, so only abandonment can end the drain.
        std::future::pending::<Result<Value, HandlerError>>()
    });
    let (stop, running) = run(&worker);
    running_handlers.recv().await.unwrap();
    let began = tokio::time::Instant::now();
    stop.send(()).unwrap();
    let outcome = tokio::time::timeout(Duration::from_secs(2), running)
        .await
        .expect("drain never returned while a handler stayed stuck")
        .unwrap();
    assert!(matches!(outcome, Err(Error::ShutdownIncomplete { abandoned: 1 })), "{outcome:?}");
    assert!(began.elapsed() >= Duration::from_millis(200), "drain ended before grace");
    // The abandoned lease stays with PostgreSQL, which recovers it after expiry.
    assert_eq!(harness.state(task).await, TaskState::Active);
}

#[tokio::test]
async fn a_drain_finishes_running_handlers_within_grace() {
    let Some(harness) = harness("worker_drain").await else { return };
    let task = harness.enqueue("rust.slow", json!({}), EnqueueOptions::default()).await;
    let worker = harness.worker(options());
    let (started, mut running_handlers) = mpsc::unbounded_channel();
    worker.handle("rust.slow", move |_: Value, _| {
        let _ = started.send(());
        async {
            tokio::time::sleep(Duration::from_millis(300)).await;
            Ok(json!("done"))
        }
    });
    let (stop, running) = run(&worker);
    running_handlers.recv().await.unwrap();
    stop.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), running).await.unwrap().unwrap().unwrap();
    assert_eq!(harness.state(task).await, TaskState::Succeeded);
}

#[tokio::test]
async fn a_handler_that_honors_shutdown_cancellation_releases_its_task() {
    let Some(harness) = harness("worker_unwind").await else { return };
    let task = harness.enqueue("rust.cooperative", json!({}), EnqueueOptions::default()).await;
    let options = WorkerOptions { shutdown_grace_period: Duration::from_millis(100), ..options() };
    let worker = harness.worker(options);
    let (started, mut running_handlers) = mpsc::unbounded_channel();
    worker.handle("rust.cooperative", move |_: Value, context: HandlerContext| {
        let _ = started.send(());
        async move {
            context.cancellation().cancelled().await;
            assert_eq!(context.cancellation().reason(), Some(CancelReason::Shutdown));
            Err::<Value, _>(HandlerError::new("stopped"))
        }
    });
    let (stop, running) = run(&worker);
    running_handlers.recv().await.unwrap();
    stop.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(2), running).await.unwrap().unwrap().unwrap();
    let snapshot = harness.admin.get_task(task).await.unwrap().unwrap();
    assert_eq!(snapshot.state, TaskState::Ready, "a shutdown release keeps the attempt budget");
    assert!(snapshot.error.is_none());
}

#[tokio::test]
async fn concurrent_handlers_stay_within_the_concurrency_limit() {
    let Some(harness) = harness("worker_concurrency").await else { return };
    let mut tasks = Vec::new();
    for _ in 0..6 {
        tasks.push(harness.enqueue("rust.slot", json!({}), EnqueueOptions::default()).await);
    }
    let worker = harness.worker(WorkerOptions { concurrency: 2, ..options() });
    let (running_now, most) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
    let (counter, peak) = (Arc::clone(&running_now), Arc::clone(&most));
    worker.handle("rust.slot", move |_: Value, _| {
        let (counter, peak) = (Arc::clone(&counter), Arc::clone(&peak));
        async move {
            peak.fetch_max(counter.fetch_add(1, Ordering::SeqCst) + 1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(100)).await;
            counter.fetch_sub(1, Ordering::SeqCst);
            Ok(Value::Null)
        }
    });
    let (stop, running) = run(&worker);
    for task in tasks {
        harness.wait_for(task, TaskState::Succeeded).await;
    }
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
    assert_eq!(most.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn a_notification_wakes_an_idle_worker_before_its_poll() {
    let Some(harness) = harness("worker_notify").await else { return };
    let worker = harness.worker(WorkerOptions {
        polling_only: false,
        poll_interval: Some(Duration::from_secs(60)),
        listen_config: Some(harness.database.url().parse().unwrap()),
        ..options()
    });
    worker.handle("rust.woken", |_: Value, _| async { Ok(Value::Null) });
    let (stop, running) = run(&worker);
    // The first empty claim leaves the worker idle for the whole poll interval.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let task = harness.enqueue("rust.woken", json!({}), EnqueueOptions::default()).await;
    harness.wait_for(task, TaskState::Succeeded).await;
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
}

#[tokio::test]
async fn a_batch_handler_receives_its_members_in_one_call() {
    let Some(harness) = harness("worker_batch").await else { return };
    let mut tasks = Vec::new();
    for index in 0..3 {
        tasks.push(harness.enqueue("rust.batch", json!(index), EnqueueOptions::default()).await);
    }
    let worker = harness.worker(WorkerOptions { concurrency: 3, ..options() });
    let sizes = Arc::new(Mutex::new(Vec::new()));
    let record = Arc::clone(&sizes);
    worker.handle_batch(
        "rust.batch",
        BatchOptions { max_size: 3, linger: Duration::from_millis(500) },
        move |items: Vec<BatchItem<i64>>| {
            record.lock().unwrap().push(items.len());
            let results = items
                .iter()
                .map(|item| match item.payload {
                    1 => BatchResult::Failed(HandlerError::named("Odd", "member failed")),
                    payload => BatchResult::Succeeded(payload * 10),
                })
                .collect();
            async move { results }
        },
    );
    let (stop, running) = run(&worker);
    harness.wait_for(tasks[0], TaskState::Succeeded).await;
    harness.wait_for(tasks[2], TaskState::Succeeded).await;
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
    assert_eq!(*sizes.lock().unwrap(), vec![3]);
    let snapshot = |task| harness.admin.get_task(task);
    assert_eq!(snapshot(tasks[2]).await.unwrap().unwrap().result, Some(json!(20)));
    let failed = snapshot(tasks[1]).await.unwrap().unwrap();
    assert_ne!(failed.state, TaskState::Succeeded);
    assert_eq!(failed.error.unwrap()["name"], "Odd");
}

#[tokio::test]
async fn maintenance_fires_due_schedules_in_its_namespaces() {
    let Some(harness) = harness("worker_schedules").await else { return };
    // `skip` evaluates only the last maintenance window, so the missed minute needs `latest`.
    let definition = ScheduleDefinition {
        catchup_policy: ScheduleCatchupPolicy::Latest,
        ..ScheduleDefinition::new(
            "every-minute",
            "* * * * *",
            ScheduledTask::new("rust.cron", json!({})),
        )
    };
    harness.queue.sync_schedules("rust-worker", vec![definition], true).await.unwrap();
    let observer = harness.database.connect().await;
    observer
        .execute(
            "UPDATE workhorse.schedule_definition
                SET last_evaluated_at = clock_timestamp() - interval '2 minutes'",
            &[],
        )
        .await
        .unwrap();
    let worker = harness
        .worker(WorkerOptions { schedule_namespaces: vec!["rust-worker".into()], ..options() });
    worker.handle("rust.cron", |_: Value, _| async { Ok(json!({"fired": true})) });
    assert!(worker.run_once().await.unwrap(), "the fired occurrence was not claimed");
    let fired: i64 = observer
        .query_one(
            "SELECT count(*) FROM workhorse.schedule_occurrence WHERE namespace = 'rust-worker'",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    assert!(fired >= 1);
}

#[tokio::test]
async fn a_worker_runs_terminal_storage_maintenance() {
    let Some(harness) = harness("worker_retention").await else { return };
    let observer = harness.database.connect().await;
    let completed = "SELECT last_completed_at IS NOT NULL FROM workhorse.maintenance_state
                      WHERE routine_name = 'terminal_storage'";
    observer
        .execute(
            "UPDATE workhorse.maintenance_state SET last_completed_at = NULL
              WHERE routine_name = 'terminal_storage'",
            &[],
        )
        .await
        .unwrap();
    assert!(!harness.worker(options()).run_once().await.unwrap());
    assert!(observer.query_one(completed, &[]).await.unwrap().get::<_, bool>(0));
}

#[cfg(feature = "opentelemetry")]
#[tokio::test]
async fn worker_metrics_reach_the_global_meter_provider() {
    use opentelemetry_sdk::metrics::{InMemoryMetricExporter, PeriodicReader, SdkMeterProvider};

    let Some(harness) = harness("worker_metrics").await else { return };
    let exporter = InMemoryMetricExporter::default();
    let provider = SdkMeterProvider::builder()
        .with_reader(PeriodicReader::builder(exporter.clone()).build())
        .build();
    // The worker binds its instruments to the global provider when it is built.
    opentelemetry::global::set_meter_provider(provider.clone());
    let worker = harness.worker(options());
    worker.handle("rust.metered", |_: Value, _| async { Ok(Value::Null) });
    harness.enqueue("rust.metered", json!({}), EnqueueOptions::default()).await;
    assert!(worker.run_once().await.unwrap());
    provider.force_flush().unwrap();
    let mut recorded = std::collections::BTreeSet::new();
    for resource in exporter.get_finished_metrics().unwrap() {
        for scope in resource.scope_metrics() {
            for metric in scope.metrics() {
                // Other tests share the global provider, so only this task type counts.
                if format!("{:?}", metric.data()).contains("rust.metered") {
                    recorded.insert(metric.name().to_owned());
                }
            }
        }
    }
    for name in [
        "workhorse.tasks.claimed",
        "workhorse.tasks.completed",
        "workhorse.handler.executions",
        "workhorse.handler.duration",
    ] {
        assert!(recorded.contains(name), "{name} missing from {recorded:?}");
    }
}

/// The pid of a backend other than `observer`'s whose last statement was a heartbeat round.
async fn heartbeat_backend(observer: &Client, except: Option<i32>) -> i32 {
    tokio::time::timeout(WAIT, async {
        loop {
            let row = observer
                .query_opt(
                    "SELECT pid FROM pg_stat_activity
                      WHERE datname = current_database() AND pid <> pg_backend_pid()
                        AND query LIKE '%heartbeat_many_v1%' AND pid IS DISTINCT FROM $1
                      LIMIT 1",
                    &[&except],
                )
                .await
                .unwrap();
            if let Some(row) = row {
                return row.get::<_, i32>(0);
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("no heartbeat round reached PostgreSQL")
}

/// SM-913: PostgreSQL terminates the reserved heartbeat connection while the worker is idle.
///
/// The worker holds that connection between tasks, so it learns of the termination only when the
/// next task's round fails. The run must survive, the handler must keep running uncancelled, and
/// heartbeats must resume on a fresh backend.
#[tokio::test]
async fn heartbeats_resume_after_postgres_terminates_the_idle_reserved_connection() {
    let Some(harness) = harness("worker_heartbeat_terminated").await else { return };
    let observer = harness.database.connect().await;
    let worker = harness.worker(WorkerOptions {
        lease_duration: Duration::from_secs(10),
        heartbeat_interval: Some(Duration::from_millis(20)),
        ..options()
    });
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let (started, mut running_handlers) = mpsc::unbounded_channel();
    let gate = Arc::clone(&release);
    worker.handle("rust.held", move |_: Value, context: HandlerContext| {
        let (gate, started) = (Arc::clone(&gate), started.clone());
        async move {
            let _ = started.send(());
            gate.acquire().await.unwrap().forget();
            Ok(json!({"cancelled": context.cancellation().is_cancelled()}))
        }
    });
    let (stop, running) = run(&worker);

    let before = harness.enqueue("rust.held", json!({}), EnqueueOptions::default()).await;
    running_handlers.recv().await.unwrap();
    let reserved = heartbeat_backend(&observer, None).await;
    release.add_permits(1);
    harness.wait_for(before, TaskState::Succeeded).await;

    // The worker is idle and still holds the reserved connection when PostgreSQL ends it.
    let terminated: bool =
        observer.query_one("SELECT pg_terminate_backend($1)", &[&reserved]).await.unwrap().get(0);
    assert!(terminated, "the reserved heartbeat backend was not terminated");
    tokio::time::sleep(Duration::from_millis(100)).await;

    let after = harness.enqueue("rust.held", json!({}), EnqueueOptions::default()).await;
    running_handlers.recv().await.unwrap();
    let fresh = heartbeat_backend(&observer, Some(reserved)).await;
    assert_ne!(fresh, reserved);
    assert!(!running.is_finished(), "the worker run ended after the termination");
    release.add_permits(1);
    harness.wait_for(after, TaskState::Succeeded).await;
    let result = harness.admin.get_task(after).await.unwrap().unwrap().result;
    assert_eq!(result, Some(json!({"cancelled": false})));
    assert!(!running.is_finished(), "the worker run ended before its shutdown");

    stop.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), running).await.unwrap().unwrap().unwrap();
}
