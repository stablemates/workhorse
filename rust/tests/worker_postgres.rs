//! The worker runtime against a real PostgreSQL schema, one scratch database per test.
//!
//! The first seven tests each failed against the interim `workhorse-worker` crate that SM-878
//! replaced. The rest cover the bounded drain, the fast task tier, and the capabilities
//! `docs/parity.md` cites.
mod support;

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use support::{scratch_database, ScratchDatabase};
use tokio::sync::{mpsc, oneshot};
use tokio_postgres::{Client, NoTls};
use uuid::Uuid;
use workhorse::contracts::{TaskContractVersion, TaskTypeContracts};
use workhorse::{
    Admin, AdminAudit, BatchItem, BatchOptions, BatchResult, CancelReason, ChildTaskRequest,
    ClaimedTask, Debounce, DebounceSchedule, EnqueueOptions, EnqueueRequest, Error, HandlerContext,
    HandlerError, Queue, QueueHistory, QueueTier, ScheduleCatchupPolicy, ScheduleDefinition,
    ScheduledTask, TaskState, Worker, WorkerOptions, CLEANUP_WINDOW, UNWIND_WINDOW,
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
    fn pool(&self) -> deadpool_postgres::Pool {
        let manager = deadpool_postgres::Manager::new(self.database.url().parse().unwrap(), NoTls);
        deadpool_postgres::Pool::builder(manager).max_size(6).build().unwrap()
    }

    fn worker(&self, options: WorkerOptions) -> Worker {
        Worker::new(self.pool(), options).unwrap()
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

/// Scheduling slack for a loaded host. With three busy threads per core, one test runtime stalled
/// for 0.35 s.
const SHUTDOWN_SLACK: Duration = Duration::from_secs(1);
/// A runtime stall this long inside the unwind window leaves a handler that honors cancellation
/// too little of the window to settle.
const STALL_LIMIT: Duration = Duration::from_millis(125);
/// How many times a test reruns a shutdown that a host stall pushed past the unwind window.
const STALLED_ATTEMPTS: usize = 3;

/// The latest a worker run with `grace` may return after its shutdown begins: grace, the unwind
/// window and the cleanup window, plus slack.
fn shutdown_bound(grace: Duration) -> Duration {
    grace + UNWIND_WINDOW + CLEANUP_WINDOW + SHUTDOWN_SLACK
}

/// Waits for a worker run with `grace` whose shutdown began at `began`, failing past its bound.
///
/// The worker shares the current-thread runtime, so a host stall of that runtime also stops the
/// worker. The outcome comes back with the longest stall inside the unwind window that follows
/// grace.
async fn shutdown_outcome(
    running: tokio::task::JoinHandle<Result<(), Error>>,
    grace: Duration,
    began: tokio::time::Instant,
) -> (Result<(), Error>, Duration) {
    const TICK: Duration = Duration::from_millis(5);
    let bound = shutdown_bound(grace);
    let (unwinding, unwound) = (began + grace, began + grace + UNWIND_WINDOW);
    tokio::pin!(running);
    let mut stall = Duration::ZERO;
    loop {
        let due = tokio::time::Instant::now() + TICK;
        let joined = tokio::select! {
            biased;
            joined = &mut running => Some(joined.unwrap()),
            () = tokio::time::sleep_until(due) => None,
        };
        let woke = tokio::time::Instant::now();
        // The part of this wake's delay that fell inside the unwind window.
        stall = stall.max(woke.min(unwound).saturating_duration_since(due.max(unwinding)));
        assert!(
            woke - began < bound,
            "shutdown outlived grace, its unwind and cleanup windows, and {SHUTDOWN_SLACK:?} \
             of slack: {bound:?}"
        );
        if let Some(outcome) = joined {
            return (outcome, stall);
        }
    }
}

/// Whether a shutdown that cancelled a handler which honors cancellation can be judged.
///
/// The handler must settle within the unwind window, so it settles and `run` returns `Ok`. A host
/// stall of `STALL_LIMIT` or longer inside that window can push it past the window; that attempt
/// is not judged.
fn judged_cooperative_shutdown(outcome: &Result<(), Error>, stall: Duration) -> bool {
    match outcome {
        Ok(()) => true,
        Err(Error::ShutdownIncomplete { abandoned: 1 }) if stall >= STALL_LIMIT => {
            eprintln!(
                "a {stall:?} runtime stall inside the unwind window abandoned the handler; rerunning"
            );
            false
        }
        other => {
            panic!("a handler that honors cancellation stopped with {other:?} ({stall:?} unwind stall)")
        }
    }
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
    let grace = Duration::from_millis(200);
    let worker = harness.worker(WorkerOptions { shutdown_grace_period: grace, ..options() });
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
    let (outcome, _) = shutdown_outcome(running, grace, began).await;
    assert!(matches!(outcome, Err(Error::ShutdownIncomplete { abandoned: 1 })), "{outcome:?}");
    assert!(began.elapsed() >= grace + UNWIND_WINDOW, "drain ended before its unwind window");
    // The abandoned lease stays with PostgreSQL, which recovers it after expiry.
    assert_eq!(harness.state(task).await, TaskState::Active);
}

/// The lease expiry PostgreSQL holds for `task`.
async fn lease_expiry(observer: &Client, task: Uuid) -> std::time::SystemTime {
    observer
        .query_one("SELECT expires_at FROM workhorse.task_runtime WHERE task_id = $1", &[&task])
        .await
        .unwrap()
        .get(0)
}

/// SM-1028: once the future that owns a lease is dropped, no heartbeat renews it.
///
/// A round already in flight may still land, so the expiry must first hold still for five
/// heartbeat intervals. A lease that keeps renewing never holds still. Recovery runs only after
/// PostgreSQL reports the expiry has passed.
async fn assert_lease_lapses(harness: &Harness, observer: &Client, task: Uuid) {
    let settled = Duration::from_millis(500);
    tokio::time::timeout(WAIT, async {
        let mut expiry = lease_expiry(observer, task).await;
        let mut since = tokio::time::Instant::now();
        while since.elapsed() < settled {
            tokio::time::sleep(Duration::from_millis(50)).await;
            let current = lease_expiry(observer, task).await;
            if current != expiry {
                expiry = current;
                since = tokio::time::Instant::now();
            }
        }
    })
    .await
    .expect("a dropped execution renewed its lease");
    tokio::time::timeout(WAIT, async {
        while !observer
            .query_one(
                "SELECT expires_at <= clock_timestamp() FROM workhorse.task_runtime WHERE task_id = $1",
                &[&task],
            )
            .await
            .unwrap()
            .get::<_, bool>(0)
        {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("the lease never expired");
    observer
        .query("SELECT * FROM workhorse.recover_expired_telemetry_v1(100, 0)", &[])
        .await
        .unwrap();
    assert_ne!(harness.state(task).await, TaskState::Active, "recovery left the lease in place");
}

fn lapsing_options() -> WorkerOptions {
    WorkerOptions {
        lease_duration: Duration::from_secs(1),
        heartbeat_interval: Some(Duration::from_millis(100)),
        registry_interval: Duration::from_millis(100),
        ..options()
    }
}

/// Waits for a handler to start, and fails when the worker ends first or never starts one.
async fn started<T: std::fmt::Debug>(
    running_handlers: &mut mpsc::UnboundedReceiver<()>,
    running: &mut tokio::task::JoinHandle<T>,
) {
    tokio::time::timeout(WAIT, async {
        tokio::select! {
            started = running_handlers.recv() => started.expect("the handler was dropped"),
            ended = running => panic!("the worker ended before its handler started: {ended:?}"),
        }
    })
    .await
    .expect("the handler never started");
}

/// Registers a handler that signals once it starts and then never returns.
fn handle_forever(worker: &Worker) -> mpsc::UnboundedReceiver<()> {
    let (started, running_handlers) = mpsc::unbounded_channel();
    worker.handle("rust.forever", move |_: Value, _| {
        let _ = started.send(());
        std::future::pending::<Result<Value, HandlerError>>()
    });
    running_handlers
}

/// SM-1028: dropping the `run` future abandons its task, and the lease expires (ADR 0074).
///
/// The registry row, the background loops and the reserved heartbeat connection go with it, and
/// the same worker runs again.
#[tokio::test]
async fn a_dropped_run_stops_renewing_its_leases_and_releases_the_worker() {
    let Some(harness) = harness("worker_dropped_run").await else { return };
    let observer = harness.database.connect().await;
    let options = lapsing_options();
    let worker_id = options.worker_id.clone().unwrap();
    let manager = deadpool_postgres::Manager::new(harness.database.url().parse().unwrap(), NoTls);
    let pool = deadpool_postgres::Pool::builder(manager).max_size(6).build().unwrap();
    let worker = Worker::new(pool.clone(), options).unwrap();
    let mut running_handlers = handle_forever(&worker);
    let task = harness
        .enqueue(
            "rust.forever",
            json!({}),
            EnqueueOptions { max_attempts: 1, ..Default::default() },
        )
        .await;

    let (_stop, mut running) = run(&worker);
    started(&mut running_handlers, &mut running).await;
    // A heartbeat round renews the lease before the run is dropped.
    tokio::time::sleep(Duration::from_millis(250)).await;
    running.abort();
    assert!(running.await.unwrap_err().is_cancelled());
    assert_lease_lapses(&harness, &observer, task).await;

    // Teardown runs after the run is dropped, so the test waits for it rather than for the lease.
    tokio::time::timeout(WAIT, async {
        loop {
            let registered: i64 = observer
                .query_one(
                    "SELECT count(*) FROM workhorse.worker_registry WHERE worker_id = $1",
                    &[&worker_id],
                )
                .await
                .unwrap()
                .get(0);
            let status = pool.status();
            if registered == 0 && status.available == status.size {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap_or_else(|_| {
        panic!(
            "the dropped run kept its registry row or its reserved connection: {:?}",
            pool.status()
        )
    });

    worker.handle("rust.done", |_: Value, _| async { Ok(Value::Null) });
    let next = harness.enqueue("rust.done", json!({}), EnqueueOptions::default()).await;
    let (stop, running) = run(&worker);
    harness.wait_for(next, TaskState::Succeeded).await;
    stop.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), running).await.unwrap().unwrap().unwrap();
}

/// SM-1028: dropping the `run_once` future abandons its task too.
#[tokio::test]
async fn a_dropped_run_once_stops_renewing_its_lease() {
    let Some(harness) = harness("worker_dropped_run_once").await else { return };
    let observer = harness.database.connect().await;
    let worker = harness.worker(lapsing_options());
    let mut running_handlers = handle_forever(&worker);
    let task = harness
        .enqueue(
            "rust.forever",
            json!({}),
            EnqueueOptions { max_attempts: 1, ..Default::default() },
        )
        .await;

    let once = worker.clone();
    let mut running = tokio::spawn(async move { once.run_once().await });
    started(&mut running_handlers, &mut running).await;
    tokio::time::sleep(Duration::from_millis(250)).await;
    running.abort();
    assert!(running.await.unwrap_err().is_cancelled());
    assert_lease_lapses(&harness, &observer, task).await;
}

/// SM-1085: dropping `run_once` while its batch member lingers abandons the member too.
///
/// The worker keeps its batch coordinator, so a member left pending would join the next batch on
/// the same worker. Recovery hands the same task back for its next attempt, and the callback must
/// see only that attempt.
#[tokio::test]
async fn a_dropped_run_once_leaves_no_batch_member_for_the_next_run() {
    let Some(harness) = harness("worker_dropped_batch_member").await else { return };
    let observer = harness.database.connect().await;
    let worker = harness.worker(WorkerOptions { concurrency: 2, ..lapsing_options() });
    let (called, mut calls) = mpsc::unbounded_channel();
    // The second member never arrives, so the first lingers until its run is dropped.
    worker.handle_batch(
        "rust.batch.dropped",
        BatchOptions { max_size: 2, linger: Duration::from_secs(2) },
        move |items: Vec<BatchItem<Value>>| {
            let attempts =
                items.iter().map(|item| (item.context.task().id, item.context.task().attempt));
            let _ = called.send(attempts.collect::<Vec<_>>());
            let results: Vec<_> =
                items.iter().map(|_| BatchResult::Succeeded(Value::Null)).collect();
            async move { results }
        },
    );
    let retry = json!({"type": "fixed", "delayMs": 0});
    let task = harness
        .enqueue(
            "rust.batch.dropped",
            json!({}),
            EnqueueOptions {
                max_attempts: 2,
                retry_policy: Some(retry.as_object().unwrap().clone()),
                ..Default::default()
            },
        )
        .await;

    let once = worker.clone();
    let running = tokio::spawn(async move { once.run_once().await });
    harness.wait_for(task, TaskState::Active).await;
    // The claimed member joins its batch and lingers well inside the two-second linger.
    tokio::time::sleep(Duration::from_millis(250)).await;
    running.abort();
    assert!(running.await.unwrap_err().is_cancelled());
    assert_lease_lapses(&harness, &observer, task).await;

    assert!(worker.run_once().await.unwrap(), "the recovered task did not run");
    assert_eq!(harness.state(task).await, TaskState::Succeeded);
    assert_eq!(calls.recv().await.unwrap(), vec![(task, 2)], "the dropped member joined the batch");
    assert!(calls.try_recv().is_err(), "the dropped member ran in a callback of its own");
}

/// Drops a run while PostgreSQL holds its initial registration, and expects no registry row.
async fn assert_cancelled_registration_deregisters<F>(name: &str, start: impl FnOnce(Worker) -> F)
where
    F: std::future::Future<Output = Result<(), workhorse::Error>> + Send + 'static,
{
    let Some(harness) = harness(name).await else { return };
    let (locker, observer) = (harness.database.connect().await, harness.database.connect().await);
    let options = options();
    let worker_id = options.worker_id.clone().unwrap();
    let worker = harness.worker(options);
    locker
        .batch_execute("BEGIN; LOCK TABLE workhorse.worker_registry IN ACCESS EXCLUSIVE MODE")
        .await
        .unwrap();
    let running = tokio::spawn(start(worker.clone()));

    let registering = "SELECT pid FROM pg_stat_activity WHERE datname = current_database() \
         AND state = 'active' AND query LIKE '%workhorse.register_worker_v1%'";
    let blocked = format!("{registering} AND wait_event_type = 'Lock'");
    let pid: i32 = tokio::time::timeout(WAIT, async {
        loop {
            if let Some(row) = observer.query_opt(&blocked, &[]).await.unwrap() {
                return row.get(0);
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the registration never waited on the registry lock");

    running.abort();
    assert!(running.await.unwrap_err().is_cancelled());
    locker.batch_execute("COMMIT").await.unwrap();
    let still_registering = format!("{registering} AND pid = $1");
    tokio::time::timeout(WAIT, async {
        while observer.query_opt(&still_registering, &[&pid]).await.unwrap().is_some() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the abandoned registration never finished");

    let registered = "SELECT count(*) FROM workhorse.worker_registry WHERE worker_id = $1";
    let rows = tokio::time::timeout(WAIT, async {
        loop {
            let rows: i64 = observer.query_one(registered, &[&worker_id]).await.unwrap().get(0);
            if rows == 0 {
                return rows;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    assert!(rows.is_ok(), "the dropped run left its registration behind");
}

/// SM-1028: a run dropped while it registers removes the registration PostgreSQL still makes.
#[tokio::test]
async fn a_run_dropped_during_registration_deregisters() {
    assert_cancelled_registration_deregisters(
        "worker_dropped_registering_run",
        |worker| async move { worker.run(std::future::pending::<()>()).await },
    )
    .await;
}

/// SM-1028: `run_once` cleans up a registration it was dropped during, as `run` does.
#[tokio::test]
async fn a_run_once_dropped_during_registration_deregisters() {
    assert_cancelled_registration_deregisters(
        "worker_dropped_registering_once",
        |worker| async move { worker.run_once().await.map(drop) },
    )
    .await;
}

#[tokio::test]
async fn a_drain_finishes_running_handlers_within_grace() {
    let Some(harness) = harness("worker_drain").await else { return };
    let task = harness.enqueue("rust.slow", json!({}), EnqueueOptions::default()).await;
    let grace = Duration::from_secs(1);
    let worker = harness.worker(WorkerOptions { shutdown_grace_period: grace, ..options() });
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
    let began = tokio::time::Instant::now();
    stop.send(()).unwrap();
    let (outcome, _) = shutdown_outcome(running, grace, began).await;
    outcome.unwrap();
    assert_eq!(harness.state(task).await, TaskState::Succeeded);
}

#[tokio::test]
async fn shutdown_returns_within_its_bound_while_the_registry_row_stays_locked() {
    let Some(harness) = harness("worker_stalled_registry").await else { return };
    for _ in 0..STALLED_ATTEMPTS {
        if shutdown_with_a_locked_registry_row(&harness).await {
            return;
        }
    }
    panic!("a runtime stall pushed every attempt past its unwind window");
}

/// One attempt of the test above. Returns false when a host stall leaves the attempt unjudged.
async fn shutdown_with_a_locked_registry_row(harness: &Harness) -> bool {
    let task = harness.enqueue("rust.cooperative", json!({}), EnqueueOptions::default()).await;
    // Longer than the slack, so a fresh grace period per phase would overrun each bound below.
    let grace = Duration::from_secs(2);
    let options = WorkerOptions { shutdown_grace_period: grace, ..options() };
    let worker_id = options.worker_id.clone().unwrap();
    let pool = harness.pool();
    let worker = Worker::new(pool.clone(), options).unwrap();
    let (started, mut running_handlers) = mpsc::unbounded_channel();
    let (cancelled, cancellation) = oneshot::channel::<tokio::time::Instant>();
    let cancelled = Arc::new(Mutex::new(Some(cancelled)));
    worker.handle("rust.cooperative", move |_: Value, context: HandlerContext| {
        let _ = started.send(());
        let cancelled = Arc::clone(&cancelled);
        async move {
            context.cancellation().cancelled().await;
            if let Some(cancelled) = cancelled.lock().unwrap().take() {
                let _ = cancelled.send(tokio::time::Instant::now());
            }
            Err::<Value, _>(HandlerError::new("stopped"))
        }
    });
    let (stop, running) = run(&worker);
    running_handlers.recv().await.unwrap();

    // Every registry write the drain makes now waits on this row lock until the attempt ends.
    let mut locker = harness.database.connect().await;
    let lock = locker.transaction().await.unwrap();
    let locked = lock
        .execute(
            "SELECT 1 FROM workhorse.worker_registry WHERE worker_id = $1 FOR UPDATE",
            &[&worker_id],
        )
        .await
        .unwrap();
    assert_eq!(locked, 1, "the worker never registered");

    let began = tokio::time::Instant::now();
    stop.send(()).unwrap();
    // The cleanup window also bounds the stalled deregistration.
    let (outcome, stall) = shutdown_outcome(running, grace, began).await;
    let judged = judged_cooperative_shutdown(&outcome, stall);
    if judged {
        // The stalled refresh spends the whole grace period. One deadline still bounds the
        // handler, so it sees cancellation when grace ends rather than a fresh grace period later.
        // It reports that before it returns.
        let cancelled_after = cancellation.await.unwrap() - began;
        assert!(
            cancelled_after >= grace,
            "the handler was cancelled before grace: {cancelled_after:?}"
        );
        assert!(
            cancelled_after < grace + SHUTDOWN_SLACK,
            "the stalled refresh delayed handler cancellation past grace: {cancelled_after:?}"
        );
        // The handler that honored cancellation released its task.
        assert_eq!(harness.state(task).await, TaskState::Ready);
        // The abandoned registry statements still wait on the lock. Their connections left the
        // pool, so every connection the pool lends now answers at once.
        let mut lent = Vec::new();
        for _ in 0..pool.status().max_size {
            lent.push(pool.get().await.unwrap());
        }
        for connection in &lent {
            tokio::time::timeout(Duration::from_secs(2), connection.query_one("SELECT 1", &[]))
                .await
                .expect("the pool lent a connection still running an abandoned registry statement")
                .unwrap();
        }
    }
    lock.rollback().await.unwrap();
    judged
}

#[tokio::test]
async fn shutdown_discards_the_connection_of_a_claim_it_abandons() {
    let Some(harness) = harness("worker_stalled_claim").await else { return };
    let grace = Duration::from_millis(100);
    let options = WorkerOptions {
        disable_registry: true,
        shared_heartbeats: true,
        maintenance_interval: Duration::from_secs(600),
        maintenance_routine_interval: Duration::from_secs(600),
        shutdown_grace_period: grace,
        ..options()
    };
    let pool = harness.pool();
    let worker = Worker::new(pool.clone(), options).unwrap();
    let (stop, running) = run(&worker);
    // The first maintenance pass also reads the task table. Let it finish before the lock.
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Every claim now waits on this table lock until the test ends.
    let mut locker = harness.database.connect().await;
    let lock = locker.transaction().await.unwrap();
    lock.execute("LOCK TABLE workhorse.task IN ACCESS EXCLUSIVE MODE", &[]).await.unwrap();
    let observer = harness.database.connect().await;
    let waiting = tokio::time::Instant::now() + WAIT;
    loop {
        let stalled: i64 = observer
            .query_one(
                "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() \
                 AND wait_event_type = 'Lock' AND query LIKE '%claim_many_v1%'",
                &[],
            )
            .await
            .unwrap()
            .get(0);
        if stalled > 0 {
            break;
        }
        assert!(tokio::time::Instant::now() < waiting, "no claim reached the lock");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    let began = tokio::time::Instant::now();
    stop.send(()).unwrap();
    let (outcome, _) = shutdown_outcome(running, grace, began).await;
    outcome.unwrap();
    // The abandoned claim still waits on the lock. Its connection left the pool, so every
    // connection the pool lends now answers at once.
    let mut lent = Vec::new();
    for _ in 0..pool.status().max_size {
        lent.push(pool.get().await.unwrap());
    }
    for connection in &lent {
        tokio::time::timeout(Duration::from_secs(2), connection.query_one("SELECT 1", &[]))
            .await
            .expect("the pool lent a connection still running an abandoned claim")
            .unwrap();
    }
    drop(lent);
    lock.rollback().await.unwrap();
}

#[tokio::test]
async fn shutdown_does_not_wait_for_a_stalled_heartbeat_round() {
    let Some(harness) = harness("worker_stalled_heartbeat").await else { return };
    let task = harness.enqueue("rust.stuck", json!({}), EnqueueOptions::default()).await;
    let interval = Duration::from_secs(8);
    let grace = Duration::from_millis(200);
    let options = WorkerOptions {
        shutdown_grace_period: grace,
        lease_duration: Duration::from_secs(60),
        heartbeat_interval: Some(interval),
        ..options()
    };
    let worker = harness.worker(options);
    let (started, mut running_handlers) = mpsc::unbounded_channel();
    worker.handle("rust.stuck", move |_: Value, _| {
        let _ = started.send(());
        std::future::pending::<Result<Value, HandlerError>>()
    });
    let (stop, running) = run(&worker);
    running_handlers.recv().await.unwrap();

    // The first heartbeat round waits on this lock for its whole interval.
    let mut locker = harness.database.connect().await;
    let lock = locker.transaction().await.unwrap();
    let mut locked = 0;
    for table in ["workhorse.task_runtime", "workhorse.fast_task_runtime"] {
        let statement = format!("SELECT 1 FROM {table} WHERE task_id = $1 FOR UPDATE");
        locked += lock.execute(statement.as_str(), &[&task]).await.unwrap();
    }
    assert_eq!(locked, 1, "the task has no runtime row");
    let observer = harness.database.connect().await;
    let waiting = tokio::time::Instant::now() + interval + Duration::from_secs(5);
    loop {
        let stalled: i64 = observer
            .query_one(
                "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() \
                 AND wait_event_type = 'Lock' AND query LIKE '%heartbeat_many_v1%'",
                &[],
            )
            .await
            .unwrap()
            .get(0);
        if stalled > 0 {
            break;
        }
        assert!(tokio::time::Instant::now() < waiting, "no heartbeat round reached the lock");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    let began = tokio::time::Instant::now();
    stop.send(()).unwrap();
    // The bound falls well short of the interval the stalled round would otherwise hold the
    // heartbeat connection for.
    assert!(shutdown_bound(grace) < interval);
    let (outcome, _) = shutdown_outcome(running, grace, began).await;
    assert!(matches!(outcome, Err(Error::ShutdownIncomplete { abandoned: 1 })), "{outcome:?}");
    lock.rollback().await.unwrap();
}

#[tokio::test]
async fn a_handler_that_honors_shutdown_cancellation_releases_its_task() {
    let Some(harness) = harness("worker_unwind").await else { return };
    for _ in 0..STALLED_ATTEMPTS {
        if shutdown_releases_a_cooperative_task(&harness).await {
            return;
        }
    }
    panic!("a runtime stall pushed every attempt past its unwind window");
}

/// One attempt of the test above. Returns false when a host stall leaves the attempt unjudged.
async fn shutdown_releases_a_cooperative_task(harness: &Harness) -> bool {
    let task = harness.enqueue("rust.cooperative", json!({}), EnqueueOptions::default()).await;
    let grace = Duration::from_millis(100);
    let worker = harness.worker(WorkerOptions { shutdown_grace_period: grace, ..options() });
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
    let began = tokio::time::Instant::now();
    stop.send(()).unwrap();
    let (outcome, stall) = shutdown_outcome(running, grace, began).await;
    if !judged_cooperative_shutdown(&outcome, stall) {
        return false;
    }
    let snapshot = harness.admin.get_task(task).await.unwrap().unwrap();
    assert_eq!(snapshot.state, TaskState::Ready, "a shutdown release keeps the attempt budget");
    assert!(snapshot.error.is_none());
    true
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

/// Forwards PostgreSQL frontend messages from `client` to `server` whole, until a simple query
/// containing `marker` arrives. It swallows that query and everything after it, fires
/// `intercepted`, and returns when `client` closes.
async fn forward_until_query<R, W>(
    mut client: R,
    mut server: W,
    marker: &[u8],
    intercepted: oneshot::Sender<()>,
) where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    // Untyped startup messages come first: an optional SSL or GSS request, then the startup
    // packet. Each is a length that counts itself, then a code.
    loop {
        let mut header = [0; 8];
        if client.read_exact(&mut header).await.is_err() {
            return;
        }
        let length = u32::from_be_bytes(header[..4].try_into().unwrap()) as usize;
        let mut message = header.to_vec();
        message.resize(length, 0);
        if client.read_exact(&mut message[8..]).await.is_err() {
            return;
        }
        server.write_all(&message).await.unwrap();
        let code = u32::from_be_bytes(header[4..].try_into().unwrap());
        if code != 80_877_103 && code != 80_877_104 {
            break;
        }
    }
    // Every later message is a type byte, then a length that counts itself but not the type.
    loop {
        let mut header = [0; 5];
        if client.read_exact(&mut header).await.is_err() {
            return;
        }
        let length = u32::from_be_bytes(header[1..].try_into().unwrap()) as usize;
        let mut message = header.to_vec();
        message.resize(length + 1, 0);
        if client.read_exact(&mut message[5..]).await.is_err() {
            return;
        }
        if header[0] == b'Q' && message[5..].windows(marker.len()).any(|window| window == marker) {
            break;
        }
        server.write_all(&message).await.unwrap();
    }
    let _ = intercepted.send(());
    let mut rest = Vec::new();
    let _ = client.read_to_end(&mut rest).await;
}

#[tokio::test]
async fn the_proxy_intercepts_a_query_that_arrives_in_fragments() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    fn query(text: &str) -> Vec<u8> {
        let mut message = vec![b'Q'];
        message.extend_from_slice(&(text.len() as u32 + 5).to_be_bytes());
        message.extend_from_slice(text.as_bytes());
        message.push(0);
        message
    }
    let mut startup = 16_u32.to_be_bytes().to_vec();
    startup.extend_from_slice(&196_608_u32.to_be_bytes());
    startup.extend_from_slice(b"user\0u\0\0");
    let forwarded = [startup.clone(), query("SELECT 1")].concat();
    let sent = [forwarded.clone(), query("LISTEN workhorse_tasks"), query("SELECT 2")].concat();

    let (mut client, client_end) = tokio::io::duplex(64);
    let (server_end, mut server) = tokio::io::duplex(1024);
    let (intercepted, interception) = oneshot::channel();
    let proxy = tokio::spawn(forward_until_query(
        client_end,
        server_end,
        b"LISTEN workhorse_tasks",
        intercepted,
    ));
    // One byte per write, so no read holds a whole message, and the marker spans many reads.
    for byte in sent {
        client.write_all(&[byte]).await.unwrap();
        client.flush().await.unwrap();
        tokio::task::yield_now().await;
    }
    drop(client);
    tokio::time::timeout(WAIT, proxy).await.expect("the proxy outlived its client").unwrap();
    interception.await.expect("the proxy never intercepted the fragmented query");
    let mut received = Vec::new();
    server.read_to_end(&mut received).await.unwrap();
    assert_eq!(received, forwarded);
}

#[tokio::test]
async fn shutdown_closes_the_notification_connection_while_listen_stalls() {
    let Some(harness) = harness("worker_stalled_listen").await else { return };
    let database: tokio_postgres::Config = harness.database.url().parse().unwrap();
    let tokio_postgres::config::Host::Tcp(host) = &database.get_hosts()[0] else {
        panic!("the test database must be reachable over TCP");
    };
    let upstream = (host.clone(), database.get_ports()[0]);
    // This proxy forwards the listener's connection but swallows its LISTEN, so the statement
    // waits for a reply that never comes.
    let proxy = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut listen = tokio_postgres::Config::new();
    listen.host("127.0.0.1").port(proxy.local_addr().unwrap().port());
    listen.user(database.get_user().unwrap()).dbname(database.get_dbname().unwrap());
    if let Some(password) = database.get_password() {
        listen.password(password);
    }
    let (stalled, listen_sent) = oneshot::channel();
    let (closed, client_closed) = oneshot::channel();
    let grace = Duration::from_millis(100);
    tokio::spawn(async move {
        let (client, _) = proxy.accept().await.unwrap();
        let server = tokio::net::TcpStream::connect(upstream).await.unwrap();
        let (client_reader, mut client_writer) = client.into_split();
        let (mut server_reader, server_writer) = server.into_split();
        tokio::spawn(async move { tokio::io::copy(&mut server_reader, &mut client_writer).await });
        forward_until_query(client_reader, server_writer, b"LISTEN workhorse_tasks", stalled).await;
        let _ = closed.send(());
    });
    let worker = harness.worker(WorkerOptions {
        polling_only: false,
        listen_config: Some(listen),
        shutdown_grace_period: grace,
        ..options()
    });
    let (stop, running) = run(&worker);
    tokio::time::timeout(WAIT, listen_sent).await.expect("the listener never sent LISTEN").unwrap();
    let began = tokio::time::Instant::now();
    stop.send(()).unwrap();
    let (outcome, _) = shutdown_outcome(running, grace, began).await;
    outcome.unwrap();
    // Shutdown aborted the stalled listener. Its connection must close with it.
    tokio::time::timeout(Duration::from_secs(2), client_closed)
        .await
        .expect("the notification connection outlived shutdown")
        .unwrap();
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

/// Reports which task a member's cancellation token fired for, and why.
type Cancellations = mpsc::UnboundedReceiver<(Uuid, Option<CancelReason>)>;

/// Reports each member's cancellation once its token fires, without ending the callback.
fn watch_cancellations(
    items: &[BatchItem<impl Send + 'static>],
    cancelled: &mpsc::UnboundedSender<(Uuid, Option<CancelReason>)>,
) {
    for item in items {
        let (id, token, cancelled) =
            (item.context.task().id, item.context.cancellation().clone(), cancelled.clone());
        tokio::spawn(async move {
            token.cancelled().await;
            let _ = cancelled.send((id, token.reason()));
        });
    }
}

/// A batch callback that never returns and ignores cancellation, reporting each task it starts.
fn stuck_batches(
    worker: &Worker,
    max_size: usize,
) -> (mpsc::UnboundedReceiver<Uuid>, Cancellations, Arc<AtomicUsize>) {
    let (started, starts) = mpsc::unbounded_channel();
    let (cancelled, cancellations) = mpsc::unbounded_channel();
    let peak = Arc::new(AtomicUsize::new(0));
    let (active, highest) = (Arc::new(AtomicUsize::new(0)), Arc::clone(&peak));
    worker.handle_batch(
        "rust.stuck",
        BatchOptions { max_size, linger: Duration::ZERO },
        move |items: Vec<BatchItem<Value>>| {
            highest.fetch_max(active.fetch_add(1, Ordering::SeqCst) + 1, Ordering::SeqCst);
            for item in &items {
                let _ = started.send(item.context.task().id);
            }
            watch_cancellations(&items, &cancelled);
            async move { std::future::pending::<Vec<BatchResult<Value>>>().await }
        },
    );
    (starts, cancellations, peak)
}

#[tokio::test]
async fn cancelled_batch_members_keep_their_callbacks_inside_the_concurrency() {
    let Some(harness) = harness("worker_batch_bound").await else { return };
    for _ in 0..3 {
        harness.enqueue("rust.stuck", json!({}), EnqueueOptions::default()).await;
    }
    let grace = Duration::from_millis(100);
    let worker = harness.worker(WorkerOptions {
        concurrency: 1,
        heartbeat_interval: Some(Duration::from_millis(50)),
        shutdown_grace_period: grace,
        ..options()
    });
    let (mut starts, mut cancellations, peak) = stuck_batches(&worker, 1);
    let (stop, running) = run(&worker);
    let first = tokio::time::timeout(WAIT, starts.recv()).await.unwrap().unwrap();
    harness.queue.cancel(first, None, None).await.unwrap();
    let cancellation = tokio::time::timeout(WAIT, cancellations.recv()).await.unwrap();
    assert_eq!(cancellation, Some((first, Some(CancelReason::Requested))));
    // A member freed by its cancellation would let the next claim start a second callback.
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(starts.try_recv().is_err(), "a second callback started beside the first");
    assert_eq!(peak.load(Ordering::SeqCst), 1);
    let began = tokio::time::Instant::now();
    stop.send(()).unwrap();
    let (outcome, _) = shutdown_outcome(running, grace, began).await;
    assert!(matches!(outcome, Err(Error::ShutdownIncomplete { abandoned: 1 })), "{outcome:?}");
}

#[tokio::test]
async fn shutdown_counts_a_batch_callback_that_outlives_the_grace_period() {
    let Some(harness) = harness("worker_batch_drain").await else { return };
    harness.enqueue("rust.stuck", json!({}), EnqueueOptions::default()).await;
    let grace = Duration::from_millis(200);
    let worker =
        harness.worker(WorkerOptions { concurrency: 1, shutdown_grace_period: grace, ..options() });
    let (mut starts, _, _) = stuck_batches(&worker, 1);
    let (stop, running) = run(&worker);
    tokio::time::timeout(WAIT, starts.recv()).await.unwrap().unwrap();
    let began = tokio::time::Instant::now();
    stop.send(()).unwrap();
    let (stopped, _) = shutdown_outcome(running, grace, began).await;
    assert!(
        matches!(stopped, Err(Error::ShutdownIncomplete { abandoned: 1 })),
        "shutdown reported {stopped:?} while the callback still ran"
    );
}

#[tokio::test]
async fn cancelling_one_batch_member_keeps_the_others_outcome() {
    let Some(harness) = harness("worker_batch_cancel").await else { return };
    let cancelled = harness.enqueue("rust.gated", json!(1), EnqueueOptions::default()).await;
    let kept = harness.enqueue("rust.gated", json!(2), EnqueueOptions::default()).await;
    let worker = harness.worker(WorkerOptions {
        concurrency: 2,
        heartbeat_interval: Some(Duration::from_millis(50)),
        ..options()
    });
    let (called, mut calls) = mpsc::unbounded_channel();
    let (watched, mut cancellations) = mpsc::unbounded_channel();
    let gate = Arc::new(tokio::sync::Notify::new());
    let opened = Arc::clone(&gate);
    worker.handle_batch(
        "rust.gated",
        BatchOptions { max_size: 2, linger: Duration::from_millis(500) },
        move |items: Vec<BatchItem<i64>>| {
            let _ = called.send(items.len());
            watch_cancellations(&items, &watched);
            let opened = Arc::clone(&opened);
            async move {
                opened.notified().await;
                items.iter().map(|item| BatchResult::Succeeded(item.payload * 10)).collect()
            }
        },
    );
    let (stop, running) = run(&worker);
    assert_eq!(tokio::time::timeout(WAIT, calls.recv()).await.unwrap(), Some(2));
    harness.queue.cancel(cancelled, None, None).await.unwrap();
    // The callback still holds both members when the cancelled one learns why it stopped.
    let cancellation = tokio::time::timeout(WAIT, cancellations.recv()).await.unwrap();
    assert_eq!(cancellation, Some((cancelled, Some(CancelReason::Requested))));
    gate.notify_one();
    harness.wait_for(kept, TaskState::Succeeded).await;
    let result = harness.admin.get_task(kept).await.unwrap().unwrap().result;
    assert_eq!(result, Some(json!(20)));
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
}

/// A batch callback can panic before it returns its future or while that future is polled. Both
/// panics fail every member with the panic detail and record the shared failure.
#[tokio::test]
async fn a_panicking_batch_callback_fails_every_member_with_failure_evidence() {
    let Some(harness) = harness("worker_batch_panic").await else { return };
    let once = || EnqueueOptions { max_attempts: 1, ..Default::default() };
    let mut tasks = Vec::new();
    for task_type in ["rust.batch.eager", "rust.batch.polled"] {
        for index in 0..2 {
            tasks.push((task_type, harness.enqueue(task_type, json!(index), once()).await));
        }
    }
    let worker = harness.worker(WorkerOptions { concurrency: 4, ..options() });
    let batch = BatchOptions { max_size: 2, linger: Duration::from_millis(500) };
    worker.handle_batch("rust.batch.eager", batch, |_: Vec<BatchItem<i64>>| {
        if true {
            panic!("eager batch panic");
        }
        async { Vec::<BatchResult<i64>>::new() }
    });
    worker.handle_batch("rust.batch.polled", batch, |_: Vec<BatchItem<i64>>| async {
        if true {
            panic!("polled batch panic");
        }
        Vec::<BatchResult<i64>>::new()
    });
    let (stop, running) = run(&worker);
    for &(_, task) in &tasks {
        harness.wait_for(task, TaskState::Failed).await;
    }
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
    let observer = harness.database.connect().await;
    for (task_type, task) in tasks {
        let error = harness.admin.get_task(task).await.unwrap().unwrap().error.unwrap();
        let detail = task_type.strip_prefix("rust.batch.").unwrap();
        assert_eq!(error["name"], "HandlerPanic", "{task_type}");
        assert_eq!(
            error["message"],
            format!("batch handler for {task_type} panicked: {detail} batch panic"),
            "{task_type}"
        );
        let failures: i64 = observer
            .query_one(
                "SELECT count(*) FROM workhorse.task_event
                  WHERE task_id = $1 AND event_type = 'batch_failed'",
                &[&task],
            )
            .await
            .unwrap()
            .get(0);
        assert_eq!(failures, 1, "{task_type} recorded no batch failure");
    }
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
///
/// With `idle`, the backend must also have finished that statement, which is how a connection the
/// worker holds between tasks looks.
async fn heartbeat_backend(observer: &Client, except: Option<i32>, idle: bool) -> i32 {
    tokio::time::timeout(WAIT, async {
        loop {
            let row = observer
                .query_opt(
                    "SELECT pid FROM pg_stat_activity
                      WHERE datname = current_database() AND pid <> pg_backend_pid()
                        AND query LIKE '%heartbeat_many_v1%' AND pid IS DISTINCT FROM $1
                        AND (NOT $2 OR state = 'idle')
                      LIMIT 1",
                    &[&except, &idle],
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
///
/// SM-951: a round that outlives the heartbeat interval discards the reserved connection, and the
/// next round reserves another. The interval is long enough that a loaded host does not replace
/// the connection, and the test names the reserved backend only once the worker is idle.
#[tokio::test]
async fn heartbeats_resume_after_postgres_terminates_the_idle_reserved_connection() {
    let Some(harness) = harness("worker_heartbeat_terminated").await else { return };
    let observer = harness.database.connect().await;
    let worker = harness.worker(WorkerOptions {
        lease_duration: Duration::from_secs(10),
        heartbeat_interval: Some(Duration::from_secs(1)),
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
    // A round has reached PostgreSQL, so the worker holds a connection that ran one.
    heartbeat_backend(&observer, None, false).await;
    release.add_permits(1);
    harness.wait_for(before, TaskState::Succeeded).await;
    let reserved = heartbeat_backend(&observer, None, true).await;

    // The worker is idle and still holds the reserved connection when PostgreSQL ends it.
    let terminated: bool =
        observer.query_one("SELECT pg_terminate_backend($1)", &[&reserved]).await.unwrap().get(0);
    assert!(terminated, "the reserved heartbeat backend was not terminated");
    tokio::time::sleep(Duration::from_millis(100)).await;

    let after = harness.enqueue("rust.held", json!({}), EnqueueOptions::default()).await;
    running_handlers.recv().await.unwrap();
    let fresh = heartbeat_backend(&observer, Some(reserved), false).await;
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

// The fast task tier (ADR 0077): one runtime row while a task is live and one outcome row after.

fn on(queue: &str) -> EnqueueOptions {
    EnqueueOptions { queue: Some(queue.into()), ..Default::default() }
}

fn serving(queue: &str) -> WorkerOptions {
    WorkerOptions { queues: vec![queue.into()], ..options() }
}

impl Harness {
    async fn make_fast(&self, queue: &str) {
        let tier = self.admin.set_queue_tier(queue, QueueTier::Fast, &audit()).await.unwrap();
        assert_eq!(tier, QueueTier::Fast);
    }

    /// Each settled fast task's outcome state and attempt, by task.
    async fn fast_outcomes(&self, ids: &[Uuid]) -> Vec<(Uuid, String, i32)> {
        let rows = self
            .database
            .connect()
            .await
            .query(
                "SELECT task_id, state, attempt FROM workhorse.fast_task_outcome
                  WHERE task_id = ANY($1::uuid[])",
                &[&ids],
            )
            .await
            .unwrap();
        rows.iter().map(|row| (row.get(0), row.get(1), row.get(2))).collect()
    }

    async fn wait_for_outcomes(&self, ids: &[Uuid]) {
        tokio::time::timeout(WAIT, async {
            while self.fast_outcomes(ids).await.len() < ids.len() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("every fast task settles");
    }

    async fn runtime_rows(&self, queue: &str) -> i64 {
        self.database
            .connect()
            .await
            .query_one(
                "SELECT count(*) FROM workhorse.fast_task_runtime WHERE queue_name = $1",
                &[&queue],
            )
            .await
            .unwrap()
            .get(0)
    }
}

#[tokio::test]
async fn a_fast_queue_rejects_full_tier_enqueue_features_by_ordinal() {
    let Some(harness) = harness("fast_enqueue").await else { return };
    harness.make_fast("fast-enqueue").await;
    let keyed = EnqueueOptions { concurrency_key: Some("tenant-a".into()), ..on("fast-enqueue") };
    let error = harness.queue.enqueue("keyed", &json!({}), keyed).await.unwrap_err();
    assert!(
        matches!(&error, Error::FastTierUnsupported { queue, feature, .. }
            if queue == "fast-enqueue" && feature == "concurrency keys"),
        "{error:?}"
    );

    let debounced = EnqueueOptions {
        debounce: Some(Debounce::new("k", 1_000, DebounceSchedule::Reset)),
        ..on("fast-enqueue")
    };
    let requests = vec![
        EnqueueRequest { options: on("fast-enqueue"), ..EnqueueRequest::new("plain", json!({})) },
        EnqueueRequest { options: debounced, ..EnqueueRequest::new("debounced", json!({})) },
    ];
    let error = harness.queue.enqueue_many(requests).await.unwrap_err();
    assert!(
        matches!(&error, Error::FastTierUnsupported { feature, ordinal: Some(2), .. }
            if feature == "debounce"),
        "{error:?}"
    );

    // A plain request is admitted into the fast runtime table.
    let task = harness.enqueue("plain", json!({}), on("fast-enqueue")).await;
    assert_eq!(harness.state(task).await, TaskState::Ready);
    assert_eq!(harness.runtime_rows("fast-enqueue").await, 1);
}

#[tokio::test]
async fn a_tier_change_waits_for_an_empty_queue() {
    let Some(harness) = harness("fast_tier_change").await else { return };
    harness.enqueue("live", json!({}), on("tier-change")).await;
    let error =
        harness.admin.set_queue_tier("tier-change", QueueTier::Fast, &audit()).await.unwrap_err();
    assert!(
        matches!(&error, Error::FastTierUnsupported { queue, feature, ordinal: None }
            if queue == "tier-change" && feature == "tier change"),
        "{error:?}"
    );

    harness.admin.purge_queue("tier-change", &audit()).await.unwrap();
    harness.make_fast("tier-change").await;
    let tier = harness.admin.set_queue_tier("tier-change", QueueTier::Full, &audit()).await;
    assert_eq!(tier.unwrap(), QueueTier::Full);
}

#[tokio::test]
async fn a_fast_queue_records_attempt_history_only_when_it_opts_in() {
    let Some(harness) = harness("fast_history").await else { return };
    harness.make_fast("fast-history").await;
    let history = harness.admin.set_queue_history("fast-history", Some(true), None).await.unwrap();
    assert_eq!(history, QueueHistory { record_attempts: true, record_claims: false });
    let task = harness.enqueue("recorded", json!({}), on("fast-history")).await;
    let worker = harness.worker(serving("fast-history"));
    worker.handle("recorded", |_: Value, _| async { Ok(json!({"ok": true})) });
    assert!(worker.run_once().await.unwrap());
    let attempts = harness
        .database
        .connect()
        .await
        .query(
            "SELECT attempt, outcome FROM workhorse.dashboard_attempt_history_v1
              WHERE task_id = $1",
            &[&task],
        )
        .await
        .unwrap();
    let attempts: Vec<(i32, String)> =
        attempts.iter().map(|row| (row.get(0), row.get(1))).collect();
    assert_eq!(attempts, [(1, "succeeded".to_owned())]);
    // Leaving a setting out keeps it.
    let history = harness.admin.set_queue_history("fast-history", None, Some(true)).await.unwrap();
    assert_eq!(history, QueueHistory { record_attempts: true, record_claims: true });
}

#[tokio::test]
async fn fast_tasks_run_within_the_concurrency_and_leave_one_outcome_each() {
    let Some(harness) = harness("fast_run").await else { return };
    harness.make_fast("fast-run").await;
    let requests = (0..40)
        .map(|sequence| EnqueueRequest {
            options: on("fast-run"),
            ..EnqueueRequest::new("square", json!({ "sequence": sequence }))
        })
        .collect();
    let ids: Vec<Uuid> = harness
        .queue
        .enqueue_many(requests)
        .await
        .unwrap()
        .into_iter()
        .map(|result| result.task_id)
        .collect();
    let concurrency = 4;
    let worker = harness.worker(WorkerOptions { concurrency, ..serving("fast-run") });
    let running = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let (counter, highest) = (Arc::clone(&running), Arc::clone(&peak));
    worker.handle("square", move |payload: Value, _| {
        let (running, peak) = (Arc::clone(&counter), Arc::clone(&highest));
        async move {
            let now = running.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(now, Ordering::SeqCst);
            let sequence = payload["sequence"].as_i64().unwrap();
            tokio::time::sleep(Duration::from_millis(sequence as u64 % 3)).await;
            running.fetch_sub(1, Ordering::SeqCst);
            Ok(json!({ "square": sequence * sequence }))
        }
    });
    let (stop, run) = run(&worker);
    harness.wait_for_outcomes(&ids).await;
    stop.send(()).unwrap();
    run.await.unwrap().unwrap();

    assert!(peak.load(Ordering::SeqCst) <= concurrency, "peak {peak:?}");
    let outcomes = harness.fast_outcomes(&ids).await;
    assert_eq!(outcomes.len(), ids.len());
    assert!(outcomes.iter().all(|(_, state, attempt)| state == "succeeded" && *attempt == 1));
    let snapshot = harness.admin.get_task(ids[7]).await.unwrap().unwrap();
    assert_eq!(snapshot.state, TaskState::Succeeded);
    assert_eq!(snapshot.result, Some(json!({ "square": 49 })));
    assert_eq!(harness.runtime_rows("fast-run").await, 0);
}

#[tokio::test]
async fn a_fast_task_fails_when_it_asks_for_durable_execution_state() {
    let Some(harness) = harness("fast_guard").await else { return };
    harness.make_fast("fast-guard").await;
    let worker = harness.worker(serving("fast-guard"));
    let seen = Arc::new(Mutex::new(Vec::new()));
    let record = Arc::clone(&seen);
    worker.handle("guarded", move |operation: String, context: HandlerContext| {
        let record = Arc::clone(&record);
        async move {
            let child = || ChildTaskRequest::new("child", "leaf", &json!({})).unwrap();
            let rejection = match operation.as_str() {
                "checkpoint" => {
                    context
                        .checkpoint("step", || async { Ok(1) })
                        .await
                        .map(drop)
                        .unwrap_err()
                        .message
                }
                "progress" => {
                    context.set_progress(&json!({"done": 1})).await.unwrap_err().to_string()
                }
                "sleep" => {
                    context.sleep("pause", Duration::from_millis(10)).await.unwrap_err().to_string()
                }
                "sleep_until" => {
                    context.sleep_until("pause", chrono::Utc::now()).await.unwrap_err().to_string()
                }
                "signal" => {
                    context.wait_for_signal::<Value>("approve", None).await.unwrap_err().to_string()
                }
                "human" => context
                    .wait_for_human::<_, Value>("review", &json!({}), None)
                    .await
                    .unwrap_err()
                    .to_string(),
                "run_child" => context
                    .run_child::<_, Value>("child", "leaf", &json!({}), on("fast-guard"))
                    .await
                    .unwrap_err()
                    .to_string(),
                "run_children" => {
                    context.run_children(vec![child()]).await.unwrap_err().to_string()
                }
                "run_children_all" => {
                    context.run_children_all(vec![child()]).await.unwrap_err().to_string()
                }
                other => panic!("unknown operation {other}"),
            };
            record.lock().unwrap().push(rejection.clone());
            Err::<Value, _>(HandlerError::named("FastTierUnsupportedError", rejection))
        }
    });
    let cases = [
        ("checkpoint", "checkpoints"),
        ("progress", "progress"),
        ("sleep", "durable waits"),
        ("sleep_until", "durable waits"),
        ("signal", "signal waits"),
        ("human", "human waits"),
        ("run_child", "child tasks"),
        ("run_children", "child tasks"),
        ("run_children_all", "child tasks"),
    ];
    for (operation, feature) in cases {
        let options = EnqueueOptions { max_attempts: 1, ..on("fast-guard") };
        let task = harness.enqueue("guarded", json!(operation), options).await;
        assert!(worker.run_once().await.unwrap());
        let rejection = seen.lock().unwrap().pop().expect("the handler ran");
        assert_eq!(
            rejection,
            format!("Fast-tier queue fast-guard does not support {feature}"),
            "{operation}"
        );
        let snapshot = harness.admin.get_task(task).await.unwrap().unwrap();
        assert_eq!(snapshot.state, TaskState::Failed, "{operation}");
        assert_eq!(snapshot.error.unwrap()["name"], "FastTierUnsupportedError", "{operation}");
    }
    // No rejected call created a child task.
    let children: i64 = harness
        .database
        .connect()
        .await
        .query_one("SELECT count(*) FROM workhorse.task WHERE task_type = 'leaf'", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(children, 0);
}

#[tokio::test]
async fn a_full_tier_queue_is_claimed_after_its_fast_claim_is_rejected() {
    let Some(harness) = harness("fast_probe").await else { return };
    let worker = harness.worker(serving("full-queue"));
    worker.handle("full-work", |_: Value, _| async { Ok(json!({"ok": true})) });
    // The second claim reuses the remembered tier instead of probing again.
    for _ in 0..2 {
        let task = harness.enqueue("full-work", json!({}), on("full-queue")).await;
        assert!(worker.run_once().await.unwrap());
        assert_eq!(harness.state(task).await, TaskState::Succeeded);
    }
    assert_eq!(harness.runtime_rows("full-queue").await, 0);
}

#[tokio::test]
async fn a_crashed_fast_worker_loses_no_task_and_records_one_outcome_each() {
    let Some(harness) = harness("fast_crash").await else { return };
    harness.make_fast("fast-crash").await;
    let mut ids = Vec::new();
    for sequence in 0..3 {
        let options = EnqueueOptions { max_attempts: 3, ..on("fast-crash") };
        ids.push(harness.enqueue("effect", json!({ "sequence": sequence }), options).await);
    }
    // A worker claims every task and vanishes before its lease runs out.
    let observer = harness.database.connect().await;
    let claimed = observer
        .query(
            "SELECT task_id, fence_token FROM workhorse.claim_many_v1('fast-crash', 'crashed', 3, 100)",
            &[],
        )
        .await
        .unwrap();
    let claimed: Vec<(Uuid, i64)> = claimed.iter().map(|row| (row.get(0), row.get(1))).collect();
    assert_eq!(claimed.len(), 3);
    tokio::time::sleep(Duration::from_millis(200)).await;
    observer
        .query("SELECT * FROM workhorse.recover_expired_telemetry_v1(100, 0)", &[])
        .await
        .unwrap();

    let effects = Arc::new(Mutex::new(std::collections::HashMap::<Uuid, usize>::new()));
    let record = Arc::clone(&effects);
    let worker = harness.worker(serving("fast-crash"));
    worker.handle("effect", move |_: Value, context: HandlerContext| {
        *record.lock().unwrap().entry(context.task().id).or_default() += 1;
        async { Ok(json!({"ok": true})) }
    });
    let (stop, run) = run(&worker);
    harness.wait_for_outcomes(&ids).await;
    stop.send(()).unwrap();
    run.await.unwrap().unwrap();

    let outcomes = harness.fast_outcomes(&ids).await;
    assert_eq!(outcomes.len(), 3, "one outcome row per task");
    assert!(outcomes.iter().all(|(_, state, _)| state == "succeeded"));
    let effects = effects.lock().unwrap().clone();
    assert!(ids.iter().all(|id| effects.get(id) == Some(&1)), "{effects:?}");

    // The crashed worker's late completion carries a stale fence, so PostgreSQL accepts none.
    let (task, fence) = claimed[0];
    let accepted: Option<Vec<Uuid>> = observer
        .query_one(
            "SELECT accepted FROM workhorse.complete_many_and_claim_v1(
               'crashed', ARRAY[$1::uuid], ARRAY[$2::bigint], ARRAY['{}'::jsonb], 'fast-crash', 0, 1000)",
            &[&task, &fence],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(accepted, Some(Vec::new()));
}

/// The environment variable that turns `fast_crash_child_process` into the killed worker.
const FAST_CRASH_CHILD_URL: &str = "WORKHORSE_FAST_CRASH_CHILD_URL";
/// The killed worker's sessions carry this name, so the test can find what its process left open.
const FAST_CRASH_CHILD: &str = "rust-fast-crash-child";
const FAST_CRASH_QUEUE: &str = "rust-fast-kill";
const FAST_CRASH_CONCURRENCY: usize = 4;

/// Records one handler run of `task` in the crash test's invocation table.
async fn record_fast_crash_run(
    pool: &deadpool_postgres::Pool,
    task: &ClaimedTask,
    worker: &str,
) -> Result<Value, HandlerError> {
    let client = pool.get().await.map_err(|error| HandlerError::new(error.to_string()))?;
    client
        .execute(
            "INSERT INTO fast_crash_invocation(task_id, attempt, worker) VALUES ($1, $2, $3)",
            &[&task.id, &task.attempt, &worker],
        )
        .await
        .map_err(|error| HandlerError::new(error.to_string()))?;
    Ok(json!({"ok": true}))
}

/// Kills and reaps the child process when dropped, so a failing test leaves no worker behind.
struct KilledOnDrop(std::process::Child);

impl Drop for KilledOnDrop {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// The worker `a_killed_fast_worker_loses_no_buffered_completion` kills. The test runs this test
/// binary again with only this test selected, and the test serves the queue until it is killed.
/// Without the environment variable it does nothing.
#[tokio::test(flavor = "multi_thread")]
async fn fast_crash_child_process() {
    let Ok(url) = std::env::var(FAST_CRASH_CHILD_URL) else { return };
    let manager = deadpool_postgres::Manager::new(url.parse().unwrap(), NoTls);
    let pool = deadpool_postgres::Pool::builder(manager).max_size(10).build().unwrap();
    let worker = Worker::new(
        pool.clone(),
        WorkerOptions {
            queues: vec![FAST_CRASH_QUEUE.into()],
            worker_id: Some("rust-fast-crashed".into()),
            concurrency: FAST_CRASH_CONCURRENCY,
            polling_only: true,
            poll_interval: Some(Duration::from_millis(5)),
            ..WorkerOptions::default()
        },
    )
    .unwrap();
    worker.handle("effect", move |_: Value, context: HandlerContext| {
        let pool = pool.clone();
        async move { record_fast_crash_run(&pool, context.task(), "crashed").await }
    });
    worker.run(std::future::pending::<()>()).await.unwrap();
}

/// Kills a real worker process while its completions and refill claims are in flight. A trigger
/// holds every outcome insert of the queue on an advisory lock the test owns, so the worker's
/// completion statements wait inside PostgreSQL. The worker is then killed, its sessions end, and
/// a second worker recovers every task.
#[tokio::test]
async fn a_killed_fast_worker_loses_no_buffered_completion() {
    let Some(harness) = harness("fast_kill").await else { return };
    harness.make_fast(FAST_CRASH_QUEUE).await;
    let mut ids = Vec::new();
    for sequence in 0..12 {
        let options = EnqueueOptions { max_attempts: 3, ..on(FAST_CRASH_QUEUE) };
        ids.push(harness.enqueue("effect", json!({ "sequence": sequence }), options).await);
    }
    let holder = harness.database.connect().await;
    holder
        .batch_execute(&format!(
            "CREATE TABLE fast_crash_invocation
               (task_id uuid NOT NULL, attempt integer NOT NULL, worker text NOT NULL);
             CREATE FUNCTION hold_fast_outcome() RETURNS trigger LANGUAGE plpgsql AS $$
             BEGIN PERFORM pg_advisory_xact_lock(1172); RETURN NEW; END; $$;
             CREATE TRIGGER hold_fast_outcome AFTER INSERT ON workhorse.fast_task_outcome
               FOR EACH ROW WHEN (NEW.queue_name = '{FAST_CRASH_QUEUE}')
               EXECUTE FUNCTION hold_fast_outcome();"
        ))
        .await
        .unwrap();
    let holder_pid: i32 = holder
        .query_one("SELECT pg_backend_pid() FROM (SELECT pg_advisory_lock(1172)) held", &[])
        .await
        .unwrap()
        .get(0);

    let separator = if harness.database.url().contains('?') { '&' } else { '?' };
    let mut child = KilledOnDrop(
        std::process::Command::new(std::env::current_exe().unwrap())
            .args(["fast_crash_child_process", "--exact", "--nocapture"])
            .env(
                FAST_CRASH_CHILD_URL,
                format!("{}{separator}application_name={FAST_CRASH_CHILD}", harness.database.url()),
            )
            .spawn()
            .unwrap(),
    );
    // Every slot's handler has run, and a completion statement waits on the test's lock.
    let held = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let row = holder
                .query_one(
                    "SELECT (SELECT count(DISTINCT task_id) FROM fast_crash_invocation),
                            (SELECT count(*) FROM pg_stat_activity
                              WHERE $1::integer = ANY(pg_blocking_pids(pid)))",
                    &[&holder_pid],
                )
                .await
                .unwrap();
            let (ran, blocked): (i64, i64) = (row.get(0), row.get(1));
            if ran >= FAST_CRASH_CONCURRENCY as i64 && blocked > 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    child.0.kill().unwrap();
    child.0.wait().unwrap();
    held.expect("the killed worker ran every slot and blocked a completion");
    // The kernel closes the dead process's sockets, but a session waiting on a lock does not
    // notice until it next talks to the client. Ending the sessions rolls their statements back.
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let remaining: i64 = holder
                .query_one(
                    "SELECT count(*) FROM pg_stat_activity, pg_terminate_backend(pid)
                      WHERE application_name = $1",
                    &[&FAST_CRASH_CHILD],
                )
                .await
                .unwrap()
                .get(0);
            if remaining == 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the killed worker's sessions end");
    holder
        .batch_execute(
            "SELECT pg_advisory_unlock(1172);
             DROP TRIGGER hold_fast_outcome ON workhorse.fast_task_outcome;",
        )
        .await
        .unwrap();

    // No completion committed, and every task the killed worker ran still holds its lease.
    assert_eq!(harness.fast_outcomes(&ids).await, Vec::new());
    let active: std::collections::HashSet<Uuid> = holder
        .query(
            "SELECT task_id FROM workhorse.fast_task_runtime
              WHERE queue_name = $1 AND state = 'active' AND attempt = 1",
            &[&FAST_CRASH_QUEUE],
        )
        .await
        .unwrap()
        .iter()
        .map(|row| row.get(0))
        .collect();
    let crashed_runs: Vec<(Uuid, i32)> = holder
        .query("SELECT task_id, attempt FROM fast_crash_invocation", &[])
        .await
        .unwrap()
        .iter()
        .map(|row| (row.get(0), row.get(1)))
        .collect();
    let ran: std::collections::HashSet<Uuid> = crashed_runs.iter().map(|run| run.0).collect();
    assert!(ran.len() >= FAST_CRASH_CONCURRENCY, "{crashed_runs:?}");
    assert_eq!(crashed_runs.len(), ran.len(), "each task ran once in the killed worker");
    assert!(crashed_runs.iter().all(|run| run.1 == 1), "{crashed_runs:?}");
    assert!(ran.is_subset(&active), "ran {ran:?}, active {active:?}");

    holder
        .execute(
            "UPDATE workhorse.fast_task_runtime
                SET expires_at = clock_timestamp() - interval '1 millisecond'
              WHERE queue_name = $1 AND state = 'active'",
            &[&FAST_CRASH_QUEUE],
        )
        .await
        .unwrap();
    holder
        .query("SELECT * FROM workhorse.recover_expired_telemetry_v1(100, 0)", &[])
        .await
        .unwrap();
    let survivor = harness
        .worker(WorkerOptions { concurrency: FAST_CRASH_CONCURRENCY, ..serving(FAST_CRASH_QUEUE) });
    let pool = harness.pool();
    survivor.handle("effect", move |_: Value, context: HandlerContext| {
        let pool = pool.clone();
        async move { record_fast_crash_run(&pool, context.task(), "survivor").await }
    });
    let (stop, run) = run(&survivor);
    harness.wait_for_outcomes(&ids).await;
    stop.send(()).unwrap();
    run.await.unwrap().unwrap();

    // A task the killed worker held runs again as attempt 2. Every other task runs once.
    let mut survivor_runs: Vec<(Uuid, i32)> = holder
        .query("SELECT task_id, attempt FROM fast_crash_invocation WHERE worker = 'survivor'", &[])
        .await
        .unwrap()
        .iter()
        .map(|row| (row.get(0), row.get(1)))
        .collect();
    let mut expected: Vec<(Uuid, i32)> =
        ids.iter().map(|id| (*id, if active.contains(id) { 2 } else { 1 })).collect();
    survivor_runs.sort();
    expected.sort();
    assert_eq!(survivor_runs, expected);
    let mut outcomes = harness.fast_outcomes(&ids).await;
    outcomes.sort();
    let expected: Vec<(Uuid, String, i32)> =
        expected.into_iter().map(|(id, attempt)| (id, "succeeded".into(), attempt)).collect();
    assert_eq!(outcomes, expected);
}

#[tokio::test]
async fn a_worker_serving_both_tiers_completes_each_task_in_its_own_tier() {
    let Some(harness) = harness("fast_mixed").await else { return };
    harness.make_fast("fast-mixed").await;
    let mut fast = Vec::new();
    let mut full = Vec::new();
    for sequence in 0..24 {
        fast.push(harness.enqueue("work", json!({ "sequence": sequence }), on("fast-mixed")).await);
        full.push(harness.enqueue("work", json!({ "sequence": sequence }), on("full-mixed")).await);
    }
    // Four slots in two cohorts: fast completions batch, and the full-tier queue turns cohorts off.
    let worker = harness.worker(WorkerOptions {
        concurrency: 4,
        cohorts: Some(2),
        queues: vec!["fast-mixed".into(), "full-mixed".into()],
        ..options()
    });
    worker.handle("work", |payload: Value, _| async move { Ok(payload) });
    let (stop, run) = run(&worker);
    harness.wait_for_outcomes(&fast).await;
    tokio::time::timeout(WAIT, async {
        for &task in &full {
            while harness.state(task).await != TaskState::Succeeded {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
    })
    .await
    .expect("every full-tier task succeeds");
    stop.send(()).unwrap();
    run.await.unwrap().unwrap();

    let outcomes = harness.fast_outcomes(&fast).await;
    assert_eq!(outcomes.len(), fast.len());
    assert!(outcomes.iter().all(|(_, state, attempt)| state == "succeeded" && *attempt == 1));
    assert!(harness.fast_outcomes(&full).await.is_empty(), "a full-tier task has no outcome row");
    assert_eq!(harness.runtime_rows("fast-mixed").await, 0);
}

#[tokio::test]
async fn an_abandoned_batching_worker_reruns_no_more_tasks_than_its_concurrency() {
    let Some(harness) = harness("fast_abandon").await else { return };
    harness.make_fast("fast-abandon").await;
    let requests = (0..60)
        .map(|sequence| EnqueueRequest {
            options: EnqueueOptions { max_attempts: 3, ..on("fast-abandon") },
            ..EnqueueRequest::new("effect", json!({ "sequence": sequence }))
        })
        .collect();
    let ids: Vec<Uuid> = harness
        .queue
        .enqueue_many(requests)
        .await
        .unwrap()
        .into_iter()
        .map(|result| result.task_id)
        .collect();
    let effects = Arc::new(Mutex::new(std::collections::HashMap::<Uuid, usize>::new()));
    let concurrency = 8;
    let grace = Duration::from_millis(50);

    // The first worker completes 20 tasks in fused batches, then every handler hangs until the
    // worker abandons them. Their leases lapse as if the process had died.
    let started = Arc::new(AtomicUsize::new(0));
    let (record, count) = (Arc::clone(&effects), Arc::clone(&started));
    let crashing = harness.worker(WorkerOptions {
        concurrency,
        lease_duration: Duration::from_millis(500),
        heartbeat_interval: Some(Duration::from_millis(100)),
        shutdown_grace_period: grace,
        ..serving("fast-abandon")
    });
    crashing.handle("effect", move |_: Value, context: HandlerContext| {
        *record.lock().unwrap().entry(context.task().id).or_default() += 1;
        let hang = count.fetch_add(1, Ordering::SeqCst) >= 20;
        async move {
            if hang {
                std::future::pending::<()>().await;
            }
            Ok(json!({"ok": true}))
        }
    });
    let (stop, run_crashing) = run(&crashing);
    tokio::time::timeout(WAIT, async {
        while started.load(Ordering::SeqCst) < 20 + concurrency {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the first worker fills every slot with a hung handler");
    let began = tokio::time::Instant::now();
    stop.send(()).unwrap();
    let (outcome, _) = shutdown_outcome(run_crashing, grace, began).await;
    assert!(matches!(outcome, Err(Error::ShutdownIncomplete { .. })), "{outcome:?}");
    tokio::time::sleep(Duration::from_millis(600)).await;
    harness
        .database
        .connect()
        .await
        .query("SELECT * FROM workhorse.recover_expired_telemetry_v1(100, 0)", &[])
        .await
        .unwrap();

    let record = Arc::clone(&effects);
    let worker = harness.worker(WorkerOptions { concurrency, ..serving("fast-abandon") });
    worker.handle("effect", move |_: Value, context: HandlerContext| {
        *record.lock().unwrap().entry(context.task().id).or_default() += 1;
        async { Ok(json!({"ok": true})) }
    });
    let (stop, run) = run(&worker);
    harness.wait_for_outcomes(&ids).await;
    stop.send(()).unwrap();
    run.await.unwrap().unwrap();

    let outcomes = harness.fast_outcomes(&ids).await;
    assert_eq!(outcomes.len(), ids.len(), "one outcome row per task");
    assert!(outcomes.iter().all(|(_, state, _)| state == "succeeded"));
    let effects = effects.lock().unwrap().clone();
    assert!(ids.iter().all(|id| effects.contains_key(id)), "every task ran");
    let reruns = effects.values().filter(|&&runs| runs > 1).count();
    assert!(reruns > 0 && reruns <= concurrency, "{reruns} tasks ran twice");
    assert!(effects.values().all(|&runs| runs <= 2), "{effects:?}");
    assert_eq!(harness.runtime_rows("fast-abandon").await, 0);
}

/// SM-1051: two contracts whose type and version join to the same text keep separate schemas.
#[tokio::test]
async fn result_schemas_stay_apart_when_type_and_version_join_alike() {
    let Some(harness) = harness("worker_schema_key").await else { return };
    let contract = |version: &str, result_schema: Value| TaskTypeContracts {
        current_version: version.into(),
        versions: BTreeMap::from([(
            version.to_string(),
            TaskContractVersion { result_schema, ..TaskContractVersion::default() },
        )]),
    };
    let contracts = BTreeMap::from([
        ("a|b".to_string(), contract("c", json!({"type": "string"}))),
        ("a".to_string(), contract("b|c", json!({"type": "number"}))),
    ]);
    harness.queue.sync_contracts(&contracts).await.unwrap();
    let once = EnqueueOptions { max_attempts: 1, ..Default::default() };
    // A fresh worker per order starts with an empty cache, so each pair takes its turn first.
    for order in [["a|b", "a"], ["a", "a|b"]] {
        let worker = harness.worker(options());
        worker.handle("a|b", |_: Value, _| async { Ok(json!("text")) });
        worker.handle("a", |_: Value, _| async { Ok(json!(1)) });
        for task_type in order {
            let task = harness.enqueue(task_type, json!({}), once.clone()).await;
            assert!(worker.run_once().await.unwrap());
            let snapshot = harness.admin.get_task(task).await.unwrap().unwrap();
            assert_eq!(
                snapshot.state,
                TaskState::Succeeded,
                "{task_type} after {order:?} met the other pair's schema: {:?}",
                snapshot.error
            );
        }
    }
}

const UNSTORABLE_RESULT: &str =
    "result contains a NUL character or an unpaired surrogate, which PostgreSQL jsonb cannot store";

/// Runs three results holding NUL and one valid result on `queue`. Each NUL result fails its
/// attempts through the retry policy, the valid one succeeds, and the worker keeps running.
async fn run_unstorable_results(harness: &Harness, queue: &str) {
    let retried = EnqueueOptions { max_attempts: 2, ..on(queue) };
    let tasks = [
        harness.enqueue("rust.nul", json!("string"), retried.clone()).await,
        harness.enqueue("rust.nul", json!("key"), retried.clone()).await,
        harness.enqueue("rust.nul", json!("nested"), retried).await,
        harness.enqueue("rust.nul", json!("valid"), on(queue)).await,
    ];
    let worker = harness.worker(WorkerOptions {
        retry_delay: Some(Arc::new(|_: i32, _: &ClaimedTask| Some(Duration::ZERO))),
        ..serving(queue)
    });
    // A payload cannot carry NUL either, so the handler builds each result from a case name.
    worker.handle("rust.nul", |case: Value, _| async move {
        Ok(match case.as_str() {
            Some("string") => json!("a\u{0}b"),
            Some("key") => json!({"k\u{0}": 1}),
            Some("nested") => json!(["ok", ["\u{0}"]]),
            _ => json!({"pair": "\u{1F600}"}),
        })
    });
    let (stop, running) = run(&worker);
    let mut outcomes = Vec::new();
    for task in tasks {
        let snapshot = tokio::time::timeout(WAIT, async {
            loop {
                let snapshot = harness.admin.get_task(task).await.unwrap().unwrap();
                if matches!(snapshot.state, TaskState::Succeeded | TaskState::Failed) {
                    return snapshot;
                }
                assert!(!running.is_finished(), "the worker stopped");
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("task {task} never settled"));
        outcomes.push((task, snapshot.state, snapshot.current_attempt, snapshot.error));
    }
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
    let (valid, rest) = outcomes.split_last().unwrap();
    assert_eq!((valid.1, valid.2), (TaskState::Succeeded, 1));
    for (task, state, attempts, error) in rest {
        assert_eq!((*state, *attempts), (TaskState::Failed, 2), "task {task}");
        let error = error.as_ref().unwrap();
        assert_eq!(error["name"], "Error");
        assert_eq!(error["message"], format!("rust.nul {UNSTORABLE_RESULT}"));
    }
}

#[tokio::test]
async fn a_result_holding_nul_fails_only_its_task() {
    let Some(harness) = harness("worker_unstorable").await else { return };
    run_unstorable_results(&harness, "rust-unstorable").await;
}

#[tokio::test]
async fn a_fast_result_holding_nul_fails_only_its_task() {
    let Some(harness) = harness("fast_unstorable").await else { return };
    harness.make_fast("fast-unstorable").await;
    run_unstorable_results(&harness, "fast-unstorable").await;
}

/// The default `result_max_bytes`. A result of `n` zeros prints as `3n` bytes of jsonb text but
/// only `2n + 1` bytes of compact JSON, so these cases also pin which text the worker measures.
const RESULT_MAX_BYTES: usize = 1_048_576;

/// Runs an oversized result twice and a result exactly at the limit once on `queue`. The oversized
/// result fails each attempt through the retry policy, and then terminally. The lease outlasts the
/// test, so only the worker's own settlement can move the task.
async fn run_oversized_results(harness: &Harness, queue: &str) {
    let fits = RESULT_MAX_BYTES / 3;
    let oversized = harness
        .enqueue("rust.oversized", json!(fits + 1), EnqueueOptions { max_attempts: 2, ..on(queue) })
        .await;
    let worker = harness.worker(WorkerOptions {
        lease_duration: Duration::from_secs(300),
        retry_delay: Some(Arc::new(|_: i32, _: &ClaimedTask| Some(Duration::ZERO))),
        ..serving(queue)
    });
    worker.handle("rust.oversized", |zeros: usize, _| async move {
        Ok(Value::Array(vec![json!(0); zeros]))
    });
    for (state, attempt) in [(TaskState::Ready, 2), (TaskState::Failed, 2)] {
        assert!(worker.run_once().await.unwrap());
        let snapshot = harness.admin.get_task(oversized).await.unwrap().unwrap();
        assert_eq!((snapshot.state, snapshot.current_attempt), (state, attempt));
        let error = snapshot.error.expect("the attempt recorded its error");
        assert_eq!(error["name"], "TaskValueSizeLimitError");
        assert_eq!(error["message"], "rust.oversized result exceeds its configured size limit");
    }
    let at_limit = harness.enqueue("rust.oversized", json!(fits), on(queue)).await;
    assert!(worker.run_once().await.unwrap());
    let snapshot = harness.admin.get_task(at_limit).await.unwrap().unwrap();
    assert_eq!((snapshot.state, snapshot.current_attempt), (TaskState::Succeeded, 1));
}

#[tokio::test]
async fn an_oversized_result_fails_its_attempt_through_the_retry_policy() {
    let Some(harness) = harness("worker_oversized").await else { return };
    run_oversized_results(&harness, "rust-oversized").await;
}

#[tokio::test]
async fn a_fast_oversized_result_fails_its_attempt_through_the_retry_policy() {
    let Some(harness) = harness("fast_oversized").await else { return };
    harness.make_fast("fast-oversized").await;
    run_oversized_results(&harness, "fast-oversized").await;
}
