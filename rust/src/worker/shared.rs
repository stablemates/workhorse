//! The connections that all workers on one pool identity share (ADR 0071, amendment of
//! 2026-10-21): one heartbeat connection from the pool, and one listener connection outside it.
//!
//! The pool identity is the address that `Pool::manager()` returns. deadpool 0.13 stores
//! `PoolInner` in an `Arc`, clones of a pool share that allocation, and `manager()` returns a
//! reference into it. Thus clones of one pool give one address, and two pools that a caller builds
//! separately give two addresses. deadpool does not promise this property in its signature, so the
//! test `clones_share_one_identity_and_separate_pools_do_not` asserts it. A deadpool upgrade that
//! breaks the property fails that test.
//!
//! A registry entry holds a `WeakPool`, so it does not keep the pool alive. While the entry exists,
//! that weak reference keeps the allocation, and thus the address, from reuse by another pool. The
//! entry goes when its last subscription releases, before that subscription releases anything
//! else. Each entry has a generation, so the cleanup of an old entry cannot remove a new one.
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use tokio::sync::{oneshot, watch, Notify};
use tokio::task::JoinHandle;
use tokio::time::{timeout, timeout_at, Instant};
use tokio_util::sync::CancellationToken as StopToken;

use super::heartbeat::heartbeat_round_bound_for;
use super::{lock, notifications, until};
use crate::Error;

/// The address of the manager of a pool. See the module documentation.
type PoolKey = usize;

fn pool_key(pool: &deadpool_postgres::Pool) -> PoolKey {
    std::ptr::from_ref(pool.manager()) as usize
}

/// The shared connections of one pool identity. Every count changes under the registry lock.
///
/// The entry stays until every close of its connections has settled, so a new run cannot open a
/// second heartbeat connection or listener while the old one still closes.
struct Entry {
    generation: u64,
    /// Proves the address while the entry exists. It is never upgraded to hold the pool.
    _pool: deadpool_postgres::WeakPool,
    subscribers: usize,
    heartbeat_users: usize,
    heartbeat: Option<Arc<HeartbeatConnection>>,
    /// Set while the last heartbeat user closes the connection.
    heartbeat_closing: Option<watch::Receiver<bool>>,
    listener_users: usize,
    listener: Option<Arc<SharedListener>>,
    /// Set while the last listening user closes the listener.
    listener_closing: Option<watch::Receiver<bool>>,
}

impl Entry {
    fn settled(&self) -> bool {
        self.subscribers == 0 && self.heartbeat_closing.is_none() && self.listener_closing.is_none()
    }
}

static REGISTRY: LazyLock<Mutex<HashMap<PoolKey, Entry>>> = LazyLock::new(Mutex::default);
static GENERATIONS: AtomicU64 = AtomicU64::new(1);
static SUBSCRIBERS: AtomicU64 = AtomicU64::new(1);

/// What one worker run asks of the shared connections.
#[derive(Clone)]
pub(super) struct Request {
    /// The worker uses the dedicated heartbeat connection, so it has no `shared_heartbeats`.
    pub(super) dedicated: bool,
    pub(super) interval: Duration,
    /// The end of the startup budget. It bounds the first acquisition of the heartbeat connection.
    pub(super) startup_deadline: Instant,
    pub(super) listen: Option<Listen>,
}

/// A worker that wants notifications for its queues.
#[derive(Clone)]
pub(super) struct Listen {
    pub(super) config: tokio_postgres::Config,
    pub(super) queues: Vec<String>,
    pub(super) wake: Arc<Notify>,
}

/// One worker run's use of the shared connections of its pool identity.
///
/// [`Subscription::release`] leaves them and closes each one that has no other user. Dropping the
/// subscription without that call does the same at once, without a wait.
pub(super) struct Subscription {
    key: PoolKey,
    generation: u64,
    id: u64,
    heartbeat: Option<Arc<HeartbeatConnection>>,
    listener: Option<Arc<SharedListener>>,
    released: bool,
}

/// The result of one attempt to join: the subscription, or a close that must settle first.
enum Joined {
    Ready(Subscription),
    Wait(watch::Receiver<bool>),
}

/// Joins the shared connections of the pool identity of `pool`, and opens each one that is missing.
/// Returns `Ok(None)` when `stop` fires first.
///
/// If the last user of a connection that this run needs still closes it, the run waits until the
/// close settles, until `deadline` at most. If the pool identity already has a listener with a
/// different `listen_config`, the worker refuses to start, because one listener connection serves
/// every worker on the pool identity.
pub(super) async fn subscribe(
    pool: &deadpool_postgres::Pool,
    request: Request,
    deadline: Instant,
    stop: &StopToken,
) -> Result<Option<Subscription>, Error> {
    loop {
        let mut closing = match try_subscribe(pool, request.clone())? {
            Joined::Ready(subscription) => return Ok(Some(subscription)),
            Joined::Wait(closing) => closing,
        };
        tokio::select! {
            () = stop.cancelled() => return Ok(None),
            settled = timeout_at(deadline, closing.wait_for(|settled| *settled)) => {
                if settled.is_err() {
                    return Err(Error::invalid(
                        "worker could not join the shared connections of its pool within the startup budget, because the last run on the pool still closed them",
                    ));
                }
            }
        }
    }
}

fn try_subscribe(pool: &deadpool_postgres::Pool, request: Request) -> Result<Joined, Error> {
    let key = pool_key(pool);
    let mut registry = lock(&REGISTRY);
    if let Some(entry) = registry.get(&key) {
        if let Some(listen) = &request.listen {
            if entry.listener.as_ref().is_some_and(|listener| listener.config != listen.config) {
                return Err(Error::invalid(
                    "worker listen_config differs from the listen_config of another worker on the same pool; the workers on one pool share one listener connection",
                ));
            }
            if let Some(closing) = &entry.listener_closing {
                return Ok(Joined::Wait(closing.clone()));
            }
        }
        if let Some(closing) = entry.heartbeat_closing.as_ref().filter(|_| request.dedicated) {
            return Ok(Joined::Wait(closing.clone()));
        }
    }
    let entry = registry.entry(key).or_insert_with(|| Entry {
        generation: GENERATIONS.fetch_add(1, Ordering::Relaxed),
        _pool: pool.weak(),
        subscribers: 0,
        heartbeat_users: 0,
        heartbeat: None,
        heartbeat_closing: None,
        listener_users: 0,
        listener: None,
        listener_closing: None,
    });
    entry.subscribers += 1;
    let id = SUBSCRIBERS.fetch_add(1, Ordering::Relaxed);
    let heartbeat = request.dedicated.then(|| {
        entry.heartbeat_users += 1;
        let connection = entry.heartbeat.get_or_insert_with(|| {
            HeartbeatConnection::open(pool, request.interval, request.startup_deadline)
        });
        connection.join(request.interval, request.startup_deadline);
        Arc::clone(connection)
    });
    let listener = request.listen.map(|listen| {
        entry.listener_users += 1;
        let listener =
            entry.listener.get_or_insert_with(|| SharedListener::open(listen.config.clone()));
        lock(&listener.subscribers)
            .insert(id, Subscriber { queues: listen.queues, wake: listen.wake });
        Arc::clone(listener)
    });
    let generation = entry.generation;
    Ok(Joined::Ready(Subscription { key, generation, id, heartbeat, listener, released: false }))
}

impl Subscription {
    /// The shared heartbeat connection, when the worker uses the dedicated connection.
    pub(super) fn heartbeat(&self) -> Option<&Arc<HeartbeatConnection>> {
        self.heartbeat.as_ref()
    }

    /// Whether the shared listener is connected, when the worker listens.
    pub(super) fn listening(&self) -> Option<Arc<AtomicBool>> {
        self.listener.as_ref().map(|listener| Arc::clone(&listener.listening))
    }

    /// Leaves the shared connections, and closes each one that has no other user. One cleanup task
    /// owns the close from the start, until every connection settles. The caller waits for it until
    /// `deadline`, the stop deadline of the run. That deadline, or a dropped call, ends only the
    /// wait of the caller, not the cleanup.
    pub(super) async fn release(mut self, deadline: Option<Instant>) {
        if let Some(cleanup) = self.detach().hand_over() {
            if !until(deadline, cleanup).await {
                tracing::warn!(
                    "the close of the shared connections outlived the shutdown cleanup window"
                );
            }
        }
    }

    /// Removes this subscription from its entry. The connections that now have no user stay in
    /// the entry as closing until the returned cleanup settles.
    fn detach(&mut self) -> Cleanup {
        self.released = true;
        let mut cleanup = Cleanup {
            key: self.key,
            generation: self.generation,
            heartbeat: None,
            listener: None,
            settled: false,
            background: false,
        };
        let mut registry = lock(&REGISTRY);
        // Only the entry of this generation counts this subscription.
        let Some(entry) =
            registry.get_mut(&self.key).filter(|entry| entry.generation == self.generation)
        else {
            cleanup.settled = true;
            return cleanup;
        };
        entry.subscribers -= 1;
        if self.heartbeat.is_some() {
            entry.heartbeat_users -= 1;
            if entry.heartbeat_users == 0 {
                if let Some(heartbeat) = entry.heartbeat.take() {
                    let (settled, closing) = watch::channel(false);
                    entry.heartbeat_closing = Some(closing);
                    cleanup.heartbeat = Some((heartbeat, settled));
                }
            }
        }
        if let Some(subscribed) = &self.listener {
            lock(&subscribed.subscribers).remove(&self.id);
            entry.listener_users -= 1;
            if entry.listener_users == 0 {
                if let Some(listener) = entry.listener.take() {
                    let (settled, closing) = watch::channel(false);
                    entry.listener_closing = Some(closing);
                    cleanup.listener = Some((listener, settled));
                }
            }
        }
        if entry.settled() {
            registry.remove(&self.key);
        }
        cleanup
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        if !self.released {
            drop(self.detach());
        }
    }
}

/// The close of the shared connections that the last user of each one left. The entry keeps them
/// as closing until this settles. Dropping the cleanup before it settles closes them at once.
struct Cleanup {
    key: PoolKey,
    generation: u64,
    heartbeat: Option<(Arc<HeartbeatConnection>, watch::Sender<bool>)>,
    listener: Option<(Arc<SharedListener>, watch::Sender<bool>)>,
    settled: bool,
    /// Set when a background task owns the cleanup. If the runtime drops that task, the cleanup
    /// settles at once instead of starting another task.
    background: bool,
}

impl Cleanup {
    /// Hands the close to one cleanup task, which owns it until every connection settles, and
    /// returns that task. A cleanup with nothing to close settles at once.
    fn hand_over(mut self) -> Option<JoinHandle<()>> {
        if self.heartbeat.is_none() && self.listener.is_none() {
            self.settle();
            return None;
        }
        self.background = true;
        Some(tokio::spawn(async move {
            self.finish().await;
            self.settle();
        }))
    }

    /// Closes each connection and waits until it settles.
    async fn finish(&self) {
        if let Some((heartbeat, _)) = &self.heartbeat {
            heartbeat.close().await;
        }
        if let Some((listener, _)) = &self.listener {
            listener.close().await;
        }
    }

    /// Marks the closes as settled, and removes the entry if nothing else holds it.
    fn settle(&mut self) {
        if std::mem::replace(&mut self.settled, true) {
            return;
        }
        let mut registry = lock(&REGISTRY);
        if let Some(entry) =
            registry.get_mut(&self.key).filter(|entry| entry.generation == self.generation)
        {
            if self.heartbeat.is_some() {
                entry.heartbeat_closing = None;
            }
            if self.listener.is_some() {
                entry.listener_closing = None;
            }
            if entry.settled() {
                registry.remove(&self.key);
            }
        }
        drop(registry);
        for settled in
            [self.heartbeat.as_ref().map(|(_, s)| s), self.listener.as_ref().map(|(_, s)| s)]
                .into_iter()
                .flatten()
        {
            settled.send_replace(true);
        }
    }
}

impl Drop for Cleanup {
    /// A cleanup dropped before a task owns it hands itself to a cleanup task. If the runtime drops
    /// that task, or no runtime runs, it stops the connections at once and settles.
    fn drop(&mut self) {
        if self.settled {
            return;
        }
        let waits = self.heartbeat.is_some() || self.listener.is_some();
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) if waits && !self.background => {
                let rest = Cleanup {
                    key: self.key,
                    generation: self.generation,
                    heartbeat: self.heartbeat.take(),
                    listener: self.listener.take(),
                    settled: false,
                    background: false,
                };
                self.settled = true;
                let _context = runtime.enter();
                drop(rest.hand_over());
            }
            _ => {
                if let Some((heartbeat, _)) = &self.heartbeat {
                    heartbeat.close_now();
                }
                if let Some((listener, _)) = &self.listener {
                    listener.close_now();
                }
                self.settle();
            }
        }
    }
}

/// The heartbeat connection of one pool identity. Each worker sends its own rounds on it. The
/// rounds that wait for it share one transaction (`HeartbeatConnection::turn`), and one
/// transaction runs at a time.
///
/// One keeper task owns every acquisition. It takes the first connection, and after a round
/// discards the connection, it takes a replacement at once. It retries with a backoff capped at the
/// heartbeat interval, also when no worker holds an active task. A connection that arrives after
/// the connection closed goes back to the pool.
pub(super) struct HeartbeatConnection {
    state: Arc<HeartbeatState>,
    keeper: Mutex<Option<JoinHandle<()>>>,
    /// The rounds that share the next transaction on the connection.
    group: Mutex<Group>,
}

/// The rows of one round: the task ID and the status of each lease.
pub(super) type RoundRows = Vec<(String, String)>;

/// The rounds of the workers on one pool identity, grouped into transactions.
///
/// The round that finds no transaction in progress leads one. Just before the leader sends its
/// heartbeat statement, every waiting round whose deadline is not earlier than the leader's
/// deadline joins it. When the transaction ends, the waiting round with the earliest deadline leads
/// the next one. Each guard of the group (`Waiting`, `Lead`) hands the lead on when it drops, so a
/// round that the caller drops cannot stop the group.
#[derive(Default)]
struct Group {
    /// A round leads a transaction, or got the lead and has not started yet.
    leading: bool,
    waiting: Vec<Pending>,
    next_id: u64,
}

/// A round that waits for a transaction.
struct Pending {
    id: u64,
    deadline: Instant,
    batches: Vec<serde_json::Value>,
    reply: oneshot::Sender<Reply>,
}

/// What a waiting round gets.
enum Reply {
    /// The round leads the next transaction. It gets its batches back.
    Lead(Vec<serde_json::Value>),
    /// The transaction that the round joined ended with this result.
    Rows(Result<RoundRows, Error>),
}

impl Group {
    /// Gives the lead to the waiting round with the earliest deadline. A round that no longer waits
    /// for its reply cannot lead, so the next one gets the lead. With no waiting round, no round
    /// leads.
    fn hand_over(&mut self) {
        while let Some(index) =
            (0..self.waiting.len()).min_by_key(|&index| self.waiting[index].deadline)
        {
            let pending = self.waiting.swap_remove(index);
            if pending.reply.send(Reply::Lead(pending.batches)).is_ok() {
                return;
            }
        }
        self.leading = false;
    }
}

/// The turn of one round in the group.
pub(super) enum Turn<'a> {
    /// The round leads a transaction.
    Lead(Lead<'a>),
    /// The round joined the transaction of another round, which ended with this result.
    Joined(Result<RoundRows, Error>),
}

/// A round that waits in the group. Dropping it removes the round, or hands on a lead that it got.
struct Waiting<'a> {
    group: &'a Mutex<Group>,
    id: u64,
    reply: oneshot::Receiver<Reply>,
    answered: bool,
}

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        let mut group = lock(self.group);
        if let Some(index) = group.waiting.iter().position(|pending| pending.id == self.id) {
            group.waiting.swap_remove(index);
        } else if !self.answered && matches!(self.reply.try_recv(), Ok(Reply::Lead(_))) {
            group.hand_over();
        }
    }
}

/// A joined round: where its batches start in the statement, how many it has, and its reply.
struct Joiner {
    start: usize,
    count: usize,
    reply: oneshot::Sender<Reply>,
}

/// The lead of one transaction. Dropping it hands the lead to the next waiting round. A joined
/// round that got no answer then fails.
pub(super) struct Lead<'a> {
    group: &'a Mutex<Group>,
    deadline: Instant,
    batches: Vec<serde_json::Value>,
    own: usize,
    joined: Vec<Joiner>,
}

impl Lead<'_> {
    /// Takes every waiting round whose deadline is not earlier than the deadline of the lead, and
    /// returns the batches of all rounds in statement order: the batches of the lead first.
    pub(super) fn join(&mut self) -> serde_json::Value {
        let mut group = lock(self.group);
        let mut index = 0;
        while index < group.waiting.len() {
            if group.waiting[index].deadline < self.deadline {
                index += 1;
                continue;
            }
            let pending = group.waiting.remove(index);
            let start = self.batches.len();
            self.joined.push(Joiner { start, count: pending.batches.len(), reply: pending.reply });
            self.batches.extend(pending.batches);
        }
        drop(group);
        serde_json::Value::Array(self.batches.clone())
    }

    /// Gives each joined round its rows, or the same failure, and returns the result of the lead.
    /// `rows` holds the 1-based batch position, the task ID, and the status of each lease.
    pub(super) fn answer(
        &mut self,
        rows: Result<Vec<(usize, String, String)>, Error>,
    ) -> Result<RoundRows, Error> {
        let joined = std::mem::take(&mut self.joined);
        let rows = match rows {
            Ok(rows) => rows,
            Err(error) => {
                for round in joined {
                    let _ = round.reply.send(Reply::Rows(Err(error.share())));
                }
                return Err(error);
            }
        };
        let mut own = Vec::new();
        let mut answers: Vec<RoundRows> = joined.iter().map(|_| Vec::new()).collect();
        for (batch, task, status) in rows {
            let index = batch.wrapping_sub(1);
            if index < self.own {
                own.push((task, status));
            } else if let Some(round) = joined
                .iter()
                .position(|round| (round.start..round.start + round.count).contains(&index))
            {
                answers[round].push((task, status));
            }
        }
        for (round, rows) in joined.into_iter().zip(answers) {
            let _ = round.reply.send(Reply::Rows(Ok(rows)));
        }
        Ok(own)
    }

    /// How many rounds joined the transaction, for the tests.
    #[cfg(test)]
    pub(super) fn joined(&self) -> usize {
        self.joined.len()
    }
}

impl Drop for Lead<'_> {
    fn drop(&mut self) {
        // A joined round without an answer sees its reply channel close.
        self.joined.clear();
        lock(self.group).hand_over();
    }
}

struct HeartbeatState {
    connection: tokio::sync::Mutex<Option<deadpool_postgres::Object>>,
    /// Whether the connection is present. A round that holds it does not change this value.
    ready: watch::Sender<bool>,
    /// Asks the keeper to check whether the connection is missing.
    wanted: Notify,
    closed: AtomicBool,
    /// The shortest heartbeat interval of the users, in milliseconds.
    interval_ms: AtomicU64,
    /// The latest end of a startup budget that waits for the connection.
    startup_until: Mutex<Instant>,
    /// The claim attempts in flight that passed the gate. The close waits until none is left, so
    /// the reservation stays valid through every claim statement (ADR 0071, rule 6).
    claims: Mutex<usize>,
    /// Wakes the close when the last claim attempt in flight ends.
    claims_settled: Notify,
    /// The failed acquisitions, for the tests that wait for a retry.
    #[cfg(test)]
    failed: std::sync::atomic::AtomicUsize,
}

/// One claim attempt in flight. It holds the reservation open until it drops.
pub(super) struct ClaimPermit(Arc<HeartbeatState>);

impl Drop for ClaimPermit {
    fn drop(&mut self) {
        let mut claims = lock(&self.0.claims);
        *claims -= 1;
        if *claims == 0 {
            self.0.claims_settled.notify_one();
        }
    }
}

/// The first delay before an acquisition that follows a failed one. The delay doubles up to the
/// heartbeat interval.
const BACKOFF_INITIAL: Duration = Duration::from_millis(100);

impl HeartbeatConnection {
    fn open(
        pool: &deadpool_postgres::Pool,
        interval: Duration,
        startup_deadline: Instant,
    ) -> Arc<Self> {
        let state = Arc::new(HeartbeatState {
            connection: tokio::sync::Mutex::new(None),
            ready: watch::Sender::new(false),
            wanted: Notify::new(),
            closed: AtomicBool::new(false),
            interval_ms: AtomicU64::new(millis(interval)),
            startup_until: Mutex::new(startup_deadline),
            claims: Mutex::new(0),
            claims_settled: Notify::new(),
            #[cfg(test)]
            failed: std::sync::atomic::AtomicUsize::new(0),
        });
        let keeper = tokio::spawn(keep(Arc::clone(&state), pool.weak()));
        Arc::new(Self { state, keeper: Mutex::new(Some(keeper)), group: Mutex::default() })
    }

    /// Adds a user with `interval`, whose startup waits until `startup_deadline`.
    fn join(&self, interval: Duration, startup_deadline: Instant) {
        self.state.interval_ms.fetch_min(millis(interval), Ordering::Relaxed);
        let mut until = lock(&self.state.startup_until);
        *until = (*until).max(startup_deadline);
        drop(until);
        self.state.wanted.notify_one();
    }

    /// Whether the connection is present. While it is not, no worker on the pool claims a task.
    pub(super) fn ready(&self) -> bool {
        *self.state.ready.borrow()
    }

    /// Lets one claim attempt run, if the connection is present. The reservation stays valid until
    /// the permit drops: the close of the connection waits for it.
    pub(super) fn claim_permit(&self) -> Option<ClaimPermit> {
        let mut claims = lock(&self.state.claims);
        // The close sets `ready` to false under this lock, so either the permit sees the closed gate
        // or the close sees the permit.
        if !self.ready() {
            return None;
        }
        *claims += 1;
        Some(ClaimPermit(Arc::clone(&self.state)))
    }

    /// Changes each time the connection comes or goes.
    pub(super) fn readiness(&self) -> watch::Receiver<bool> {
        self.state.ready.subscribe()
    }

    /// Waits until the connection is present.
    pub(super) async fn wait_ready(&self) {
        let mut ready = self.state.ready.subscribe();
        if ready.wait_for(|ready| *ready).await.is_err() {
            std::future::pending::<()>().await;
        }
    }

    /// Enters a round with `batches` into the group, and waits until it leads a transaction or a
    /// transaction that it joined ends. A round whose `deadline` passes while it waits leaves the
    /// group and fails, because it sent nothing.
    pub(super) async fn turn(
        &self,
        batches: Vec<serde_json::Value>,
        deadline: Instant,
    ) -> Result<Turn<'_>, Error> {
        let lead = |batches: Vec<serde_json::Value>| Lead {
            group: &self.group,
            deadline,
            own: batches.len(),
            batches,
            joined: Vec::new(),
        };
        let (reply, answer) = oneshot::channel();
        let id = {
            let mut group = lock(&self.group);
            if !group.leading {
                group.leading = true;
                return Ok(Turn::Lead(lead(batches)));
            }
            group.next_id += 1;
            let id = group.next_id;
            group.waiting.push(Pending { id, deadline, batches, reply });
            id
        };
        let mut waiting = Waiting { group: &self.group, id, reply: answer, answered: false };
        let reply = timeout_at(deadline, &mut waiting.reply)
            .await
            .map_err(|_| Error::invalid("heartbeat round exceeded its deadline"))?;
        waiting.answered = true;
        match reply {
            Ok(Reply::Lead(batches)) => Ok(Turn::Lead(lead(batches))),
            Ok(Reply::Rows(rows)) => Ok(Turn::Joined(rows)),
            Err(_) => Err(Error::invalid("the heartbeat transaction ended without an answer")),
        }
    }

    /// Waits for the connection and takes it for one round. The caller bounds the wait. The guard
    /// holds `None` only when the connection closed.
    pub(super) async fn lock(
        &self,
    ) -> tokio::sync::MutexGuard<'_, Option<deadpool_postgres::Object>> {
        loop {
            let mut ready = self.state.ready.subscribe();
            let connection = self.state.connection.lock().await;
            if connection.is_some() || self.state.closed.load(Ordering::SeqCst) {
                return connection;
            }
            drop(connection);
            self.state.wanted.notify_one();
            if ready.wait_for(|ready| *ready).await.is_err() {
                std::future::pending::<()>().await;
            }
        }
    }

    /// Discards the connection after a failed round, because a statement of that round can still
    /// run, and starts the replacement at once.
    ///
    /// The gate closes before the connection frees its pool slot. A claim that waits for a
    /// connection and gets that slot thus reads a closed gate.
    pub(super) fn discard(&self, connection: &mut Option<deadpool_postgres::Object>) {
        self.state.ready.send_replace(false);
        if let Some(connection) = connection.take() {
            drop(deadpool_postgres::Object::take(connection));
        }
        self.state.wanted.notify_one();
    }

    /// Ends a round. A round that ends after the connection closed returns it to the pool.
    pub(super) fn finish(&self, connection: &mut Option<deadpool_postgres::Object>) {
        if self.state.closed.load(Ordering::SeqCst) {
            connection.take();
        }
    }

    /// Closes the connection, and waits until it settles: until the claim attempts in flight end,
    /// the keeper ends, and a round in flight returns the connection. Only the cleanup task calls
    /// it, so no other caller can take the keeper handle away from it.
    async fn close(&self) {
        self.stop_keeping();
        loop {
            let settled = self.state.claims_settled.notified();
            tokio::pin!(settled);
            settled.as_mut().enable();
            if *lock(&self.state.claims) == 0 {
                break;
            }
            settled.await;
        }
        let keeper = lock(&self.keeper).take();
        if let Some(keeper) = keeper {
            // An aborted task ends at its next poll.
            let _ = keeper.await;
        }
        drop(self.state.connection.lock().await.take());
    }

    /// Closes the gate without a wait. The connection goes back to the pool now only if no claim
    /// attempt holds a permit. Otherwise it goes back when the last permit drops, because the
    /// permits keep the state that holds it.
    fn close_now(&self) {
        self.stop_keeping();
        if *lock(&self.state.claims) > 0 {
            return;
        }
        if let Ok(mut connection) = self.state.connection.try_lock() {
            connection.take();
        }
    }

    /// Closes the gate and stops new acquisitions. The keeper handle stays for the close to join.
    fn stop_keeping(&self) {
        // Under the permit lock, so a permit sees the closed gate or the close sees the permit.
        let claims = lock(&self.state.claims);
        self.state.ready.send_replace(false);
        drop(claims);
        self.state.closed.store(true, Ordering::SeqCst);
        if let Some(keeper) = lock(&self.keeper).as_ref() {
            keeper.abort();
        }
    }

    /// Whether the keeper has stopped, for the tests of the close.
    #[cfg(test)]
    pub(super) fn keeping(&self) -> bool {
        lock(&self.keeper).as_ref().is_some_and(|keeper| !keeper.is_finished())
    }

    /// Puts `keeper` in place of the keeper task, for the tests that hold the join of the close.
    #[cfg(test)]
    pub(super) fn hold_keeper_for_test(&self, keeper: JoinHandle<()>) -> Option<JoinHandle<()>> {
        lock(&self.keeper).replace(keeper)
    }

    /// How many acquisitions failed, for the tests that wait for a retry.
    #[cfg(test)]
    pub(super) fn failed_acquisitions(&self) -> usize {
        self.state.failed.load(Ordering::SeqCst)
    }

    /// The connection, for the tests that read its backend.
    #[cfg(test)]
    pub(super) async fn connection(
        &self,
    ) -> tokio::sync::MutexGuard<'_, Option<deadpool_postgres::Object>> {
        self.state.connection.lock().await
    }
}

impl Drop for HeartbeatConnection {
    fn drop(&mut self) {
        self.close_now();
    }
}

fn millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

impl HeartbeatState {
    fn interval(&self) -> Duration {
        Duration::from_millis(self.interval_ms.load(Ordering::Relaxed))
    }

    /// The bound of one acquisition: the round bound, or the rest of a startup budget that still
    /// waits, if that is longer (ADR 0071, rules 3 and 5).
    fn attempt_bound(&self) -> Duration {
        let startup = lock(&self.startup_until).saturating_duration_since(Instant::now());
        heartbeat_round_bound_for(self.interval()).max(startup)
    }
}

/// Takes the connection each time it is missing, until the connection closes or the pool is gone.
///
/// An acquisition waits for its bound at most. Dropping a deadpool 0.13 checkout before it returns
/// gives its slot back to the pool, so a timed-out acquisition leaves no pending connection and no
/// helper task.
async fn keep(state: Arc<HeartbeatState>, pool: deadpool_postgres::WeakPool) {
    let mut failures = 0u32;
    loop {
        while *state.ready.borrow() {
            state.wanted.notified().await;
        }
        if state.closed.load(Ordering::SeqCst) {
            return;
        }
        if failures > 0 {
            let backoff = BACKOFF_INITIAL.saturating_mul(1 << (failures - 1).min(16));
            tokio::time::sleep(backoff.min(state.interval())).await;
        }
        let Some(pool) = pool.upgrade() else { return };
        let bound = state.attempt_bound();
        let acquired = timeout(bound, pool.get()).await;
        drop(pool);
        let error = match acquired {
            Ok(Ok(object)) => {
                let mut connection = state.connection.lock().await;
                if state.closed.load(Ordering::SeqCst) {
                    return;
                }
                *connection = Some(object);
                state.ready.send_replace(true);
                failures = 0;
                continue;
            }
            Ok(Err(error)) => error.to_string(),
            Err(_) => format!("no pooled connection within {bound:?}"),
        };
        failures = failures.saturating_add(1);
        #[cfg(test)]
        state.failed.fetch_add(1, Ordering::SeqCst);
        // One warning for each loss; the retries that follow it log at debug level.
        if failures == 1 {
            tracing::warn!(error = %error, "heartbeat connection unavailable; claims pause until it returns");
        } else {
            tracing::debug!(error = %error, "heartbeat connection still unavailable");
        }
    }
}

/// The listener of one pool identity. It wakes each subscriber whose queues a notification names,
/// and every subscriber for the `*` wildcard.
pub(super) struct SharedListener {
    config: tokio_postgres::Config,
    listening: Arc<AtomicBool>,
    subscribers: Arc<Mutex<HashMap<u64, Subscriber>>>,
    stop: StopToken,
    task: Mutex<Option<JoinHandle<()>>>,
}

struct Subscriber {
    queues: Vec<String>,
    wake: Arc<Notify>,
}

/// Wakes each subscriber whose queues `payload` names, and every subscriber for `*`. `None` marks
/// a new `LISTEN`, which wakes every subscriber.
fn deliver(subscribers: &Mutex<HashMap<u64, Subscriber>>, payload: Option<&str>) {
    for subscriber in lock(subscribers).values() {
        let wanted = payload
            .is_none_or(|queue| queue == "*" || subscriber.queues.iter().any(|name| name == queue));
        if wanted {
            subscriber.wake.notify_one();
        }
    }
}

impl SharedListener {
    fn open(config: tokio_postgres::Config) -> Arc<Self> {
        let subscribers: Arc<Mutex<HashMap<u64, Subscriber>>> = Arc::default();
        let listening = Arc::new(AtomicBool::new(false));
        let stop = StopToken::new();
        let deliver = {
            let subscribers = Arc::clone(&subscribers);
            move |payload: Option<&str>| deliver(&subscribers, payload)
        };
        let task = tokio::spawn(notifications::listen(
            config.clone(),
            deliver,
            Arc::clone(&listening),
            stop.clone(),
        ));
        Arc::new(Self { config, listening, subscribers, stop, task: Mutex::new(Some(task)) })
    }

    /// Stops the listener and waits until it ends. Only the cleanup task calls it. The listener
    /// ends at its stop, after an `UNLISTEN` that it waits for 1 s at most.
    async fn close(&self) {
        self.stop.cancel();
        let task = lock(&self.task).take();
        if let Some(task) = task {
            let _ = task.await;
        }
    }

    fn close_now(&self) {
        self.stop.cancel();
        if let Some(task) = lock(&self.task).take() {
            task.abort();
        }
    }
}

impl Drop for SharedListener {
    fn drop(&mut self) {
        self.close_now();
    }
}

/// The registry state of the pool identity of `pool`, for the lifetime tests: the generation, the
/// subscriptions, the heartbeat users, and the listener users. `None` when it has no entry.
#[cfg(test)]
pub(super) fn entry_of(pool: &deadpool_postgres::Pool) -> Option<(u64, usize, usize, usize)> {
    let registry = lock(&REGISTRY);
    registry.get(&pool_key(pool)).map(|entry| {
        (entry.generation, entry.subscribers, entry.heartbeat_users, entry.listener_users)
    })
}

#[cfg(test)]
mod tests {
    use futures_util::FutureExt;

    use super::*;
    use crate::worker::scratch;

    fn pool() -> deadpool_postgres::Pool {
        let manager = deadpool_postgres::Manager::new(
            "postgresql://localhost/unused".parse().unwrap(),
            tokio_postgres::NoTls,
        );
        deadpool_postgres::Pool::builder(manager).max_size(3).build().unwrap()
    }

    /// Joins at once, and fails if a close must settle first.
    fn joined(pool: &deadpool_postgres::Pool, request: Request) -> Subscription {
        match try_subscribe(pool, request).unwrap() {
            Joined::Ready(subscription) => subscription,
            Joined::Wait(_) => panic!("the join waited for a close to settle"),
        }
    }

    fn request() -> Request {
        Request {
            dedicated: false,
            interval: Duration::from_secs(1),
            startup_deadline: Instant::now(),
            listen: None,
        }
    }

    /// A heartbeat connection whose group the tests use without a database.
    fn group_connection() -> Arc<HeartbeatConnection> {
        HeartbeatConnection::open(&pool(), Duration::from_secs(1), Instant::now())
    }

    fn batch(worker: &str) -> serde_json::Value {
        serde_json::json!({"workerId": worker, "leases": []})
    }

    fn workers(batches: &serde_json::Value) -> Vec<String> {
        let batches = batches.as_array().unwrap();
        batches.iter().map(|batch| batch["workerId"].as_str().unwrap().to_string()).collect()
    }

    fn lead(turn: Result<Turn<'_>, Error>) -> Lead<'_> {
        match turn.unwrap() {
            Turn::Lead(lead) => lead,
            Turn::Joined(_) => panic!("the round joined instead of leading"),
        }
    }

    fn row(batch: usize, task: &str) -> (usize, String, String) {
        (batch, task.into(), "accepted".into())
    }

    fn tasks(rows: &RoundRows) -> Vec<&str> {
        rows.iter().map(|(task, _)| task.as_str()).collect()
    }

    /// A round of `worker` with `batches` batches in its own task. It must join a transaction,
    /// and it returns the rows of that transaction.
    fn joining(
        connection: &Arc<HeartbeatConnection>,
        worker: &'static str,
        batches: usize,
        deadline: Instant,
    ) -> JoinHandle<Result<RoundRows, Error>> {
        let connection = Arc::clone(connection);
        tokio::spawn(async move {
            match connection.turn(vec![batch(worker); batches], deadline).await? {
                Turn::Joined(rows) => rows,
                Turn::Lead(_) => panic!("round {worker} led instead of joining"),
            }
        })
    }

    /// Lets the spawned rounds run until `count` rounds wait in the group.
    async fn waiting(connection: &HeartbeatConnection, count: usize) {
        timeout(WAIT, async {
            while lock(&connection.group).waiting.len() != count {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("{count} rounds never waited"));
    }

    // The first round leads. Rounds with an equal or later deadline join it just before the
    // statement, after the batches of the lead, and each round gets the rows of its own batches.
    #[tokio::test]
    async fn rounds_with_a_later_deadline_join_the_transaction_and_get_their_rows() {
        let connection = group_connection();
        let deadline = Instant::now() + WAIT;
        let mut first = lead(connection.turn(vec![batch("a")], deadline).await);
        let equal = joining(&connection, "b", 2, deadline);
        let later = joining(&connection, "c", 1, deadline + Duration::from_millis(1));
        waiting(&connection, 2).await;
        let batches = first.join();
        assert_eq!(first.joined(), 2);
        let mut order = workers(&batches);
        assert_eq!(order.remove(0), "a", "the batches of the lead come first");
        order.sort();
        assert_eq!(order, ["b", "b", "c"]);
        // The joined rounds can come in either order, so the rows follow the batches.
        let rows: Vec<_> = workers(&batches)
            .iter()
            .enumerate()
            .map(|(index, worker)| row(index + 1, &format!("{worker}{index}")))
            .collect();
        let expected = |worker: &str| {
            rows.iter()
                .filter(|(_, task, _)| task.starts_with(worker))
                .map(|(_, task, _)| task.clone())
                .collect::<Vec<_>>()
        };
        let (own, b, c) = (expected("a"), expected("b"), expected("c"));
        assert_eq!(tasks(&first.answer(Ok(rows)).unwrap()), own);
        drop(first);
        assert_eq!(tasks(&equal.await.unwrap().unwrap()), b);
        assert_eq!(tasks(&later.await.unwrap().unwrap()), c);
        // No transaction runs now, so the next round leads at once.
        drop(lead(connection.turn(vec![batch("d")], deadline).await));
    }

    // A round with an earlier deadline does not join. A round that arrives after the statement
    // went out does not join either. When the transaction ends, the waiting round with the
    // earliest deadline leads the next one, and the other round joins it.
    #[tokio::test]
    async fn the_waiting_round_with_the_earliest_deadline_leads_the_next_transaction() {
        let connection = group_connection();
        let deadline = Instant::now() + WAIT;
        let mut first = lead(connection.turn(vec![batch("a")], deadline).await);
        let earlier = {
            let connection = Arc::clone(&connection);
            tokio::spawn(async move {
                let mut next = lead(
                    connection.turn(vec![batch("e")], deadline - Duration::from_secs(1)).await,
                );
                let batches = workers(&next.join());
                let own = next.answer(Ok(vec![row(1, "e1"), row(2, "l1")])).unwrap();
                (batches, own)
            })
        };
        waiting(&connection, 1).await;
        assert_eq!(workers(&first.join()), ["a"], "a round with an earlier deadline joined");
        let late = joining(&connection, "l", 1, deadline + Duration::from_secs(1));
        waiting(&connection, 2).await;
        first.answer(Ok(vec![row(1, "a1")])).unwrap();
        drop(first);
        let (batches, own) = earlier.await.unwrap();
        assert_eq!(batches, ["e", "l"]);
        assert_eq!(tasks(&own), ["e1"]);
        assert_eq!(tasks(&late.await.unwrap().unwrap()), ["l1"]);
    }

    // A failed transaction gives every joined round the same failure.
    #[tokio::test]
    async fn every_joined_round_gets_the_failure_of_the_transaction() {
        let connection = group_connection();
        let deadline = Instant::now() + WAIT;
        let mut first = lead(connection.turn(vec![batch("a")], deadline).await);
        let joined = joining(&connection, "b", 1, deadline);
        waiting(&connection, 1).await;
        first.join();
        let error = first.answer(Err(Error::invalid("the statement failed"))).unwrap_err();
        assert_eq!(error.to_string(), "the statement failed");
        drop(first);
        let error = joined.await.unwrap().unwrap_err();
        assert_eq!(error.to_string(), "the statement failed");
    }

    // A dropped round cannot stop the group: a dropped lead hands the lead on, a dropped waiting
    // round leaves, a dropped round that got the lead hands it on, and a joined round of a dropped
    // lead fails. A waiting round whose deadline passes fails and leaves.
    #[tokio::test]
    async fn dropped_rounds_hand_the_lead_on() {
        let connection = group_connection();
        let deadline = Instant::now() + WAIT;
        let first = lead(connection.turn(vec![batch("a")], deadline).await);
        // A round that waits, and is dropped, leaves the group.
        let mut dropped = Box::pin(connection.turn(vec![batch("x")], deadline));
        assert!(dropped.as_mut().now_or_never().is_none());
        assert_eq!(lock(&connection.group).waiting.len(), 1);
        drop(dropped);
        assert_eq!(lock(&connection.group).waiting.len(), 0);
        // A round that expires while it waits fails and leaves.
        let expired = connection.turn(vec![batch("t")], Instant::now() + Duration::from_millis(20));
        let error = expired.await.err().expect("an expired round got a turn");
        assert_eq!(error.to_string(), "heartbeat round exceeded its deadline");
        assert_eq!(lock(&connection.group).waiting.len(), 0);
        // The lead goes to a round that the caller drops before it reads its turn.
        let mut handed = Box::pin(connection.turn(vec![batch("h")], deadline));
        assert!(handed.as_mut().now_or_never().is_none());
        let mut next = Box::pin(connection.turn(vec![batch("n")], deadline));
        assert!(next.as_mut().now_or_never().is_none());
        drop(first);
        drop(handed);
        let mut next = lead(next.await);
        // A lead that is dropped before it answers fails its joined rounds.
        let joined = joining(&connection, "j", 1, deadline);
        waiting(&connection, 1).await;
        next.join();
        drop(next);
        let error = joined.await.unwrap().unwrap_err();
        assert_eq!(error.to_string(), "the heartbeat transaction ended without an answer");
        drop(lead(connection.turn(vec![batch("z")], deadline).await));
    }

    // The pool identity depends on deadpool 0.13 (see the module documentation). If an upgrade
    // breaks the property, this test fails, not production.
    #[test]
    fn clones_share_one_identity_and_separate_pools_do_not() {
        let first = pool();
        let clone = first.clone();
        let second = pool();
        assert_eq!(pool_key(&first), pool_key(&clone), "two clones of one pool");
        assert_ne!(pool_key(&first), pool_key(&second), "two separate pools");
        let moved = clone;
        assert_eq!(pool_key(&first), pool_key(&moved), "a moved clone");
    }

    #[tokio::test]
    async fn the_last_release_removes_the_entry() {
        let pool = pool();
        let first = joined(&pool, request());
        let second = joined(&pool.clone(), request());
        let (generation, subscribers, _, _) = entry_of(&pool).unwrap();
        assert_eq!(subscribers, 2, "two clones of one pool share one entry");
        first.release(None).await;
        assert_eq!(entry_of(&pool), Some((generation, 1, 0, 0)));
        // A dropped subscription releases without a wait.
        drop(second);
        assert_eq!(entry_of(&pool), None);
    }

    // A subscription of an old generation cannot remove the entry of a new generation.
    #[tokio::test]
    async fn an_old_cleanup_cannot_remove_a_new_entry() {
        let pool = pool();
        let mut old = joined(&pool, request());
        let old_generation = old.generation;
        // The old entry goes, and the next subscription makes a new one at the same address.
        lock(&REGISTRY).remove(&old.key);
        let new = joined(&pool, request());
        assert_ne!(new.generation, old_generation);
        let cleanup = old.detach();
        assert!(cleanup.settled, "the old subscription found an entry to clean up");
        drop(cleanup);
        let (generation, subscribers, _, _) = entry_of(&pool).unwrap();
        assert_eq!((generation, subscribers), (new.generation, 1), "the old cleanup changed it");
        drop(old);
        new.release(None).await;
        assert_eq!(entry_of(&pool), None);
    }

    // A pool that is gone frees its address only after its entry goes. A new pool can then use the
    // same address, and it gets a new entry of a new generation.
    #[tokio::test]
    async fn a_recreated_pool_gets_a_new_generation() {
        let mut generations = Vec::new();
        for _ in 0..50 {
            let pool = pool();
            let subscription = joined(&pool, request());
            generations.push((pool_key(&pool), subscription.generation));
            subscription.release(None).await;
            assert_eq!(entry_of(&pool), None);
        }
        let mut unique = generations.iter().map(|(_, generation)| *generation).collect::<Vec<_>>();
        unique.dedup();
        assert_eq!(unique.len(), generations.len(), "a generation came back");
    }

    #[tokio::test]
    async fn a_different_listen_config_refuses_to_start() {
        let pool = pool();
        let listen = |dbname: &str| {
            let mut config = tokio_postgres::Config::new();
            config.host("127.0.0.1").port(1).user("unused").dbname(dbname);
            Some(Listen { config, queues: vec!["default".into()], wake: Arc::new(Notify::new()) })
        };
        let first = joined(&pool, Request { listen: listen("one"), ..request() });
        let same = joined(&pool, Request { listen: listen("one"), ..request() });
        let error = try_subscribe(&pool, Request { listen: listen("two"), ..request() })
            .err()
            .expect("a second listen_config was accepted");
        assert!(error.to_string().starts_with("worker listen_config differs"), "{error}");
        // A worker that does not listen can still join.
        let polling = joined(&pool, request());
        assert_eq!(entry_of(&pool).map(|entry| entry.3), Some(2), "one listener, two users");
        for subscription in [first, same, polling] {
            subscription.release(None).await;
        }
        assert_eq!(entry_of(&pool), None);
    }

    #[tokio::test]
    async fn the_listener_wakes_only_the_subscribers_of_the_named_queue() {
        let pool = pool();
        let mut config = tokio_postgres::Config::new();
        config.host("127.0.0.1").port(1).user("unused").dbname("unused");
        let subscribe_to = |queue: &str| {
            let wake = Arc::new(Notify::new());
            let listen = Listen {
                config: config.clone(),
                queues: vec![queue.into()],
                wake: Arc::clone(&wake),
            };
            (joined(&pool, Request { listen: Some(listen), ..request() }), wake)
        };
        let (emails, emails_wake) = subscribe_to("emails");
        let (reports, reports_wake) = subscribe_to("reports");
        let listener = Arc::clone(emails.listener.as_ref().unwrap());
        let woken = |wake: &Arc<Notify>| wake.notified().now_or_never().is_some();
        let send = |payload: Option<&str>| deliver(&listener.subscribers, payload);
        send(Some("emails"));
        assert!(woken(&emails_wake) && !woken(&reports_wake));
        send(Some("*"));
        assert!(woken(&emails_wake) && woken(&reports_wake));
        send(None);
        assert!(woken(&emails_wake) && woken(&reports_wake));
        send(Some("other"));
        assert!(!woken(&emails_wake) && !woken(&reports_wake));
        emails.release(None).await;
        reports.release(None).await;
    }

    // The lifetime tests below run whole workers on a scratch database. They wait for conditions,
    // not for fixed times. They use two runtime threads: the drop of the scratch database blocks
    // one thread, and the other still ends the connections, also after a failed assertion.

    const WAIT: Duration = Duration::from_secs(10);

    fn database_pool(database: &scratch::ScratchDatabase, size: usize) -> deadpool_postgres::Pool {
        let manager =
            deadpool_postgres::Manager::new(database.url().parse().unwrap(), tokio_postgres::NoTls);
        deadpool_postgres::Pool::builder(manager).max_size(size).build().unwrap()
    }

    fn lifetime_options() -> crate::WorkerOptions {
        crate::WorkerOptions {
            queues: vec!["lifetime".into()],
            polling_only: true,
            poll_interval: Some(Duration::from_millis(20)),
            lease_duration: Duration::from_millis(1_000),
            heartbeat_interval: Some(Duration::from_millis(300)),
            maintenance_interval: Duration::from_secs(60),
            shutdown_grace_period: Duration::from_millis(200),
            disable_registry: true,
            ..crate::WorkerOptions::default()
        }
    }

    type Run = (tokio::sync::oneshot::Sender<()>, JoinHandle<Result<(), Error>>);

    /// Runs `worker` until the returned sender fires.
    fn run(worker: &crate::Worker) -> Run {
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
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

    async fn stop((stop, running): Run) {
        let _ = stop.send(());
        timeout(WAIT, running).await.expect("the run never stopped").unwrap().unwrap();
    }

    /// Waits until `condition` holds, and fails with `what` after `WAIT`.
    async fn eventually(what: &str, mut condition: impl FnMut() -> bool) {
        timeout(WAIT, async {
            while !condition() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("{what}"));
    }

    /// Waits until the run of `worker` holds the shared heartbeat connection.
    async fn ready(worker: &crate::Worker) {
        eventually("the worker never held the heartbeat connection", || {
            worker.0.heartbeat_connection().is_some_and(|heartbeat| heartbeat.ready())
        })
        .await;
    }

    /// Connections that `pool` lends out now.
    fn lent(pool: &deadpool_postgres::Pool) -> usize {
        let status = pool.status();
        status.size - status.available
    }

    /// Waits until the pool identity of `pool` has no entry and the pool lends nothing out.
    async fn released(pool: &deadpool_postgres::Pool) {
        eventually("the shared connections outlived the last run", || {
            entry_of(pool).is_none() && lent(pool) == 0
        })
        .await;
    }

    /// Takes `count` connections from `pool`, waiting for each.
    async fn hold(pool: &deadpool_postgres::Pool, count: usize) -> Vec<deadpool_postgres::Object> {
        let mut held = Vec::new();
        for _ in 0..count {
            held.push(pool.get().await.unwrap());
        }
        held
    }

    /// Waits until a checkout waits for a connection of `pool`.
    async fn checkout_waits(pool: &deadpool_postgres::Pool) {
        eventually("no checkout waited", || pool.status().waiting > 0).await;
    }

    /// Discards the shared heartbeat connection of `worker`. The returned slot guard keeps the
    /// keeper from putting a replacement back until the test drops it.
    async fn lose_heartbeat(
        heartbeat: &HeartbeatConnection,
    ) -> tokio::sync::MutexGuard<'_, Option<deadpool_postgres::Object>> {
        let mut slot = heartbeat.connection().await;
        heartbeat.discard(&mut slot);
        slot
    }

    // A failed startup, a shutdown during startup, and a dropped run each leave no entry and no
    // reserved connection.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn every_ended_run_leaves_no_entry() {
        let Some(database) = scratch::scratch_database("shared_ended_runs").await else { return };
        let observer = database.connect().await;
        let pool = database_pool(&database, 3);
        let worker = crate::Worker::new(pool.clone(), lifetime_options()).unwrap();

        // Failed startup: the worker reserves the heartbeat connection, then the compatibility
        // check finds no schema.
        observer.batch_execute("ALTER SCHEMA workhorse RENAME TO workhorse_hidden").await.unwrap();
        let failed = worker.run(std::future::pending()).await;
        observer.batch_execute("ALTER SCHEMA workhorse_hidden RENAME TO workhorse").await.unwrap();
        assert!(matches!(failed, Err(Error::Compatibility { .. })), "{failed:?}");
        released(&pool).await;

        // Cancellation: a shutdown while startup waits for the heartbeat connection.
        let held = hold(&pool, 3).await;
        let started = run(&worker);
        checkout_waits(&pool).await;
        assert!(entry_of(&pool).is_some(), "the waiting run held no entry");
        stop(started).await;
        drop(held);
        released(&pool).await;

        // A dropped run: teardown leaves the shared connections in the background.
        let (_stop, running) = run(&worker);
        ready(&worker).await;
        running.abort();
        released(&pool).await;
    }

    // The heartbeat connection stays while any worker on the pool runs, and goes with the last.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_last_release_closes_the_shared_heartbeat_connection() {
        let Some(database) = scratch::scratch_database("shared_last_release").await else {
            return;
        };
        let pool = database_pool(&database, 4);
        let first = crate::Worker::new(pool.clone(), lifetime_options()).unwrap();
        let second = crate::Worker::new(pool.clone(), lifetime_options()).unwrap();
        let (first_run, second_run) = (run(&first), run(&second));
        ready(&first).await;
        ready(&second).await;
        let (generation, subscribers, heartbeat_users, _) = entry_of(&pool).unwrap();
        assert_eq!((subscribers, heartbeat_users), (2, 2));
        let shared = first.0.heartbeat_connection().unwrap();
        assert!(Arc::ptr_eq(&shared, &second.0.heartbeat_connection().unwrap()));
        drop(shared);
        stop(first_run).await;
        assert_eq!(entry_of(&pool), Some((generation, 1, 1, 0)));
        assert!(second.0.claims_allowed(), "the first stop closed the shared connection");
        stop(second_run).await;
        released(&pool).await;
    }

    // Each run of a worker, and each pool recreated at what can be the same address, gets a new
    // entry, and leaves none.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn repeated_runs_on_recreated_pools_leave_no_entry() {
        let Some(database) = scratch::scratch_database("shared_repeated_runs").await else {
            return;
        };
        let mut generations = std::collections::HashSet::new();
        let mut addresses = std::collections::HashSet::new();
        for _ in 0..4 {
            let pool = database_pool(&database, 3);
            addresses.insert(pool_key(&pool));
            let worker = crate::Worker::new(pool.clone(), lifetime_options()).unwrap();
            for _ in 0..3 {
                let running = run(&worker);
                ready(&worker).await;
                generations.insert(entry_of(&pool).unwrap().0);
                eventually("the run held more than the heartbeat connection", || lent(&pool) == 1)
                    .await;
                stop(running).await;
                released(&pool).await;
            }
        }
        assert_eq!(generations.len(), 12, "a run reused an entry");
        eprintln!("4 recreated pools used {} addresses", addresses.len());
    }

    fn quick_worker(
        pool: &deadpool_postgres::Pool,
        options: crate::WorkerOptions,
    ) -> crate::Worker {
        let worker = crate::Worker::new(pool.clone(), options).unwrap();
        worker.handle("lifetime.quick", |_: serde_json::Value, _| async {
            Ok(serde_json::Value::Null)
        });
        worker
    }

    async fn enqueue(queue: &crate::Queue<tokio_postgres::Client>) -> uuid::Uuid {
        let payload = serde_json::json!({});
        let options = crate::EnqueueOptions::default();
        queue.enqueue("lifetime.quick", &payload, options).await.unwrap().task_id
    }

    async fn state(
        operator: &crate::Admin<tokio_postgres::Client>,
        task: uuid::Uuid,
    ) -> crate::TaskState {
        operator.get_task(task).await.unwrap().unwrap().state
    }

    /// Waits until `task` succeeds, and fails with `what` after `WAIT`.
    async fn succeeded(
        operator: &crate::Admin<tokio_postgres::Client>,
        task: uuid::Uuid,
        what: &str,
    ) {
        timeout(WAIT, async {
            while state(operator, task).await != crate::TaskState::Succeeded {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("{what}"));
    }

    // A claim that waits for its connection reads the gate again when it gets one. The heartbeat
    // connection goes while the claim waits, so the claim sends nothing.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_claim_that_waited_for_its_connection_reads_the_gate_again() {
        let Some(database) = scratch::scratch_database("shared_claim_gate").await else { return };
        let queue = crate::Queue::connect(database.url(), "lifetime").await.unwrap();
        let operator = crate::Admin::connect(database.url()).await.unwrap();
        let task = enqueue(&queue).await;
        let pool = database_pool(&database, 3);
        let worker = quick_worker(&pool, lifetime_options());
        worker.0.reserve_for_test().await;
        // The heartbeat connection holds one of the 3 connections, and the test holds the rest.
        let held = hold(&pool, 2).await;
        let claim = tokio::spawn({
            let inner = Arc::clone(&worker.0);
            async move { inner.claim(1, 1).await }
        });
        checkout_waits(&pool).await;
        let heartbeat = worker.0.heartbeat_connection().unwrap();
        let slot = lose_heartbeat(&heartbeat).await;
        drop(held);
        let (tasks, error) = claim.await.unwrap();
        assert!(tasks.is_empty(), "a claim ran without the heartbeat connection");
        assert!(error.is_none(), "a closed gate is no claim failure: {error:?}");
        assert_eq!(state(&operator, task).await, crate::TaskState::Ready);
        // The replacement opens the gate again.
        drop(slot);
        heartbeat.wait_ready().await;
        let (tasks, error) = worker.0.claim(1, 1).await;
        assert_eq!((tasks.len(), error.map(|error| error.to_string())), (1, None));
        worker.0.release_subscription(None).await;
    }

    // A fast-tier completion that waits for its connection reads the gate again when it gets one.
    // The heartbeat connection goes while it waits, so it completes with a claim limit of zero.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_queued_completion_claims_nothing_after_the_heartbeat_connection_goes() {
        let Some(database) = scratch::scratch_database("shared_completion_gate").await else {
            return;
        };
        let pool = database_pool(&database, 3);
        let (worker, task) = fast_worker_with_a_claim(&database, &pool).await;
        let held = hold(&pool, 2).await;
        let completion = tokio::spawn({
            let inner = Arc::clone(&worker.0);
            async move { inner.complete_batched(&task, serde_json::Value::Null, 1, 0).await }
        });
        checkout_waits(&pool).await;
        let heartbeat = worker.0.heartbeat_connection().unwrap();
        let slot = lose_heartbeat(&heartbeat).await;
        drop(held);
        let (accepted, claimed) = completion.await.unwrap().unwrap();
        assert!(accepted, "the completion did not settle its task");
        assert!(claimed.is_empty(), "a completion claimed without the heartbeat connection");
        drop(slot);
        heartbeat.wait_ready().await;
        // The second task stayed in the queue.
        let (tasks, error) = worker.0.claim(1, 1).await;
        assert_eq!((tasks.len(), error.map(|error| error.to_string())), (1, None));
        worker.0.release_subscription(None).await;
    }

    // After the database refuses connections and the heartbeat connection is lost, the keeper
    // retries without any active task. When the database accepts connections again, the worker
    // claims at once. While the gate is closed, the dispatch loop sets no poll timer. Thus no poll
    // can start that claim.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn claims_resume_at_once_when_the_heartbeat_connection_returns() {
        let Some(database) = scratch::scratch_database("shared_claim_resume").await else {
            return;
        };
        // A database cannot disallow connections to itself, so this client uses the admin database.
        let (admin, connection) = database.admin().connect(tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(connection);
        let queue = crate::Queue::connect(database.url(), "lifetime").await.unwrap();
        let operator = crate::Admin::connect(database.url()).await.unwrap();
        let pool = database_pool(&database, 3);
        let options = crate::WorkerOptions {
            poll_interval: Some(Duration::from_secs(60)),
            ..lifetime_options()
        };
        let worker = quick_worker(&pool, options);
        // A first task proves that startup ended and that the worker claims. The test enqueues it
        // before the run starts, so the first claim gets it and no poll wait comes before it.
        let first = enqueue(&queue).await;
        let running = run(&worker);
        succeeded(&operator, first, "the first task never ran").await;
        let allow = |allowed: bool| {
            format!("ALTER DATABASE \"{}\" ALLOW_CONNECTIONS {allowed}", database.name())
        };
        // The test holds every connection but the heartbeat connection, then the pool cannot open
        // a new one. The test takes them while the database still accepts connections. Thus each
        // checkout opens a connection, or it waits for a claim in flight to return one. If the
        // database refused connections first, a checkout could fail while a claim held a
        // connection. The keeper would then get that connection when the claim returned it.
        let held = hold(&pool, 2).await;
        admin.batch_execute(&allow(false)).await.unwrap();
        let heartbeat = worker.0.heartbeat_connection().unwrap();
        drop(lose_heartbeat(&heartbeat).await);
        let task = enqueue(&queue).await;
        assert!(!worker.0.claims_allowed());
        eventually("the keeper never retried", || heartbeat.failed_acquisitions() >= 2).await;
        assert!(!worker.0.claims_allowed(), "the keeper found a connection");
        assert_eq!(state(&operator, task).await, crate::TaskState::Ready);
        admin.batch_execute(&allow(true)).await.unwrap();
        drop(held);
        let after = "the worker did not claim when the heartbeat connection returned";
        succeeded(&operator, task, after).await;
        stop(running).await;
        released(&pool).await;
    }

    // The last release closes the gate, then waits for the claim attempt in flight before it
    // closes the connection. While the close runs, the entry stays, and a new run on the pool
    // waits for it. After the close settles, the entry goes.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_last_release_waits_for_a_claim_in_flight_and_a_new_run_waits_for_the_release() {
        let Some(database) = scratch::scratch_database("shared_release_claims").await else {
            return;
        };
        let pool = database_pool(&database, 3);
        let worker = crate::Worker::new(pool.clone(), lifetime_options()).unwrap();
        worker.0.reserve_for_test().await;
        let heartbeat = worker.0.heartbeat_connection().unwrap();
        let generation = entry_of(&pool).unwrap().0;
        // A claim statement that passed the gate holds this permit until it ends.
        let attempt = heartbeat.claim_permit().expect("the gate was closed");
        let attempt_ended = Arc::new(AtomicBool::new(false));
        let release = tokio::spawn({
            let (inner, attempt_ended) = (Arc::clone(&worker.0), Arc::clone(&attempt_ended));
            async move {
                inner.release_subscription(None).await;
                attempt_ended.load(Ordering::SeqCst)
            }
        });
        eventually("the release never left the entry", || {
            entry_of(&pool) == Some((generation, 0, 0, 0))
        })
        .await;
        // The cleanup task closes the gate when it first runs.
        eventually("the release left the gate open", || !heartbeat.ready()).await;
        assert!(heartbeat.claim_permit().is_none(), "a new claim passed the closing gate");
        let request = crate::worker::shared::Request {
            dedicated: true,
            interval: Duration::from_millis(300),
            startup_deadline: Instant::now(),
            listen: None,
        };
        assert!(
            matches!(try_subscribe(&pool, request.clone()), Ok(Joined::Wait(_))),
            "a new run opened a second heartbeat connection while the old one closed"
        );
        attempt_ended.store(true, Ordering::SeqCst);
        drop(attempt);
        assert!(release.await.unwrap(), "the release ended before the claim attempt");
        assert_eq!(entry_of(&pool), None);
        assert!(!heartbeat.keeping(), "the keeper outlived the release");
        let joined = joined(&pool, request);
        assert_ne!(joined.generation, generation);
        joined.release(None).await;
        released(&pool).await;
    }

    // A release whose future is dropped while it waits still settles its cleanup. A background
    // task owns the rest of it: the entry stays closing until the claim attempt in flight and the
    // round in flight end.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_dropped_release_still_settles_its_cleanup() {
        let Some(database) = scratch::scratch_database("shared_dropped_release").await else {
            return;
        };
        let pool = database_pool(&database, 3);
        let worker = crate::Worker::new(pool.clone(), lifetime_options()).unwrap();
        worker.0.reserve_for_test().await;
        let heartbeat = worker.0.heartbeat_connection().unwrap();
        let generation = entry_of(&pool).unwrap().0;
        let attempt = heartbeat.claim_permit().expect("the gate was closed");
        let round = heartbeat.connection().await;
        let release = tokio::spawn({
            let inner = Arc::clone(&worker.0);
            async move { inner.release_subscription(None).await }
        });
        let closing = Some((generation, 0, 0, 0));
        eventually("the release never left the entry", || entry_of(&pool) == closing).await;
        release.abort();
        assert!(release.await.unwrap_err().is_cancelled());
        assert_eq!(entry_of(&pool), closing, "the entry went before its claim attempt ended");
        drop(attempt);
        eventually("the keeper outlived a dropped release", || !heartbeat.keeping()).await;
        assert_eq!(entry_of(&pool), closing, "the entry went before its round returned");
        drop(round);
        eventually("a dropped release never settled", || entry_of(&pool).is_none()).await;
        drop(heartbeat);
        released(&pool).await;
    }

    // SM-1572 review: a round that outlives the cleanup deadline keeps the entry closing until it
    // returns its connection. A new run on the pool waits for it and does not open a second
    // heartbeat connection.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_round_past_the_cleanup_deadline_keeps_the_entry_until_it_returns() {
        let Some(database) = scratch::scratch_database("shared_late_round").await else {
            return;
        };
        let pool = database_pool(&database, 3);
        let worker = crate::Worker::new(pool.clone(), lifetime_options()).unwrap();
        worker.0.reserve_for_test().await;
        let heartbeat = worker.0.heartbeat_connection().unwrap();
        let generation = entry_of(&pool).unwrap().0;
        // A round in flight holds the connection.
        let round = heartbeat.connection().await;
        let deadline = Instant::now() + Duration::from_millis(100);
        worker.0.release_subscription(Some(deadline)).await;
        assert_eq!(
            entry_of(&pool),
            Some((generation, 0, 0, 0)),
            "the entry went with the deadline"
        );
        let request = Request {
            dedicated: true,
            interval: Duration::from_millis(300),
            startup_deadline: Instant::now(),
            listen: None,
        };
        assert!(
            matches!(try_subscribe(&pool, request.clone()), Ok(Joined::Wait(_))),
            "a new run opened a second heartbeat connection while the late round held the first"
        );
        drop(round);
        eventually("the late round never settled", || entry_of(&pool).is_none()).await;
        let joined = joined(&pool, request);
        assert_ne!(joined.generation, generation);
        joined.release(None).await;
        drop(heartbeat);
        released(&pool).await;
    }

    /// Makes the queue `lifetime` a fast-tier queue, enqueues two tasks on it, and starts a worker
    /// that holds the shared heartbeat connection and has claimed the first task.
    async fn fast_worker_with_a_claim(
        database: &scratch::ScratchDatabase,
        pool: &deadpool_postgres::Pool,
    ) -> (crate::Worker, crate::ClaimedTask) {
        let operator = crate::Admin::connect(database.url()).await.unwrap();
        let audit = crate::AdminAudit {
            actor: "ops".into(),
            reason: "test".into(),
            request_id: "req-1".into(),
        };
        let tier = operator.set_queue_tier("lifetime", crate::QueueTier::Fast, &audit).await;
        assert_eq!(tier.unwrap(), crate::QueueTier::Fast);
        let queue = crate::Queue::connect(database.url(), "lifetime").await.unwrap();
        enqueue(&queue).await;
        enqueue(&queue).await;
        let worker = quick_worker(pool, lifetime_options());
        worker.0.reserve_for_test().await;
        let (mut tasks, error) = worker.0.claim(1, 1).await;
        assert!(error.is_none(), "{error:?}");
        let task = tasks.pop().expect("the first claim found no task");
        assert!(task.fast_tier);
        (worker, task)
    }

    // SM-1572 review: the gate only sets the claim limit of a completion. A completion with a
    // claim limit of zero settles its task while the gate is closed.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_completion_with_a_closed_gate_settles_its_task_and_claims_nothing() {
        let Some(database) = scratch::scratch_database("shared_closed_completion").await else {
            return;
        };
        let pool = database_pool(&database, 3);
        let (worker, task) = fast_worker_with_a_claim(&database, &pool).await;
        let heartbeat = worker.0.heartbeat_connection().unwrap();
        let slot = lose_heartbeat(&heartbeat).await;
        assert!(!worker.0.claims_allowed());
        let completed = worker.0.complete_batched(&task, serde_json::Value::Null, 0, 0).await;
        let (accepted, claimed) = completed.expect("the closed gate stopped the settlement");
        assert!(accepted, "the completion did not settle its task");
        assert!(claimed.is_empty());
        drop(slot);
        heartbeat.wait_ready().await;
        let (tasks, error) = worker.0.claim(1, 1).await;
        assert_eq!((tasks.len(), error.map(|error| error.to_string())), (1, None));
        worker.0.release_subscription(None).await;
    }

    // SM-1572 review: a completion batch keeps the gate of the run that submitted it. The batch
    // waits for its connection while its run ends and the next run opens its own gate, so it
    // settles its task and claims nothing.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_batch_that_outlives_its_run_claims_nothing_in_the_next_run() {
        let Some(database) = scratch::scratch_database("shared_old_batch").await else {
            return;
        };
        let pool = database_pool(&database, 3);
        let (worker, task) = fast_worker_with_a_claim(&database, &pool).await;
        // The heartbeat connection holds one of the 3 connections, and the test holds the rest.
        let held = hold(&pool, 2).await;
        let batch = tokio::spawn({
            let inner = Arc::clone(&worker.0);
            async move { inner.complete_batched(&task, serde_json::Value::Null, 1, 0).await }
        });
        checkout_waits(&pool).await;
        // The run ends, and the next run starts on the same shared heartbeat connection.
        worker.0.end_run();
        let ended = lock(&worker.0.subscription).take();
        worker.0.reserve_for_test().await;
        assert!(worker.0.claims_allowed(), "the next run has no open gate");
        drop(held);
        let (accepted, claimed) = batch.await.unwrap().unwrap();
        assert!(accepted, "the old batch did not settle its task");
        assert!(claimed.is_empty(), "an old batch claimed through the gate of the next run");
        if let Some(ended) = ended {
            ended.release(None).await;
        }
        let (tasks, error) = worker.0.claim(1, 1).await;
        assert_eq!((tasks.len(), error.map(|error| error.to_string())), (1, None));
        worker.0.release_subscription(None).await;
    }

    /// A server that accepts connections and never answers. It counts the connections that are
    /// still open: each one counts until its client closes it.
    fn counting_silent_server() -> (u16, Arc<std::sync::atomic::AtomicUsize>) {
        use std::io::Read;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let open = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = Arc::clone(&open);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                counted.fetch_add(1, Ordering::SeqCst);
                let counted = Arc::clone(&counted);
                std::thread::spawn(move || {
                    let mut buffer = [0; 1024];
                    while matches!(stream.read(&mut buffer), Ok(read) if read > 0) {}
                    counted.fetch_sub(1, Ordering::SeqCst);
                });
            }
        });
        (port, open)
    }

    // An acquisition that reaches its bound is cancelled before the next one starts, so repeated
    // timeouts leave no pending connection. The server accepts connections and never answers.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_timed_out_acquisition_settles_before_the_next_one() {
        let (port, open) = counting_silent_server();
        let mut config = deadpool_postgres::Config::new();
        config.host = Some("127.0.0.1".into());
        config.port = Some(port);
        config.user = Some("unused".into());
        config.dbname = Some("unused".into());
        config.pool = Some(deadpool_postgres::PoolConfig::new(3));
        let pool = config
            .create_pool(Some(deadpool_postgres::Runtime::Tokio1), tokio_postgres::NoTls)
            .unwrap();
        let request = Request {
            dedicated: true,
            interval: Duration::from_millis(100),
            startup_deadline: Instant::now(),
            listen: None,
        };
        let subscription = joined(&pool, request);
        let heartbeat = Arc::clone(subscription.heartbeat().unwrap());
        let open_connections = || open.load(Ordering::SeqCst);
        for failed in 1..=3 {
            eventually("the keeper never retried", || heartbeat.failed_acquisitions() >= failed)
                .await;
            // The connection of the timed-out acquisition closes. Only the next one can be open.
            eventually("timed-out acquisitions stayed open", || open_connections() <= 1).await;
        }
        subscription.release(None).await;
        assert!(!heartbeat.keeping());
        eventually("an acquisition outlived the release", || open_connections() == 0).await;
    }

    // SM-1572 review round 2: a cancelled release must not end the cleanup. These tests cancel
    // the caller at each wait of the close: a claim permit without a round guard, the join of the
    // keeper, and the join of the listener. The cleanup task keeps the entry closing and the
    // reservation until each one ends.

    /// Starts a release of the subscription of `worker` and waits until it left the entry, so the
    /// close runs. Then it cancels the caller of the release.
    async fn cancel_release(
        worker: &crate::Worker,
        pool: &deadpool_postgres::Pool,
        closing: Option<(u64, usize, usize, usize)>,
    ) {
        let release = tokio::spawn({
            let inner = Arc::clone(&worker.0);
            async move { inner.release_subscription(None).await }
        });
        eventually("the release never left the entry", || entry_of(pool) == closing).await;
        release.abort();
        assert!(release.await.unwrap_err().is_cancelled());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_cancelled_release_keeps_the_reservation_while_a_claim_permit_is_held() {
        let Some(database) = scratch::scratch_database("shared_cancel_permit").await else {
            return;
        };
        let pool = database_pool(&database, 3);
        let worker = crate::Worker::new(pool.clone(), lifetime_options()).unwrap();
        worker.0.reserve_for_test().await;
        let heartbeat = worker.0.heartbeat_connection().unwrap();
        let closing = Some((entry_of(&pool).unwrap().0, 0, 0, 0));
        // A claim statement is in flight. No round holds the connection.
        let attempt = heartbeat.claim_permit().expect("the gate was closed");
        cancel_release(&worker, &pool, closing).await;
        assert_eq!(entry_of(&pool), closing, "the entry went while a claim was in flight");
        assert_eq!(lent(&pool), 1, "the reservation went while a claim was in flight");
        drop(attempt);
        drop(heartbeat);
        released(&pool).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_cancelled_release_keeps_the_entry_until_the_keeper_ends() {
        let Some(database) = scratch::scratch_database("shared_cancel_keeper").await else {
            return;
        };
        let pool = database_pool(&database, 3);
        let worker = crate::Worker::new(pool.clone(), lifetime_options()).unwrap();
        worker.0.reserve_for_test().await;
        let heartbeat = worker.0.heartbeat_connection().unwrap();
        let closing = Some((entry_of(&pool).unwrap().0, 0, 0, 0));
        // An abort cannot end a blocking task that has started, so this keeper ends only when the
        // test lets it. Tokio can still cancel a blocking task that has not started, so the test
        // waits until the task runs before the close can abort it.
        let (end_keeper, keeper_runs) = std::sync::mpsc::channel::<()>();
        let (keeper_started, started) = tokio::sync::oneshot::channel::<()>();
        let keeper = tokio::task::spawn_blocking(move || {
            let _ = keeper_started.send(());
            let _ = keeper_runs.recv();
        });
        timeout(WAIT, started).await.expect("the blocking keeper never started").unwrap();
        if let Some(real) = heartbeat.hold_keeper_for_test(keeper) {
            real.abort();
        }
        cancel_release(&worker, &pool, closing).await;
        assert_eq!(entry_of(&pool), closing, "the entry went while the keeper still ran");
        assert_eq!(lent(&pool), 1, "the reservation went while the keeper still ran");
        end_keeper.send(()).unwrap();
        drop(heartbeat);
        released(&pool).await;
    }

    /// A proxy to `database` that forwards every client message until it sees `marker`. It then
    /// swallows that message and the rest, and sends on the returned receiver.
    async fn swallowing_proxy(
        database: &scratch::ScratchDatabase,
        marker: &'static [u8],
    ) -> (tokio_postgres::Config, tokio::sync::oneshot::Receiver<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let upstream: tokio_postgres::Config = database.url().parse().unwrap();
        let tokio_postgres::config::Host::Tcp(host) = &upstream.get_hosts()[0] else {
            panic!("the test database must be reachable over TCP");
        };
        let address = (host.clone(), upstream.get_ports()[0]);
        let proxy = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut config = tokio_postgres::Config::new();
        config.host("127.0.0.1").port(proxy.local_addr().unwrap().port());
        config.user(upstream.get_user().unwrap()).dbname(upstream.get_dbname().unwrap());
        if let Some(password) = upstream.get_password() {
            config.password(password);
        }
        let (swallowed, seen) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let (client, _) = proxy.accept().await.unwrap();
            let server = tokio::net::TcpStream::connect(address).await.unwrap();
            let (mut client_reader, mut client_writer) = client.into_split();
            let (mut server_reader, mut server_writer) = server.into_split();
            tokio::spawn(async move {
                let _ = tokio::io::copy(&mut server_reader, &mut client_writer).await;
            });
            let mut swallowed = Some(swallowed);
            let mut buffer = vec![0; 8192];
            loop {
                let read = match client_reader.read(&mut buffer).await {
                    Ok(0) | Err(_) => return,
                    Ok(read) => read,
                };
                let chunk = &buffer[..read];
                if swallowed.is_none() || chunk.windows(marker.len()).any(|part| part == marker) {
                    if let Some(swallowed) = swallowed.take() {
                        let _ = swallowed.send(());
                    }
                    continue;
                }
                if server_writer.write_all(chunk).await.is_err() {
                    return;
                }
            }
        });
        (config, seen)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_cancelled_release_keeps_the_entry_until_the_listener_ends() {
        let Some(database) = scratch::scratch_database("shared_cancel_listener").await else {
            return;
        };
        let pool = database_pool(&database, 3);
        // The listener's UNLISTEN never gets an answer, so the listener waits for it.
        let (config, unlisten_sent) = swallowing_proxy(&database, b"UNLISTEN").await;
        let listen = Listen { config, queues: vec!["lifetime".into()], wake: Arc::default() };
        let subscription = joined(&pool, Request { listen: Some(listen), ..request() });
        let listening = subscription.listening().unwrap();
        eventually("the listener never listened", || listening.load(Ordering::SeqCst)).await;
        let closing = Some((entry_of(&pool).unwrap().0, 0, 0, 0));
        let release = tokio::spawn(subscription.release(None));
        timeout(WAIT, unlisten_sent).await.expect("the listener never sent UNLISTEN").unwrap();
        release.abort();
        assert!(release.await.unwrap_err().is_cancelled());
        assert_eq!(entry_of(&pool), closing, "the entry went while the listener still ran");
        eventually("the listener never ended", || entry_of(&pool).is_none()).await;
    }
}
