//! The worker runtime: claim, execute under a fenced lease, settle, and drain on shutdown.
//!
//! PostgreSQL owns every state transition. The worker supervises handler futures, renews their
//! leases in one batched round, and runs the maintenance and registry loops ADR 0072 describes.
mod batch;
mod completion;
mod database_now;
mod dispatch;
mod execute;
mod handler;
mod heartbeat;
mod notifications;
mod process;
mod shared;

/// The scratch databases of the integration tests, for the unit tests that need PostgreSQL.
#[cfg(test)]
#[path = "../../tests/support/mod.rs"]
mod scratch;

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use chrono::{DateTime, Utc};
use futures_util::FutureExt;
use serde_json::Value;
use tokio::sync::{watch, Notify, OwnedSemaphorePermit, Semaphore};
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::{timeout_at, Instant};
use tokio_util::sync::CancellationToken as StopToken;
use uuid::Uuid;

pub use handler::{
    BatchItem, BatchOptions, BatchResult, CancellationToken, ClaimedTask, HandlerError,
};
pub use process::run_worker_process;

use crate::contracts::ContractSchema;
use crate::fenced_write::fenced_rows;
use crate::queue::{exactly_one, BoundedPool};
use crate::sql_catalogue_generated as sql;
use crate::telemetry::{Attribute, Counter, Histogram, Metrics};
use crate::HandlerContext;
use crate::{Error, Executor, Operation};
use database_now::DatabaseNow;
use handler::ErasedHandler;

const DEFAULT_LEASE: Duration = Duration::from_secs(30);
const MIN_LEASE: Duration = Duration::from_millis(100);
const MAX_LEASE: Duration = Duration::from_secs(24 * 60 * 60);
const MAX_SHUTDOWN_GRACE: Duration = Duration::from_secs(24 * 60 * 60);
const GRACE_RANGE: &str =
    "worker shutdown grace period must be a whole number of milliseconds between 1 and 86400000";
const LISTENING_POLL: Duration = Duration::from_secs(5);
const POLLING_POLL: Duration = Duration::from_millis(250);
const MAX_EMPTY_POLL: Duration = Duration::from_secs(5);
const MAX_NOTIFICATION_DELAY_MS: u128 = 50;
const MAX_CONCURRENCY: usize = 100;
// register_worker_v1 takes each maintenance, routine, and registry interval as a PostgreSQL
// integer, and its check refuses a value below 100 ms. Every SDK accepts this range (ADR 0112).
const MIN_INTERVAL: Duration = Duration::from_millis(100);
const MAX_INTERVAL: Duration = Duration::from_millis(i32::MAX as u64);
const MAX_CATCHUP_LIMIT: i32 = 10_000;
const PROMOTE_LIMIT: i32 = 100;
const RECOVER_LIMIT: i32 = 100;
/// How long a stopped handler may unwind after its cancellation fires at the end of grace.
///
/// Public only so integration tests derive their shutdown bounds from it; not part of the API.
#[doc(hidden)]
pub const UNWIND_WINDOW: Duration = Duration::from_millis(250);
/// How long shutdown waits, past its deadline, for the registry loop and the listener to stop and
/// for the worker to deregister.
///
/// Public only so integration tests derive their shutdown bounds from it; not part of the API.
#[doc(hidden)]
pub const CLEANUP_WINDOW: Duration = Duration::from_secs(1);
/// The heartbeat connection plus one claim and one settlement.
const MIN_DEDICATED_POOL: usize = 3;
/// The startup budget is the larger of the heartbeat interval and this floor (ADR 0071, rule 3).
const STARTUP_FLOOR: Duration = Duration::from_secs(5);
/// A worker statement waits for a pooled connection for the larger of the lease and this floor.
const CHECKOUT_FLOOR: Duration = Duration::from_secs(5);
/// How long a worker claims a queue that rejected a fast claim through `claim_many_v1` before
/// probing it again. A queue can change tier only while it holds no live tasks (ADR 0077).
const TIER_PROBE_INTERVAL: Duration = Duration::from_secs(30);

/// The ownership outcome PostgreSQL reports for a heartbeat, expiration or release.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OwnershipStatus {
    Accepted,
    CancelRequested,
    DeadlineExceeded,
    TimeoutExceeded,
    Stale,
    NotDue,
}

impl OwnershipStatus {
    pub(crate) fn parse(status: Option<&str>) -> Result<Self, Error> {
        let status = status
            .ok_or_else(|| Error::invalid("PostgreSQL returned an invalid ownership result"))?;
        Ok(match status {
            "accepted" => Self::Accepted,
            "cancel_requested" => Self::CancelRequested,
            "deadline_exceeded" => Self::DeadlineExceeded,
            "timeout_exceeded" => Self::TimeoutExceeded,
            "stale" => Self::Stale,
            "not_due" => Self::NotDue,
            other => {
                return Err(Error::UnexpectedStatus {
                    operation: Operation::Heartbeat,
                    status: other.into(),
                })
            }
        })
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::CancelRequested => "cancel_requested",
            Self::DeadlineExceeded => "deadline_exceeded",
            Self::TimeoutExceeded => "timeout_exceeded",
            Self::Stale => "stale",
            Self::NotDue => "not_due",
        }
    }
}

/// Receives a registry write failure; the worker keeps running without it.
///
/// If the hook panics, the worker catches the panic, logs it through `tracing`, and continues. It
/// logs at most one such panic in each minute.
pub type RegistrationErrorHook = Arc<dyn Fn(&Error) + Send + Sync>;
/// Overrides the persisted retry delay for a failed attempt; `None` keeps the task's policy.
///
/// The worker rounds the duration to the nearest millisecond, half up. A duration that rounds above
/// 2147483647 ms makes the failure settlement return [`Error::InvalidArgument`] before `fail_v1`.
/// The worker does not clamp it.
pub type RetryDelay = Arc<dyn Fn(i32, &ClaimedTask) -> Option<Duration> + Send + Sync>;

/// How a worker claims, leases, maintains and drains. `Default` gives the ADR 0072 values.
#[derive(Clone)]
pub struct WorkerOptions {
    /// The queues claimed round-robin. Empty names and duplicates are dropped.
    pub queues: Vec<String>,
    /// Defaults to `{host}-{pid}-{random}`.
    pub worker_id: Option<String>,
    /// Concurrent handler executions, between 1 and 100.
    pub concurrency: usize,
    /// Slot cohorts for fast-tier dispatch, between 1 and `concurrency` (ADR 0076, rules 10 to
    /// 15). One cohort keeps every slot in one group. Defaults to one below concurrency 8, and
    /// otherwise to one per 8 slots between 2 and 8, capped by the pool's spare connections.
    pub cohorts: Option<usize>,
    /// Whole milliseconds between 100ms and 24h.
    pub lease_duration: Duration,
    /// Defaults to the larger of 100ms and a third of the lease. The smallest supported value is
    /// 100ms. The worker accepts a shorter value, but on a loaded host it can renew no lease.
    pub heartbeat_interval: Option<Duration>,
    /// The wait after an empty claim. Defaults to 5s while the notification listener is connected.
    /// Without a connected listener, it defaults to 250ms, which doubles toward 5s after each empty
    /// claim.
    pub poll_interval: Option<Duration>,
    /// The maintenance tick cadence. Defaults to 1s. This interval, `maintenance_routine_interval`,
    /// and `registry_interval` each take whole milliseconds from 100ms through 2147483647ms
    /// (ADR 0112).
    pub maintenance_interval: Duration,
    /// How often this worker offers the slow retention routines. Defaults to 60s.
    pub maintenance_routine_interval: Duration,
    /// The registry refresh cadence. Defaults to 5s. `disable_registry` turns registration off.
    pub registry_interval: Duration,
    /// Skips registration, so operator surfaces neither see nor pause this worker. An unregistered
    /// worker does not shorten the expired-lease scan spacing, which follows the shortest
    /// maintenance interval among live registered workers. While any are live, an expired lease can
    /// wait up to that interval for recovery.
    pub disable_registry: bool,
    /// Schedule namespaces this worker fires during maintenance. Empty fires none.
    pub schedule_namespaces: Vec<String>,
    pub schedule_catchup_limit: i32,
    /// How long shutdown may take before running handlers see their cancellation, counted from the
    /// moment the worker observes shutdown. Draining claims and refreshing the registration spend
    /// from the same period. `Worker::new` accepts whole milliseconds from 1 ms through one day.
    pub shutdown_grace_period: Duration,
    /// Never opens the `LISTEN` connection.
    pub polling_only: bool,
    /// Sends heartbeat rounds through the shared pool instead of a reserved connection. Without
    /// it, all workers on clones of one pool share one reserved heartbeat connection.
    pub shared_heartbeats: bool,
    /// The connection the notification listener opens, outside the pool. Without it the worker
    /// polls. All workers on clones of one pool share one listener, so a worker whose value
    /// differs from that of a running worker on the same pool refuses to start.
    pub listen_config: Option<tokio_postgres::Config>,
    pub on_registration_error: Option<RegistrationErrorHook>,
    pub retry_delay: Option<RetryDelay>,
}

impl Default for WorkerOptions {
    fn default() -> Self {
        Self {
            queues: vec!["default".into()],
            worker_id: None,
            concurrency: 1,
            cohorts: None,
            lease_duration: DEFAULT_LEASE,
            heartbeat_interval: None,
            poll_interval: None,
            maintenance_interval: Duration::from_secs(1),
            maintenance_routine_interval: Duration::from_secs(60),
            registry_interval: Duration::from_secs(5),
            disable_registry: false,
            schedule_namespaces: Vec::new(),
            schedule_catchup_limit: 100,
            shutdown_grace_period: Duration::from_secs(25),
            polling_only: false,
            shared_heartbeats: false,
            listen_config: None,
            on_registration_error: None,
            retry_delay: None,
        }
    }
}

impl std::fmt::Debug for WorkerOptions {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WorkerOptions")
            .field("queues", &self.queues)
            .field("worker_id", &self.worker_id)
            .field("concurrency", &self.concurrency)
            .field("cohorts", &self.cohorts)
            .field("lease_duration", &self.lease_duration)
            .field("heartbeat_interval", &self.heartbeat_interval)
            .field("poll_interval", &self.poll_interval)
            .field("shutdown_grace_period", &self.shutdown_grace_period)
            .finish_non_exhaustive()
    }
}

fn whole_millis(duration: Duration) -> bool {
    duration.subsec_nanos() % 1_000_000 == 0
}

fn valid_interval(interval: Duration) -> bool {
    whole_millis(interval) && (MIN_INTERVAL..=MAX_INTERVAL).contains(&interval)
}

fn millis_i32(duration: Duration) -> i32 {
    i32::try_from(duration.as_millis()).unwrap_or(i32::MAX)
}

fn unique_names(names: &[String]) -> Vec<String> {
    let mut unique: Vec<String> = Vec::with_capacity(names.len());
    for name in names {
        if !name.is_empty() && !unique.contains(name) {
            unique.push(name.clone());
        }
    }
    unique
}

/// A uniform fraction in `[0, 1)`.
fn random_fraction() -> f64 {
    (Uuid::new_v4().as_u128() >> 75) as f64 / (1u64 << 53) as f64
}

fn hostname() -> String {
    #[cfg(unix)]
    {
        let mut buffer = [0u8; 256];
        // SAFETY: gethostname writes at most `buffer.len()` bytes into a buffer this frame owns.
        if unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) } == 0 {
            let end = buffer.iter().position(|byte| *byte == 0).unwrap_or(buffer.len());
            let name = String::from_utf8_lossy(&buffer[..end]).into_owned();
            if !name.is_empty() {
                return name;
            }
        }
    }
    "rust-worker".into()
}

/// Validates options, rejecting what Go's worker rejects with the same messages.
fn validate(
    options: &mut WorkerOptions,
    pool: &deadpool_postgres::Pool,
) -> Result<Duration, Error> {
    let invalid = |message: &str| Err(Error::invalid(message));
    options.queues = unique_names(&options.queues);
    if options.queues.is_empty() {
        return invalid("worker queues must contain at least one non-empty queue name");
    }
    if !(1..=MAX_CONCURRENCY).contains(&options.concurrency) {
        return invalid("worker concurrency must be between 1 and 100");
    }
    if options.cohorts.is_some_and(|cohorts| !(1..=options.concurrency).contains(&cohorts)) {
        return invalid("worker cohorts must be between 1 and concurrency");
    }
    let lease = options.lease_duration;
    if !whole_millis(lease) || !(MIN_LEASE..=MAX_LEASE).contains(&lease) {
        return invalid("worker lease duration must be a whole number of milliseconds between 100ms and 24h0m0s");
    }
    let heartbeat = options
        .heartbeat_interval
        // The default never goes below the smallest supported interval, as in every SDK.
        .unwrap_or_else(|| Duration::from_millis((lease.as_millis() / 3).max(100) as u64));
    if !whole_millis(heartbeat) || heartbeat.is_zero() || heartbeat >= lease {
        return invalid("worker heartbeat interval must be a whole number of milliseconds greater than zero and shorter than the lease duration");
    }
    if !valid_interval(options.maintenance_interval) {
        return invalid(
            "worker maintenance interval must be between 100 and 2147483647 whole milliseconds",
        );
    }
    if !valid_interval(options.maintenance_routine_interval) {
        return invalid(
            "worker maintenance routine interval must be between 100 and 2147483647 whole milliseconds",
        );
    }
    if !valid_interval(options.registry_interval) {
        return invalid(
            "worker registry interval must be between 100 and 2147483647 whole milliseconds",
        );
    }
    if options.schedule_namespaces.iter().any(String::is_empty) {
        return invalid("worker schedule namespaces must contain only non-empty names");
    }
    options.schedule_namespaces = unique_names(&options.schedule_namespaces);
    if !(1..=MAX_CATCHUP_LIMIT).contains(&options.schedule_catchup_limit) {
        return invalid("worker schedule catch-up limit must be between 1 and 10000");
    }
    // The upper limit is the one Ruby, the JVM, and .NET use. It also keeps `Instant::now() +
    // grace` in the run from an overflow.
    let grace = options.shutdown_grace_period;
    if !whole_millis(grace) || grace.is_zero() || grace > MAX_SHUTDOWN_GRACE {
        return invalid(GRACE_RANGE);
    }
    let capacity = pool.status().max_size;
    if capacity < MIN_DEDICATED_POOL && !options.shared_heartbeats {
        return Err(Error::invalid(format!(
            "worker cannot reserve a dedicated heartbeat connection: max pool size is {capacity}; need at least {MIN_DEDICATED_POOL} (set shared_heartbeats to opt out)"
        )));
    }
    Ok(heartbeat)
}

/// The slot cohorts a worker without a `cohorts` option uses (ADR 0076, rule 11). It keeps one
/// pooled connection per cohort after the heartbeat connection takes its own. The notification
/// listener opens a connection outside the pool.
fn default_cohorts(concurrency: usize, spare_connections: usize) -> usize {
    let cohorts = if concurrency < 8 { 1 } else { concurrency.div_ceil(8).clamp(2, 8) };
    cohorts.min(spare_connections).max(1)
}

pub(crate) struct Inner {
    options: WorkerOptions,
    pool: deadpool_postgres::Pool,
    worker_id: String,
    hostname: String,
    heartbeat_interval: Duration,
    poll_interval: Duration,
    listener_expected: bool,
    cohorts: usize,
    heartbeats: heartbeat::Heartbeats,
    metrics: Metrics,
    handlers: RwLock<HashMap<String, ErasedHandler>>,
    run_permit: Arc<Semaphore>,
    instance: Mutex<Uuid>,
    registered: AtomicBool,
    paused: AtomicBool,
    draining: AtomicBool,
    active: AtomicUsize,
    last_routine: Mutex<Option<Instant>>,
    next_queue: AtomicUsize,
    /// Compiled result schemas, keyed by task type and contract version.
    contracts: Mutex<HashMap<(String, String), Arc<ContractSchema>>>,
    /// Queues that rejected a fast claim, with the instant to probe them again.
    full_tier_until: Mutex<HashMap<String, Instant>>,
    /// Queues whose last claim answered on the fast tier.
    fast_tier_queues: Mutex<HashSet<String>>,
    completions: completion::Batcher,
    /// The shared connections of the pool identity, while a run holds them.
    subscription: Mutex<Option<shared::Subscription>>,
    /// The claim gate of the current run.
    run_gate: Mutex<Option<Arc<RunGate>>>,
    /// Registry statements of an ended run that outlived its stop deadline. The next run waits
    /// for them before it registers, so they cannot change that run.
    late: Mutex<Vec<JoinHandle<()>>>,
    /// When the worker last logged a panic of `on_registration_error`.
    registration_reporter: Mutex<ReporterFailures>,
}

/// A reporter callback that always fails logs at most once in this interval.
const REPORTER_FAILURE_REPORT_INTERVAL: Duration = Duration::from_secs(60);

/// When the worker last logged a failure of one reporter callback.
#[derive(Default)]
struct ReporterFailures {
    reported_at: Option<Instant>,
    /// Failures since `reported_at` that the worker did not log.
    suppressed: u64,
}

impl ReporterFailures {
    /// Whether the worker logs this failure, and how many failures it did not log since the last
    /// one it logged.
    fn admit(&mut self, now: Instant) -> Option<u64> {
        if self
            .reported_at
            .is_some_and(|at| now.duration_since(at) < REPORTER_FAILURE_REPORT_INTERVAL)
        {
            self.suppressed += 1;
            return None;
        }
        self.reported_at = Some(now);
        Some(std::mem::take(&mut self.suppressed))
    }
}

/// Calls an application reporter callback so that its panic never reaches the run. A reporter
/// observes the worker. It is not part of the dispatch contract, so its failure must not stop
/// claims or change the result of the run. `tracing` is the diagnostic path, so the worker never
/// calls the failed reporter again for its own failure.
fn call_reporter(name: &str, failures: &Mutex<ReporterFailures>, call: impl FnOnce()) {
    let Err(panic) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(call)) else {
        return;
    };
    let suppressed = lock(failures).admit(Instant::now());
    let message = panic
        .downcast_ref::<&str>()
        .map(|message| (*message).to_owned())
        .or_else(|| panic.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "a panic without a message".to_owned());
    // A panic payload can panic when it drops, and a tracing subscriber can panic too. The
    // diagnostic path must not become a second failure.
    contain(move || drop(panic));
    let Some(suppressed) = suppressed else {
        return;
    };
    contain(|| {
        let detail = if suppressed > 0 {
            format!(" after {suppressed} unreported failures")
        } else {
            String::new()
        };
        tracing::error!(error = %message, "Workhorse worker {name} reporter failed{detail}");
    });
}

/// Runs `step` and discards a panic from it. The payload of that panic can also panic when it
/// drops, so the worker leaks it instead.
fn contain(step: impl FnOnce()) {
    if let Err(payload) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(step)) {
        std::mem::forget(payload);
    }
}

/// The claim gate of one run. It holds the shared heartbeat connection of that run, and it closes
/// for good when the run ends. A statement keeps the gate of the run that started it, so a
/// statement that outlives its run claims nothing, also after a later run opens its own gate.
pub(super) struct RunGate {
    open: AtomicBool,
    heartbeat: Option<Arc<shared::HeartbeatConnection>>,
}

impl RunGate {
    /// Whether a claim can start now.
    fn is_open(&self) -> bool {
        self.open.load(Ordering::SeqCst)
            && self.heartbeat.as_ref().is_none_or(|heartbeat| heartbeat.ready())
    }

    /// A permit for one claim statement, if the gate is open. With the dedicated heartbeat
    /// connection, the permit keeps the reservation valid until the statement ends.
    pub(super) fn permit(&self) -> Option<crate::queue::GatePermit> {
        if !self.open.load(Ordering::SeqCst) {
            return None;
        }
        match &self.heartbeat {
            None => Some(Box::new(())),
            Some(heartbeat) => {
                heartbeat.claim_permit().map(|permit| Box::new(permit) as crate::queue::GatePermit)
            }
        }
    }

    fn close(&self) {
        self.open.store(false, Ordering::SeqCst);
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Releases one active slot when an execution ends, including when shutdown aborts it.
///
/// A fused claim that leases successors hands the slot over to them before the execution ends.
struct ActiveSlot {
    inner: Arc<Inner>,
    ticket: dispatch::Ticket<ClaimedTask>,
    counted: AtomicBool,
}

impl ActiveSlot {
    /// Stops counting this execution as active, because the tasks its completion claimed
    /// now hold its slot.
    fn hand_over(&self) {
        if self.counted.swap(false, Ordering::SeqCst) {
            self.inner.active.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

impl Drop for ActiveSlot {
    fn drop(&mut self) {
        if *self.counted.get_mut() {
            self.inner.active.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

/// What one `run` or `run_once` owns beyond its own future: the run permit, the background loops,
/// the heartbeat loop, the registry row and the subscription to the shared connections.
///
/// Startup and teardown each run as one task on the runtime the scope opened on, so cancelling the
/// run future, even inside [`RunScope::start`] or [`RunScope::close`], cannot skip a step.
/// Teardown waits for a startup still in flight, stops the loops and joins them, deregisters, then
/// releases the connection. The permit goes with the teardown task, so the next run of the same
/// worker starts only after the cleanup ends.
struct RunScope {
    inner: Arc<Inner>,
    runtime: tokio::runtime::Handle,
    permit: Option<OwnedSemaphorePermit>,
    starting: Option<JoinHandle<Result<bool, Error>>>,
    background: StopToken,
    loops: Vec<JoinHandle<()>>,
    /// The registry loop. Teardown never aborts it, because its statement could still change the
    /// registry row after the run ended.
    registry: Option<JoinHandle<()>>,
    /// The draining registry refresh. The scope holds it before the run waits for it, so a dropped
    /// run hands it to teardown.
    refresh: Option<JoinHandle<()>>,
}

impl RunScope {
    fn new(inner: &Arc<Inner>, permit: OwnedSemaphorePermit) -> Self {
        Self {
            inner: Arc::clone(inner),
            runtime: tokio::runtime::Handle::current(),
            permit: Some(permit),
            starting: None,
            background: StopToken::new(),
            loops: Vec::new(),
            registry: None,
            refresh: None,
        }
    }

    /// Starts the worker in a task the scope owns. Returns `Ok(false)` when teardown began first.
    ///
    /// PostgreSQL may still execute an initial registration the dropped run already sent, so
    /// teardown waits for it to answer before it deregisters. Teardown stops the waits of startup,
    /// and the startup budget bounds them, so that wait is short.
    async fn start(&mut self, wake: Option<Arc<Notify>>) -> Result<bool, Error> {
        let (inner, stop) = (Arc::clone(&self.inner), self.background.clone());
        let starting =
            self.starting.insert(self.runtime.spawn(async move { inner.start(stop, wake).await }));
        let started = starting.await;
        self.starting = None;
        // Nothing aborts the startup task, so it ends only by returning or panicking.
        started.unwrap_or_else(|error| std::panic::resume_unwind(error.into_panic()))
    }

    /// Waits for the teardown, which keeps running if this future is dropped.
    ///
    /// With a `cleanup` deadline, every wait of teardown ends by it. Teardown aborts a loop that
    /// outlives it and stops waiting for a heartbeat round in flight, which then releases its
    /// connection itself. A startup, a registry refresh, or a deregistration that outlives it keeps
    /// running as a late statement of the worker, which the next run waits for.
    async fn close(mut self, cleanup: Option<Instant>) {
        if let Some(teardown) = self.teardown(cleanup) {
            let _ = teardown.await;
        }
    }

    fn teardown(&mut self, cleanup: Option<Instant>) -> Option<JoinHandle<()>> {
        let permit = self.permit.take()?;
        self.background.cancel();
        // Every execution has ended or is being dropped, so no renewal is still owed.
        self.inner.abandon_heartbeats();
        // A statement of this run that outlives it claims nothing from here on.
        self.inner.end_run();
        let (inner, starting) = (Arc::clone(&self.inner), self.starting.take());
        let loops = std::mem::take(&mut self.loops);
        let registry = self.registry.take();
        let refresh = self.refresh.take();
        Some(self.runtime.spawn(async move {
            // The startup can still be in its first registration, which teardown cannot stop.
            if let Some(mut starting) = starting {
                if !until(cleanup, &mut starting).await {
                    tracing::warn!(workhorse.worker.id = %inner.worker_id, "the first registration outlived the shutdown cleanup window");
                    inner.own_late(tokio::spawn(async move {
                        let _ = starting.await;
                    }));
                }
            }
            for mut statement in [registry, refresh].into_iter().flatten() {
                if !until(cleanup, &mut statement).await {
                    tracing::warn!(workhorse.worker.id = %inner.worker_id, "a registry refresh outlived the shutdown cleanup window");
                    inner.own_late(statement);
                }
            }
            for running in loops {
                join_until(running, cleanup).await;
            }
            // A round in flight finishes before its connection can go back to the pool, so the
            // loop is never aborted: one that outlives the deadline returns the connection itself
            // when it is the last user.
            if let Some(heartbeats) = inner.heartbeat_loop() {
                match cleanup {
                    Some(cleanup) => drop(timeout_at(cleanup, heartbeats).await),
                    None => drop(heartbeats.await),
                }
            }
            inner.stop(cleanup).await;
            drop(permit);
        }))
    }
}

impl Drop for RunScope {
    /// A dropped run gets one cleanup window too. A registry statement that outlives it stays owned
    /// by the worker, so the next run waits for it within its startup budget, not for the run
    /// permit without a limit.
    fn drop(&mut self) {
        self.teardown(Some(Instant::now() + CLEANUP_WINDOW));
    }
}

/// A worker bound to one pool. Clones share the same handlers and runtime state.
#[derive(Clone)]
pub struct Worker(Arc<Inner>);

impl std::fmt::Debug for Worker {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Worker")
            .field("worker_id", &self.0.worker_id)
            .finish_non_exhaustive()
    }
}

impl Worker {
    /// Validates `options` against the pool; running the worker needs no other setup.
    pub fn new(pool: deadpool_postgres::Pool, mut options: WorkerOptions) -> Result<Self, Error> {
        let heartbeat_interval = validate(&mut options, &pool)?;
        let hostname = hostname();
        let worker_id =
            options.worker_id.clone().filter(|id| !id.is_empty()).unwrap_or_else(|| {
                let suffix = format!("{:016x}", Uuid::new_v4().as_u128() as u64);
                format!("{hostname}-{}-{suffix}", std::process::id())
            });
        let listener_expected =
            !options.polling_only && options.listen_config.is_some() && pool.status().max_size >= 2;
        let poll_interval = options.poll_interval.unwrap_or(if listener_expected {
            LISTENING_POLL
        } else {
            POLLING_POLL
        });
        let spare_connections =
            pool.status().max_size.saturating_sub(usize::from(!options.shared_heartbeats));
        let cohorts = options
            .cohorts
            .unwrap_or_else(|| default_cohorts(options.concurrency, spare_connections));
        Ok(Self(Arc::new(Inner {
            options,
            pool,
            worker_id,
            hostname,
            heartbeat_interval,
            poll_interval,
            listener_expected,
            cohorts,
            heartbeats: heartbeat::Heartbeats::default(),
            metrics: Metrics::new(),
            handlers: RwLock::default(),
            run_permit: Arc::new(Semaphore::new(1)),
            instance: Mutex::new(Uuid::nil()),
            registered: AtomicBool::new(false),
            paused: AtomicBool::new(false),
            draining: AtomicBool::new(false),
            active: AtomicUsize::new(0),
            last_routine: Mutex::new(None),
            next_queue: AtomicUsize::new(0),
            full_tier_until: Mutex::new(HashMap::new()),
            fast_tier_queues: Mutex::default(),
            completions: completion::Batcher::default(),
            contracts: Mutex::default(),
            subscription: Mutex::default(),
            run_gate: Mutex::default(),
            late: Mutex::default(),
            registration_reporter: Mutex::default(),
        })))
    }

    pub fn worker_id(&self) -> &str {
        &self.0.worker_id
    }

    /// Registers the handler for `task_type`, replacing any earlier one.
    ///
    /// A payload that does not decode fails the attempt through the task's retry policy.
    ///
    /// # Panics
    ///
    /// Panics when `task_type` is empty.
    pub fn handle<P, R, F, Fut>(&self, task_type: &str, handler: F) -> &Self
    where
        P: serde::de::DeserializeOwned + Send + 'static,
        R: serde::Serialize + Send + 'static,
        F: Fn(P, HandlerContext) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<R, HandlerError>> + Send + 'static,
    {
        assert!(!task_type.is_empty(), "worker task type must not be empty");
        let handler = Arc::new(handler);
        let erased: ErasedHandler = Arc::new(move |payload: Value, context: HandlerContext| {
            let handler = Arc::clone(&handler);
            async move { handler(handler::decode(payload)?, context).await.and_then(handler::encode) }.boxed()
        });
        self.0
            .handlers
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(task_type.into(), erased);
        self
    }

    /// Claims and executes until `shutdown` resolves, then drains within the grace period.
    ///
    /// Startup has a budget: the larger of the heartbeat interval and 5 s. Within it, the shared
    /// heartbeat connection of the pool must be present, unless `shared_heartbeats` is set, and
    /// one more pooled connection must run the schema compatibility check. Otherwise `run`
    /// returns an error that names the pool, the budget, and the opt-out. A `shutdown` that
    /// resolves during startup ends the run with `Ok`.
    ///
    /// The grace period starts when the worker observes `shutdown`. Claims in flight, the draining
    /// registration refresh, and running handlers all finish within it. Handlers still running
    /// when grace ends see [`crate::CancelReason::Shutdown`] and get a short unwind window. Any
    /// that outlive it are abandoned, their leases expire, and PostgreSQL recovers them; `run` then
    /// returns [`Error::ShutdownIncomplete`]. Stopping the background loops and deregistering wait
    /// at most a short cleanup window past the grace period.
    ///
    /// Dropping the future instead abandons every task it owns at once: renewals stop and the
    /// leases expire. The worker deregisters after the run, and its next run waits for that within
    /// its startup budget. If a registry statement of the dropped run still runs at the end of that
    /// budget, the next run refuses to start.
    pub async fn run<F: Future<Output = ()> + Send>(&self, shutdown: F) -> Result<(), Error> {
        let inner = &self.0;
        tokio::pin!(shutdown);
        let permit = tokio::select! {
            permit = Arc::clone(&inner.run_permit).acquire_owned() => permit.map_err(|_| Error::invalid("worker is closed"))?,
            () = &mut shutdown => return Ok(()),
        };
        let mut scope = RunScope::new(inner, permit);
        let wake = Arc::new(Notify::new());
        // Startup observes the shutdown signal: teardown stops its waits.
        let started = tokio::select! {
            started = scope.start(Some(Arc::clone(&wake))) => started,
            () = &mut shutdown => Ok(false),
        };
        if !matches!(started, Ok(true)) {
            // One cleanup window covers the whole teardown, the release of the shared connections
            // included.
            scope.close(Some(Instant::now() + CLEANUP_WINDOW)).await;
            return started.map(drop);
        }

        let registry_wake = Arc::new(Notify::new());
        let listening = inner.listening();
        let maintenance_stop = scope.background.child_token();
        scope.registry = Some(tokio::spawn(
            Arc::clone(inner).registry_loop(Arc::clone(&registry_wake), scope.background.clone()),
        ));
        // Maintenance goes last, so the drain below can stop it before the other loops.
        scope
            .loops
            .push(tokio::spawn(Arc::clone(inner).maintenance_loop(maintenance_stop.clone())));

        let shutdown_token = StopToken::new();
        let mut executions: JoinSet<Result<(), Error>> = JoinSet::new();
        let mut first_error = None;
        let dispatcher = Arc::new(WorkerDispatch {
            inner: Arc::clone(inner),
            shutdown: shutdown_token.clone(),
            listening,
            readiness: inner.heartbeat_connection().map(|heartbeat| heartbeat.readiness()),
        });
        let deadline = dispatch::dispatch(
            &dispatcher,
            &mut executions,
            shutdown.as_mut(),
            &wake,
            &registry_wake,
            &mut first_error,
            inner.options.shutdown_grace_period,
        )
        .await;

        inner.draining.store(true, Ordering::SeqCst);
        // The scope holds the refresh before the run waits for it, so a dropped run cannot detach it.
        let refresh = scope.refresh.insert(tokio::spawn({
            let inner = Arc::clone(inner);
            async move { inner.refresh_registration().await }
        }));
        if timeout_at(deadline, refresh).await.is_ok() {
            scope.refresh = None;
        } else {
            tracing::warn!(workhorse.worker.id = %inner.worker_id, "draining registration refresh outlived the shutdown grace period");
            if let Some(refresh) = scope.refresh.take() {
                inner.own_late(refresh);
            }
        }
        maintenance_stop.cancel();
        // The handle stays in the scope until it resolves, so a drop here still joins it.
        if let Some(maintenance) = scope.loops.last_mut() {
            let _ = maintenance.await;
            scope.loops.pop();
        }
        drain(&mut executions, deadline, &mut first_error).await;
        if !executions.is_empty() {
            shutdown_token.cancel();
            drain(&mut executions, Instant::now() + UNWIND_WINDOW, &mut first_error).await;
        }
        let abandoned = executions.len();
        if abandoned > 0 {
            inner.abandon_heartbeats();
            executions.abort_all();
            while executions.join_next().await.is_some() {}
        }
        scope.close(Some(deadline.max(Instant::now()) + CLEANUP_WINDOW)).await;
        if abandoned > 0 {
            if let Some(error) = first_error {
                tracing::error!(error = %error, workhorse.worker.id = %inner.worker_id, "task execution failed");
            }
            tracing::warn!(
                workhorse.worker.id = %inner.worker_id,
                workhorse.worker.abandoned = abandoned,
                "Shutdown grace elapsed; abandoned tasks will be recovered after their leases expire"
            );
            return Err(Error::ShutdownIncomplete { abandoned });
        }
        first_error.map_or(Ok(()), Err)
    }

    /// Runs one maintenance pass and at most one task, returning whether a handler ran.
    ///
    /// A claimed task without a registered handler is released and reports `false`. Dropping the
    /// future abandons its task as dropping [`Worker::run`] does.
    pub async fn run_once(&self) -> Result<bool, Error> {
        let inner = &self.0;
        let permit = Arc::clone(&inner.run_permit)
            .acquire_owned()
            .await
            .map_err(|_| Error::invalid("worker is closed"))?;
        let mut scope = RunScope::new(inner, permit);
        let started = scope.start(None).await;
        if !matches!(started, Ok(true)) {
            scope.close(None).await;
            return started;
        }
        let result = async {
            if inner.paused.load(Ordering::SeqCst) {
                return Ok(false);
            }
            inner.run_maintenance().await?;
            let (mut tasks, error) = inner.claim(1, 1).await;
            let Some(task) = tasks.pop() else { return error.map_or(Ok(false), Err) };
            match inner.handler(&task.task_type) {
                Some(handler) => {
                    inner.execute(task, handler, StopToken::new(), None).await.map(|()| true)
                }
                None => inner.release(&task, true).await.map(|_| false),
            }
        }
        .await;
        scope.close(None).await;
        result
    }
}

/// The worker side of the dispatch loop.
struct WorkerDispatch {
    inner: Arc<Inner>,
    shutdown: StopToken,
    listening: Arc<AtomicBool>,
    /// Changes when the shared heartbeat connection comes or goes. `None` with `shared_heartbeats`.
    readiness: Option<watch::Receiver<bool>>,
}

impl dispatch::Dispatch for WorkerDispatch {
    type Task = ClaimedTask;

    fn concurrency(&self) -> usize {
        self.inner.options.concurrency
    }

    fn cohorts(&self) -> usize {
        self.inner.cohorts
    }

    fn queue_count(&self) -> usize {
        self.inner.options.queues.len()
    }

    fn queue_index(&self, task: &ClaimedTask) -> usize {
        self.inner.options.queues.iter().position(|queue| *queue == task.queue).unwrap_or(0)
    }

    fn fairness_interval(&self) -> Duration {
        self.inner.options.poll_interval.unwrap_or(POLLING_POLL)
    }

    fn paused(&self) -> bool {
        self.inner.paused.load(Ordering::SeqCst)
    }

    fn fast_tier_only(&self) -> bool {
        lock(&self.inner.full_tier_until).is_empty()
    }

    fn tiers_known(&self) -> bool {
        self.inner.tiers_known()
    }

    fn listening(&self) -> bool {
        self.listening.load(Ordering::SeqCst)
    }

    fn poll_delay(&self, consecutive_empty: u32, listening: bool) -> Duration {
        self.inner.poll_delay(consecutive_empty, listening)
    }

    fn claims_allowed(&self) -> bool {
        self.inner.claims_allowed()
    }

    fn readiness(&self) -> Option<watch::Receiver<bool>> {
        self.readiness.clone()
    }

    fn claim(
        &self,
        limit: usize,
        fast_limit: usize,
        asked: dispatch::AskedQueues<ClaimedTask>,
    ) -> impl Future<Output = Vec<ClaimedTask>> + Send + 'static {
        let inner = Arc::clone(&self.inner);
        async move {
            let asked = |queue| asked.record(queue);
            let (tasks, error) = inner.claim_asking(limit, fast_limit, &asked).await;
            if let Some(error) = error {
                tracing::warn!(error = %error, workhorse.worker.id = %inner.worker_id, "task claim failed");
            }
            tasks
        }
    }

    fn launch(
        &self,
        executions: &mut JoinSet<Result<(), Error>>,
        task: ClaimedTask,
        ticket: dispatch::Ticket<ClaimedTask>,
    ) -> bool {
        let handler = self.inner.handler(&task.task_type);
        let handled = handler.is_some();
        self.inner.spawn_execution(executions, task, handler, ticket, self.shutdown.clone());
        handled
    }
}

fn record(
    result: Result<Result<(), Error>, tokio::task::JoinError>,
    first_error: &mut Option<Error>,
) {
    let error = match result {
        Ok(Ok(())) => return,
        Ok(Err(error)) => error,
        Err(error) if error.is_panic() => {
            Error::invalid(format!("task execution panicked: {error}"))
        }
        Err(_) => return,
    };
    tracing::warn!(error = %error, "task execution failed");
    first_error.get_or_insert(error);
}

async fn drain(
    executions: &mut JoinSet<Result<(), Error>>,
    deadline: Instant,
    first_error: &mut Option<Error>,
) {
    while let Ok(Some(result)) = timeout_at(deadline, executions.join_next()).await {
        record(result, first_error);
    }
}

/// Waits for `future` until `deadline`, and returns whether it ended in time. Without a deadline,
/// it waits for the end.
pub(super) async fn until<F: Future>(deadline: Option<Instant>, future: F) -> bool {
    match deadline {
        Some(deadline) => timeout_at(deadline, future).await.is_ok(),
        None => {
            future.await;
            true
        }
    }
}

/// Waits for a background loop to stop until `deadline`, then aborts it.
async fn join_until(mut task: tokio::task::JoinHandle<()>, deadline: Option<Instant>) {
    let Some(deadline) = deadline else {
        let _ = task.await;
        return;
    };
    if timeout_at(deadline, &mut task).await.is_err() {
        task.abort();
        let _ = task.await;
    }
}

impl Inner {
    fn handler(&self, task_type: &str) -> Option<ErasedHandler> {
        self.handlers
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(task_type)
            .cloned()
    }

    fn spawn_execution(
        self: &Arc<Self>,
        executions: &mut JoinSet<Result<(), Error>>,
        task: ClaimedTask,
        handler: Option<ErasedHandler>,
        ticket: dispatch::Ticket<ClaimedTask>,
        shutdown: StopToken,
    ) {
        self.active.fetch_add(1, Ordering::SeqCst);
        let slot = ActiveSlot { inner: Arc::clone(self), ticket, counted: AtomicBool::new(true) };
        executions.spawn(async move {
            let inner = Arc::clone(&slot.inner);
            let result = match handler {
                Some(handler) => inner.execute(task, handler, shutdown, Some(&slot)).await,
                None => inner.release(&task, true).await.map(drop),
            };
            drop(slot);
            result
        });
    }

    /// Starts one run, and returns `Ok(false)` when `stop` fires first.
    ///
    /// The run joins the shared connections of its pool identity. Then, within the startup budget
    /// and in this order, the shared heartbeat connection must be present, and one ordinary pooled
    /// connection must run the compatibility check (ADR 0071, rule 3). If either step fails, the
    /// worker refuses to start. Last, the run registers a fresh instance.
    async fn start(&self, stop: StopToken, wake: Option<Arc<Notify>>) -> Result<bool, Error> {
        let budget = self.startup_budget();
        let deadline = Instant::now() + budget;
        let listen = wake.filter(|_| self.listener_expected).and_then(|wake| {
            Some(shared::Listen {
                config: self.options.listen_config.clone()?,
                queues: self.options.queues.clone(),
                wake,
            })
        });
        let request = self.request(deadline, listen);
        let Some(subscription) = shared::subscribe(&self.pool, request, deadline, &stop).await?
        else {
            return Ok(false);
        };
        let heartbeat = subscription.heartbeat().cloned();
        // Teardown releases the subscription, with the stop deadline of the run, also when a later
        // step of startup fails.
        *lock(&self.subscription) = Some(subscription);
        *lock(&self.run_gate) =
            Some(Arc::new(RunGate { open: AtomicBool::new(true), heartbeat: heartbeat.clone() }));
        if !self.ready_within(heartbeat, deadline, budget, &stop).await? {
            return Ok(false);
        }
        if !self.late_settled(deadline, budget, &stop).await? {
            return Ok(false);
        }
        *lock(&self.instance) = Uuid::new_v4();
        self.registered.store(false, Ordering::SeqCst);
        self.draining.store(false, Ordering::SeqCst);
        self.paused.store(false, Ordering::SeqCst);
        self.refresh_registration().await;
        Ok(true)
    }

    fn request(
        &self,
        startup_deadline: Instant,
        listen: Option<shared::Listen>,
    ) -> shared::Request {
        shared::Request {
            dedicated: !self.options.shared_heartbeats,
            interval: self.heartbeat_interval,
            startup_deadline,
            listen,
        }
    }

    /// The startup budget: the larger of the heartbeat interval and 5 s.
    fn startup_budget(&self) -> Duration {
        self.heartbeat_interval.max(STARTUP_FLOOR)
    }

    /// Waits until `deadline` for the shared heartbeat connection, then runs the compatibility
    /// check on one ordinary connection, which goes back to the pool at once.
    async fn ready_within(
        &self,
        heartbeat: Option<Arc<shared::HeartbeatConnection>>,
        deadline: Instant,
        budget: Duration,
        stop: &StopToken,
    ) -> Result<bool, Error> {
        if let Some(heartbeat) = heartbeat {
            tokio::select! {
                () = stop.cancelled() => return Ok(false),
                ready = timeout_at(deadline, heartbeat.wait_ready()) => if ready.is_err() {
                    return Err(self.startup_error("could not reserve its heartbeat connection", budget));
                },
            }
        }
        let checkout = BoundedPool::new(&self.pool, budget);
        let check = crate::compatibility::assert_schema_compatible(&checkout);
        tokio::select! {
            () = stop.cancelled() => Ok(false),
            checked = timeout_at(deadline, check) => match checked {
                Ok(checked) => checked.map(|()| true),
                Err(_) => Err(self.startup_error(
                    "could not run the compatibility check on a pooled connection",
                    budget,
                )),
            },
        }
    }

    /// The refusal of a startup step that did not finish within the startup budget. It names the
    /// pool, the budget, and the opt-out.
    fn startup_error(&self, step: &str, budget: Duration) -> Error {
        let status = self.pool.status();
        let opt_out = if self.options.shared_heartbeats {
            ""
        } else {
            "; the workers on one pool need one heartbeat connection and at least one more connection (set shared_heartbeats to opt out of the heartbeat connection)"
        };
        Error::invalid(format!(
            "worker {step} within the startup budget of {budget:?}: the pool has max size {}, {} connections, {} available, and {} waiting{opt_out}",
            status.max_size, status.size, status.available, status.waiting
        ))
    }

    /// Waits until `deadline` for the late statements of the previous run. Returns `Ok(false)`
    /// when `stop` fires first, and refuses to start if a statement is still running at the end.
    async fn late_settled(
        &self,
        deadline: Instant,
        budget: Duration,
        stop: &StopToken,
    ) -> Result<bool, Error> {
        loop {
            let Some(mut late) = lock(&self.late).pop() else { return Ok(true) };
            let ended = tokio::select! {
                () = stop.cancelled() => None,
                ended = timeout_at(deadline, &mut late) => Some(ended.is_ok()),
            };
            match ended {
                Some(true) => {}
                Some(false) => {
                    lock(&self.late).push(late);
                    return Err(Error::invalid(format!(
                        "worker could not start within the startup budget of {budget:?}: a registry statement of its previous run has not ended"
                    )));
                }
                None => {
                    lock(&self.late).push(late);
                    return Ok(false);
                }
            }
        }
    }

    /// Keeps a registry statement of an ended run, so the next run waits for it.
    fn own_late(&self, statement: JoinHandle<()>) {
        lock(&self.late).push(statement);
    }

    /// Closes the claim gate of the current run for good.
    fn end_run(&self) {
        if let Some(gate) = lock(&self.run_gate).take() {
            gate.close();
        }
    }

    /// The claim gate of the current run, if one runs.
    fn run_gate(&self) -> Option<Arc<RunGate>> {
        lock(&self.run_gate).clone()
    }

    /// Deregisters the worker after the late statements of this run, and leaves the shared
    /// connections. Each wait ends by `deadline`. A deregistration that outlives it keeps running
    /// as a late statement.
    async fn stop(self: &Arc<Self>, deadline: Option<Instant>) {
        let earlier = std::mem::take(&mut *lock(&self.late));
        // The instance of the run that stops. deregister_worker_v2 deletes the row only while it
        // names this instance, so a late deregistration cannot delete the row of a later run.
        let instance = *lock(&self.instance);
        let mut deregister = tokio::spawn({
            let inner = Arc::clone(self);
            async move {
                // A late registration of this run ends first, so the deregistration comes last.
                for statement in earlier {
                    let _ = statement.await;
                }
                if !inner.registered.swap(false, Ordering::SeqCst) {
                    return;
                }
                let statements = inner.statements();
                if let Err(error) =
                    statements.rows(sql::DEREGISTER_WORKER_V2, &[&inner.worker_id, &instance]).await
                {
                    tracing::warn!(error = %error, workhorse.worker.id = %inner.worker_id, "worker deregistration failed");
                }
            }
        });
        if !until(deadline, &mut deregister).await {
            tracing::warn!(workhorse.worker.id = %self.worker_id, "worker deregistration outlived the shutdown cleanup window");
            self.own_late(deregister);
        }
        self.release_subscription(deadline).await;
    }

    /// Leaves the shared connections. The last user closes each one, waiting until `deadline`.
    async fn release_subscription(&self, deadline: Option<Instant>) {
        let subscription = lock(&self.subscription).take();
        if let Some(subscription) = subscription {
            subscription.release(deadline).await;
        }
    }

    /// The shared heartbeat connection of this run. `None` with `shared_heartbeats` or between runs.
    fn heartbeat_connection(&self) -> Option<Arc<shared::HeartbeatConnection>> {
        lock(&self.subscription).as_ref()?.heartbeat().cloned()
    }

    /// Whether the worker may claim a task now. A worker with the dedicated heartbeat connection
    /// claims nothing, ordinary or fused, while its pool identity holds no connection (ADR 0071,
    /// rule 6). No run claims after it ends.
    fn claims_allowed(&self) -> bool {
        self.run_gate().is_some_and(|gate| gate.is_open())
    }

    /// Whether the shared listener of the pool identity is connected.
    fn listening(&self) -> Arc<AtomicBool> {
        let listening = lock(&self.subscription).as_ref().and_then(shared::Subscription::listening);
        if listening.is_none() && !self.options.polling_only && !self.listener_expected {
            tracing::warn!(workhorse.worker.id = %self.worker_id, "PostgreSQL notification listener unavailable; worker is using polling");
        }
        listening.unwrap_or_default()
    }

    /// The pool, with a checkout that waits at most for the larger of the lease and 5 s.
    fn statements(&self) -> BoundedPool<'_> {
        BoundedPool::new(&self.pool, self.statement_checkout())
    }

    /// The longest wait of a checkout for a worker or context statement.
    fn statement_checkout(&self) -> Duration {
        self.options.lease_duration.max(CHECKOUT_FLOOR)
    }

    /// Joins the shared connections and waits for the heartbeat connection, as a run does.
    #[cfg(test)]
    pub(super) async fn reserve_for_test(&self) {
        let deadline = Instant::now() + self.startup_budget();
        let request = self.request(deadline, None);
        let subscription = shared::subscribe(&self.pool, request, deadline, &StopToken::new())
            .await
            .unwrap()
            .unwrap();
        let heartbeat = subscription.heartbeat().cloned();
        *lock(&self.subscription) = Some(subscription);
        *lock(&self.run_gate) =
            Some(Arc::new(RunGate { open: AtomicBool::new(true), heartbeat: heartbeat.clone() }));
        if let Some(heartbeat) = heartbeat {
            heartbeat.wait_ready().await;
        }
    }

    /// The wait after an empty claim. Without a caller interval, the base follows the listener: a
    /// configured listener that is not connected yet, or that reconnects, wakes nobody. So the
    /// worker polls at the polling-only base until a `LISTEN` succeeds.
    fn poll_delay(&self, consecutive_empty: u32, listening: bool) -> Duration {
        let mut delay = self.options.poll_interval.unwrap_or(if listening {
            LISTENING_POLL
        } else {
            POLLING_POLL
        });
        if !listening {
            delay = delay.min(MAX_EMPTY_POLL);
            for _ in 0..consecutive_empty.saturating_sub(1).min(30) {
                if delay >= MAX_EMPTY_POLL / 2 {
                    delay = MAX_EMPTY_POLL;
                    break;
                }
                delay *= 2;
            }
        }
        delay.mul_f64(0.9 + 0.2 * random_fraction()).max(Duration::from_millis(1))
    }

    async fn registry_loop(self: Arc<Self>, wake: Arc<Notify>, stop: StopToken) {
        if self.options.disable_registry {
            return;
        }
        let mut interval = tokio::time::interval(self.options.registry_interval);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        interval.tick().await;
        loop {
            tokio::select! {
                () = stop.cancelled() => return,
                _ = interval.tick() => {}
            }
            let paused = self.paused.load(Ordering::SeqCst);
            self.refresh_registration().await;
            if paused != self.paused.load(Ordering::SeqCst) {
                wake.notify_one();
            }
        }
    }

    /// Writes this instance's registry row and reads back whether an operator paused it.
    async fn refresh_registration(&self) {
        if self.options.disable_registry {
            return;
        }
        match self.register().await {
            Ok(paused) => {
                self.registered.store(true, Ordering::SeqCst);
                self.paused.store(paused, Ordering::SeqCst);
            }
            Err(error) => match &self.options.on_registration_error {
                Some(hook) => {
                    call_reporter("on_registration_error", &self.registration_reporter, || {
                        hook(&error);
                    });
                }
                None => {
                    tracing::warn!(error = %error, workhorse.worker.id = %self.worker_id, "worker registration failed")
                }
            },
        }
    }

    async fn register(&self) -> Result<bool, Error> {
        let options = &self.options;
        let instance = *lock(&self.instance);
        let pid = i32::try_from(std::process::id()).unwrap_or(i32::MAX);
        let concurrency = options.concurrency as i32;
        let lease = millis_i32(options.lease_duration);
        let heartbeat = millis_i32(self.heartbeat_interval);
        let poll = millis_i32(self.poll_interval);
        let maintenance = millis_i32(options.maintenance_interval);
        let routine = millis_i32(options.maintenance_routine_interval);
        let registry = millis_i32(options.registry_interval);
        let active = i32::try_from(self.active.load(Ordering::SeqCst)).unwrap_or(i32::MAX);
        let draining = self.draining.load(Ordering::SeqCst);
        let rows = self
            .statements()
            .rows(
                sql::REGISTER_WORKER_V1,
                &[
                    &self.worker_id,
                    &instance,
                    &self.hostname,
                    &pid,
                    &options.queues,
                    &options.schedule_namespaces,
                    &concurrency,
                    &lease,
                    &heartbeat,
                    &poll,
                    &maintenance,
                    &routine,
                    &registry,
                    &active,
                    &draining,
                    &sql::CLIENT_PROTOCOL_VERSION,
                    &"rust",
                    &env!("CARGO_PKG_VERSION"),
                ],
            )
            .await?;
        let invalid =
            || Error::invalid("PostgreSQL returned an invalid worker registration result");
        let [row] = rows.as_slice() else { return Err(invalid()) };
        row.try_get::<_, Option<bool>>("paused").ok().flatten().ok_or_else(invalid)
    }

    async fn maintenance_loop(self: Arc<Self>, stop: StopToken) {
        let mut interval = tokio::time::interval(self.options.maintenance_interval);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                () = stop.cancelled() => return,
                _ = interval.tick() => {}
            }
            tokio::select! {
                () = stop.cancelled() => return,
                result = self.run_maintenance() => if let Err(error) = result {
                    tracing::warn!(error = %error, workhorse.worker.id = %self.worker_id, "maintenance failed");
                },
            }
        }
    }

    /// Awaits `statement`, one maintenance pass or one claim statement. If it still runs after
    /// `shutdown_grace_period`, this logs `workhorse.worker.statement_slow` once with the measured
    /// wait and keeps waiting. The warning does not change the statement, a drop of the future
    /// drops the timer, and a zero grace starts no timer.
    async fn warn_when_slow<T>(&self, kind: &'static str, statement: impl Future<Output = T>) -> T {
        let budget = self.options.shutdown_grace_period;
        if budget.is_zero() {
            return statement.await;
        }
        let mut statement = std::pin::pin!(statement);
        let started = Instant::now();
        tokio::select! {
            biased;
            output = &mut statement => return output,
            () = tokio::time::sleep(budget) => {}
        }
        let elapsed = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        // A subscriber that panics must not fail the statement.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            tracing::warn!(
                event.name = "workhorse.worker.statement_slow",
                workhorse.worker.id = %self.worker_id,
                workhorse.worker.statement = kind,
                workhorse.worker.elapsed_ms = elapsed,
                "Worker statement is still waiting after the stop budget"
            );
        }));
        statement.await
    }

    /// Runs one maintenance pass, and warns once if it outlives the stop budget.
    async fn run_maintenance(&self) -> Result<(), Error> {
        self.warn_when_slow("maintenance", self.maintenance_pass()).await
    }

    /// Promotes and recovers tasks, fires due schedules, and runs the routine pass when due.
    async fn maintenance_pass(&self) -> Result<(), Error> {
        let rows = self.statements().rows(sql::TICK_V1, &[&PROMOTE_LIMIT, &RECOVER_LIMIT]).await?;
        if rows.is_empty() {
            return Err(Error::invalid("PostgreSQL returned an invalid maintenance result"));
        }
        for row in &rows {
            if row.try_get::<_, Option<bool>>("skipped_lock")?.unwrap_or(false) {
                continue;
            }
            let phase: String = row.try_get::<_, Option<String>>("phase")?.unwrap_or_default();
            if let Some(error) = row.try_get::<_, Option<Value>>("error")? {
                tracing::warn!(workhorse.worker.id = %self.worker_id, "maintenance phase {phase} failed: {error}");
            }
            if phase != "recover" {
                continue;
            }
            let expired = row.try_get::<_, Option<i32>>("expired_leases")?.unwrap_or(0);
            if expired > 0 {
                self.metrics.add(Counter::LeasesExpired, f64::from(expired), &[]);
            }
            let retried = row.try_get::<_, Option<i32>>("retried")?.unwrap_or(0);
            let dimensions =
                row.try_get::<_, Option<Value>>("retry_dimensions")?.unwrap_or(Value::Null);
            for (queue, task_type, count) in recovery_retries(retried, &dimensions) {
                self.metrics.add(
                    Counter::Retried,
                    count as f64,
                    &[
                        ("workhorse.queue.name", Attribute::Text(&queue)),
                        ("workhorse.task.type", Attribute::Text(&task_type)),
                    ],
                );
            }
            let recovered = row.try_get::<_, Option<i32>>("rows_affected")?.unwrap_or(0);
            if recovered > 0 {
                tracing::info!(
                    event.name = "workhorse.leases.recovered",
                    workhorse.worker.id = %self.worker_id,
                    workhorse.leases.recovered = recovered,
                    "Expired leases recovered"
                );
            }
        }
        if !self.options.schedule_namespaces.is_empty() {
            let catchup = self.options.schedule_catchup_limit;
            let interval =
                i64::try_from(self.options.maintenance_interval.as_millis()).unwrap_or(i64::MAX);
            self.statements()
                .rows(
                    sql::FIRE_DUE_SCHEDULES_V2,
                    &[
                        &self.options.schedule_namespaces,
                        &None::<DateTime<Utc>>,
                        &catchup,
                        &interval,
                    ],
                )
                .await?;
        }
        let due = {
            let mut last = lock(&self.last_routine);
            let now = Instant::now();
            let due =
                last.is_none_or(|last| now >= last + self.options.maintenance_routine_interval);
            if due {
                *last = Some(now);
            }
            due
        };
        if due {
            self.statements().rows(sql::RUN_MAINTENANCE_V1, &[&DatabaseNow]).await?;
        }
        Ok(())
    }

    /// Claims up to `limit` tasks round-robin across the queues, and at most `fast_limit` of them
    /// from fast-tier queues (ADR 0076, rule 13).
    ///
    /// Tasks claimed before an error are returned with it, so the caller still owns them.
    async fn claim(&self, limit: usize, fast_limit: usize) -> (Vec<ClaimedTask>, Option<Error>) {
        self.claim_asking(limit, fast_limit, &|_| {}).await
    }

    /// Claims as [`Inner::claim`] does, and calls `asked` with the index of each queue it asks
    /// when it sends that queue's claim (ADR 0076, rule 17).
    async fn claim_asking(
        &self,
        limit: usize,
        fast_limit: usize,
        asked: &(dyn Fn(usize) + Sync),
    ) -> (Vec<ClaimedTask>, Option<Error>) {
        // The claim keeps the gate of the run that started it.
        let Some(gate) = self.run_gate() else { return (Vec::new(), None) };
        let queues = &self.options.queues;
        let mut tasks = Vec::new();
        let lease = millis_i32(self.options.lease_duration);
        for _ in 0..queues.len() {
            let remaining = limit - tasks.len();
            // A claim that the gate closed during returns what it already leased. Each statement
            // also reads the gate again after its checkout.
            if remaining == 0 || !gate.is_open() {
                break;
            }
            let index = self.next_queue.fetch_add(1, Ordering::SeqCst) % queues.len();
            let queue = &queues[index];
            let sent_at = Instant::now();
            asked(index);
            let fast_remaining = fast_limit.saturating_sub(tasks.len());
            let claimed =
                self.claim_queue(&gate, queue, remaining, fast_remaining, lease, sent_at).await;
            let (rows, fast_tier) = match claimed {
                Ok(Some(claimed)) => claimed,
                // The gate closed while the claim waited for its connection. That is no failure.
                Ok(None) => break,
                Err(error) => return (tasks, Some(error)),
            };
            if let Err(error) = self.claimed_tasks(&rows, queue, sent_at, fast_tier, &mut tasks) {
                return (tasks, Some(error));
            }
        }
        (tasks, None)
    }

    /// Converts the claimed rows of one claim statement, and records the claim's metrics.
    fn claimed_tasks(
        &self,
        rows: &[tokio_postgres::Row],
        queue: &str,
        sent_at: Instant,
        fast_tier: bool,
        tasks: &mut Vec<ClaimedTask>,
    ) -> Result<(), Error> {
        let result = if rows.is_empty() { "empty" } else { "claimed" };
        self.metrics.record(
            Histogram::ClaimDuration,
            sent_at.elapsed().as_secs_f64() * 1000.0,
            &[
                ("workhorse.queue.name", Attribute::Text(queue)),
                ("workhorse.claim.result", Attribute::Text(result)),
            ],
        );
        for row in rows {
            let mut task = claimed_task(row, queue, sent_at)?;
            task.fast_tier = fast_tier;
            tracing::debug!(
                event.name = "workhorse.task.claimed",
                workhorse.task.id = %task.id,
                workhorse.task.type = %task.task_type,
                workhorse.queue.name = %queue,
                workhorse.worker.id = %self.worker_id,
                "Task claimed"
            );
            self.metrics.add(
                Counter::Claimed,
                1.0,
                &[
                    ("workhorse.queue.name", Attribute::Text(queue)),
                    ("workhorse.task.type", Attribute::Text(&task.task_type)),
                ],
            );
            tasks.push(task);
        }
        Ok(())
    }

    /// Records which tier answered a claim of `queue` sent at `sent_at`.
    fn record_tier(&self, queue: &str, fast_tier: bool, sent_at: Instant) {
        if fast_tier {
            lock(&self.full_tier_until).remove(queue);
            lock(&self.fast_tier_queues).insert(queue.into());
        } else {
            lock(&self.full_tier_until).insert(queue.into(), sent_at + TIER_PROBE_INTERVAL);
            lock(&self.fast_tier_queues).remove(queue);
        }
    }

    /// Whether every queue answered its last claim on the fast tier.
    fn tiers_known(&self) -> bool {
        let fast = lock(&self.fast_tier_queues);
        self.options.queues.iter().all(|queue| fast.contains(queue))
    }

    /// Claims one queue through the fast-tier path, or through `claim_many_v1` when the queue is
    /// full-tier, and reports which path answered. Returns `None` when the claim gate closed
    /// before a claim statement went out.
    ///
    /// The fast claim is `complete_many_and_claim_v1` with no completions, and claims at most
    /// `fast_limit`. A full-tier queue rejects it, and the worker then claims that queue through
    /// `claim_many_v1` until the next probe.
    async fn claim_queue(
        &self,
        gate: &RunGate,
        queue: &str,
        limit: usize,
        fast_limit: usize,
        lease: i32,
        sent_at: Instant,
    ) -> Result<Option<(Vec<tokio_postgres::Row>, bool)>, Error> {
        let allowed = || gate.permit();
        let probe_due =
            lock(&self.full_tier_until).get(queue).is_none_or(|until| sent_at >= *until);
        if probe_due {
            if fast_limit == 0 {
                return Ok(Some((Vec::new(), true)));
            }
            let fast_limit = limit.min(fast_limit) as i32;
            let gated = self.statements().gated(&allowed);
            let claimed = self
                .warn_when_slow(
                    "claim",
                    fenced_rows(
                        &gated,
                        sql::COMPLETE_MANY_AND_CLAIM_V1,
                        &[
                            &self.worker_id,
                            &Vec::<Uuid>::new(),
                            &Vec::<i64>::new(),
                            &Vec::<Value>::new(),
                            &queue,
                            &fast_limit,
                            &lease,
                        ],
                    ),
                )
                .await
                .map_err(Error::translate_fast_tier);
            if gated.refused() {
                return Ok(None);
            }
            match claimed {
                Ok(rows) => {
                    self.record_tier(queue, true, sent_at);
                    // A claim that finds nothing still returns one row, with every claim column
                    // null.
                    let mut claimed = Vec::with_capacity(rows.len());
                    for row in rows {
                        if row.try_get::<_, Option<Uuid>>("task_id")?.is_some() {
                            claimed.push(row);
                        }
                    }
                    return Ok(Some((claimed, true)));
                }
                Err(Error::FastTierUnsupported { .. }) => self.record_tier(queue, false, sent_at),
                Err(error) => return Err(error),
            }
        }
        let limit = limit as i32;
        let gated = self.statements().gated(&allowed);
        let rows = self
            .warn_when_slow(
                "claim",
                gated.rows(sql::CLAIM_MANY_V1, &[&queue, &self.worker_id, &limit, &lease]),
            )
            .await;
        if gated.refused() {
            return Ok(None);
        }
        Ok(Some((rows?, false)))
    }
}

fn claimed_task(
    row: &tokio_postgres::Row,
    queue: &str,
    claim_sent_at: Instant,
) -> Result<ClaimedTask, Error> {
    let execution_timeout: Option<i64> = row.try_get("execution_timeout_ms")?;
    Ok(ClaimedTask {
        id: row.try_get("task_id")?,
        task_type: row.try_get("task_type")?,
        queue: queue.into(),
        priority: row.try_get("priority")?,
        payload: row.try_get("payload")?,
        contract_version: row.try_get("contract_version")?,
        result_max_bytes: row.try_get("result_max_bytes")?,
        redact_error_details: row
            .try_get::<_, Option<bool>>("redact_error_details")?
            .unwrap_or(false),
        trace_context: row.try_get("trace_context")?,
        attempt: row.try_get("attempt")?,
        max_attempts: row.try_get("max_attempts")?,
        retry_policy: row.try_get::<_, Option<Value>>("retry_policy")?.unwrap_or(Value::Null),
        deadline_at: row.try_get("deadline_at")?,
        execution_timeout: execution_timeout.map(|ms| Duration::from_millis(ms.max(0) as u64)),
        attempt_timeout_at: row.try_get("attempt_timeout_at")?,
        fence_token: row.try_get("fence_token")?,
        lease_expires_at: row.try_get("lease_expires_at")?,
        claim_sent_at,
        fast_tier: false,
    })
}

/// The `workhorse.tasks.retried` additions for one recovery result: one for each entry of
/// `retry_dimensions`, by queue and task type, and `unknown` for both when `retried` is larger than
/// the list. A missing queue or task type is `unknown`. Every SDK counts recovery retries this way.
fn recovery_retries(retried: i32, dimensions: &Value) -> Vec<(String, String, u64)> {
    let listed = dimensions.as_array().map_or(&[][..], Vec::as_slice);
    let text = |dimension: &Value, key: &str| {
        dimension.get(key).and_then(Value::as_str).unwrap_or("unknown").to_owned()
    };
    let mut retries: Vec<_> = listed
        .iter()
        .map(|dimension| (text(dimension, "queue"), text(dimension, "type"), 1))
        .collect();
    let unlisted = u64::try_from(retried).unwrap_or(0).saturating_sub(listed.len() as u64);
    if unlisted > 0 {
        retries.push(("unknown".to_owned(), "unknown".to_owned(), unlisted));
    }
    retries
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pool(max_size: usize) -> deadpool_postgres::Pool {
        let mut config = deadpool_postgres::Config::new();
        config.dbname = Some("unused".into());
        config.pool = Some(deadpool_postgres::PoolConfig::new(max_size));
        config.create_pool(Some(deadpool_postgres::Runtime::Tokio1), tokio_postgres::NoTls).unwrap()
    }

    /// A server that accepts connections and never answers. It reports each connection it accepts.
    pub(in crate::worker) fn silent_server() -> (u16, tokio::sync::mpsc::UnboundedReceiver<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (accepted, receiver) = tokio::sync::mpsc::unbounded_channel();
        std::thread::spawn(move || {
            let mut held = Vec::new();
            for stream in listener.incoming() {
                held.push(stream);
                let _ = accepted.send(());
            }
        });
        (port, receiver)
    }

    /// A pool whose server accepts connections and never answers, so every borrow waits.
    fn silent_pool_on(port: u16) -> deadpool_postgres::Pool {
        let mut config = deadpool_postgres::Config::new();
        config.host = Some("127.0.0.1".into());
        config.port = Some(port);
        config.user = Some("unused".into());
        config.dbname = Some("unused".into());
        config.pool = Some(deadpool_postgres::PoolConfig::new(4));
        config.create_pool(Some(deadpool_postgres::Runtime::Tokio1), tokio_postgres::NoTls).unwrap()
    }

    /// Opens a scope for a registered worker, whose teardown then waits to deregister.
    async fn registered_scope(worker: &Worker) -> RunScope {
        let permit = Arc::clone(&worker.0.run_permit).acquire_owned().await.unwrap();
        worker.0.registered.store(true, Ordering::SeqCst);
        RunScope::new(&worker.0, permit)
    }

    /// A tracing writer that keeps every line in memory.
    #[derive(Clone, Default)]
    struct CapturedLog(Arc<Mutex<Vec<u8>>>);

    impl std::io::Write for CapturedLog {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            lock(&self.0).extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl CapturedLog {
        fn text(&self) -> String {
            String::from_utf8_lossy(&lock(&self.0)).into_owned()
        }
    }

    /// SM-1696: a panic of `on_registration_error` never reaches the worker, and the worker logs
    /// it at most once in each interval.
    #[tokio::test]
    async fn a_panicking_registration_reporter_is_isolated_and_bounded() {
        let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = closed.local_addr().unwrap().port();
        drop(closed);
        let calls = Arc::new(AtomicUsize::new(0));
        let options = WorkerOptions {
            on_registration_error: Some(Arc::new({
                let calls = Arc::clone(&calls);
                move |_: &Error| {
                    calls.fetch_add(1, Ordering::SeqCst);
                    panic!("alert client is offline");
                }
            })),
            ..WorkerOptions::default()
        };
        let worker = Worker::new(silent_pool_on(port), options).unwrap();
        let log = CapturedLog::default();
        let subscriber = tracing_subscriber::fmt()
            .with_writer({
                let log = log.clone();
                move || log.clone()
            })
            .finish();
        let _default = tracing::subscriber::set_default(subscriber);

        for _ in 0..3 {
            worker.0.refresh_registration().await;
        }

        assert_eq!(calls.load(Ordering::SeqCst), 3);
        assert!(!worker.0.registered.load(Ordering::SeqCst));
        let text = log.text();
        assert_eq!(
            text.matches("Workhorse worker on_registration_error reporter failed").count(),
            1,
            "{text}"
        );
        assert!(text.contains("alert client is offline"), "{text}");

        // After the interval, the next report states the failures that the worker did not log.
        lock(&worker.0.registration_reporter).reported_at =
            Instant::now().checked_sub(REPORTER_FAILURE_REPORT_INTERVAL);
        worker.0.refresh_registration().await;
        let text = log.text();
        assert!(text.contains("reporter failed after 2 unreported failures"), "{text}");
    }

    /// A tracing writer that panics on each write.
    struct PanickingWriter;

    impl std::io::Write for PanickingWriter {
        fn write(&mut self, _bytes: &[u8]) -> std::io::Result<usize> {
            panic!("log writer failed");
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// SM-1696: a tracing subscriber that panics while the worker reports a reporter panic does
    /// not reach the worker either.
    #[tokio::test]
    async fn a_panicking_subscriber_does_not_reach_the_worker() {
        let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = closed.local_addr().unwrap().port();
        drop(closed);
        let options = WorkerOptions {
            on_registration_error: Some(Arc::new(|_: &Error| panic!("alert client is offline"))),
            ..WorkerOptions::default()
        };
        let worker = Worker::new(silent_pool_on(port), options).unwrap();
        let subscriber = tracing_subscriber::fmt().with_writer(|| PanickingWriter).finish();
        let _default = tracing::subscriber::set_default(subscriber);

        worker.0.refresh_registration().await;

        assert!(lock(&worker.0.registration_reporter).reported_at.is_some());
    }

    /// A panic payload that panics again when it drops.
    struct PanickingPayload;

    impl Drop for PanickingPayload {
        fn drop(&mut self) {
            panic!("payload drop failed");
        }
    }

    /// SM-1696: a reporter panic whose payload panics when it drops does not reach the worker,
    /// also when the worker does not log the failure.
    #[tokio::test]
    async fn a_panic_payload_that_panics_on_drop_does_not_reach_the_worker() {
        let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = closed.local_addr().unwrap().port();
        drop(closed);
        let options = WorkerOptions {
            on_registration_error: Some(Arc::new(|_: &Error| {
                std::panic::panic_any(PanickingPayload);
            })),
            ..WorkerOptions::default()
        };
        let worker = Worker::new(silent_pool_on(port), options).unwrap();
        let log = CapturedLog::default();
        let subscriber = tracing_subscriber::fmt()
            .with_writer({
                let log = log.clone();
                move || log.clone()
            })
            .finish();
        let _default = tracing::subscriber::set_default(subscriber);

        // The first failure is logged, and the second is not.
        worker.0.refresh_registration().await;
        worker.0.refresh_registration().await;

        let text = log.text();
        assert_eq!(text.matches("reporter failed").count(), 1, "{text}");
        assert!(text.contains("a panic without a message"), "{text}");
        assert_eq!(lock(&worker.0.registration_reporter).suppressed, 1);
    }

    const ACCEPTED: Duration = Duration::from_secs(5);

    /// Whether the next run of `worker` could take the run permit within a short wait.
    async fn next_run_starts(worker: &Worker) -> bool {
        let acquire = worker.0.run_permit.acquire();
        tokio::time::timeout(Duration::from_millis(100), acquire).await.is_ok()
    }

    /// SM-1028: a run dropped while it deregisters keeps that obligation and the run permit.
    #[tokio::test]
    async fn a_cancelled_close_finishes_its_teardown_before_the_next_run() {
        let (port, mut accepted) = silent_server();
        let worker = Worker::new(silent_pool_on(port), WorkerOptions::default()).unwrap();
        let closing = tokio::spawn(registered_scope(&worker).await.close(None));
        // Deregistration is the only step here that connects, so `close` is inside it.
        let deregistering = tokio::time::timeout(ACCEPTED, accepted.recv()).await;
        assert!(deregistering.unwrap().is_some(), "close never began to deregister");
        closing.abort();
        assert!(closing.await.unwrap_err().is_cancelled());
        assert!(
            !next_run_starts(&worker).await,
            "the next run could start before the dropped run deregistered"
        );
    }

    /// SM-1028: a scope dropped where no runtime is current tears down on the one it opened on.
    #[test]
    fn a_scope_dropped_outside_its_runtime_still_tears_down() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let (port, mut accepted) = silent_server();
        let (worker, scope) = runtime.block_on(async {
            let worker = Worker::new(silent_pool_on(port), WorkerOptions::default()).unwrap();
            let scope = registered_scope(&worker).await;
            (worker, scope)
        });
        drop(scope);
        runtime.block_on(async {
            let deregistering = tokio::time::timeout(ACCEPTED, accepted.recv()).await;
            assert!(deregistering.unwrap().is_some(), "the dropped scope never deregistered");
            assert!(
                !next_run_starts(&worker).await,
                "the dropped scope released its permit before it deregistered"
            );
        });
    }

    /// SM-1028: the connection a heartbeat round is waiting on returns to the pool before the run ends.
    #[tokio::test]
    async fn teardown_waits_for_the_heartbeat_round_in_flight() {
        let options = WorkerOptions {
            shared_heartbeats: true,
            heartbeat_interval: Some(Duration::from_millis(10)),
            ..Default::default()
        };
        let (port, mut accepted) = silent_server();
        let worker = Worker::new(silent_pool_on(port), options).unwrap();
        let permit = Arc::clone(&worker.0.run_permit).acquire_owned().await.unwrap();
        let scope = RunScope::new(&worker.0, permit);
        let membership = worker.0.register_heartbeat(
            Uuid::new_v4(),
            1,
            tokio::time::Instant::now() + Duration::from_secs(30),
        );
        // The round is in flight once the server holds the connection it asked for.
        tokio::time::timeout(Duration::from_secs(5), accepted.recv())
            .await
            .expect("the heartbeat round never connected")
            .expect("the heartbeat round connected");
        drop(membership);
        drop(scope);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(
            worker.0.run_permit.available_permits(),
            0,
            "the run ended while its heartbeat round still waited for a connection"
        );
    }

    fn rejects(options: WorkerOptions, message: &str) {
        let error = Worker::new(pool(4), options).unwrap_err();
        assert_eq!(error.to_string(), message);
    }

    #[tokio::test]
    async fn defaults_follow_adr_0072() {
        let worker = Worker::new(pool(4), WorkerOptions::default()).unwrap();
        assert_eq!(worker.0.heartbeat_interval, Duration::from_secs(10));
        assert_eq!(worker.0.poll_interval, POLLING_POLL);
        assert!(worker.worker_id().contains(&format!("-{}-", std::process::id())));
    }

    #[tokio::test]
    async fn the_default_heartbeat_is_at_least_the_smallest_supported_interval() {
        // A third of a 150 ms lease is 50 ms, below the 100 ms that every SDK supports.
        let lease = |millis| WorkerOptions {
            lease_duration: Duration::from_millis(millis),
            ..Default::default()
        };
        let worker = Worker::new(pool(4), lease(150)).unwrap();
        assert_eq!(worker.0.heartbeat_interval, Duration::from_millis(100));
        let worker = Worker::new(pool(4), lease(900)).unwrap();
        assert_eq!(worker.0.heartbeat_interval, Duration::from_millis(300));
        // The floor is not less than the smallest lease, so the default must still be shorter.
        rejects(
            lease(100),
            "worker heartbeat interval must be a whole number of milliseconds greater than zero and shorter than the lease duration",
        );
    }

    #[test]
    fn recovery_counts_the_retries_that_its_dimensions_do_not_list() {
        let dimensions = serde_json::json!([
            { "queue": "emails", "type": "send" },
            { "queue": "emails", "type": "send" },
            { "queue": "reports" }
        ]);
        let entry =
            |queue: &str, task_type: &str, count| (queue.to_owned(), task_type.to_owned(), count);
        assert_eq!(
            recovery_retries(5, &dimensions),
            vec![
                entry("emails", "send", 1),
                entry("emails", "send", 1),
                entry("reports", "unknown", 1),
                entry("unknown", "unknown", 2),
            ],
        );
        // A list that holds every retry, or more, adds no unknown retries.
        assert_eq!(recovery_retries(3, &dimensions).len(), 3);
        assert_eq!(recovery_retries(1, &dimensions).len(), 3);
        assert_eq!(recovery_retries(2, &Value::Null), vec![entry("unknown", "unknown", 2)]);
        assert!(recovery_retries(0, &Value::Null).is_empty());
    }

    // SM-1668 PAR-09 (ADR 0112): register_worker_v1 takes each interval as a PostgreSQL integer,
    // and its check refuses a value below 100 ms. Every SDK accepts 100 through 2147483647 ms.
    #[tokio::test]
    async fn intervals_accept_100_ms_through_the_sql_integer_limit() {
        let limit = Duration::from_millis(i32::MAX as u64);
        for interval in [Duration::from_millis(100), limit] {
            let options = WorkerOptions {
                maintenance_interval: interval,
                maintenance_routine_interval: interval,
                registry_interval: interval,
                ..Default::default()
            };
            assert!(Worker::new(pool(4), options).is_ok(), "{interval:?}");
        }
        type Set = fn(&mut WorkerOptions, Duration);
        let options: [(Set, &str); 3] = [
            (|options, value| options.maintenance_interval = value, "maintenance"),
            (|options, value| options.maintenance_routine_interval = value, "maintenance routine"),
            (|options, value| options.registry_interval = value, "registry"),
        ];
        for (set, name) in options {
            for value in [
                Duration::ZERO,
                Duration::from_millis(1),
                Duration::from_millis(99),
                limit + Duration::from_millis(1),
                Duration::from_micros(100_500),
            ] {
                let mut refused = WorkerOptions::default();
                set(&mut refused, value);
                rejects(
                    refused,
                    &format!(
                        "worker {name} interval must be between 100 and 2147483647 whole milliseconds"
                    ),
                );
            }
        }
    }

    #[tokio::test]
    async fn validation_matches_go() {
        rejects(
            WorkerOptions { queues: vec![String::new()], ..Default::default() },
            "worker queues must contain at least one non-empty queue name",
        );
        rejects(
            WorkerOptions { concurrency: 101, ..Default::default() },
            "worker concurrency must be between 1 and 100",
        );
        rejects(
            WorkerOptions { lease_duration: Duration::from_micros(100_500), ..Default::default() },
            "worker lease duration must be a whole number of milliseconds between 100ms and 24h0m0s",
        );
        rejects(
            WorkerOptions { heartbeat_interval: Some(DEFAULT_LEASE), ..Default::default() },
            "worker heartbeat interval must be a whole number of milliseconds greater than zero and shorter than the lease duration",
        );
        rejects(
            WorkerOptions { registry_interval: Duration::from_millis(99), ..Default::default() },
            "worker registry interval must be between 100 and 2147483647 whole milliseconds",
        );
        rejects(
            WorkerOptions { schedule_catchup_limit: 0, ..Default::default() },
            "worker schedule catch-up limit must be between 1 and 10000",
        );
        // SM-1668 PAR-09: Rust refuses a zero grace. It does not read zero as the default.
        rejects(
            WorkerOptions { shutdown_grace_period: Duration::ZERO, ..Default::default() },
            GRACE_RANGE,
        );
        rejects(
            WorkerOptions {
                shutdown_grace_period: Duration::from_micros(1_500),
                ..Default::default()
            },
            GRACE_RANGE,
        );
        // SM-1778: `Worker::new` refuses a grace above one day, as Ruby, the JVM, and .NET do.
        // Before, a grace near `Duration::MAX` passed and the run panicked on `Instant::now() +
        // grace`.
        for grace in [MAX_SHUTDOWN_GRACE + Duration::from_millis(1), Duration::from_secs(u64::MAX)]
        {
            rejects(
                WorkerOptions { shutdown_grace_period: grace, ..Default::default() },
                GRACE_RANGE,
            );
        }
        let limit =
            WorkerOptions { shutdown_grace_period: MAX_SHUTDOWN_GRACE, ..Default::default() };
        assert!(Worker::new(pool(4), limit).is_ok());
        let error = Worker::new(pool(2), WorkerOptions::default()).unwrap_err();
        assert!(error.to_string().starts_with(
            "worker cannot reserve a dedicated heartbeat connection: max pool size is 2"
        ));
        assert!(Worker::new(
            pool(2),
            WorkerOptions { shared_heartbeats: true, ..Default::default() }
        )
        .is_ok());
    }

    #[tokio::test]
    async fn cohorts_default_to_an_eighth_of_the_concurrency_within_the_spare_connections() {
        let cohorts = |max_size: usize, options: WorkerOptions| {
            Worker::new(pool(max_size), options).unwrap().0.cohorts
        };
        let concurrency = |concurrency: usize| WorkerOptions { concurrency, ..Default::default() };
        assert_eq!(cohorts(20, concurrency(1)), 1);
        assert_eq!(cohorts(20, concurrency(7)), 1);
        assert_eq!(cohorts(20, concurrency(8)), 2, "at least two cohorts from concurrency 8");
        assert_eq!(cohorts(20, concurrency(16)), 2);
        assert_eq!(cohorts(20, concurrency(40)), 5);
        assert_eq!(cohorts(20, concurrency(100)), 8, "at most eight cohorts");
        assert_eq!(cohorts(4, concurrency(100)), 3, "one pool connection is the heartbeat's");
        assert_eq!(
            cohorts(2, WorkerOptions { shared_heartbeats: true, ..concurrency(100) }),
            2,
            "shared heartbeats leave the whole pool spare"
        );
        assert_eq!(
            cohorts(4, WorkerOptions { cohorts: Some(8), ..concurrency(100) }),
            8,
            "an explicit count is never capped"
        );
    }

    #[tokio::test]
    async fn cohorts_must_be_between_one_and_the_concurrency() {
        for invalid in [0, 17] {
            rejects(
                WorkerOptions { concurrency: 16, cohorts: Some(invalid), ..Default::default() },
                "worker cohorts must be between 1 and concurrency",
            );
        }
        for valid in [1, 16] {
            let options =
                WorkerOptions { concurrency: 16, cohorts: Some(valid), ..Default::default() };
            assert_eq!(Worker::new(pool(4), options).unwrap().0.cohorts, valid);
        }
    }

    #[tokio::test]
    async fn empty_polls_back_off_to_the_ceiling() {
        let worker = Worker::new(pool(4), WorkerOptions::default()).unwrap();
        let first = worker.0.poll_delay(1, false);
        assert!(first >= Duration::from_millis(225) && first <= Duration::from_millis(275));
        let ceiling = worker.0.poll_delay(40, false);
        assert!(ceiling >= Duration::from_millis(4500) && ceiling <= Duration::from_millis(5500));
    }

    #[tokio::test]
    async fn a_listener_that_is_not_connected_polls_at_the_polling_only_base() {
        let config: tokio_postgres::Config =
            "host=127.0.0.1 port=1 user=workhorse".parse().unwrap();
        let options = WorkerOptions { listen_config: Some(config), ..Default::default() };
        let worker = Worker::new(pool(4), options.clone()).unwrap();
        let polling = worker.0.poll_delay(1, false);
        assert!(polling >= Duration::from_millis(225) && polling <= Duration::from_millis(275));
        let listening = worker.0.poll_delay(1, true);
        assert!(
            listening >= Duration::from_millis(4500) && listening <= Duration::from_millis(5500)
        );
        // An explicit interval keeps its value in both states.
        let explicit = WorkerOptions { poll_interval: Some(Duration::from_secs(1)), ..options };
        let worker = Worker::new(pool(4), explicit).unwrap();
        for listening in [false, true] {
            let delay = worker.0.poll_delay(1, listening);
            assert!(delay >= Duration::from_millis(900) && delay <= Duration::from_millis(1100));
        }
    }

    // SM-1668 PAR-09 (ADR 0112): with a live subscription, an explicit poll interval is the
    // fallback interval, so the 5 s cap does not apply. Without one, the cap applies before the
    // jitter.
    #[tokio::test]
    async fn an_explicit_poll_interval_is_capped_only_while_the_worker_polls() {
        let options =
            WorkerOptions { poll_interval: Some(Duration::from_secs(30)), ..Default::default() };
        let worker = Worker::new(pool(4), options).unwrap();
        for _ in 0..50 {
            let listening = worker.0.poll_delay(4, true);
            assert!(listening >= Duration::from_secs(27) && listening <= Duration::from_secs(33));
            let polling = worker.0.poll_delay(4, false);
            assert!(
                polling >= Duration::from_millis(4500) && polling <= Duration::from_millis(5500)
            );
        }
    }
}
