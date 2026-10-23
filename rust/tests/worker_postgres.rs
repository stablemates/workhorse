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
    ClaimedTask, Debounce, DebounceSchedule, EnqueueOptions, EnqueueOutcome, EnqueueRequest, Error,
    HandlerContext, HandlerError, Queue, QueueHistory, QueueTier, ScheduleCatchupPolicy,
    ScheduleDefinition, ScheduledTask, TaskState, Throttle, Worker, WorkerOptions, CLEANUP_WINDOW,
    UNWIND_WINDOW,
};

const QUEUE: &str = "rust-worker";
const WAIT: Duration = Duration::from_secs(10);
/// Holds every heartbeat statement until the transaction ends. `heartbeat_many_v2` locks the rows of
/// both tiers with `SKIP LOCKED`, so a row lock only makes a lease busy. Its fast-tier step takes a
/// table lock that conflicts with this one, so the statement waits on the table instead.
const HOLD_HEARTBEATS: &str = "LOCK TABLE workhorse.fast_task_runtime IN EXCLUSIVE MODE";

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
/// is not judged. `returned` is how long after `began` the handler returned. If the handler
/// returned inside the window, it honored cancellation, and only its settlement statement on a
/// loaded database outlived the window (SM-1155). That attempt is not judged either.
fn judged_cooperative_shutdown(
    outcome: &Result<(), Error>,
    stall: Duration,
    returned: Option<Duration>,
    grace: Duration,
) -> bool {
    match outcome {
        Ok(()) => true,
        Err(Error::ShutdownIncomplete { abandoned: 1 }) if stall >= STALL_LIMIT => {
            eprintln!(
                "a {stall:?} runtime stall inside the unwind window abandoned the handler; rerunning"
            );
            false
        }
        Err(Error::ShutdownIncomplete { abandoned: 1 })
            if returned.is_some_and(|returned| returned < grace + UNWIND_WINDOW) =>
        {
            eprintln!(
                "the handler returned {returned:?} after shutdown began, but its settlement \
                 outlived the unwind window; rerunning"
            );
            false
        }
        other => {
            panic!(
                "a handler that honors cancellation stopped with {other:?} ({stall:?} unwind \
                 stall, returned {returned:?} after shutdown began)"
            )
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

/// SM-1028: once the worker abandons a lease, no heartbeat renews it.
///
/// A round already in flight may still land, so the expiry must first hold still for five
/// heartbeat intervals. A lease that keeps renewing never holds still. Recovery runs only after
/// PostgreSQL reports the expiry has passed.
async fn assert_lease_lapses(harness: &Harness, observer: &Client, task: Uuid) {
    assert_renewals_stop(observer, task).await;
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
    recover(harness, observer, task).await;
}

/// Fails unless the lease expiry of `task` holds still for five heartbeat intervals.
async fn assert_renewals_stop(observer: &Client, task: Uuid) {
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
    .expect("a lease kept renewing after its owner abandoned it");
}

/// Runs lease recovery and expects it to take the expired lease of `task`.
async fn recover(harness: &Harness, observer: &Client, task: Uuid) {
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

/// How the handler and the heartbeat round behave after the lease watchdog fires.
#[derive(Clone, Copy, PartialEq)]
enum AfterWatchdog {
    /// The handler ignores its cancellation and never returns.
    KeepsRunning,
    /// Rounds run without a client bound, so the round that the table lock held answers late.
    AnswersLate,
    /// The handler ignores its cancellation, then returns a result.
    ReturnsLate,
}

/// SM-1445: once the lease watchdog abandons an attempt, no later heartbeat round renews its lease.
///
/// A table lock holds every round until the watchdog fires. Then a renewal commits, as a round that
/// the worker abandoned can, so the lease is valid again in PostgreSQL. Only the watchdog can stop
/// the renewals that follow, because the handler ignores its cancellation.
async fn assert_watchdog_stops_renewals(name: &str, after: AfterWatchdog) {
    let Some(harness) = harness(name).await else { return };
    let mut observer = harness.database.connect().await;
    // The run continues, so its own maintenance would recover the lapsed lease before the test.
    let worker = harness.worker(WorkerOptions {
        shared_heartbeats: after == AfterWatchdog::AnswersLate,
        maintenance_interval: Duration::from_secs(3600),
        ..lapsing_options()
    });
    let (starts, mut running_handlers) = mpsc::unbounded_channel();
    let (cancelled, mut reasons) = mpsc::unbounded_channel();
    let (returns, mut returned) = mpsc::unbounded_channel();
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let release = Arc::clone(&gate);
    worker.handle("rust.ignores", move |_: Value, context: HandlerContext| {
        let (starts, cancelled, returns) = (starts.clone(), cancelled.clone(), returns.clone());
        let gate = Arc::clone(&release);
        async move {
            let _ = starts.send(());
            let token = context.cancellation();
            token.cancelled().await;
            let _ = cancelled.send(token.reason());
            gate.acquire().await.unwrap().forget();
            let _ = returns.send(());
            Ok(json!({"late": true}))
        }
    });
    let task = harness
        .enqueue(
            "rust.ignores",
            json!({}),
            EnqueueOptions { max_attempts: 1, ..Default::default() },
        )
        .await;

    let (_stop, mut running) = run(&worker);
    started(&mut running_handlers, &mut running).await;
    let lock = observer.transaction().await.unwrap();
    lock.execute(HOLD_HEARTBEATS, &[]).await.unwrap();
    let reason =
        tokio::time::timeout(WAIT, reasons.recv()).await.expect("the watchdog never fired");
    assert_eq!(reason, Some(Some(CancelReason::LeaseLost)));
    let renewed: std::time::SystemTime = lock
        .query_one(
            "UPDATE workhorse.task_runtime
                SET heartbeat_at = clock_timestamp(),
                    expires_at = clock_timestamp() + interval '1 second'
              WHERE task_id = $1
          RETURNING heartbeat_at",
            &[&task],
        )
        .await
        .unwrap()
        .get(0);
    lock.commit().await.unwrap();

    match after {
        AfterWatchdog::KeepsRunning => {}
        AfterWatchdog::AnswersLate => {
            // The held round renews after the lock, and its accepted answer reaches the worker.
            tokio::time::timeout(WAIT, async {
                loop {
                    let beat: std::time::SystemTime = observer
                        .query_one(
                            "SELECT heartbeat_at FROM workhorse.task_runtime WHERE task_id = $1",
                            &[&task],
                        )
                        .await
                        .unwrap()
                        .get(0);
                    if beat > renewed {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .expect("the held round never renewed the lease");
        }
        AfterWatchdog::ReturnsLate => {
            gate.add_permits(1);
            tokio::time::timeout(WAIT, returned.recv()).await.expect("the handler never returned");
            // The lease is valid, so only the `lease_lost` verdict prevents `complete_v1`.
            tokio::time::sleep(Duration::from_millis(200)).await;
            let row = harness.admin.get_task(task).await.unwrap().expect("task exists");
            assert_eq!(row.state, TaskState::Active, "a late return settled the attempt");
            assert_eq!(row.result, None);
        }
    }

    assert_lease_lapses(&harness, &observer, task).await;
    assert_ne!(harness.state(task).await, TaskState::Succeeded);
    assert!(!running.is_finished(), "the worker run ended while its handler ran");
    running.abort();
}

#[tokio::test]
async fn a_lapsed_watchdog_stops_renewing_while_the_handler_keeps_running() {
    assert_watchdog_stops_renewals("worker_watchdog_running", AfterWatchdog::KeepsRunning).await;
}

#[tokio::test]
async fn a_renewal_answered_after_the_watchdog_does_not_restore_renewals() {
    assert_watchdog_stops_renewals("worker_watchdog_late_answer", AfterWatchdog::AnswersLate).await;
}

#[tokio::test]
async fn a_handler_that_returns_after_the_watchdog_settles_as_lease_lost() {
    assert_watchdog_stops_renewals("worker_watchdog_late_return", AfterWatchdog::ReturnsLate).await;
}

/// SM-1085: dropping `run_once` while its batch member lingers abandons the member too.
///
/// The worker keeps its batch coordinator, so a member left pending would join the next batch on
/// the same worker. Recovery hands the same task back for its next attempt, and the callback must
/// see only that attempt.
///
/// Each run lingers for the full linger, so the lease must outlast it without a renewal. A lease
/// shorter than the linger failed under host load (SM-1155). A stall longer than the lease ended
/// the second attempt with lease loss, and the task stayed active. The test expires the dropped
/// lease itself.
#[tokio::test]
async fn a_dropped_run_once_leaves_no_batch_member_for_the_next_run() {
    let Some(harness) = harness("worker_dropped_batch_member").await else { return };
    let observer = harness.database.connect().await;
    let worker = harness.worker(WorkerOptions {
        concurrency: 2,
        lease_duration: Duration::from_secs(30),
        ..lapsing_options()
    });
    let (called, mut calls) = mpsc::unbounded_channel();
    // The second member never arrives, so the first lingers until its run is dropped.
    let linger = Duration::from_secs(10);
    worker.handle_batch(
        "rust.batch.dropped",
        BatchOptions { max_size: 2, linger },
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
    // The execution joins the batch before its first heartbeat round can run, so a renewal shows
    // that the member lingers. The member joins after the spawn. Thus the abort comes before its
    // linger ends if the claim and the renewal arrive within half the linger.
    tokio::time::timeout(linger / 2, async {
        harness.wait_for(task, TaskState::Active).await;
        let claimed = lease_expiry(&observer, task).await;
        while lease_expiry(&observer, task).await <= claimed {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("no heartbeat round renewed the lingering member's lease within half the linger");
    running.abort();
    assert!(running.await.unwrap_err().is_cancelled());
    assert_renewals_stop(&observer, task).await;
    observer
        .execute(
            "UPDATE workhorse.task_runtime SET expires_at = clock_timestamp() WHERE task_id = $1",
            &[&task],
        )
        .await
        .unwrap();
    recover(&harness, &observer, task).await;

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
    // A wait without a bound fails the test here, not after the CI step timeout.
    let judged = tokio::time::timeout(Duration::from_secs(120), async {
        for _ in 0..STALLED_ATTEMPTS {
            if shutdown_with_a_locked_registry_row(&harness).await {
                return true;
            }
        }
        false
    })
    .await
    .expect("the locked registry test waited without a bound");
    assert!(judged, "a runtime stall pushed every attempt past its unwind window");
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
    let (cancelled, mut cancellation) = oneshot::channel::<tokio::time::Instant>();
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
    // The handler reports its cancellation just before it returns.
    let cancelled_after = cancellation.try_recv().ok().map(|at| at - began);
    let judged = judged_cooperative_shutdown(&outcome, stall, cancelled_after, grace);
    if judged {
        // The stalled refresh spends the whole grace period. One deadline still bounds the
        // handler, so it sees cancellation when grace ends rather than a fresh grace period later.
        let cancelled_after = cancelled_after.expect("the handler never saw cancellation");
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
        // The registry statements that outlived the deadline still wait on the lock. The worker
        // owns them as late statements, and each keeps its connection out of the pool until it
        // ends. So every connection that the pool can still lend answers at once.
        let status = pool.status();
        let free = status.max_size - (status.size - status.available);
        let mut lent = Vec::new();
        for _ in 0..free {
            let connection = tokio::time::timeout(WAIT, pool.get())
                .await
                .expect("the pool could not lend a free connection")
                .unwrap();
            lent.push(connection);
        }
        for connection in &lent {
            tokio::time::timeout(Duration::from_secs(2), connection.query_one("SELECT 1", &[]))
                .await
                .expect("the pool lent a connection still running a late registry statement")
                .unwrap();
        }
        drop(lent);
    }
    lock.rollback().await.unwrap();
    if judged {
        // With the lock gone, the late statements end and return their connections.
        let settled = tokio::time::timeout(WAIT, async {
            while pool.status().available != pool.status().size {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await;
        assert!(settled.is_ok(), "a late registry statement never ended: {:?}", pool.status());
    }
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
    let locked: i64 = lock
        .query_one("SELECT count(*) FROM workhorse.task_runtime WHERE task_id = $1", &[&task])
        .await
        .unwrap()
        .get(0);
    assert_eq!(locked, 1, "the task has no runtime row");
    lock.execute(HOLD_HEARTBEATS, &[]).await.unwrap();
    let observer = harness.database.connect().await;
    let waiting = tokio::time::Instant::now() + interval + Duration::from_secs(5);
    loop {
        let stalled: i64 = observer
            .query_one(
                "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() \
                 AND wait_event_type = 'Lock' AND query LIKE '%heartbeat_many_v2%'",
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

// SM-1442: dropping a connection does not stop its statement, so each round that timed out used to
// leave one more backend waiting on the same lock. PostgreSQL now ends the round's transaction by
// the round's deadline.
#[tokio::test]
async fn a_heartbeat_statement_that_waits_on_a_lock_ends_on_the_server_by_its_deadline() {
    let Some(harness) = harness("worker_heartbeat_bound").await else { return };
    let task = harness.enqueue("rust.bounded", json!({}), EnqueueOptions::default()).await;
    let interval = Duration::from_millis(200);
    let options = WorkerOptions {
        lease_duration: Duration::from_secs(30),
        heartbeat_interval: Some(interval),
        ..options()
    };
    let worker = harness.worker(options);
    let (started, mut running_handlers) = mpsc::unbounded_channel();
    let release = Arc::new(tokio::sync::Notify::new());
    let gate = release.clone();
    worker.handle("rust.bounded", move |_: Value, _| {
        let _ = started.send(());
        let gate = gate.clone();
        async move {
            gate.notified().await;
            Ok::<Value, HandlerError>(json!({}))
        }
    });
    let (stop, running) = run(&worker);
    running_handlers.recv().await.unwrap();

    let mut locker = harness.database.connect().await;
    let lock = locker.transaction().await.unwrap();
    let locked: i64 = lock
        .query_one("SELECT count(*) FROM workhorse.task_runtime WHERE task_id = $1", &[&task])
        .await
        .unwrap()
        .get(0);
    assert_eq!(locked, 1, "the task has no runtime row");
    lock.execute(HOLD_HEARTBEATS, &[]).await.unwrap();
    let observer = harness.database.connect().await;
    let mut samples: Vec<Vec<f64>> = Vec::new();
    let until = tokio::time::Instant::now() + 8 * interval;
    while tokio::time::Instant::now() < until {
        let rows = observer
            .query(
                "SELECT (extract(epoch FROM clock_timestamp() - query_start) * 1000)::float8 \
                 FROM pg_stat_activity WHERE datname = current_database() \
                 AND pid <> pg_backend_pid() AND state = 'active' \
                 AND query LIKE '%workhorse.heartbeat_many_v2%'",
                &[],
            )
            .await
            .unwrap();
        samples.push(rows.iter().map(|row| row.get::<_, f64>(0)).collect());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    lock.commit().await.unwrap();
    release.notify_one();
    harness.wait_for(task, TaskState::Succeeded).await;
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();

    assert!(samples.iter().any(|sample| !sample.is_empty()), "no heartbeat waited on the lock");
    let most = samples.iter().map(Vec::len).max().unwrap_or(0);
    assert!(most <= 1, "{most} heartbeat statements were active at once: {samples:?}");
    // A statement ends by its round's deadline. The slack allows for a slow host, and stays far
    // below the 1.6 s that the lock was held.
    let oldest = samples.iter().flatten().fold(0.0_f64, |oldest, age| oldest.max(*age));
    let limit = 5.0 * interval.as_millis() as f64;
    assert!(oldest < limit, "a heartbeat statement ran for {oldest} ms: {samples:?}");
}

// SM-1444: a round falls due one interval after the previous round started, so one timed-out
// round does not move the next round toward the end of the lease. The lease is 2.3 intervals,
// shorter than the default of 3. The table lock makes the first round end on the server at about 1.4
// intervals. The fixed schedule sends the next round at 2 intervals, inside the lease. A schedule
// that waits one interval after the failed round ends sends it at about 2.4 intervals, after the
// lease.
//
// The lease starts when the claim leaves, so the claim, the start of the handler, and the second
// round must end in 0.3 intervals. The delays of a loaded host are absolute, so the interval is
// 4 s, which gives them 1.2 s. A trace of the TypeScript test ran at a 1-minute load of 46 on 32
// cores. The delay from the claim to the handler was up to 654 ms, and the second round took up to
// 221 ms (SM-1479).
#[tokio::test]
async fn one_timed_out_heartbeat_round_leaves_a_renewal_margin() {
    let Some(harness) = harness("worker_heartbeat_margin").await else { return };
    let task = harness.enqueue("rust.margin", json!({}), EnqueueOptions::default()).await;
    let interval = Duration::from_secs(4);
    let worker = harness.worker(WorkerOptions {
        lease_duration: Duration::from_millis(9200),
        heartbeat_interval: Some(interval),
        ..options()
    });
    let (start, mut running_handlers) = mpsc::unbounded_channel();
    let (reasons, mut reason) = mpsc::unbounded_channel();
    let release = Arc::new(tokio::sync::Notify::new());
    let gate = release.clone();
    worker.handle("rust.margin", move |_: Value, context: HandlerContext| {
        let _ = start.send(());
        let (gate, reasons) = (gate.clone(), reasons.clone());
        async move {
            gate.notified().await;
            let _ = reasons.send(context.cancellation().reason());
            Ok::<Value, HandlerError>(json!({}))
        }
    });
    let (stop, mut running) = run(&worker);
    started(&mut running_handlers, &mut running).await;
    let handler_started = tokio::time::Instant::now();

    let observer = harness.database.connect().await;
    let mut locker = harness.database.connect().await;
    let blocker: i32 = locker.query_one("SELECT pg_backend_pid()", &[]).await.unwrap().get(0);
    let lock = locker.transaction().await.unwrap();
    tokio::time::timeout(WAIT, lock.execute(HOLD_HEARTBEATS, &[]))
        .await
        .expect("the test never got the table lock")
        .unwrap();
    // The first round falls due one interval after the lease registered, just before the handler
    // started. A lock that comes later than half an interval can miss that round.
    let held = handler_started.elapsed();
    assert!(
        held <= interval / 2,
        "precondition not met: the table lock came {held:?} after the handler started"
    );
    // Hold the lock until the first round waits on it and then stops. While the lock is held, the
    // statement stops only when its round times out. Then release the lock before the second round.
    assert!(
        heartbeats_reach(&observer, blocker, true, handler_started + interval * 3 / 2).await,
        "precondition not met: the first round did not wait on the table lock"
    );
    assert!(
        heartbeats_reach(&observer, blocker, false, handler_started + interval * 19 / 10).await,
        "precondition not met: the first round did not time out"
    );
    lock.commit().await.unwrap();
    let released = handler_started.elapsed();
    assert!(
        released <= interval * 19 / 10,
        "precondition not met: the table lock ended {released:?} after the handler started"
    );
    // Run past the end of the lease from the claim, so only a renewal keeps the task.
    tokio::time::sleep_until(handler_started + interval * 26 / 10).await;
    release.notify_one();
    let returned = tokio::time::timeout(WAIT, reason.recv()).await;
    assert_eq!(
        returned.expect("the released handler never returned"),
        Some(None),
        "the handler lost its lease"
    );
    harness.wait_for(task, TaskState::Succeeded).await;
    stop.send(()).unwrap();
    tokio::time::timeout(WAIT, running)
        .await
        .expect("the worker run did not stop")
        .unwrap()
        .unwrap();
}

/// Whether a heartbeat statement waits on the lock of the backend `blocker` (`waits` true), or no
/// statement waits on it (`waits` false). An answer after `deadline` does not count, and a query
/// that has no answer by `deadline` gives `false`.
async fn heartbeats_reach(
    observer: &Client,
    blocker: i32,
    waits: bool,
    deadline: tokio::time::Instant,
) -> bool {
    loop {
        let statement = "SELECT count(*) FROM pg_stat_activity \
                         WHERE $1 = ANY(pg_blocking_pids(pid)) AND query LIKE '%heartbeat_many%'";
        let params: [&(dyn tokio_postgres::types::ToSql + Sync); 1] = [&blocker];
        let answer = tokio::time::timeout_at(deadline, observer.query_one(statement, &params));
        let Ok(row) = answer.await else { return false };
        let waiting: i64 = row.unwrap().get(0);
        if tokio::time::Instant::now() > deadline {
            return false;
        }
        if (waiting > 0) == waits {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// One heartbeat round for `task` under `worker_id`, as the worker sends it, and its status.
async fn heartbeat_status(observer: &Client, worker_id: &str, task: Uuid, lease_ms: u64) -> String {
    let fence: i64 = observer
        .query_one("SELECT fence_token FROM workhorse.task_runtime WHERE task_id = $1", &[&task])
        .await
        .unwrap()
        .get(0);
    let leases = json!([{"taskId": task, "fenceToken": fence.to_string(), "leaseMs": lease_ms}]);
    let params: [&(dyn tokio_postgres::types::ToSql + Sync); 2] = [&worker_id, &leases];
    let round = observer.query_one(
        "SELECT task_id::text AS task_id, status FROM workhorse.heartbeat_many_v2($1::text, $2::jsonb) \
         ORDER BY ordinal",
        &params,
    );
    let row = tokio::time::timeout(WAIT, round).await.expect("the round waited").unwrap();
    assert_eq!(row.get::<_, String>("task_id"), task.to_string());
    row.get("status")
}

// SM-1443: a heartbeat round skips a task row that another transaction holds. It answers `busy`
// while the lock is held, renews nothing, and gives no ownership verdict, so the attempt keeps
// running. Once the holder commits, a round of the worker renews the lease again.
#[tokio::test]
async fn a_heartbeat_round_reports_a_locked_row_as_busy() {
    let Some(harness) = harness("worker_heartbeat_busy").await else { return };
    let task = harness.enqueue("rust.busy", json!({}), EnqueueOptions::default()).await;
    let lease = Duration::from_secs(3);
    let options = WorkerOptions {
        lease_duration: lease,
        heartbeat_interval: Some(Duration::from_millis(200)),
        ..options()
    };
    let worker_id = options.worker_id.clone().unwrap();
    let worker = harness.worker(options);
    let (started, mut running_handlers) = mpsc::unbounded_channel();
    let release = Arc::new(tokio::sync::Notify::new());
    let gate = release.clone();
    worker.handle("rust.busy", move |_: Value, context: HandlerContext| {
        let _ = started.send(());
        let gate = gate.clone();
        async move {
            gate.notified().await;
            Ok::<Value, HandlerError>(json!({"cancelled": context.cancellation().is_cancelled()}))
        }
    });
    let (stop, running) = run(&worker);
    running_handlers.recv().await.unwrap();

    let observer = harness.database.connect().await;
    let mut locker = harness.database.connect().await;
    let lock = locker.transaction().await.unwrap();
    let locked = lock
        .execute("SELECT 1 FROM workhorse.task_runtime WHERE task_id = $1 FOR UPDATE", &[&task])
        .await
        .unwrap();
    assert_eq!(locked, 1, "the task has no runtime row");
    let held = lease_expiry(&observer, task).await;
    // A round that waited on the row lock could not answer before the commit below.
    let lease_ms = lease.as_millis() as u64;
    assert_eq!(heartbeat_status(&observer, &worker_id, task, lease_ms).await, "busy");
    // The worker's own rounds and busy retries renew nothing while the lock is held.
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(lease_expiry(&observer, task).await, held, "a busy round renewed the lease");
    lock.commit().await.unwrap();

    // The worker's own round renews the lease. A call from the test here could answer `busy`,
    // because a worker round can hold the row lock at that time (SM-1472).
    tokio::time::timeout(Duration::from_secs(1), async {
        while lease_expiry(&observer, task).await <= held {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("no heartbeat round renewed the lease after the commit");
    release.notify_one();
    harness.wait_for(task, TaskState::Succeeded).await;
    let result = harness.admin.get_task(task).await.unwrap().unwrap().result;
    assert_eq!(result, Some(json!({"cancelled": false})), "a busy round ended the attempt");
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
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
///
/// Each attempt has its own queue, so a task that an earlier attempt released is not claimed here.
async fn shutdown_releases_a_cooperative_task(harness: &Harness) -> bool {
    let queue = format!("rust-unwind-{}", Uuid::new_v4());
    let task = harness.enqueue("rust.cooperative", json!({}), on(&queue)).await;
    let grace = Duration::from_millis(100);
    let worker = harness.worker(WorkerOptions { shutdown_grace_period: grace, ..serving(&queue) });
    let (started, mut running_handlers) = mpsc::unbounded_channel();
    let (returned, mut returns) = mpsc::unbounded_channel();
    worker.handle("rust.cooperative", move |_: Value, context: HandlerContext| {
        let _ = started.send(context.task().id);
        let returned = returned.clone();
        async move {
            context.cancellation().cancelled().await;
            assert_eq!(context.cancellation().reason(), Some(CancelReason::Shutdown));
            let _ = returned.send(tokio::time::Instant::now());
            Err::<Value, _>(HandlerError::new("stopped"))
        }
    });
    let (stop, running) = run(&worker);
    assert_eq!(running_handlers.recv().await, Some(task));
    let began = tokio::time::Instant::now();
    stop.send(()).unwrap();
    let (outcome, stall) = shutdown_outcome(running, grace, began).await;
    let returned = returns.try_recv().ok().map(|at| at - began);
    if !judged_cooperative_shutdown(&outcome, stall, returned, grace) {
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

/// A `listen_config` whose connection reaches the test database through a proxy that swallows
/// `LISTEN`, so the statement waits for a reply that never comes. The first receiver fires when
/// the proxy swallows `LISTEN`, and the second when the client closes the connection.
async fn stalling_listen(
    harness: &Harness,
) -> (tokio_postgres::Config, oneshot::Receiver<()>, oneshot::Receiver<()>) {
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
    tokio::spawn(async move {
        let (client, _) = proxy.accept().await.unwrap();
        let server = tokio::net::TcpStream::connect(upstream).await.unwrap();
        let (client_reader, mut client_writer) = client.into_split();
        let (mut server_reader, server_writer) = server.into_split();
        tokio::spawn(async move { tokio::io::copy(&mut server_reader, &mut client_writer).await });
        forward_until_query(client_reader, server_writer, b"LISTEN workhorse_tasks", stalled).await;
        let _ = closed.send(());
    });
    (listen, listen_sent, client_closed)
}

#[tokio::test]
async fn shutdown_closes_the_notification_connection_while_listen_stalls() {
    let Some(harness) = harness("worker_stalled_listen").await else { return };
    let (listen, listen_sent, client_closed) = stalling_listen(&harness).await;
    let grace = Duration::from_millis(100);
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
        // The worker sees the cancel request only in a heartbeat status. Below 100 ms, the smallest
        // supported interval, every round under host load can time out.
        heartbeat_interval: Some(Duration::from_millis(100)),
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
        // The worker sees the cancel request only in a heartbeat status. Below 100 ms, the smallest
        // supported interval, every round under host load can time out.
        heartbeat_interval: Some(Duration::from_millis(100)),
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
    // `skip` fires only inside the supported delay of at least 60 seconds, so the missed minute
    // needs `latest`.
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

/// Maintenance writes shared due times and retention cutoffs, so the worker binds the text `now`
/// and PostgreSQL chooses the time. Then `p_now` equals the start time of the call's transaction. A
/// time from the host clock is read before the call is sent, so it is not equal to that start.
#[tokio::test]
async fn a_worker_binds_the_database_clock_to_maintenance() {
    let Some(harness) = harness("worker_maintenance_time").await else { return };
    let observer = harness.database.connect().await;
    observer
        .batch_execute(
            "CREATE TABLE public.maintenance_time_probe(on_database_clock boolean NOT NULL);
             ALTER FUNCTION workhorse.run_maintenance_v1(timestamptz)
               RENAME TO run_maintenance_v1_probed;
             CREATE FUNCTION workhorse.run_maintenance_v1(p_now timestamptz DEFAULT clock_timestamp())
             RETURNS TABLE (
               phase text, rows_affected integer, duration_ms integer, skipped_lock boolean,
               error jsonb
             ) LANGUAGE plpgsql AS $$
             BEGIN
               INSERT INTO public.maintenance_time_probe VALUES (p_now = transaction_timestamp());
               RETURN QUERY SELECT * FROM workhorse.run_maintenance_v1_probed(p_now);
             END $$;",
        )
        .await
        .unwrap();
    assert!(!harness.worker(options()).run_once().await.unwrap());
    let probes: Vec<bool> = observer
        .query("SELECT on_database_clock FROM public.maintenance_time_probe", &[])
        .await
        .unwrap()
        .iter()
        .map(|row| row.get(0))
        .collect();
    assert_eq!(probes, vec![true]);
}

/// The worker records to the global provider with the units and attribute keys of the shared
/// TypeScript catalog and the descriptions of `api/telemetry.txt`.
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
    let mut recorded = BTreeMap::new();
    let mut descriptions = BTreeMap::new();
    for resource in exporter.get_finished_metrics().unwrap() {
        for scope in resource.scope_metrics() {
            for metric in scope.metrics() {
                // Other tests share the global provider, so only this task type counts.
                let keys: std::collections::BTreeSet<String> = metric_points(metric.data())
                    .into_iter()
                    .filter(|point| {
                        point.iter().any(|attribute| {
                            attribute.key.as_str() == "workhorse.task.type"
                                && attribute.value.as_str() == "rust.metered"
                        })
                    })
                    .flatten()
                    .map(|attribute| attribute.key.as_str().to_owned())
                    .collect();
                if !keys.is_empty() {
                    descriptions.insert(metric.name().to_owned(), metric.description().to_owned());
                    recorded.insert(
                        metric.name().to_owned(),
                        json!({ "unit": metric.unit(), "attributes": keys }),
                    );
                }
            }
        }
    }
    let catalog = typescript_worker_metric_catalog();
    let contract = contract_instrument_descriptions();
    for name in [
        "workhorse.tasks.claimed",
        "workhorse.tasks.completed",
        "workhorse.handler.executions",
        "workhorse.handler.duration",
        "workhorse.handler.runtime",
    ] {
        assert!(recorded.contains_key(name), "{name} missing from {recorded:?}");
    }
    for (name, observed) in &recorded {
        assert_eq!(Some(observed), catalog.get(name), "{name} differs from the catalog");
        assert_eq!(descriptions.get(name), contract.get(name), "{name} description");
    }
}

/// The description of each instrument in `api/telemetry.txt`.
#[cfg(feature = "opentelemetry")]
fn contract_instrument_descriptions() -> BTreeMap<String, String> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../api/telemetry.txt");
    let contract = std::fs::read_to_string(path).unwrap();
    let instruments = contract.split("## Instruments").nth(1).unwrap();
    let instruments = instruments.split("## Spans").next().unwrap();
    instruments
        .lines()
        .filter(|line| line.starts_with("workhorse."))
        .map(|line| {
            // A row is the name, the kind, the unit, and the description, split by spaces.
            let mut rest = line;
            let mut fields = Vec::new();
            for _ in 0..3 {
                let (field, tail) = rest.split_once(char::is_whitespace).unwrap();
                fields.push(field);
                rest = tail.trim_start();
            }
            (fields[0].to_owned(), rest.trim_end().to_owned())
        })
        .collect()
}

/// The unit and attribute keys of each worker instrument, as TypeScript records them.
#[cfg(feature = "opentelemetry")]
fn typescript_worker_metric_catalog() -> serde_json::Map<String, Value> {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let output = std::process::Command::new("pnpm")
        .args([
            "exec",
            "tsx",
            "--conditions=workhorse-source",
            "typescript/core/test/worker-telemetry-catalog.ts",
        ])
        .current_dir(root)
        .output()
        .expect("pnpm runs the TypeScript metric catalog");
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    serde_json::from_slice(&output.stdout).unwrap()
}

/// The attributes of each data point in one exported metric.
#[cfg(feature = "opentelemetry")]
fn metric_points(
    data: &opentelemetry_sdk::metrics::data::AggregatedMetrics,
) -> Vec<Vec<opentelemetry::KeyValue>> {
    use opentelemetry_sdk::metrics::data::{AggregatedMetrics, MetricData};

    macro_rules! points {
        ($data:expr) => {
            match $data {
                MetricData::Gauge(gauge) => {
                    gauge.data_points().map(|point| point.attributes().cloned().collect()).collect()
                }
                MetricData::Sum(sum) => {
                    sum.data_points().map(|point| point.attributes().cloned().collect()).collect()
                }
                MetricData::Histogram(histogram) => histogram
                    .data_points()
                    .map(|point| point.attributes().cloned().collect())
                    .collect(),
                MetricData::ExponentialHistogram(histogram) => histogram
                    .data_points()
                    .map(|point| point.attributes().cloned().collect())
                    .collect(),
            }
        };
    }
    match data {
        AggregatedMetrics::F64(data) => points!(data),
        AggregatedMetrics::U64(data) => points!(data),
        AggregatedMetrics::I64(data) => points!(data),
    }
}

/// The pid of a backend other than `observer`'s whose last statement was a heartbeat round. A round
/// ends with the `COMMIT` of its transaction, and no other worker statement sends one.
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
                        AND (query LIKE '%heartbeat_many_v2%' OR query = 'COMMIT')
                        AND pid IS DISTINCT FROM $1
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
    let (start, mut running_handlers) = mpsc::unbounded_channel();
    let gate = Arc::clone(&release);
    worker.handle("rust.held", move |_: Value, context: HandlerContext| {
        let (gate, start) = (Arc::clone(&gate), start.clone());
        async move {
            let _ = start.send(());
            gate.acquire().await.unwrap().forget();
            Ok(json!({"cancelled": context.cancellation().is_cancelled()}))
        }
    });
    let (stop, mut running) = run(&worker);

    let before = harness.enqueue("rust.held", json!({}), EnqueueOptions::default()).await;
    started(&mut running_handlers, &mut running).await;
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
    started(&mut running_handlers, &mut running).await;
    let fresh = heartbeat_backend(&observer, Some(reserved), false).await;
    assert_ne!(fresh, reserved);
    assert!(!running.is_finished(), "the worker run ended after the termination");
    release.add_permits(1);
    harness.wait_for(after, TaskState::Succeeded).await;
    let result = harness.admin.get_task(after).await.unwrap().unwrap().result;
    assert_eq!(result, Some(json!({"cancelled": false})));
    assert!(!running.is_finished(), "the worker run ended before its shutdown");

    stop.send(()).unwrap();
    let stopped = tokio::time::timeout(Duration::from_secs(5), running).await;
    stopped.expect("the worker run did not stop within 5 s").unwrap().unwrap();
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
async fn a_fast_queue_throttles_an_enqueue_and_writes_no_throttled_event() {
    let Some(harness) = harness("fast_throttle").await else { return };
    harness.make_fast("fast-throttle").await;
    let throttle = Throttle { scope: "fast-throttle".into(), ..Throttle::new("digest", 60_000) };
    let throttled = EnqueueOptions { throttle: Some(throttle.clone()), ..on("fast-throttle") };

    let first = harness.queue.enqueue("digest", &json!({"n": 1}), throttled.clone()).await.unwrap();
    assert_eq!(first.outcome, EnqueueOutcome::Accepted);
    assert_eq!(harness.runtime_rows("fast-throttle").await, 1);
    let second = harness.queue.enqueue("digest", &json!({"n": 1}), throttled).await.unwrap();
    assert_eq!(second.outcome, EnqueueOutcome::Coalesced);
    assert_eq!(second.task_id, first.task_id);
    let events: i64 = harness
        .database
        .connect()
        .await
        .query_one(
            "SELECT count(*) FROM workhorse.task_event WHERE task_id = $1",
            &[&first.task_id],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(events, 0);

    // A member that runs alone reports a fast-tier rejection with its ordinal in the batch.
    let keyed = EnqueueOptions {
        concurrency_key: Some("tenant-a".into()),
        throttle: Some(Throttle { key: "keyed".into(), ..throttle }),
        ..on("fast-throttle")
    };
    let requests = vec![
        EnqueueRequest { options: on("fast-throttle"), ..EnqueueRequest::new("plain", json!({})) },
        EnqueueRequest { options: keyed, ..EnqueueRequest::new("keyed", json!({})) },
    ];
    let error = harness.queue.enqueue_many(requests).await.unwrap_err();
    assert!(
        matches!(&error, Error::FastTierUnsupported { queue, feature, ordinal: Some(2) }
            if queue == "fast-throttle" && feature == "concurrency keys"),
        "{error:?}"
    );
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
    // worker abandons them. The test then expires their leases as if the process had died. The
    // lease is long, so a host stall cannot lapse a lease before the abandonment and rerun a task
    // that completed (SM-1155).
    let started = Arc::new(AtomicUsize::new(0));
    let (record, count) = (Arc::clone(&effects), Arc::clone(&started));
    let crashing = harness.worker(WorkerOptions {
        concurrency,
        lease_duration: Duration::from_secs(30),
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
    // The run has abandoned its heartbeats, and a round answers `stale` for an expired lease, so
    // no late round renews these leases again.
    let observer = harness.database.connect().await;
    let expired = observer
        .execute(
            "UPDATE workhorse.fast_task_runtime SET expires_at = clock_timestamp()
              WHERE queue_name = $1 AND state = 'active'",
            &[&"fast-abandon"],
        )
        .await
        .unwrap();
    assert_eq!(expired, concurrency as u64, "every hung handler holds one lease");
    observer
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

// SM-1572: all workers on one pool identity share one heartbeat connection from the pool and one
// listener connection outside it (ADR 0071, amendment of 2026-10-21).
//
// These tests use two runtime threads: the drop of the scratch database blocks one thread, and the
// other still ends the connections of the workers, also after a failed assertion.

/// A pool of `size` connections whose sessions carry `application`, so the tests can find them.
fn named_pool(harness: &Harness, size: usize, application: &str) -> deadpool_postgres::Pool {
    let mut config: tokio_postgres::Config = harness.database.url().parse().unwrap();
    config.application_name(application);
    let manager = deadpool_postgres::Manager::new(config, NoTls);
    deadpool_postgres::Pool::builder(manager).max_size(size).build().unwrap()
}

/// Waits until `pool` lends out exactly one connection: the shared heartbeat connection. A short
/// statement can borrow another one for a moment, so the test waits for the moment between.
async fn one_reserved_connection(pool: &deadpool_postgres::Pool, what: &str) {
    let lent = || {
        let status = pool.status();
        status.size - status.available
    };
    let reached = tokio::time::timeout(WAIT, async {
        while lent() != 1 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await;
    assert!(reached.is_ok(), "{what}: the pool still lends out {} connections", lent());
}

/// Registers `rust.held` on `worker`. Each handler reports its start on `started`, then waits until
/// `release` turns true.
fn hold_until_released(
    worker: &Worker,
    started: &mpsc::UnboundedSender<()>,
    release: &tokio::sync::watch::Receiver<bool>,
) {
    let (started, release) = (started.clone(), release.clone());
    worker.handle("rust.held", move |_: Value, _| {
        let (started, mut release) = (started.clone(), release.clone());
        async move {
            let _ = started.send(());
            let _ = release.wait_for(|released| *released).await;
            Ok(Value::Null)
        }
    });
}

/// A running worker: the sender that starts its shutdown, and its run.
type Running = (oneshot::Sender<()>, tokio::task::JoinHandle<Result<(), Error>>);

/// Stops every run at once and waits for each within the shutdown bound of `grace`.
async fn stop_all(runs: Vec<Running>, grace: Duration) {
    let began = tokio::time::Instant::now();
    let mut running = Vec::new();
    for (stop, run) in runs {
        stop.send(()).unwrap();
        running.push(run);
    }
    for run in running {
        let (outcome, _) = shutdown_outcome(run, grace, began).await;
        outcome.unwrap();
    }
}

/// `workers` workers on clones of one pool of 20, each with concurrency 1, claim one task each,
/// hold it while only the shared heartbeat connection stays out of the pool, and complete it.
///
/// Before SM-1572, each worker held its own heartbeat connection, so the reserved connections grew
/// with the workers. With more workers than pooled connections, no claim started, and the run did
/// not stop.
async fn workers_on_a_pool_of_20_claim_and_complete(name: &str, workers: usize) {
    let Some(harness) = harness(name).await else { return };
    let pool = named_pool(&harness, 20, name);
    let grace = Duration::from_secs(1);
    let (started, mut handlers) = mpsc::unbounded_channel();
    let (release, released) = tokio::sync::watch::channel(false);
    let mut runs = Vec::new();
    for _ in 0..workers {
        let worker = Worker::new(
            pool.clone(),
            WorkerOptions {
                maintenance_interval: Duration::from_secs(60),
                disable_registry: true,
                shutdown_grace_period: grace,
                ..options()
            },
        )
        .unwrap();
        hold_until_released(&worker, &started, &released);
        runs.push(run(&worker));
    }
    let mut tasks = Vec::new();
    for _ in 0..workers {
        tasks.push(harness.enqueue("rust.held", json!({}), EnqueueOptions::default()).await);
    }
    let mut running = 0;
    let all_started = tokio::time::timeout(Duration::from_secs(60), async {
        while running < workers {
            handlers.recv().await.unwrap();
            running += 1;
        }
    })
    .await;
    assert!(all_started.is_ok(), "only {running} of {workers} workers claimed a task");
    // Every slot is full, so no worker claims, and only the heartbeat connection stays out.
    one_reserved_connection(&pool, "the workers did not share one heartbeat connection").await;
    release.send_replace(true);
    for task in tasks {
        harness.wait_for(task, TaskState::Succeeded).await;
    }
    stop_all(runs, grace).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sixteen_workers_on_a_pool_of_20_claim_and_complete() {
    workers_on_a_pool_of_20_claim_and_complete("worker_sixteen_on_twenty", 16).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sixty_four_workers_on_a_pool_of_20_claim_and_complete() {
    workers_on_a_pool_of_20_claim_and_complete("worker_sixty_four_on_twenty", 64).await;
}

/// The listener backends and the heartbeat backends whose application name starts with `prefix`,
/// in one snapshot. A listener backend last ran `LISTEN`. A heartbeat backend runs a round or last
/// ended one, and a round ends with `COMMIT` or `ROLLBACK`. No other statement of these workers
/// ends that way.
async fn shared_backends(observer: &Client, prefix: &str) -> (usize, usize) {
    let rows = observer
        .query(
            "SELECT query FROM pg_stat_activity WHERE starts_with(application_name, $1)",
            &[&prefix],
        )
        .await
        .unwrap();
    let queries: Vec<String> = rows.iter().map(|row| row.get(0)).collect();
    let listeners = queries.iter().filter(|query| query.starts_with("LISTEN")).count();
    let heartbeats = queries
        .iter()
        .filter(|query| {
            query.contains("heartbeat_many_v")
                || query.contains("idle_in_transaction_session_timeout")
                || *query == "COMMIT"
                || *query == "ROLLBACK"
        })
        .count();
    (listeners, heartbeats)
}

/// The latest accepted renewal of each task in `tasks`.
async fn renewals(observer: &Client, tasks: &[Uuid]) -> Vec<std::time::SystemTime> {
    let rows = observer
        .query(
            "SELECT heartbeat_at FROM workhorse.task_runtime WHERE task_id = ANY($1) ORDER BY task_id",
            &[&tasks],
        )
        .await
        .unwrap();
    rows.iter().map(|row| row.get(0)).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_workers_share_one_heartbeat_connection_and_one_listener_connection() {
    let Some(harness) = harness("worker_shared_connections").await else { return };
    let observer = harness.database.connect().await;
    let prefix = format!("wh-shared-{}", &Uuid::new_v4().simple().to_string()[..8]);
    let pool = named_pool(&harness, 6, &format!("{prefix}-pool"));
    let mut listen: tokio_postgres::Config = harness.database.url().parse().unwrap();
    listen.application_name(format!("{prefix}-listen"));
    let grace = Duration::from_secs(1);
    let (started, mut handlers) = mpsc::unbounded_channel();
    let (release, released) = tokio::sync::watch::channel(false);
    let mut runs = Vec::new();
    for _ in 0..2 {
        let worker = Worker::new(
            pool.clone(),
            WorkerOptions {
                polling_only: false,
                listen_config: Some(listen.clone()),
                poll_interval: Some(Duration::from_secs(60)),
                lease_duration: Duration::from_millis(2_000),
                heartbeat_interval: Some(Duration::from_millis(500)),
                maintenance_interval: Duration::from_secs(60),
                disable_registry: true,
                shutdown_grace_period: grace,
                ..options()
            },
        )
        .unwrap();
        hold_until_released(&worker, &started, &released);
        runs.push(run(&worker));
    }
    // Once the listener runs LISTEN, a new task wakes the idle workers, and each claims one.
    let listening = tokio::time::timeout(WAIT, async {
        while shared_backends(&observer, &prefix).await.0 == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await;
    assert!(listening.is_ok(), "the listener never ran LISTEN");
    let mut tasks = vec![
        harness.enqueue("rust.held", json!({}), EnqueueOptions::default()).await,
        harness.enqueue("rust.held", json!({}), EnqueueOptions::default()).await,
    ];
    tasks.sort();
    for _ in 0..2 {
        tokio::time::timeout(WAIT, handlers.recv()).await.expect("a worker never claimed").unwrap();
    }
    // After the rounds of both workers renewed their leases, each worker has used the heartbeat
    // connection. Before SM-1572, each had its own, and both stayed open.
    let claimed = renewals(&observer, &tasks).await;
    let renewed = tokio::time::timeout(WAIT, async {
        loop {
            let latest = renewals(&observer, &tasks).await;
            if latest.iter().zip(&claimed).all(|(latest, claimed)| latest > claimed) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await;
    assert!(renewed.is_ok(), "a lease was never renewed");
    one_reserved_connection(&pool, "the pool lent out more than the heartbeat").await;
    let mut backends = (0, 0);
    let shared = tokio::time::timeout(WAIT, async {
        loop {
            backends = shared_backends(&observer, &prefix).await;
            if backends == (1, 1) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await;
    assert!(shared.is_ok(), "listener and heartbeat backends: {backends:?}");
    release.send_replace(true);
    for task in tasks {
        harness.wait_for(task, TaskState::Succeeded).await;
    }
    stop_all(runs, grace).await;
}

// SM-1572: the listener is best effort. A LISTEN that never answers uses none of the startup
// budget: the worker starts, polls, and runs a task.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stalled_listen_leaves_startup_alone_and_the_worker_polls() {
    let Some(harness) = harness("worker_stalled_listen_startup").await else { return };
    let (listen, listen_sent, _client_closed) = stalling_listen(&harness).await;
    let grace = Duration::from_millis(500);
    let worker = harness.worker(WorkerOptions {
        polling_only: false,
        listen_config: Some(listen),
        poll_interval: Some(Duration::from_millis(50)),
        shutdown_grace_period: grace,
        ..options()
    });
    worker.handle("rust.polled", |_: Value, _| async { Ok(Value::Null) });
    let (stop, running) = run(&worker);
    tokio::time::timeout(WAIT, listen_sent).await.expect("the listener never sent LISTEN").unwrap();
    // The listener waits for an answer to LISTEN that never comes, so only a poll claims.
    let task = harness.enqueue("rust.polled", json!({}), EnqueueOptions::default()).await;
    harness.wait_for(task, TaskState::Succeeded).await;
    let began = tokio::time::Instant::now();
    stop.send(()).unwrap();
    let (outcome, _) = shutdown_outcome(running, grace, began).await;
    outcome.unwrap();
}

/// Takes `count` connections from `pool`, waiting for each, and holds them until the result drops.
async fn hold(pool: &deadpool_postgres::Pool, count: usize) -> Vec<deadpool_postgres::Object> {
    let mut held = Vec::new();
    for _ in 0..count {
        held.push(pool.get().await.unwrap());
    }
    held
}

/// The startup budget for the options of `full_pool_options`: the 5 s floor.
const STARTUP_BUDGET: Duration = Duration::from_secs(5);

fn full_pool_options() -> WorkerOptions {
    WorkerOptions {
        lease_duration: Duration::from_millis(1_000),
        heartbeat_interval: Some(Duration::from_millis(300)),
        ..options()
    }
}

// Before SM-1572, startup waited without a bound for a connection for the compatibility check.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_worker_on_a_full_pool_refuses_to_start_within_the_startup_budget() {
    let Some(harness) = harness("worker_full_pool_startup").await else { return };
    let pool = harness.pool();
    let _held = hold(&pool, pool.status().max_size).await;
    let worker = Worker::new(pool, full_pool_options()).unwrap();
    let began = tokio::time::Instant::now();
    let error = tokio::time::timeout(STARTUP_BUDGET + WAIT, worker.run(std::future::pending()))
        .await
        .expect("startup outlived its budget")
        .unwrap_err();
    assert!(began.elapsed() >= STARTUP_BUDGET, "the worker gave up early");
    let message = error.to_string();
    assert!(
        message.starts_with(
            "worker could not reserve its heartbeat connection within the startup budget of 5s"
        ) && message.contains("set shared_heartbeats to opt out"),
        "{message}"
    );
}

// A shutdown while startup waits for the heartbeat connection ends the run with `Ok`. If startup
// waited for its budget instead, it would end with its refusal.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_shutdown_during_startup_ends_the_run_at_once() {
    let Some(harness) = harness("worker_full_pool_cancel").await else { return };
    let pool = harness.pool();
    let _held = hold(&pool, pool.status().max_size).await;
    let worker = Worker::new(pool.clone(), full_pool_options()).unwrap();
    let (stop, running) = run(&worker);
    let waiting = tokio::time::timeout(WAIT, async {
        while pool.status().waiting == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await;
    assert!(waiting.is_ok(), "startup never waited for a connection");
    stop.send(()).unwrap();
    let outcome = tokio::time::timeout(WAIT, running).await.expect("the run never ended");
    outcome.unwrap().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stop_with_a_full_pool_finishes_within_the_grace() {
    let Some(harness) = harness("worker_full_pool_stop").await else { return };
    let pool = harness.pool();
    let grace = Duration::from_millis(500);
    let worker =
        Worker::new(pool.clone(), WorkerOptions { shutdown_grace_period: grace, ..options() })
            .unwrap();
    worker.handle("rust.quick", |_: Value, _| async { Ok(Value::Null) });
    let (stop, running) = run(&worker);
    // The worker holds the heartbeat connection once it claims.
    let task = harness.enqueue("rust.quick", json!({}), EnqueueOptions::default()).await;
    harness.wait_for(task, TaskState::Succeeded).await;
    // The test takes every connection but the heartbeat connection. A claim in flight returns its
    // connection, so the checkout waits for it.
    let held = hold(&pool, pool.status().max_size - 1).await;
    assert_eq!(pool.status().available, 0, "the pool still had a connection");
    let began = tokio::time::Instant::now();
    stop.send(()).unwrap();
    let (outcome, _) = shutdown_outcome(running, grace, began).await;
    outcome.unwrap();
    drop(held);
}

/// Whether a statement in this database waits for a lock on `workhorse.worker_registry`. A
/// relation OID is unique only in its database, so another database on the server can have a
/// relation with the same OID.
async fn registry_lock_waits(observer: &Client) -> bool {
    let waiting: i64 = observer
        .query_one(
            "SELECT count(*) FROM pg_locks WHERE NOT granted \
             AND database = (SELECT oid FROM pg_database WHERE datname = current_database()) \
             AND relation = 'workhorse.worker_registry'::regclass",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    waiting > 0
}

/// The `draining` flags of the registry rows of `worker_id`.
async fn registry_draining(observer: &Client, worker_id: &str) -> Vec<bool> {
    observer
        .query("SELECT draining FROM workhorse.worker_registry WHERE worker_id = $1", &[&worker_id])
        .await
        .unwrap()
        .iter()
        .map(|row| row.get(0))
        .collect()
}

/// Runs `worker` until a new task of type `rust.quick` succeeds. The handler execution proves that
/// this run finished its startup, its registration included.
async fn run_until_a_task_succeeds(
    harness: &Harness,
    worker: &Worker,
) -> (oneshot::Sender<()>, tokio::task::JoinHandle<Result<(), Error>>) {
    let running = run(worker);
    let task = harness.enqueue("rust.quick", json!({}), EnqueueOptions::default()).await;
    harness.wait_for(task, TaskState::Succeeded).await;
    running
}

/// The registry rows of `worker_id`.
async fn registry_rows(observer: &Client, worker_id: &str) -> i64 {
    observer
        .query_one(
            "SELECT count(*) FROM workhorse.worker_registry WHERE worker_id = $1",
            &[&worker_id],
        )
        .await
        .unwrap()
        .get(0)
}

// SM-1572 review: a shutdown while the first registration waits for a locked registry ends by
// the stop deadline. The late registration stays owned: the next run waits for it within its
// startup budget and refuses to start while it runs. When it ends, its run deregisters, and the
// next run registers its own row.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_shutdown_during_the_first_registration_ends_and_the_next_run_waits_for_it() {
    let Some(harness) = harness("worker_late_registration").await else { return };
    let observer = harness.database.connect().await;
    let mut locker = harness.database.connect().await;
    let lock = locker.transaction().await.unwrap();
    lock.batch_execute("LOCK TABLE workhorse.worker_registry IN ACCESS EXCLUSIVE MODE")
        .await
        .unwrap();
    let options = full_pool_options();
    let worker_id = options.worker_id.clone().unwrap();
    let worker = harness
        .worker(WorkerOptions { shutdown_grace_period: Duration::from_millis(200), ..options });
    worker.handle("rust.quick", |_: Value, _| async { Ok(Value::Null) });
    let (stop, running) = run(&worker);
    let waiting = tokio::time::timeout(WAIT, async {
        while !registry_lock_waits(&observer).await {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await;
    assert!(waiting.is_ok(), "the first registration never waited for the registry");
    stop.send(()).unwrap();
    // The lock stays held, so only a bounded teardown lets the run end.
    let outcome = tokio::time::timeout(WAIT, running)
        .await
        .expect("shutdown waited for the first registration");
    outcome.unwrap().unwrap();
    let refused = tokio::time::timeout(STARTUP_BUDGET + WAIT, worker.run(std::future::pending()))
        .await
        .expect("the next startup outlived its budget")
        .expect_err("the next run started while the late registration still ran");
    assert!(refused.to_string().contains("of its previous run has not ended"), "{refused}");
    lock.rollback().await.unwrap();
    // The next run waits for the late registration and for its deregistration, then registers. A
    // handler execution proves that it finished its startup, so the row is its own.
    let (stop, running) = run_until_a_task_succeeds(&harness, &worker).await;
    assert_eq!(registry_draining(&observer, &worker_id).await, [false], "the next run has no row");
    stop.send(()).unwrap();
    tokio::time::timeout(WAIT, running).await.expect("the run never ended").unwrap().unwrap();
    assert_eq!(registry_rows(&observer, &worker_id).await, 0, "a registry row outlived the run");
}

/// The advisory lock key that holds a draining registry refresh in the test below.
const DRAINING_REFRESH_HOLD: i64 = 15_721;

/// Installs a trigger that holds each registry write which sets `draining`, until the session that
/// holds `DRAINING_REFRESH_HOLD` releases it. A `BEFORE INSERT` row trigger runs for the proposed
/// row before the conflict check of `register_worker_v1`, so it holds no row lock while it waits.
/// The deregistration deletes the row, which no insert trigger sees, so the trigger never holds it.
async fn hold_draining_refreshes(observer: &Client) {
    observer
        .batch_execute(&format!(
            "CREATE FUNCTION public.hold_draining_refresh() RETURNS trigger LANGUAGE plpgsql AS $$ \
             BEGIN \
               IF NEW.draining THEN PERFORM pg_advisory_xact_lock({DRAINING_REFRESH_HOLD}); END IF; \
               RETURN NEW; \
             END $$; \
             CREATE TRIGGER hold_draining_refresh BEFORE INSERT ON workhorse.worker_registry \
               FOR EACH ROW EXECUTE FUNCTION public.hold_draining_refresh();"
        ))
        .await
        .unwrap();
}

/// Whether a statement in this database waits for the advisory lock `DRAINING_REFRESH_HOLD`. An
/// advisory key is scoped to its database, and a run of this test from another checkout on the same
/// server uses the same key.
async fn draining_refresh_held(observer: &Client) -> bool {
    let waiting: i64 = observer
        .query_one(
            "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND NOT granted \
             AND database = (SELECT oid FROM pg_database WHERE datname = current_database()) \
             AND objid = $1::bigint::oid",
            &[&DRAINING_REFRESH_HOLD],
        )
        .await
        .unwrap()
        .get(0);
    waiting > 0
}

// SM-1572 review rounds 2 and 3: a run dropped while its draining refresh waits hands that refresh
// to its teardown. Only the refresh is held: the deregistration is not blocked by any lock. The
// teardown orders the deregistration after the refresh it owns, so the next run waits for the
// refresh within its startup budget and refuses to start. If teardown did not own the refresh, the
// deregistration would end at once and the next run would start while the old refresh still runs.
// When the refresh ends, its run deregisters, and the next run registers its own row.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_run_dropped_during_its_draining_refresh_keeps_that_refresh_from_the_next_run() {
    let Some(harness) = harness("worker_dropped_drain_refresh").await else { return };
    let observer = harness.database.connect().await;
    hold_draining_refreshes(&observer).await;
    let options = full_pool_options();
    let worker_id = options.worker_id.clone().unwrap();
    let worker = harness.worker(WorkerOptions {
        // No periodic refresh runs, so the only held statement is the draining refresh.
        registry_interval: Duration::from_secs(3_600),
        shutdown_grace_period: Duration::from_secs(60),
        ..options
    });
    worker.handle("rust.quick", |_: Value, _| async { Ok(Value::Null) });
    let (stop, running) = run_until_a_task_succeeds(&harness, &worker).await;
    let holder = harness.database.connect().await;
    holder.execute("SELECT pg_advisory_lock($1)", &[&DRAINING_REFRESH_HOLD]).await.unwrap();
    stop.send(()).unwrap();
    let waiting = tokio::time::timeout(WAIT, async {
        while !draining_refresh_held(&observer).await {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await;
    assert!(waiting.is_ok(), "the draining refresh never reached its hold");
    running.abort();
    assert!(running.await.unwrap_err().is_cancelled());
    // A run that starts claims this task. A run that refuses ends with its refusal.
    let probe = harness.enqueue("rust.quick", json!({}), EnqueueOptions::default()).await;
    let next = worker.run(std::future::pending());
    tokio::pin!(next);
    let refused = tokio::select! {
        outcome = &mut next => outcome.expect_err("the next run ended without an error"),
        () = async {
            while harness.state(probe).await != TaskState::Succeeded {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        } => {
            panic!("the next run started while the draining refresh of the dropped run still ran")
        }
        () = tokio::time::sleep(STARTUP_BUDGET + WAIT) => {
            panic!("the next run neither started nor refused within its startup budget")
        }
    };
    assert!(refused.to_string().contains("of its previous run has not ended"), "{refused}");
    assert!(draining_refresh_held(&observer).await, "the draining refresh ended before the check");
    holder.execute("SELECT pg_advisory_unlock($1)", &[&DRAINING_REFRESH_HOLD]).await.unwrap();
    let (stop, running) = run_until_a_task_succeeds(&harness, &worker).await;
    assert_eq!(
        registry_draining(&observer, &worker_id).await,
        [false],
        "the old draining refresh changed the row of the next run"
    );
    stop.send(()).unwrap();
    tokio::time::timeout(WAIT, running).await.expect("the run never ended").unwrap().unwrap();
    assert_eq!(registry_rows(&observer, &worker_id).await, 0, "a registry row outlived the run");
}

/// PostgreSQL holds the execution timeout 2.5 seconds after the worker's copy, and the lease is two
/// seconds. PostgreSQL answers `not_due` for longer than one lease, so the attempt reaches its
/// database timeout only if renewal continues while the worker asks. A worker that cancelled the
/// handler on its own clock, or stopped renewing, would end the attempt before that timeout. The
/// original timeout of 1.5 seconds gives the handler time to move the database copy first. A
/// maintenance tick could settle the timeout first and turn the next heartbeat into `stale`, so
/// only the worker's own request settles it here.
#[tokio::test]
async fn an_early_expiry_keeps_the_handler_running_and_renewing_until_postgres_confirms_it() {
    let Some(harness) = harness("worker_expiry_not_due").await else { return };
    let task = harness
        .enqueue(
            "rust.expiry-not-due",
            json!({}),
            EnqueueOptions {
                max_attempts: 1,
                execution_timeout_ms: Some(1500),
                ..Default::default()
            },
        )
        .await;
    let worker = harness.worker(WorkerOptions {
        lease_duration: Duration::from_secs(2),
        heartbeat_interval: Some(Duration::from_millis(200)),
        maintenance_interval: Duration::from_secs(3600),
        ..options()
    });
    let (observed, mut observation) = mpsc::unbounded_channel();
    let url = harness.database.url().to_owned();
    worker.handle("rust.expiry-not-due", move |_: Value, context: HandlerContext| {
        let (url, observed) = (url.clone(), observed.clone());
        async move {
            // A failed step sends no observation, so the test fails on its bounded receive.
            let (client, connection) = tokio_postgres::connect(&url, NoTls)
                .await
                .map_err(|error| HandlerError::new(error.to_string()))?;
            tokio::spawn(connection);
            let expiry: chrono::DateTime<chrono::Utc> = client
                .query_one(
                    "UPDATE workhorse.task_runtime
                        SET attempt_timeout_at = attempt_timeout_at + interval '2500 milliseconds'
                      WHERE task_id = $1 RETURNING attempt_timeout_at",
                    &[&context.task().id],
                )
                .await
                .map_err(|error| HandlerError::new(error.to_string()))?
                .get(0);
            context.cancellation().cancelled().await;
            let after: bool = client
                .query_one("SELECT clock_timestamp() >= $1", &[&expiry])
                .await
                .map_err(|error| HandlerError::new(error.to_string()))?
                .get(0);
            let _ = observed.send((context.cancellation().reason(), after));
            Ok::<Value, HandlerError>(Value::Null)
        }
    });
    let bound = Duration::from_secs(30);
    let ran = tokio::time::timeout(bound, worker.run_once()).await;
    assert!(ran.expect("the attempt did not settle within 30 s").unwrap());
    let seen = tokio::time::timeout(bound, observation.recv()).await;
    assert_eq!(seen.ok().flatten(), Some((Some(CancelReason::ExecutionTimeout), true)));
    assert_eq!(harness.state(task).await, TaskState::Failed);
}

/// An `expire_owned` request that a lock holds, while the heartbeats are held too, must not hold the
/// attempt after the lease watchdog ends it. The handler returns at the lost lease, and `run_once`
/// returns without the request's answer.
///
/// The test holds the heartbeats before the claim (SM-1743). A round that reaches PostgreSQL after
/// the 200 ms attempt timeout answers `timeout_exceeded`. The worker then settles the expiry with a
/// new `expire_owned` request, which waits on the test's lock. A test that took the heartbeat lock
/// after the handler started thus failed when a loaded host delayed that lock past the timeout.
#[tokio::test]
async fn a_blocked_expiry_request_does_not_outlive_an_attempt_that_lost_its_lease() {
    let Some(harness) = harness("worker_expiry_blocked").await else { return };
    let setup = harness.database.connect().await;
    setup
        .batch_execute(
            "CREATE OR REPLACE FUNCTION workhorse.expire_owned_v1(
               p_task_id uuid, p_worker_id text, p_fence_token bigint
             ) RETURNS text LANGUAGE plpgsql AS $$
             BEGIN
               PERFORM pg_advisory_xact_lock(1651);
               RETURN 'not_due';
             END;
             $$",
        )
        .await
        .unwrap();
    let mut gate = harness.database.connect().await;
    let gate_pid: i32 = gate.query_one("SELECT pg_backend_pid()", &[]).await.unwrap().get(0);
    let expiry_lock = gate.transaction().await.unwrap();
    tokio::time::timeout(WAIT, expiry_lock.execute("SELECT pg_advisory_xact_lock(1651)", &[]))
        .await
        .expect("the test never got the expiry lock")
        .unwrap();
    let task = harness
        .enqueue(
            "rust.expiry-blocked",
            json!({}),
            EnqueueOptions {
                max_attempts: 1,
                execution_timeout_ms: Some(200),
                ..Default::default()
            },
        )
        .await;
    // No renewal reaches PostgreSQL, so the watchdog ends the attempt one lease after the claim.
    // The lease leaves the expiry request 1.8 s to reach the test's lock first.
    let worker = harness.worker(WorkerOptions {
        lease_duration: Duration::from_secs(2),
        heartbeat_interval: Some(Duration::from_millis(200)),
        maintenance_interval: Duration::from_secs(3600),
        ..options()
    });
    let (start, mut handler_started) = mpsc::unbounded_channel();
    let (reasons, mut reason) = mpsc::unbounded_channel();
    worker.handle("rust.expiry-blocked", move |_: Value, context: HandlerContext| {
        let (start, reasons) = (start.clone(), reasons.clone());
        async move {
            let _ = start.send(());
            context.cancellation().cancelled().await;
            let _ = reasons.send(context.cancellation().reason());
            Ok::<Value, HandlerError>(Value::Null)
        }
    });
    let mut locker = harness.database.connect().await;
    let heartbeat_lock = locker.transaction().await.unwrap();
    tokio::time::timeout(WAIT, heartbeat_lock.execute(HOLD_HEARTBEATS, &[]))
        .await
        .expect("the test never got the table lock")
        .unwrap();
    let mut running = {
        let worker = worker.clone();
        tokio::spawn(async move { worker.run_once().await })
    };
    started(&mut handler_started, &mut running).await;
    let observer = harness.database.connect().await;
    tokio::time::timeout(WAIT, async {
        loop {
            let blocked: bool = observer
                .query_one(
                    "SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                      WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid)))",
                    &[&gate_pid],
                )
                .await
                .unwrap()
                .get(0);
            if blocked {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the expiry request never reached the test's lock");

    let ran = tokio::time::timeout(WAIT, running).await;
    let seen = tokio::time::timeout(WAIT, reason.recv()).await;
    heartbeat_lock.rollback().await.unwrap();
    expiry_lock.rollback().await.unwrap();
    assert!(ran.expect("run_once waited for the blocked expiry request").unwrap().unwrap());
    let seen = seen.expect("the handler never reported why it was cancelled");
    assert_eq!(seen, Some(Some(CancelReason::LeaseLost)));
    assert_eq!(harness.state(task).await, TaskState::Active);
}

/// A handler that returns while an `expire_owned` request is blocked waits for the answer under a
/// live lease. The lease is two seconds and the request waits 2.5 seconds, so the attempt completes
/// only if renewals continue during that wait. The handler returns only after PostgreSQL shows
/// the request waiting on the test's lock, so the request is in flight when the handler returns.
#[tokio::test]
async fn renewals_continue_while_a_returned_handler_waits_for_its_expiry_answer() {
    let Some(harness) = harness("worker_expiry_returned").await else { return };
    let setup = harness.database.connect().await;
    setup
        .batch_execute(
            "CREATE OR REPLACE FUNCTION workhorse.expire_owned_v1(
               p_task_id uuid, p_worker_id text, p_fence_token bigint
             ) RETURNS text LANGUAGE plpgsql AS $$
             BEGIN
               PERFORM pg_advisory_xact_lock(1652);
               RETURN 'not_due';
             END;
             $$",
        )
        .await
        .unwrap();
    let mut gate = harness.database.connect().await;
    let gate_pid: i32 = gate.query_one("SELECT pg_backend_pid()", &[]).await.unwrap().get(0);
    let expiry_lock = gate.transaction().await.unwrap();
    expiry_lock.execute("SELECT pg_advisory_xact_lock(1652)", &[]).await.unwrap();
    let task = harness
        .enqueue(
            "rust.expiry-returned",
            json!({}),
            EnqueueOptions {
                max_attempts: 1,
                execution_timeout_ms: Some(300),
                ..Default::default()
            },
        )
        .await;
    let worker = harness.worker(WorkerOptions {
        lease_duration: Duration::from_secs(2),
        heartbeat_interval: Some(Duration::from_millis(200)),
        maintenance_interval: Duration::from_secs(3600),
        ..options()
    });
    let (returned, mut handler_returned) = mpsc::unbounded_channel();
    let release = Arc::new(tokio::sync::Notify::new());
    let gate_release = release.clone();
    let url = harness.database.url().to_owned();
    worker.handle("rust.expiry-returned", move |_: Value, context: HandlerContext| {
        let (returned, url, release) = (returned.clone(), url.clone(), gate_release.clone());
        async move {
            // PostgreSQL's copy of the timeout moves a minute later, so no heartbeat reports it.
            // The local timer still fires at 300 ms, and its request is blocked at return.
            let (client, connection) = tokio_postgres::connect(&url, NoTls)
                .await
                .map_err(|error| HandlerError::new(error.to_string()))?;
            tokio::spawn(connection);
            client
                .execute(
                    "UPDATE workhorse.task_runtime
                        SET attempt_timeout_at = attempt_timeout_at + interval '1 minute'
                      WHERE task_id = $1",
                    &[&context.task().id],
                )
                .await
                .map_err(|error| HandlerError::new(error.to_string()))?;
            release.notified().await;
            let _ = returned.send(());
            Ok::<Value, HandlerError>(json!({ "done": true }))
        }
    });
    let running = {
        let worker = worker.clone();
        tokio::spawn(async move { worker.run_once().await })
    };
    let observer = harness.database.connect().await;
    tokio::time::timeout(WAIT, async {
        loop {
            let blocked: bool = observer
                .query_one(
                    "SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                      WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid)))",
                    &[&gate_pid],
                )
                .await
                .unwrap()
                .get(0);
            if blocked {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the expiry request never reached the test's lock");
    release.notify_one();
    tokio::time::timeout(WAIT, handler_returned.recv()).await.unwrap().unwrap();
    tokio::time::sleep(Duration::from_millis(2500)).await;
    expiry_lock.rollback().await.unwrap();
    let ran = tokio::time::timeout(WAIT, running).await;
    assert!(ran.expect("run_once did not return after the expiry answer").unwrap().unwrap());
    assert_eq!(harness.state(task).await, TaskState::Succeeded);
}
