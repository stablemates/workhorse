//! The worker runtime: claim, execute under a fenced lease, settle, and drain on shutdown.
//!
//! PostgreSQL owns every state transition. The worker supervises handler futures, renews their
//! leases in one batched round, and runs the maintenance and registry loops ADR 0072 describes.
mod batch;
mod completion;
mod dispatch;
mod execute;
mod handler;
mod heartbeat;
mod notifications;
mod process;

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use chrono::{DateTime, Utc};
use futures_util::FutureExt;
use serde_json::Value;
use tokio::sync::{Notify, Semaphore};
use tokio::task::JoinSet;
use tokio::time::{timeout_at, Instant};
use tokio_util::sync::CancellationToken as StopToken;
use uuid::Uuid;

pub use handler::{
    BatchItem, BatchOptions, BatchResult, CancellationToken, ClaimedTask, HandlerError,
};
pub use process::run_worker_process;

use crate::contracts::ContractSchema;
use crate::queue::exactly_one;
use crate::sql_catalogue_generated as sql;
use crate::telemetry::{Attribute, Counter, Histogram, Metrics};
use crate::HandlerContext;
use crate::{Error, Executor, Operation};
use handler::ErasedHandler;

const DEFAULT_LEASE: Duration = Duration::from_secs(30);
const MIN_LEASE: Duration = Duration::from_millis(100);
const MAX_LEASE: Duration = Duration::from_secs(24 * 60 * 60);
const LISTENING_POLL: Duration = Duration::from_secs(5);
const POLLING_POLL: Duration = Duration::from_millis(250);
const MAX_EMPTY_POLL: Duration = Duration::from_secs(5);
const MAX_NOTIFICATION_DELAY_MS: u128 = 50;
const MAX_CONCURRENCY: usize = 100;
const MIN_REGISTRY_INTERVAL: Duration = Duration::from_millis(100);
const MIN_MAINTENANCE_REPORT: Duration = Duration::from_millis(100);
const MAX_CATCHUP_LIMIT: i32 = 10_000;
const PROMOTE_LIMIT: i32 = 100;
const RECOVER_LIMIT: i32 = 100;
/// How long a stopped handler may unwind after its cancellation fires at the end of grace.
const UNWIND_WINDOW: Duration = Duration::from_millis(250);
/// The heartbeat connection plus one claim and one settlement.
const MIN_DEDICATED_POOL: usize = 3;
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
pub type RegistrationErrorHook = Arc<dyn Fn(&Error) + Send + Sync>;
/// Overrides the persisted retry delay for a failed attempt; `None` keeps the task's policy.
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
    /// Defaults to a third of the lease.
    pub heartbeat_interval: Option<Duration>,
    /// Defaults to 5s while a notification listener is expected and 250ms when polling only.
    pub poll_interval: Option<Duration>,
    pub maintenance_interval: Duration,
    pub maintenance_routine_interval: Duration,
    pub registry_interval: Duration,
    pub disable_registry: bool,
    /// Schedule namespaces this worker fires during maintenance. Empty fires none.
    pub schedule_namespaces: Vec<String>,
    pub schedule_catchup_limit: i32,
    /// How long running handlers may finish before their cancellation fires.
    pub shutdown_grace_period: Duration,
    /// Never opens the `LISTEN` connection.
    pub polling_only: bool,
    /// Sends heartbeat rounds through the shared pool instead of a reserved connection.
    pub shared_heartbeats: bool,
    /// The connection the notification listener opens. Without it the worker polls.
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
        .unwrap_or_else(|| Duration::from_millis((lease.as_millis() / 3) as u64));
    if !whole_millis(heartbeat) || heartbeat.is_zero() || heartbeat >= lease {
        return invalid("worker heartbeat interval must be a whole number of milliseconds greater than zero and shorter than the lease duration");
    }
    if !whole_millis(options.maintenance_interval) || options.maintenance_interval.is_zero() {
        return invalid(
            "worker maintenance interval must be a positive whole number of milliseconds",
        );
    }
    if !whole_millis(options.maintenance_routine_interval)
        || options.maintenance_routine_interval.is_zero()
    {
        return invalid(
            "worker maintenance routine interval must be a positive whole number of milliseconds",
        );
    }
    if !whole_millis(options.registry_interval) || options.registry_interval < MIN_REGISTRY_INTERVAL
    {
        return invalid("worker registry interval must be at least 100 whole milliseconds");
    }
    if options.schedule_namespaces.iter().any(String::is_empty) {
        return invalid("worker schedule namespaces must contain only non-empty names");
    }
    options.schedule_namespaces = unique_names(&options.schedule_namespaces);
    if !(1..=MAX_CATCHUP_LIMIT).contains(&options.schedule_catchup_limit) {
        return invalid("worker schedule catch-up limit must be between 1 and 10000");
    }
    let grace = options.shutdown_grace_period;
    if !whole_millis(grace) || grace.is_zero() {
        return invalid(
            "worker shutdown grace period must be a positive whole number of milliseconds",
        );
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
    run_permit: Semaphore,
    instance: Mutex<Uuid>,
    registered: AtomicBool,
    paused: AtomicBool,
    draining: AtomicBool,
    active: AtomicUsize,
    last_routine: Mutex<Option<Instant>>,
    next_queue: AtomicUsize,
    contracts: Mutex<HashMap<String, Arc<ContractSchema>>>,
    /// Queues that rejected a fast claim, with the instant to probe them again.
    full_tier_until: Mutex<HashMap<String, Instant>>,
    /// Queues whose last claim answered on the fast tier.
    fast_tier_queues: Mutex<HashSet<String>>,
    completions: completion::Batcher,
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
            run_permit: Semaphore::new(1),
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
    /// Handlers still running when grace ends see [`crate::CancelReason::Shutdown`] and get a
    /// short unwind window. Any that outlive it are abandoned, their leases expire, and PostgreSQL
    /// recovers them; `run` then returns [`Error::ShutdownIncomplete`].
    pub async fn run<F: Future<Output = ()> + Send>(&self, shutdown: F) -> Result<(), Error> {
        let inner = &self.0;
        tokio::pin!(shutdown);
        let _permit = tokio::select! {
            permit = inner.run_permit.acquire() => permit.map_err(|_| Error::invalid("worker is closed"))?,
            () = &mut shutdown => return Ok(()),
        };
        inner.start().await?;

        let wake = Arc::new(Notify::new());
        let registry_wake = Arc::new(Notify::new());
        let listening = Arc::new(AtomicBool::new(false));
        let background = StopToken::new();
        let maintenance_stop = StopToken::new();
        let registry = tokio::spawn(
            Arc::clone(inner).registry_loop(Arc::clone(&registry_wake), background.clone()),
        );
        let listener = inner.spawn_listener(&wake, &listening, &background);
        let maintenance =
            tokio::spawn(Arc::clone(inner).maintenance_loop(maintenance_stop.clone()));

        let shutdown_token = StopToken::new();
        let mut executions: JoinSet<Result<(), Error>> = JoinSet::new();
        let mut first_error = None;
        let dispatcher = Arc::new(WorkerDispatch {
            inner: Arc::clone(inner),
            shutdown: shutdown_token.clone(),
            listening,
        });
        dispatch::dispatch(
            &dispatcher,
            &mut executions,
            shutdown.as_mut(),
            &wake,
            &registry_wake,
            &mut first_error,
        )
        .await;

        inner.draining.store(true, Ordering::SeqCst);
        inner.refresh_registration().await;
        maintenance_stop.cancel();
        let _ = maintenance.await;
        drain(
            &mut executions,
            Instant::now() + inner.options.shutdown_grace_period,
            &mut first_error,
        )
        .await;
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
        background.cancel();
        let _ = registry.await;
        if let Some(listener) = listener {
            let _ = listener.await;
        }
        inner.stop().await;
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
    /// A claimed task without a registered handler is released and reports `false`.
    pub async fn run_once(&self) -> Result<bool, Error> {
        let inner = &self.0;
        let _permit =
            inner.run_permit.acquire().await.map_err(|_| Error::invalid("worker is closed"))?;
        inner.start().await?;
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
        inner.stop().await;
        result
    }
}

/// The worker side of the dispatch loop.
struct WorkerDispatch {
    inner: Arc<Inner>,
    shutdown: StopToken,
    listening: Arc<AtomicBool>,
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

    fn paused(&self) -> bool {
        self.inner.paused.load(Ordering::SeqCst)
    }

    fn fast_tier_only(&self) -> bool {
        lock(&self.inner.full_tier_until).is_empty()
    }

    fn tiers_known(&self) -> bool {
        self.inner.tiers_known()
    }

    fn poll_delay(&self, consecutive_empty: u32) -> Duration {
        self.inner.poll_delay(consecutive_empty, self.listening.load(Ordering::SeqCst))
    }

    fn claim(
        &self,
        limit: usize,
        fast_limit: usize,
    ) -> impl Future<Output = Vec<ClaimedTask>> + Send + 'static {
        let inner = Arc::clone(&self.inner);
        async move {
            let (tasks, error) = inner.claim(limit, fast_limit).await;
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

    /// Reserves the heartbeat connection, checks the schema and registers a fresh instance.
    async fn start(&self) -> Result<(), Error> {
        self.reserve_heartbeat_connection().await;
        if let Err(error) = crate::compatibility::assert_schema_compatible(&self.pool).await {
            self.release_heartbeat_connection().await;
            return Err(error);
        }
        *lock(&self.instance) = Uuid::new_v4();
        self.registered.store(false, Ordering::SeqCst);
        self.draining.store(false, Ordering::SeqCst);
        self.paused.store(false, Ordering::SeqCst);
        self.refresh_registration().await;
        Ok(())
    }

    async fn stop(&self) {
        if self.registered.swap(false, Ordering::SeqCst) {
            if let Err(error) = self.pool.rows(sql::DEREGISTER_WORKER_V1, &[&self.worker_id]).await
            {
                tracing::warn!(error = %error, workhorse.worker.id = %self.worker_id, "worker deregistration failed");
            }
        }
        self.release_heartbeat_connection().await;
    }

    fn poll_delay(&self, consecutive_empty: u32, listening: bool) -> Duration {
        let mut delay = self.poll_interval;
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

    fn spawn_listener(
        &self,
        wake: &Arc<Notify>,
        listening: &Arc<AtomicBool>,
        stop: &StopToken,
    ) -> Option<tokio::task::JoinHandle<()>> {
        if self.options.polling_only {
            return None;
        }
        if !self.listener_expected {
            tracing::warn!(workhorse.worker.id = %self.worker_id, "PostgreSQL notification listener unavailable; worker is using polling");
            return None;
        }
        let config = self.options.listen_config.clone()?;
        Some(tokio::spawn(notifications::listen(
            config,
            self.options.queues.clone(),
            Arc::clone(wake),
            Arc::clone(listening),
            stop.clone(),
        )))
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
                Some(hook) => hook(&error),
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
        let maintenance = millis_i32(options.maintenance_interval.max(MIN_MAINTENANCE_REPORT));
        let routine = millis_i32(options.maintenance_routine_interval.max(MIN_MAINTENANCE_REPORT));
        let registry = millis_i32(options.registry_interval);
        let active = i32::try_from(self.active.load(Ordering::SeqCst)).unwrap_or(i32::MAX);
        let draining = self.draining.load(Ordering::SeqCst);
        let rows = self
            .pool
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

    /// Promotes and recovers tasks, fires due schedules, and runs the routine pass when due.
    async fn run_maintenance(&self) -> Result<(), Error> {
        let rows = self.pool.rows(sql::TICK_V1, &[&PROMOTE_LIMIT, &RECOVER_LIMIT]).await?;
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
            let dimensions =
                row.try_get::<_, Option<Value>>("retry_dimensions")?.unwrap_or(Value::Null);
            for dimension in dimensions.as_array().into_iter().flatten() {
                let text = |key: &str| {
                    dimension.get(key).and_then(Value::as_str).unwrap_or("unknown").to_owned()
                };
                let (queue, task_type) = (text("queue"), text("type"));
                self.metrics.add(
                    Counter::Retried,
                    1.0,
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
            self.pool
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
            self.pool.rows(sql::RUN_MAINTENANCE_V1, &[&Utc::now()]).await?;
        }
        Ok(())
    }

    /// Claims up to `limit` tasks round-robin across the queues, and at most `fast_limit` of them
    /// from fast-tier queues (ADR 0076, rule 13).
    ///
    /// Tasks claimed before an error are returned with it, so the caller still owns them.
    async fn claim(&self, limit: usize, fast_limit: usize) -> (Vec<ClaimedTask>, Option<Error>) {
        let queues = &self.options.queues;
        let mut tasks = Vec::new();
        let lease = millis_i32(self.options.lease_duration);
        for _ in 0..queues.len() {
            let remaining = limit - tasks.len();
            if remaining == 0 {
                break;
            }
            let queue = &queues[self.next_queue.fetch_add(1, Ordering::SeqCst) % queues.len()];
            let sent_at = Instant::now();
            let fast_remaining = fast_limit.saturating_sub(tasks.len());
            let claimed = self.claim_queue(queue, remaining, fast_remaining, lease, sent_at).await;
            let (rows, fast_tier) = match claimed {
                Ok(claimed) => claimed,
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
    /// full-tier, and reports which path answered.
    ///
    /// The fast claim is `complete_many_and_claim_v1` with no completions, and claims at most
    /// `fast_limit`. A full-tier queue rejects it, and the worker then claims that queue through
    /// `claim_many_v1` until the next probe.
    async fn claim_queue(
        &self,
        queue: &str,
        limit: usize,
        fast_limit: usize,
        lease: i32,
        sent_at: Instant,
    ) -> Result<(Vec<tokio_postgres::Row>, bool), Error> {
        let probe_due =
            lock(&self.full_tier_until).get(queue).is_none_or(|until| sent_at >= *until);
        if probe_due {
            if fast_limit == 0 {
                return Ok((Vec::new(), true));
            }
            let fast_limit = limit.min(fast_limit) as i32;
            let claimed = self
                .pool
                .rows(
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
                )
                .await
                .map_err(Error::translate_fast_tier);
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
                    return Ok((claimed, true));
                }
                Err(Error::FastTierUnsupported { .. }) => self.record_tier(queue, false, sent_at),
                Err(error) => return Err(error),
            }
        }
        let limit = limit as i32;
        let rows =
            self.pool.rows(sql::CLAIM_MANY_V1, &[&queue, &self.worker_id, &limit, &lease]).await?;
        Ok((rows, false))
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

#[cfg(test)]
mod tests {
    use super::*;

    fn pool(max_size: usize) -> deadpool_postgres::Pool {
        let mut config = deadpool_postgres::Config::new();
        config.dbname = Some("unused".into());
        config.pool = Some(deadpool_postgres::PoolConfig::new(max_size));
        config.create_pool(Some(deadpool_postgres::Runtime::Tokio1), tokio_postgres::NoTls).unwrap()
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
            "worker registry interval must be at least 100 whole milliseconds",
        );
        rejects(
            WorkerOptions { schedule_catchup_limit: 0, ..Default::default() },
            "worker schedule catch-up limit must be between 1 and 10000",
        );
        rejects(
            WorkerOptions { shutdown_grace_period: Duration::ZERO, ..Default::default() },
            "worker shutdown grace period must be a positive whole number of milliseconds",
        );
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
}
