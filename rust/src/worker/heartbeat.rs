//! One batched lease renewal per interval for every task a worker owns.
//!
//! Every worker on one pool identity sends its rounds on one shared heartbeat connection
//! (`shared::HeartbeatConnection`), which the first worker reserves before handlers can exhaust
//! the pool. Each worker keeps its own schedule, and the rounds that wait for the connection share
//! one transaction and one `heartbeat_pool_v1` statement. A transaction that fails or outlives
//! its deadline discards that connection, and the keeper of the connection takes a replacement at
//! once. A round that expires before it sends its heartbeat statement rolls back and keeps the
//! connection, because no statement of it can still run. Server timeouts end the round's heartbeat
//! statement and its idle waits by the same deadline; a `COMMIT` that PostgreSQL has already
//! started can finish later.
//!
//! A lease whose row another transaction holds comes back `busy`: no renewal and no ownership
//! verdict. A short busy retry then renews only those leases before the next regular round.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;
use tokio::sync::{mpsc, Notify};
use tokio::time::{timeout_at, Instant};
use uuid::Uuid;

use super::{random_fraction, shared, Inner, OwnershipStatus};
use crate::sql_catalogue_generated as sql;
use crate::telemetry::{Attribute, Counter};
use crate::Error;

/// What one round reports to the supervising execution. A busy lease gets no beat.
pub(super) enum Beat {
    /// PostgreSQL accepted the renewal sent at this instant, which is when the new lease started.
    Renewed(Instant),
    Rejected(OwnershipStatus),
}

/// The answer for one lease of a round.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum LeaseStatus {
    /// Another transaction held the row. The lease got no renewal and no ownership verdict.
    Busy,
    Owner(OwnershipStatus),
}

impl LeaseStatus {
    fn parse(status: Option<&str>) -> Result<Self, Error> {
        match status {
            Some("busy") => Ok(Self::Busy),
            other => OwnershipStatus::parse(other).map(Self::Owner),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Busy => "busy",
            Self::Owner(status) => status.as_str(),
        }
    }
}

/// The base of the delay before a busy retry, at most. The retry waits `base × (1 + random)`, with
/// `base = min(BUSY_RETRY_BASE, interval / 8)`.
const BUSY_RETRY_BASE: Duration = Duration::from_millis(100);

/// The part of `BUSY_RETRY_MINIMUM` above `MINIMUM_REMAINING`.
const BUSY_RETRY_MARGIN: Duration = Duration::from_millis(12);

/// A bounded busy retry with less time than this before its deadline does not run. It is the time
/// a round needs at the settings statement, plus a margin for the payload, the wait for the
/// connection, and BEGIN.
const BUSY_RETRY_MINIMUM: Duration = MINIMUM_REMAINING.saturating_add(BUSY_RETRY_MARGIN);

/// Whether a bounded busy retry that starts at `started` has too little time before `deadline`.
/// Such a retry sends nothing, and the next regular round renews its leases.
fn busy_retry_too_short(started: Instant, deadline: Instant) -> bool {
    deadline.saturating_duration_since(started) < BUSY_RETRY_MINIMUM
}

/// The delay before a busy retry for `interval`. The jitter keeps two workers from meeting the
/// same lock holder in step. Every SDK uses the same formula.
fn busy_retry_delay(interval: Duration) -> Duration {
    BUSY_RETRY_BASE.min(interval / 8).mul_f64(1.0 + random_fraction())
}

/// One membership that a round sent. A result reaches a lease only while this registration stays.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Sent {
    task: Uuid,
    fence: i64,
    registration: u64,
}

/// One task's place in the rounds. Dropping it, including with a dropped execution, stops renewals.
pub(super) struct Membership {
    inner: Arc<Inner>,
    task: Uuid,
    registration: u64,
    pub(super) beats: mpsc::Receiver<Beat>,
}

impl Membership {
    /// Stops renewing this claim. A later claim of the same task stays.
    pub(super) fn leave(&self) {
        let heartbeats = &self.inner.heartbeats;
        let mut state = heartbeats.state();
        if state.member(self.task, self.registration).is_some() {
            state.members.remove(&self.task);
        }
        if state.members.is_empty() {
            heartbeats.wake.notify_one();
        }
    }
}

impl Drop for Membership {
    fn drop(&mut self) {
        self.leave();
    }
}

/// Holds a round at its start until the returned future resolves. The round keeps the value of
/// that future until the round ends. Only the conformance runner sets one
/// (`Worker::hold_heartbeat_rounds_for_test`, behind the internal `__conformance-hooks` feature).
#[cfg(feature = "__conformance-hooks")]
pub(super) type RoundGate = Arc<
    dyn Fn() -> futures_util::future::BoxFuture<'static, Box<dyn std::any::Any + Send>>
        + Send
        + Sync,
>;

#[derive(Default)]
pub(super) struct Heartbeats {
    state: Mutex<State>,
    wake: Notify,
    #[cfg(feature = "__conformance-hooks")]
    round_gate: Mutex<Option<RoundGate>>,
    /// Answers the rounds in place of PostgreSQL in unit tests.
    #[cfg(test)]
    fake_round: Mutex<Option<tests::FakeRound>>,
}

/// One registered lease.
struct Member {
    fence: i64,
    /// Unique for each registration of the worker, so a result reaches only the membership that the
    /// round sent.
    registration: u64,
    sender: mpsc::Sender<Beat>,
    /// The end of the local lease window: the claim or the latest delivered renewal, plus the
    /// lease. The watchdog of the execution ends the attempt at the same instant.
    lease_ends_at: Instant,
}

#[derive(Default)]
struct State {
    members: HashMap<Uuid, Member>,
    registrations: u64,
    running: bool,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl State {
    /// The member with this registration, if it is still registered.
    fn member(&self, task: Uuid, registration: u64) -> Option<&Member> {
        self.members.get(&task).filter(|member| member.registration == registration)
    }

    /// Every registered membership, for a regular round.
    fn all(&self) -> Vec<Sent> {
        self.members
            .iter()
            .map(|(task, member)| Sent {
                task: *task,
                fence: member.fence,
                registration: member.registration,
            })
            .collect()
    }

    /// The busy memberships that a retry can still renew at `now`, and the earliest end of their
    /// lease windows. A membership that left or was replaced is gone, and a lease whose window
    /// ended belongs to the watchdog.
    fn retry_selection(&self, busy: Vec<Sent>, now: Instant) -> Option<(Vec<Sent>, Instant)> {
        let mut earliest: Option<Instant> = None;
        let selection: Vec<Sent> = busy
            .into_iter()
            .filter(|sent| {
                let Some(member) = self.member(sent.task, sent.registration) else { return false };
                if member.lease_ends_at <= now {
                    return false;
                }
                earliest =
                    Some(earliest.map_or(member.lease_ends_at, |at| at.min(member.lease_ends_at)));
                true
            })
            .collect();
        earliest.map(|earliest| (selection, earliest))
    }
}

impl Heartbeats {
    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Holds each later round at its start with `gate`.
    #[cfg(feature = "__conformance-hooks")]
    pub(super) fn set_round_gate(&self, gate: RoundGate) {
        *self.round_gate.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(gate);
    }

    #[cfg(feature = "__conformance-hooks")]
    fn round_gate(&self) -> Option<RoundGate> {
        self.round_gate.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
    }
}

/// The failure of a round that its own deadline ended, while it waited for the transaction of the
/// other rounds, for the connection, or for PostgreSQL.
pub(super) const DEADLINE_EXCEEDED: &str = "heartbeat round exceeded its deadline";

/// The failure of a round whose deadline came before it sent its heartbeat statement.
const DEADLINE_BEFORE_STATEMENT: &str = "heartbeat round reached its deadline before the statement";

/// The failure of a round whose `COMMIT` returned after its deadline.
const DEADLINE_AFTER_COMMIT: &str = "heartbeat round reached its deadline after the commit";

/// The failure of a round that found the heartbeat connection closed.
const CONNECTION_CLOSED: &str = "the heartbeat connection closed";

/// The bounded `workhorse.heartbeat.failure_reason` values of a failed heartbeat round.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum RoundFailureReason {
    Timeout,
    Connection,
    Database,
    Other,
}

impl RoundFailureReason {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Timeout => "timeout",
            Self::Connection => "connection",
            Self::Database => "database",
            Self::Other => "other",
        }
    }
}

/// The most errors of a source chain that `heartbeat_round_failure_reason` reads.
const FAILURE_CHAIN_LIMIT: usize = 16;

/// The category of a failed heartbeat round. It reads the error and at most
/// `FAILURE_CHAIN_LIMIT` errors of its `source` chain, and the first rule that matches wins:
///
/// 1. `timeout`: one of the round's own deadline failures (`DEADLINE_EXCEEDED`,
///    `DEADLINE_BEFORE_STATEMENT`, `DEADLINE_AFTER_COMMIT`), or SQLSTATE `57014`
///    (`statement_timeout`) or `25P03` (`idle_in_transaction_session_timeout`).
/// 2. `connection`: the round did not reach PostgreSQL or lost its connection. This is a
///    `std::io::Error` (also a socket or connect timeout), a closed `tokio_postgres` connection, a
///    closed heartbeat connection (`CONNECTION_CLOSED`), SQLSTATE class `08`, or `57P01` to `57P03`
///    (server shutdown). It is also a pool that had no connection for the round: a closed pool
///    (`PoolError::Closed`), or any pool timeout (`PoolError::Timeout`) at the pool's own wait,
///    create, or recycle limit.
/// 3. `database`: any other SQLSTATE.
/// 4. `other`: everything else, such as an invalid answer or a pool without a runtime
///    (`PoolError::NoRuntimeSpecified`, a configuration error).
///
/// A `PoolError::Backend` or `PoolError::PostCreateHook` error gets the reason of its source.
///
/// A round never uses sqlx, so no sqlx error is classified. A round that joined the transaction
/// of another worker gets a text copy of the failure (`Error::share`), so the lead classifies the
/// original error for it (`RoundFailure::shared`).
pub(super) fn heartbeat_round_failure_reason(error: &Error) -> RoundFailureReason {
    let mut deadline = false;
    let mut connection = false;
    let mut sqlstates: Vec<String> = Vec::new();
    let mut entry: Option<&(dyn std::error::Error + 'static)> = Some(error);
    for _ in 0..FAILURE_CHAIN_LIMIT {
        let Some(current) = entry else { break };
        if let Some(error) = current.downcast_ref::<Error>() {
            if let Error::InvalidArgument(message) = error {
                let message = message.as_str();
                deadline |= [DEADLINE_EXCEEDED, DEADLINE_BEFORE_STATEMENT, DEADLINE_AFTER_COMMIT]
                    .contains(&message);
                connection |= message == CONNECTION_CLOSED;
            }
            if let Error::Pool(
                deadpool_postgres::PoolError::Closed | deadpool_postgres::PoolError::Timeout(_),
            ) = error
            {
                connection = true;
            }
            sqlstates.extend(error.sqlstate().map(str::to_owned));
        } else if let Some(error) = current.downcast_ref::<tokio_postgres::Error>() {
            connection |= error.is_closed();
            sqlstates.extend(error.code().map(|code| code.code().to_owned()));
        } else if let Some(error) = current.downcast_ref::<tokio_postgres::error::DbError>() {
            sqlstates.push(error.code().code().to_owned());
        } else if current.is::<std::io::Error>() {
            connection = true;
        }
        entry = current.source();
    }
    let any = |test: fn(&str) -> bool| sqlstates.iter().any(|code| test(code));
    if deadline || any(|code| code == "57014" || code == "25P03") {
        RoundFailureReason::Timeout
    } else if connection
        || any(|code| code.starts_with("08") || ["57P01", "57P02", "57P03"].contains(&code))
    {
        RoundFailureReason::Connection
    } else if sqlstates.is_empty() {
        RoundFailureReason::Other
    } else {
        RoundFailureReason::Database
    }
}

/// A failed round, and the reason of the error that ended it.
#[derive(Debug)]
pub(super) struct RoundFailure {
    pub(super) error: Error,
    pub(super) reason: RoundFailureReason,
}

impl RoundFailure {
    /// The failure of a round that joined the transaction that `error` ended. The error is the
    /// text copy of `Error::share`, so the reason comes from the original error.
    pub(super) fn shared(error: &Error) -> Self {
        Self { error: error.share(), reason: heartbeat_round_failure_reason(error) }
    }
}

impl From<Error> for RoundFailure {
    fn from(error: Error) -> Self {
        Self { reason: heartbeat_round_failure_reason(&error), error }
    }
}

impl From<tokio_postgres::Error> for RoundFailure {
    fn from(error: tokio_postgres::Error) -> Self {
        Error::from(error).into()
    }
}

/// Starts the transaction of a round and sets both server timeouts for it only, in one message
/// and one round trip. `SET LOCAL` cannot take a bind parameter, so the budgets, which are whole
/// numbers of milliseconds, go into the text. `set_config(..., true)` has the scope of `SET LOCAL`.
fn begin_with_timeouts(statement_ms: &str, idle_ms: &str) -> String {
    format!(
        "BEGIN; SELECT set_config('statement_timeout', '{statement_ms}', true), \
         set_config('idle_in_transaction_session_timeout', '{idle_ms}', true)"
    )
}

/// A round with less time than this left fails before it sends its heartbeat. At this size every
/// budget of `round_timeouts` is at least 1 ms, and the budgets still fit in the time left.
const MINIMUM_REMAINING: Duration = Duration::from_millis(8);

/// Why a round on the reserved connection failed.
enum BoundedRoundError {
    /// The round expired before it sent its heartbeat statement, and its transaction rolled back
    /// or never started. No statement of the round can still run, so the connection stays.
    Expired,
    /// Any other failure. A statement of the round can still run, so the connection goes.
    Failed(Error),
}

impl From<Error> for BoundedRoundError {
    fn from(error: Error) -> Self {
        Self::Failed(error)
    }
}

impl From<tokio_postgres::Error> for BoundedRoundError {
    fn from(error: tokio_postgres::Error) -> Self {
        Self::Failed(error.into())
    }
}

/// The server budgets for the rest of a round that has `remaining` left, in whole milliseconds.
///
/// PostgreSQL measures `statement_timeout` for each statement and
/// `idle_in_transaction_session_timeout` for each idle gap, and restarts both every time. While the
/// round can hold a row lock, it has one idle gap before the heartbeat, the heartbeat, and one idle
/// gap before `COMMIT`. So the heartbeat gets one quarter, each gap one quarter, and the last quarter
/// is kept for the settings statement and `COMMIT`. No setting bounds `COMMIT` itself.
fn round_timeouts(remaining: Duration) -> (String, String) {
    let quarter = (remaining.as_millis() / 4).max(1).to_string();
    (quarter.clone(), quarter)
}

/// The most leases in one batch of `heartbeat_pool_v1`, the limit of `heartbeat_many_v2`.
const BATCH_LEASES: usize = 100;

/// Sends one `heartbeat_pool_v1` statement in its own transaction, with server timeouts that fit
/// before `deadline`. The statement carries the batches of the lead and of every round that joins
/// it just before the statement (`shared::Lead::join`).
///
/// `BEGIN` and the settings statement go in one message, as the JVM SDK folds `BEGIN` into its
/// first statement. So the budgets come from the time left before `BEGIN`, and the quarter that
/// the settings statement can use also covers `BEGIN`.
///
/// Dropping a connection does not stop its statement: PostgreSQL notices a closed client only when
/// it next writes to it. So the server must end a round that the client stopped waiting for. The
/// timeouts (`round_timeouts`) end the heartbeat, and a transaction whose client stopped before
/// `COMMIT`, by the deadline. A `COMMIT` that PostgreSQL has already started can still finish
/// later. Both settings end with the transaction, so the connection keeps no session state. A
/// deadlock aborts the transaction, so it fails the round, and the next round sends again.
///
/// A round that expires before its heartbeat statement returns `BoundedRoundError::Expired`. If
/// it has not sent `BEGIN`, it sends nothing. Otherwise it rolls back first. No round has joined
/// it then. A round that the caller drops while its transaction is open leaves it to the caller,
/// which discards the connection (`Holding`).
async fn server_bounded_rows(
    connection: &deadpool_postgres::Object,
    deadline: Instant,
    lead: &mut shared::Lead<'_>,
) -> Result<Vec<tokio_postgres::Row>, BoundedRoundError> {
    let begun_at = Instant::now();
    let remaining = deadline.saturating_duration_since(begun_at);
    if remaining < MINIMUM_REMAINING {
        return Err(BoundedRoundError::Expired);
    }
    let (statement_ms, idle_ms) = round_timeouts(remaining);
    #[cfg(test)]
    if let Ok(delay) = tests::SETTINGS_DELAY.try_with(|delay| *delay) {
        tokio::time::sleep(delay).await;
    }
    // tokio-postgres prepares a statement in its own cycle, and PostgreSQL restarts the statement
    // timer at the end of that cycle, so the prepare stays out of the heartbeat's budget. The
    // connection keeps the statement, so only the first round on a connection prepares it, in the
    // same round trip as `BEGIN`.
    let begin = begin_with_timeouts(&statement_ms, &idle_ms);
    let ((), heartbeat) = tokio::try_join!(
        connection.batch_execute(&begin),
        connection.prepare_cached(sql::HEARTBEAT_POOL_V1)
    )?;
    // The budgets fit only if `BEGIN` and the settings used at most the quarter kept for `COMMIT`.
    if begun_at.elapsed() > remaining / 4 {
        return roll_back_expired(connection, deadline).await;
    }
    // The payload is encoded here, not in the driver, so its time counts before the deadline check.
    // The driver then only copies the encoded text.
    let payload = serde_json::value::to_raw_value(&lead.join()).map_err(|error| {
        Error::invalid(format!("the heartbeat payload did not encode: {error}"))
    })?;
    // The payload counts against the deadline, so the statement goes out only in time.
    if Instant::now() >= deadline {
        return roll_back_expired(connection, deadline).await;
    }
    let rows = connection.query(&heartbeat, &[&tokio_postgres::types::Json(&*payload)]).await?;
    connection.batch_execute("COMMIT").await?;
    // A `COMMIT` that ends after the deadline does not count as a renewal.
    if Instant::now() >= deadline {
        return Err(Error::invalid(DEADLINE_AFTER_COMMIT).into());
    }
    Ok(rows)
}

/// Ends a round that expired after `BEGIN` and before its heartbeat statement.
///
/// The `ROLLBACK` must not start after `deadline`, and the caller bounds its wait by the same
/// deadline. If the `ROLLBACK` cannot start, fails, or does not return in time, the round fails as
/// any other round, and the caller discards the connection.
async fn roll_back_expired(
    connection: &deadpool_postgres::Object,
    deadline: Instant,
) -> Result<Vec<tokio_postgres::Row>, BoundedRoundError> {
    if Instant::now() >= deadline {
        return Err(Error::invalid(DEADLINE_BEFORE_STATEMENT).into());
    }
    connection.batch_execute("ROLLBACK").await?;
    Err(BoundedRoundError::Expired)
}

/// The heartbeat connection that one transaction holds. If the round is dropped before it
/// settles, a transaction can still be open on the connection, so the drop discards it.
struct Holding<'a> {
    heartbeat: &'a shared::HeartbeatConnection,
    reserved: tokio::sync::MutexGuard<'a, Option<deadpool_postgres::Object>>,
    settled: bool,
}

impl Holding<'_> {
    /// Ends the hold. A failed round discards the connection, because a statement of it can
    /// still run.
    fn settle(mut self, failed: bool) {
        if failed {
            self.heartbeat.discard(&mut self.reserved);
        }
        self.heartbeat.finish(&mut self.reserved);
        self.settled = true;
    }
}

impl Drop for Holding<'_> {
    fn drop(&mut self) {
        if !self.settled {
            self.heartbeat.discard(&mut self.reserved);
        }
    }
}

/// The batch position, the task ID, and the status of one row of `heartbeat_pool_v1`.
fn pool_row(row: &tokio_postgres::Row) -> Result<(usize, String, String), Error> {
    let batch: i32 = row.try_get("batch")?;
    let batch = usize::try_from(batch)
        .map_err(|_| Error::invalid("PostgreSQL returned an invalid heartbeat batch"))?;
    Ok((batch, row.try_get("task_id")?, row.try_get("status")?))
}

/// The deadline of one heartbeat round for `interval`. It is three quarters of the interval, so
/// that one timed-out round leaves a renewal margin when `2 × interval + bound < lease`. Below an
/// interval of 200 ms the bound is at least `min(50 ms, interval)`. Up to 50 ms the bound thus
/// equals the interval, as before SM-1444, and a timed-out round leaves about no margin. It is at
/// least 1 ms, in whole milliseconds rounded down. Every SDK uses the same formula.
pub(super) fn heartbeat_round_bound_for(interval: Duration) -> Duration {
    const MILLISECOND: Duration = Duration::from_millis(1);
    let floor = Duration::from_millis(50).min(interval);
    let three_quarters = Duration::from_millis((interval.as_millis() * 3 / 4) as u64);
    three_quarters.max(floor).max(MILLISECOND)
}

impl Inner {
    /// Adds `task` to the rounds until the returned membership leaves or is dropped. Its local
    /// lease window ends at `lease_ends_at` until a renewal moves it.
    pub(super) fn register_heartbeat(
        self: &Arc<Self>,
        task: Uuid,
        fence: i64,
        lease_ends_at: Instant,
    ) -> Membership {
        let (sender, beats) = mpsc::channel(4);
        let mut state = self.heartbeats.state();
        state.registrations += 1;
        let registration = state.registrations;
        state.members.insert(task, Member { fence, registration, sender, lease_ends_at });
        if !state.running {
            state.running = true;
            state.task = Some(tokio::spawn(Arc::clone(self).run_heartbeats()));
        }
        Membership { inner: Arc::clone(self), task, registration, beats }
    }

    /// Drops every renewal at once, so the abandoned tasks expire and PostgreSQL recovers them.
    pub(super) fn abandon_heartbeats(&self) {
        self.heartbeats.state().members.clear();
        self.heartbeats.wake.notify_one();
    }

    /// The latest heartbeat loop, which ends once it finds no members.
    pub(super) fn heartbeat_loop(&self) -> Option<tokio::task::JoinHandle<()>> {
        self.heartbeats.state().task.take()
    }

    /// Sends one round at a time. A round falls due one interval after the previous round started,
    /// not after it ended. A round that ends after its next slot starts one overdue round at once,
    /// and the interval after it counts from that start, so missed slots are never replayed. A
    /// wake that finds members starts no early round. `Instant` is monotonic.
    ///
    /// Between two slots, a busy retry renews only the leases that the latest round reported busy.
    /// It is a round for the one-round-in-flight rule, and it never moves the regular slot. A round
    /// of either kind replaces the busy selection, and a failed round leaves none. A bounded retry
    /// with less than `BUSY_RETRY_MINIMUM` before its deadline does not run, and leaves none either.
    async fn run_heartbeats(self: Arc<Self>) {
        let interval = self.heartbeat_interval;
        let mut next = Instant::now() + interval;
        // The busy memberships of the latest round, and when their retry falls due.
        let mut retry: Option<(Instant, Vec<Sent>)> = None;
        loop {
            let due = match &retry {
                Some((at, _)) if *at < next => *at,
                _ => next,
            };
            tokio::select! {
                () = tokio::time::sleep_until(due) => {}
                () = self.heartbeats.wake.notified() => {}
            }
            let now = Instant::now();
            let round = {
                let mut state = self.heartbeats.state();
                if state.members.is_empty() {
                    state.running = false;
                    return;
                }
                if now >= next {
                    // The regular round takes every lease, the busy ones too.
                    retry = None;
                    Some((state.all(), None))
                } else if retry.as_ref().is_some_and(|(at, _)| now >= *at) {
                    let (_, busy) = retry.take().expect("checked above");
                    // An empty selection runs nothing early. The regular slot comes next.
                    state
                        .retry_selection(busy, now)
                        .map(|(selection, lease_ends_at)| (selection, Some(lease_ends_at)))
                } else {
                    None
                }
            };
            let Some((members, lease_ends_at)) = round else { continue };
            let started = Instant::now();
            let bounded = started + self.heartbeat_round_bound();
            let deadline = match lease_ends_at {
                None => {
                    next = started + interval;
                    bounded
                }
                // A busy retry ends by the next regular slot and by the end of the earliest lease
                // window in it, so it never renews a lease that the watchdog has given up.
                Some(lease_ends_at) => {
                    let deadline = bounded.min(next).min(lease_ends_at);
                    if busy_retry_too_short(started, deadline) {
                        continue;
                    }
                    deadline
                }
            };
            retry = match self.heartbeat_round(&members, deadline).await {
                Ok(busy) if !busy.is_empty() => {
                    Some((Instant::now() + busy_retry_delay(interval), busy))
                }
                Ok(_) => None,
                Err(RoundFailure { error, reason }) => {
                    // The round gave no verdict, so `Counter::HeartbeatFailures` does not count it.
                    self.metrics.add(
                        Counter::HeartbeatRoundFailures,
                        1.0,
                        &[("workhorse.heartbeat.failure_reason", Attribute::Text(reason.as_str()))],
                    );
                    tracing::warn!(error = %error, workhorse.worker.id = %self.worker_id, "heartbeat round failed; retrying");
                    None
                }
            };
        }
    }

    /// The deadline of one round on the reserved connection (`heartbeat_round_bound_for`). Rounds
    /// start on a fixed schedule, so after one timed-out round the next round still ends before the
    /// lease when `2 × interval + bound < lease`, as with the defaults.
    fn heartbeat_round_bound(&self) -> std::time::Duration {
        heartbeat_round_bound_for(self.heartbeat_interval)
    }

    /// Sends one round for `members` and delivers its answer. Returns the memberships that the
    /// answer reported busy. `deadline` bounds a round on the reserved connection. The caller takes
    /// it before the payload is built, so serialization counts against it.
    async fn heartbeat_round(
        &self,
        members: &[Sent],
        deadline: Instant,
    ) -> Result<Vec<Sent>, RoundFailure> {
        // A gate holds the round in the worker, so the round loop cannot start another one. No
        // timeout bounds the hold. The round keeps the value of the gate until it ends.
        #[cfg(feature = "__conformance-hooks")]
        let _held = match self.heartbeats.round_gate() {
            Some(gate) => Some(gate().await),
            None => None,
        };
        // A lease renewed by this round runs from before the request left, which can only be
        // earlier than the renewal in PostgreSQL, so a local lease window never outlasts the real one.
        let sent_at = Instant::now();
        let statuses = self.send_heartbeats(members, deadline).await?;
        Ok(self.deliver_heartbeats(members, &statuses, sent_at))
    }

    /// Sends the heartbeat statement for `members` and reads each lease's status by task ID.
    async fn send_heartbeats(
        &self,
        members: &[Sent],
        deadline: Instant,
    ) -> Result<HashMap<String, LeaseStatus>, RoundFailure> {
        #[cfg(test)]
        {
            let fake = self.heartbeats.fake_round.lock().unwrap().clone();
            if let Some(fake) = fake {
                return Ok(fake(members.to_vec(), deadline).await?);
            }
        }
        let lease_ms = self.options.lease_duration.as_millis() as u64;
        let lease = |sent: &Sent| {
            let fence = sent.fence.to_string();
            json!({"taskId": sent.task, "fenceToken": fence, "leaseMs": lease_ms})
        };
        // A round on the reserved connection is bounded by `deadline`, on the client and on the
        // server, so a statement stalled on it cannot hold the next round. Each batch holds at most
        // `BATCH_LEASES` leases of this worker.
        let batches = members
            .chunks(BATCH_LEASES)
            .map(|chunk| {
                let leases: Vec<_> = chunk.iter().map(lease).collect();
                json!({"workerId": self.worker_id, "leases": leases})
            })
            .collect();
        let rows = self.reserved_round(batches, deadline).await?;
        let mut statuses = HashMap::with_capacity(rows.len());
        for (task, status) in rows {
            statuses.insert(task, LeaseStatus::parse(Some(&status))?);
        }
        Ok(statuses)
    }

    /// Renews `batches` on the shared heartbeat connection, in one transaction with the rounds of
    /// the other workers on the pool (`shared::HeartbeatConnection::turn`). One deadline bounds the
    /// whole round: the wait for the transaction of the other rounds, the wait for a replacement
    /// connection, and the transaction.
    async fn reserved_round(
        &self,
        batches: Vec<serde_json::Value>,
        deadline: Instant,
    ) -> Result<shared::RoundRows, RoundFailure> {
        let heartbeat = self
            .heartbeat_connection()
            .ok_or_else(|| Error::invalid("worker holds no heartbeat connection"))?;
        let mut lead = match heartbeat.turn(batches, deadline).await? {
            shared::Turn::Joined(rows) => return rows,
            shared::Turn::Lead(lead) => lead,
        };
        let expired = || Error::invalid(DEADLINE_EXCEEDED);
        let reserved = timeout_at(deadline, heartbeat.lock()).await.map_err(|_| expired())?;
        let holding = Holding { heartbeat: &heartbeat, reserved, settled: false };
        let round = timeout_at(deadline, async {
            let Some(connection) = holding.reserved.as_ref() else {
                return Err(Error::invalid(CONNECTION_CLOSED).into());
            };
            server_bounded_rows(connection, deadline, &mut lead).await
        })
        .await
        .unwrap_or_else(|_| Err(BoundedRoundError::Failed(expired())));
        // A failed round discards the connection instead of returning it to the pool.
        let failed = matches!(round, Err(BoundedRoundError::Failed(_)));
        let rows: Result<Vec<_>, Error> = match round {
            Ok(rows) => rows.iter().map(pool_row).collect(),
            // No statement of the round can still run, so the next round uses the connection.
            Err(BoundedRoundError::Expired) => Err(Error::invalid(DEADLINE_BEFORE_STATEMENT)),
            Err(BoundedRoundError::Failed(error)) => Err(error),
        };
        holding.settle(failed);
        Ok(lead.answer(rows)?)
    }

    /// Delivers a completed round only to the same registrations that sent it, and returns the
    /// busy ones. Only an accepted renewal moves a lease window. A busy lease stays registered and
    /// gets no beat, so its watchdog keeps the window it had.
    fn deliver_heartbeats(
        &self,
        members: &[Sent],
        statuses: &HashMap<String, LeaseStatus>,
        sent_at: Instant,
    ) -> Vec<Sent> {
        let lease = self.options.lease_duration;
        let now = Instant::now();
        let mut busy = Vec::new();
        let mut state = self.heartbeats.state();
        for sent in members {
            // A suspension can resume this task while the old round is still in flight, and a
            // lease can leave or complete. Those registrations get nothing from this round.
            let Some(member) = state.members.get_mut(&sent.task) else { continue };
            if member.registration != sent.registration {
                continue;
            }
            let status = statuses
                .get(&sent.task.to_string())
                .copied()
                .unwrap_or(LeaseStatus::Owner(OwnershipStatus::Stale));
            let beat = match status {
                LeaseStatus::Owner(OwnershipStatus::Accepted) => {
                    // A late answer never reopens a window that has ended. The watchdog owns it.
                    if now < member.lease_ends_at
                        && member.sender.try_send(Beat::Renewed(sent_at)).is_ok()
                    {
                        member.lease_ends_at = member.lease_ends_at.max(sent_at + lease);
                    }
                    continue;
                }
                LeaseStatus::Busy => {
                    busy.push(*sent);
                    None
                }
                LeaseStatus::Owner(rejected) => Some(Beat::Rejected(rejected)),
            };
            self.metrics.add(
                Counter::HeartbeatFailures,
                1.0,
                &[("workhorse.heartbeat.status", Attribute::Text(status.as_str()))],
            );
            tracing::info!(
                event.name = "workhorse.task.heartbeat_rejected",
                workhorse.task.id = %sent.task,
                workhorse.worker.id = %self.worker_id,
                workhorse.heartbeat.status = status.as_str(),
                "Task heartbeat rejected"
            );
            if let Some(beat) = beat {
                let _ = member.sender.try_send(beat);
            }
        }
        busy
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use futures_util::future::BoxFuture;
    use futures_util::FutureExt;
    use serde_json::Value;

    use super::*;
    use crate::worker::scratch;
    use crate::{CancelReason, ClaimedTask, HandlerContext, Worker, WorkerOptions};

    /// Answers a round in place of PostgreSQL: the memberships it sent and its deadline.
    pub(in crate::worker) type FakeRound = Arc<
        dyn Fn(
                Vec<Sent>,
                Instant,
            ) -> BoxFuture<'static, Result<HashMap<String, LeaseStatus>, Error>>
            + Send
            + Sync,
    >;

    tokio::task_local! {
        /// Delays the settings statement of a round on the reserved connection, as a slow one would.
        pub(in crate::worker) static SETTINGS_DELAY: Duration;
    }

    const BUSY: LeaseStatus = LeaseStatus::Busy;
    const ACCEPTED: LeaseStatus = LeaseStatus::Owner(OwnershipStatus::Accepted);

    fn worker_with(interval: Duration, lease: Duration) -> Worker {
        let manager = deadpool_postgres::Manager::new(
            "postgresql://localhost/unused".parse().unwrap(),
            tokio_postgres::NoTls,
        );
        let pool = deadpool_postgres::Pool::builder(manager).max_size(3).build().unwrap();
        Worker::new(
            pool,
            WorkerOptions {
                queues: vec!["unused".into()],
                polling_only: true,
                lease_duration: lease,
                heartbeat_interval: Some(interval),
                ..WorkerOptions::default()
            },
        )
        .unwrap()
    }

    fn worker() -> Worker {
        worker_with(Duration::from_secs(10), Duration::from_secs(30))
    }

    /// The membership that a round would send for `membership` now.
    fn sent(worker: &Worker, membership: &Membership) -> Sent {
        let state = worker.0.heartbeats.state();
        let member = state.member(membership.task, membership.registration).expect("registered");
        Sent { task: membership.task, fence: member.fence, registration: member.registration }
    }

    /// One round that the fake answered.
    struct Call {
        at: Instant,
        tasks: Vec<Uuid>,
        deadline: Instant,
    }

    /// Records each round, and answers the round with index `n` with `answer(n, sent)` after
    /// `duration`.
    #[derive(Clone, Default)]
    struct Rounds {
        calls: Arc<Mutex<Vec<Call>>>,
        in_flight: Arc<AtomicUsize>,
        most_in_flight: Arc<AtomicUsize>,
    }

    impl Rounds {
        fn install(
            worker: &Worker,
            duration: Duration,
            answer: impl Fn(usize, &[Sent]) -> Result<HashMap<String, LeaseStatus>, Error>
                + Send
                + Sync
                + 'static,
        ) -> Self {
            let rounds = Self::default();
            let recorded = rounds.clone();
            let answer = Arc::new(answer);
            let fake: FakeRound = Arc::new(move |members: Vec<Sent>, deadline: Instant| {
                let (rounds, answer) = (recorded.clone(), Arc::clone(&answer));
                async move {
                    let index = {
                        let mut calls = rounds.calls.lock().unwrap();
                        let mut tasks: Vec<Uuid> = members.iter().map(|sent| sent.task).collect();
                        tasks.sort();
                        calls.push(Call { at: Instant::now(), tasks, deadline });
                        calls.len() - 1
                    };
                    let running = rounds.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                    rounds.most_in_flight.fetch_max(running, Ordering::SeqCst);
                    if !duration.is_zero() {
                        tokio::time::sleep(duration).await;
                    }
                    rounds.in_flight.fetch_sub(1, Ordering::SeqCst);
                    answer(index, &members)
                }
                .boxed()
            });
            *worker.0.heartbeats.fake_round.lock().unwrap() = Some(fake);
            rounds
        }

        fn calls(&self) -> std::sync::MutexGuard<'_, Vec<Call>> {
            self.calls.lock().unwrap()
        }
    }

    /// Gives every lease of a round `status`, except the tasks in `others`.
    fn answer(
        members: &[Sent],
        status: LeaseStatus,
        others: &[(Uuid, LeaseStatus)],
    ) -> HashMap<String, LeaseStatus> {
        members
            .iter()
            .map(|sent| {
                let other = others.iter().find(|(task, _)| *task == sent.task);
                (sent.task.to_string(), other.map_or(status, |(_, status)| *status))
            })
            .collect()
    }

    fn sorted(mut tasks: Vec<Uuid>) -> Vec<Uuid> {
        tasks.sort();
        tasks
    }

    #[test]
    fn a_round_bound_is_three_quarters_of_the_interval_and_the_interval_up_to_50_ms() {
        let bound = |milliseconds| heartbeat_round_bound_for(Duration::from_millis(milliseconds));
        assert_eq!(bound(10), Duration::from_millis(10));
        assert_eq!(bound(40), Duration::from_millis(40));
        assert_eq!(bound(50), Duration::from_millis(50));
        assert_eq!(bound(66), Duration::from_millis(50));
        assert_eq!(bound(69), Duration::from_millis(51));
        assert_eq!(bound(200), Duration::from_millis(150));
        assert_eq!(bound(10_000), Duration::from_millis(7_500));
        // With the defaults, one timed-out round leaves a renewal margin.
        let lease = Duration::from_secs(30);
        assert!(2 * (lease / 3) + heartbeat_round_bound_for(lease / 3) < lease);
    }

    // The heartbeat statement and each idle gap get one quarter of the time left, and one quarter
    // stays for the settings statement and COMMIT. Each budget is at least 1 ms.
    #[test]
    fn each_server_budget_is_one_quarter_of_the_time_left() {
        let budgets = |milliseconds| round_timeouts(Duration::from_millis(milliseconds));
        assert_eq!(budgets(750), ("187".into(), "187".into()));
        assert_eq!(budgets(1_000), ("250".into(), "250".into()));
        assert_eq!(budgets(MINIMUM_REMAINING.as_millis() as u64), ("2".into(), "2".into()));
        assert_eq!(budgets(3), ("1".into(), "1".into()));
        assert_eq!(budgets(0), ("1".into(), "1".into()));
        // The heartbeat and both idle gaps end within three quarters of the time left.
        for milliseconds in [8, 9, 11, 100, 7_500] {
            let (statement, idle) = budgets(milliseconds);
            let used = statement.parse::<u64>().unwrap() + 2 * idle.parse::<u64>().unwrap();
            assert!(used <= milliseconds * 3 / 4, "{milliseconds} ms gave {used} ms");
        }
    }

    #[test]
    fn a_busy_retry_waits_between_one_and_two_bases() {
        for (interval, base) in [(1_000, 100.0), (800, 100.0), (400, 50.0), (8, 1.0)] {
            for _ in 0..100 {
                let delay = busy_retry_delay(Duration::from_millis(interval)).as_secs_f64() * 1e3;
                assert!(
                    (base..2.0 * base).contains(&delay),
                    "interval {interval} ms gave {delay} ms"
                );
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_delayed_round_cannot_reach_a_resumed_claim() {
        for status in [
            Some(ACCEPTED),
            Some(BUSY),
            Some(LeaseStatus::Owner(OwnershipStatus::Stale)),
            Some(LeaseStatus::Owner(OwnershipStatus::CancelRequested)),
            Some(LeaseStatus::Owner(OwnershipStatus::DeadlineExceeded)),
            Some(LeaseStatus::Owner(OwnershipStatus::TimeoutExceeded)),
            None,
        ] {
            let worker = worker();
            let task = Uuid::new_v4();
            let other = Uuid::new_v4();
            let ends = Instant::now() + Duration::from_secs(30);
            let mut suspended = worker.0.register_heartbeat(task, 1, ends);
            let mut unchanged = worker.0.register_heartbeat(other, 1, ends);
            // The round snapshots fence 1, then the parent suspends and resumes at fence 2.
            let members = [sent(&worker, &suspended), sent(&worker, &unchanged)];
            suspended.leave();
            let mut resumed = worker.0.register_heartbeat(task, 2, ends);
            let sent_at = Instant::now();
            let mut statuses = HashMap::from([(other.to_string(), ACCEPTED)]);
            if let Some(status) = status {
                statuses.insert(task.to_string(), status);
            }
            let busy = worker.0.deliver_heartbeats(&members, &statuses, sent_at);
            assert!(busy.is_empty(), "a busy answer for fence 1 selected fence 2 for a retry");
            assert!(
                matches!(resumed.beats.try_recv(), Err(mpsc::error::TryRecvError::Empty)),
                "a response for fence 1 reached fence 2"
            );
            assert!(matches!(
                suspended.beats.try_recv(),
                Err(mpsc::error::TryRecvError::Disconnected)
            ));
            assert!(matches!(unchanged.beats.try_recv(), Ok(Beat::Renewed(at)) if at == sent_at));
            // Leaving the old execution again must preserve the new membership.
            drop(suspended);
            let current = sent(&worker, &resumed);
            let busy = worker.0.deliver_heartbeats(&[current], &statuses, sent_at);
            match status.unwrap_or(LeaseStatus::Owner(OwnershipStatus::Stale)) {
                LeaseStatus::Owner(OwnershipStatus::Accepted) => assert!(
                    matches!(resumed.beats.try_recv(), Ok(Beat::Renewed(at)) if at == sent_at)
                ),
                // A busy lease gets no beat and no verdict. It stays registered for a retry.
                LeaseStatus::Busy => {
                    assert_eq!(busy, [current]);
                    assert!(matches!(
                        resumed.beats.try_recv(),
                        Err(mpsc::error::TryRecvError::Empty)
                    ));
                    assert!(worker
                        .0
                        .heartbeats
                        .state()
                        .member(task, current.registration)
                        .is_some());
                }
                LeaseStatus::Owner(expected) => assert!(
                    matches!(resumed.beats.try_recv(), Ok(Beat::Rejected(actual)) if actual == expected)
                ),
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn an_accepted_answer_after_the_lease_window_ended_renews_nothing() {
        let worker = worker();
        let lease = Duration::from_secs(30);
        let started = Instant::now();
        let mut membership = worker.0.register_heartbeat(Uuid::new_v4(), 1, started + lease);
        let members = [sent(&worker, &membership)];
        tokio::time::sleep(lease).await;
        let statuses = HashMap::from([(membership.task.to_string(), ACCEPTED)]);
        worker.0.deliver_heartbeats(&members, &statuses, started + Duration::from_secs(1));
        assert!(matches!(membership.beats.try_recv(), Err(mpsc::error::TryRecvError::Empty)));
    }

    // SM-1445: a round that answers `accepted` after the lease window ended neither renews the
    // lease nor lets a later round renew it. The watchdog owns the window from its end.
    #[tokio::test(start_paused = true)]
    async fn a_round_that_answers_after_the_lease_window_restores_no_renewals() {
        let interval = Duration::from_secs(1);
        let worker = worker_with(interval, Duration::from_secs(30));
        let rounds = Rounds::install(&worker, Duration::ZERO, move |_, members| {
            Ok(answer(members, ACCEPTED, &[]))
        });
        // The first round answers one interval late, after the window of the lease.
        *worker.0.heartbeats.fake_round.lock().unwrap() = Some({
            let fake = worker.0.heartbeats.fake_round.lock().unwrap().clone().unwrap();
            let first = Arc::new(AtomicBool::new(true));
            Arc::new(move |members: Vec<Sent>, deadline: Instant| {
                let (fake, first) = (Arc::clone(&fake), Arc::clone(&first));
                async move {
                    if first.swap(false, Ordering::SeqCst) {
                        tokio::time::sleep(interval).await;
                    }
                    fake(members, deadline).await
                }
                .boxed()
            })
        });
        let started = Instant::now();
        let window_ends = started + interval * 3 / 2;
        let mut membership = worker.0.register_heartbeat(Uuid::new_v4(), 1, window_ends);
        tokio::time::sleep(interval * 3).await;
        assert!(rounds.calls().len() >= 2, "no round ran after the late answer");
        assert!(matches!(membership.beats.try_recv(), Err(mpsc::error::TryRecvError::Empty)));
        let state = worker.0.heartbeats.state();
        let member = state.member(membership.task, membership.registration).expect("registered");
        assert_eq!(member.lease_ends_at, window_ends, "a late answer moved the lease window");
    }

    // A busy answer starts one retry with only the busy lease, before the next regular slot and
    // within the retry deadline.
    #[tokio::test(start_paused = true)]
    async fn a_busy_lease_is_retried_alone_before_the_next_slot() {
        let interval = Duration::from_secs(1);
        let worker = worker_with(interval, Duration::from_secs(30));
        let (busy, accepted) = (Uuid::new_v4(), Uuid::new_v4());
        let rounds = Rounds::install(&worker, Duration::ZERO, move |index, members| {
            let status = if index == 0 { BUSY } else { ACCEPTED };
            Ok(answer(members, ACCEPTED, &[(busy, status)]))
        });
        let started = Instant::now();
        let ends = started + Duration::from_secs(30);
        let _first = worker.0.register_heartbeat(busy, 1, ends);
        let _second = worker.0.register_heartbeat(accepted, 1, ends);
        tokio::time::sleep(interval * 15 / 10).await;
        let calls = rounds.calls();
        assert_eq!(calls.len(), 2, "one regular round and one retry");
        assert_eq!(calls[0].at, started + interval);
        assert_eq!(calls[0].tasks, sorted(vec![busy, accepted]));
        assert_eq!(calls[1].tasks, [busy], "the retry sent a lease that was not busy");
        let delay = calls[1].at - calls[0].at;
        // The delay is below 200 ms. Tokio timers have a granularity of 1 ms and round a wait up.
        // Thus, a delay of 199.4 ms fires at 200 ms.
        assert!(
            (Duration::from_millis(100)..=Duration::from_millis(200)).contains(&delay),
            "the retry came {delay:?} after the busy round"
        );
        // The retry ends by its round bound, which comes before the next slot here.
        assert_eq!(calls[1].deadline, calls[1].at + heartbeat_round_bound_for(interval));
    }

    // Retries never move the regular schedule.
    #[tokio::test(start_paused = true)]
    async fn regular_slots_stay_fixed_while_busy_retries_run() {
        let interval = Duration::from_secs(1);
        let worker = worker_with(interval, Duration::from_secs(30));
        let (busy, accepted) = (Uuid::new_v4(), Uuid::new_v4());
        let rounds = Rounds::install(&worker, Duration::ZERO, move |_, members| {
            Ok(answer(members, ACCEPTED, &[(busy, BUSY)]))
        });
        let started = Instant::now();
        let ends = started + Duration::from_secs(30);
        let _first = worker.0.register_heartbeat(busy, 1, ends);
        let _second = worker.0.register_heartbeat(accepted, 1, ends);
        tokio::time::sleep(interval * 35 / 10).await;
        let calls = rounds.calls();
        let regular: Vec<Instant> =
            calls.iter().filter(|call| call.tasks.len() == 2).map(|call| call.at).collect();
        assert_eq!(regular, [1, 2, 3].map(|slot| started + interval * slot));
        let retries = calls.iter().filter(|call| call.tasks == [busy]).count();
        // A retry falls due at most 200 ms after the previous round.
        assert!(retries >= 4 + 4 + 2, "only {retries} busy retries ran");
        for call in calls.iter().filter(|call| call.tasks.len() == 1) {
            // A retry ends by the next regular slot.
            let slot = started + interval * ((call.at - started).as_millis() / 1_000 + 1) as u32;
            assert!(call.deadline <= slot, "a retry deadline passed its next slot");
        }
    }

    // A round that outlives its slot starts the overdue regular round at once, and no retry
    // overlaps it.
    #[tokio::test(start_paused = true)]
    async fn a_busy_retry_never_overlaps_another_round() {
        let interval = Duration::from_millis(100);
        let worker = worker_with(interval, Duration::from_secs(30));
        let task = Uuid::new_v4();
        let rounds = Rounds::install(&worker, Duration::from_millis(60), move |_, members| {
            Ok(answer(members, BUSY, &[]))
        });
        let _membership =
            worker.0.register_heartbeat(task, 1, Instant::now() + Duration::from_secs(30));
        tokio::time::sleep(Duration::from_secs(2)).await;
        let calls = rounds.calls();
        assert!(calls.len() >= 20, "only {} rounds ran", calls.len());
        assert_eq!(rounds.most_in_flight.load(Ordering::SeqCst), 1);
        for pair in calls.windows(2) {
            assert!(pair[1].at - pair[0].at >= Duration::from_millis(60), "two rounds overlapped");
        }
    }

    // A failed retry starts no other retry. The next regular round tries again.
    #[tokio::test(start_paused = true)]
    async fn a_failed_busy_retry_waits_for_the_next_slot() {
        let interval = Duration::from_secs(1);
        let worker = worker_with(interval, Duration::from_secs(30));
        let task = Uuid::new_v4();
        let rounds = Rounds::install(&worker, Duration::ZERO, move |index, members| match index {
            0 => Ok(answer(members, BUSY, &[])),
            1 => Err(Error::invalid("injected failure")),
            _ => Ok(answer(members, BUSY, &[])),
        });
        let started = Instant::now();
        let _membership = worker.0.register_heartbeat(task, 1, started + Duration::from_secs(30));
        tokio::time::sleep(interval * 21 / 10).await;
        let calls = rounds.calls();
        assert!(calls.len() >= 3, "only {} rounds ran", calls.len());
        assert_eq!(calls[0].at, started + interval);
        assert!(calls[1].at < started + interval * 2, "the busy round started no retry");
        assert_eq!(calls[2].at, started + interval * 2, "the failed retry started another retry");
    }

    /// A test error whose `source` is `inner`, as a driver or an application wraps an error.
    #[derive(Debug)]
    struct Wrapped(Box<dyn std::error::Error + Send + Sync>);

    impl std::fmt::Display for Wrapped {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("wrapped")
        }
    }

    impl std::error::Error for Wrapped {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            Some(&*self.0)
        }
    }

    fn wrapped(inner: impl std::error::Error + Send + Sync + 'static) -> Error {
        Error::database(None, None, Wrapped(Box::new(inner)))
    }

    fn pool_timeout(kind: deadpool_postgres::TimeoutType) -> Error {
        Error::Pool(deadpool_postgres::PoolError::Timeout(kind))
    }

    fn sqlstate(code: &str) -> Error {
        Error::database(Some(code), None, std::fmt::Error)
    }

    #[test]
    fn a_failed_round_has_one_of_four_reasons() {
        use RoundFailureReason::{Connection, Database, Other, Timeout};
        let io = || std::io::Error::from(std::io::ErrorKind::ConnectionReset);
        let cases = [
            (Error::invalid(DEADLINE_EXCEEDED), Timeout),
            (Error::invalid(DEADLINE_BEFORE_STATEMENT), Timeout),
            (Error::invalid(DEADLINE_AFTER_COMMIT), Timeout),
            (wrapped(Error::invalid(DEADLINE_EXCEEDED)), Timeout),
            (sqlstate("57014"), Timeout),
            (sqlstate("25P03"), Timeout),
            (wrapped(sqlstate("57014")), Timeout),
            (wrapped(Wrapped(Box::new(Error::invalid(DEADLINE_EXCEEDED)))), Timeout),
            // The deadline wins over a connection error in the same chain: the `io::Error` of a
            // custom error has the source of that error.
            (
                Error::database(
                    None,
                    None,
                    std::io::Error::other(Wrapped(Box::new(Error::invalid(DEADLINE_EXCEEDED)))),
                ),
                Timeout,
            ),
            (Error::database(None, None, io()), Connection),
            (wrapped(io()), Connection),
            (Error::invalid(CONNECTION_CLOSED), Connection),
            (Error::Pool(deadpool_postgres::PoolError::Closed), Connection),
            (pool_timeout(deadpool_postgres::TimeoutType::Wait), Connection),
            (pool_timeout(deadpool_postgres::TimeoutType::Create), Connection),
            (pool_timeout(deadpool_postgres::TimeoutType::Recycle), Connection),
            (wrapped(pool_timeout(deadpool_postgres::TimeoutType::Wait)), Connection),
            (sqlstate("08006"), Connection),
            (sqlstate("57P01"), Connection),
            (sqlstate("57P03"), Connection),
            (wrapped(sqlstate("08000")), Connection),
            (sqlstate("40P01"), Database),
            (sqlstate("57P04"), Database),
            (wrapped(sqlstate("23505")), Database),
            (Error::invalid("injected failure"), Other),
            (Error::Pool(deadpool_postgres::PoolError::NoRuntimeSpecified), Other),
            (wrapped(std::fmt::Error), Other),
        ];
        for (error, reason) in cases {
            assert_eq!(heartbeat_round_failure_reason(&error), reason, "{error:?}");
        }
        assert_eq!(
            [Timeout, Connection, Database, Other].map(RoundFailureReason::as_str),
            ["timeout", "connection", "database", "other"]
        );
    }

    // A failed round counts once in `workhorse.worker.heartbeat.round_failure`, with its reason,
    // and not in `workhorse.worker.heartbeat.failure`. A later accepted round counts nothing.
    #[cfg(feature = "opentelemetry")]
    #[tokio::test(start_paused = true)]
    async fn a_failed_round_counts_one_round_failure_with_its_reason() {
        use opentelemetry::metrics::MeterProvider;
        use opentelemetry_sdk::metrics::data::{AggregatedMetrics, MetricData};
        use opentelemetry_sdk::metrics::{
            InMemoryMetricExporter, PeriodicReader, SdkMeterProvider,
        };

        let exporter = InMemoryMetricExporter::default();
        let provider = SdkMeterProvider::builder()
            .with_reader(PeriodicReader::builder(exporter.clone()).build())
            .build();
        let interval = Duration::from_secs(1);
        let mut worker = worker_with(interval, Duration::from_secs(30));
        Arc::get_mut(&mut worker.0).expect("a new worker is not shared").metrics =
            crate::telemetry::Metrics::with_meter(&provider.meter("workhorse"));
        let rounds = Rounds::install(&worker, Duration::ZERO, |index, members| match index {
            0 => Err(Error::invalid(DEADLINE_EXCEEDED)),
            _ => Ok(answer(members, ACCEPTED, &[])),
        });
        let started = Instant::now();
        let _membership =
            worker.0.register_heartbeat(Uuid::new_v4(), 1, started + Duration::from_secs(30));
        tokio::time::sleep(interval * 25 / 10).await;
        assert_eq!(rounds.calls().len(), 2, "one failed and one accepted round ran");
        provider.force_flush().unwrap();

        let mut points = Vec::new();
        let mut verdicts = 0;
        for resource in exporter.get_finished_metrics().unwrap() {
            for scope in resource.scope_metrics() {
                for metric in scope.metrics() {
                    let AggregatedMetrics::U64(MetricData::Sum(sum)) = metric.data() else {
                        continue;
                    };
                    match metric.name() {
                        "workhorse.worker.heartbeat.round_failure" => {
                            assert_eq!(metric.unit(), "{round}");
                            for point in sum.data_points() {
                                let attributes: Vec<_> = point
                                    .attributes()
                                    .map(|attribute| {
                                        (
                                            attribute.key.as_str().to_owned(),
                                            attribute.value.as_str().into_owned(),
                                        )
                                    })
                                    .collect();
                                points.push((attributes, point.value()));
                            }
                        }
                        "workhorse.worker.heartbeat.failure" => {
                            verdicts += sum.data_points().count()
                        }
                        _ => {}
                    }
                }
            }
        }
        assert_eq!(
            points,
            [(vec![("workhorse.heartbeat.failure_reason".to_owned(), "timeout".to_owned())], 1)]
        );
        assert_eq!(verdicts, 0, "a failed round counted as a heartbeat verdict");
    }

    // A busy lease that left or was replaced before its retry is not retried, and its replacement
    // waits for the regular slot.
    #[tokio::test(start_paused = true)]
    async fn a_replaced_busy_lease_is_not_retried() {
        let interval = Duration::from_secs(1);
        let worker = worker_with(interval, Duration::from_secs(30));
        let task = Uuid::new_v4();
        let rounds = Rounds::install(&worker, Duration::ZERO, move |_, members| {
            Ok(answer(members, BUSY, &[]))
        });
        let started = Instant::now();
        let ends = started + Duration::from_secs(30);
        let first = worker.0.register_heartbeat(task, 1, ends);
        tokio::time::sleep(interval + Duration::from_millis(50)).await;
        assert_eq!(rounds.calls().len(), 1);
        // The busy lease leaves, and the same task registers again under the same fence.
        first.leave();
        let _second = worker.0.register_heartbeat(task, 1, ends);
        tokio::time::sleep(interval).await;
        let calls = rounds.calls();
        assert_eq!(calls.len(), 2, "a retry ran for a replaced lease");
        assert_eq!(calls[1].at, started + interval * 2);
    }

    // Continuous busy answers never move the watchdog, so it ends the attempt with lease loss at
    // the end of the lease from the claim, not earlier.
    #[tokio::test(start_paused = true)]
    async fn continuous_busy_rounds_let_the_watchdog_end_the_attempt() {
        let interval = Duration::from_secs(1);
        let lease = Duration::from_millis(3_500);
        let worker = worker_with(interval, lease);
        let rounds =
            Rounds::install(&worker, Duration::ZERO, |_, members| Ok(answer(members, BUSY, &[])));
        let claimed = Instant::now();
        let task = ClaimedTask {
            id: Uuid::new_v4(),
            task_type: "busy".into(),
            queue: "unused".into(),
            priority: 0,
            payload: Value::Null,
            contract_version: None,
            result_max_bytes: None,
            redact_error_details: false,
            trace_context: None,
            attempt: 1,
            max_attempts: 1,
            retry_policy: Value::Null,
            deadline_at: None,
            execution_timeout: None,
            attempt_timeout_at: None,
            fence_token: 1,
            lease_expires_at: chrono::Utc::now(),
            claim_sent_at: claimed,
            fast_tier: false,
        };
        let (cancelled, mut cancellation) = mpsc::unbounded_channel();
        let handler: super::super::handler::ErasedHandler =
            Arc::new(move |_: Value, context: HandlerContext| {
                let cancelled = cancelled.clone();
                async move {
                    let token = context.cancellation();
                    token.cancelled().await;
                    let _ = cancelled.send((Instant::now(), token.reason()));
                    Ok(Value::Null)
                }
                .boxed()
            });
        let stop = tokio_util::sync::CancellationToken::new();
        worker.0.execute(task, handler, stop, None).await.unwrap();
        let (at, reason) = cancellation.recv().await.unwrap();
        assert_eq!(reason, Some(CancelReason::LeaseLost));
        assert_eq!(at, claimed + lease, "the watchdog did not fire at the end of the lease");
        let count = {
            let calls = rounds.calls();
            // Regular rounds start on whole seconds from the claim, and retries between them.
            let retries: Vec<&Call> =
                calls.iter().filter(|call| (call.at - claimed).subsec_millis() != 0).collect();
            assert!(retries.len() >= 3, "only {} busy retries ran", retries.len());
            // A retry never runs past the lease window it renews.
            assert!(retries.iter().all(|call| call.deadline <= claimed + lease));
            calls.len()
        };
        // The watchdog removed the lease, so no round follows.
        tokio::time::sleep(interval * 3).await;
        assert_eq!(rounds.calls().len(), count);
    }

    #[test]
    fn a_busy_retry_needs_the_executor_minimum_plus_a_margin() {
        assert_eq!(BUSY_RETRY_MINIMUM, Duration::from_millis(20));
        let started = Instant::now();
        assert!(!busy_retry_too_short(started, started + BUSY_RETRY_MINIMUM));
        assert!(busy_retry_too_short(
            started,
            started + BUSY_RETRY_MINIMUM - Duration::from_micros(1)
        ));
        assert!(busy_retry_too_short(started, started));
    }

    /// Answers the first round of a lease with `busy` and every later round with `accepted`. Each
    /// round takes 20 ms, so with a 40 ms interval each retry falls due 5 ms to 10 ms after the
    /// round ends, which leaves 10 ms to 15 ms before the next regular slot.
    fn late_retry_rounds(worker: &Worker) -> Rounds {
        Rounds::install(worker, Duration::from_millis(20), move |index, members| {
            Ok(answer(members, if index == 0 { BUSY } else { ACCEPTED }, &[]))
        })
    }

    // A bounded busy retry with less than the minimum before the next slot sends nothing. The next
    // regular round renews the busy lease.
    #[tokio::test(start_paused = true)]
    async fn a_busy_retry_too_close_to_the_next_slot_waits_for_it() {
        let interval = Duration::from_millis(40);
        let worker = worker_with(interval, Duration::from_secs(30));
        let rounds = late_retry_rounds(&worker);
        let started = Instant::now();
        let task = Uuid::new_v4();
        let mut membership =
            worker.0.register_heartbeat(task, 1, started + Duration::from_secs(30));
        tokio::time::sleep(interval * 2 + Duration::from_millis(30)).await;
        let calls = rounds.calls();
        assert_eq!(calls.len(), 2, "a busy retry ran with too little time");
        assert_eq!(calls[0].at, started + interval);
        assert_eq!(calls[1].at, started + interval * 2, "the regular round did not come next");
        assert_eq!(calls[1].tasks, [task]);
        assert!(matches!(membership.beats.try_recv(), Ok(Beat::Renewed(at)) if at == calls[1].at));
    }

    /// A worker whose rounds use the reserved connection to `database`, with that connection taken.
    async fn database_worker(database: &scratch::ScratchDatabase) -> Worker {
        let manager =
            deadpool_postgres::Manager::new(database.url().parse().unwrap(), tokio_postgres::NoTls);
        let pool = deadpool_postgres::Pool::builder(manager).max_size(3).build().unwrap();
        let options = WorkerOptions {
            queues: vec!["unused".into()],
            polling_only: true,
            heartbeat_interval: Some(Duration::from_secs(1)),
            ..WorkerOptions::default()
        };
        let worker = Worker::new(pool, options).unwrap();
        worker.0.reserve_for_test().await;
        worker
    }

    /// The backend process of the reserved connection, or `None` while it is missing.
    async fn reserved_backend(worker: &Worker) -> Option<i32> {
        let heartbeat = worker.0.heartbeat_connection()?;
        let reserved = heartbeat.connection().await;
        let connection = reserved.as_ref()?;
        Some(connection.query_one("SELECT pg_backend_pid()", &[]).await.unwrap().get(0))
    }

    /// The state and the latest statement of `backend`, as PostgreSQL reports them.
    async fn activity(observer: &tokio_postgres::Client, backend: i32) -> (String, String) {
        let row = observer
            .query_one("SELECT state, query FROM pg_stat_activity WHERE pid = $1", &[&backend])
            .await
            .unwrap();
        (row.get(0), row.get(1))
    }

    /// One lease that no worker owns, so a round that runs answers `stale`.
    fn unowned() -> [Sent; 1] {
        [Sent { task: Uuid::new_v4(), fence: 1, registration: 1 }]
    }

    const BEFORE_THE_STATEMENT: &str = "heartbeat round reached its deadline before the statement";

    // A settings statement that uses more than its quarter of the round ends the round before the
    // heartbeat statement. The round rolls back, and the next round uses the same connection.
    #[tokio::test]
    async fn a_round_that_expires_before_its_heartbeat_keeps_the_connection() {
        let Some(database) = scratch::scratch_database("heartbeat_expired_round").await else {
            return;
        };
        let observer = database.connect().await;
        let worker = database_worker(&database).await;
        let backend = reserved_backend(&worker).await.expect("no reserved connection");
        let members = unowned();
        // The quarter of a 750 ms round is about 187 ms, so a 300 ms delay fails the check.
        let round = worker.0.send_heartbeats(&members, Instant::now() + Duration::from_millis(750));
        let error = SETTINGS_DELAY.scope(Duration::from_millis(300), round).await.unwrap_err();
        assert_eq!(error.error.to_string(), BEFORE_THE_STATEMENT);
        assert_eq!(error.reason, RoundFailureReason::Timeout);
        // The settings statement came last before the ROLLBACK, so no heartbeat statement went out.
        assert_eq!(activity(&observer, backend).await, ("idle".into(), "ROLLBACK".into()));
        assert_eq!(reserved_backend(&worker).await, Some(backend), "the round discarded it");
        let statuses = worker
            .0
            .send_heartbeats(&members, Instant::now() + Duration::from_millis(750))
            .await
            .unwrap();
        assert_eq!(
            statuses.get(&members[0].task.to_string()),
            Some(&LeaseStatus::Owner(OwnershipStatus::Stale))
        );
        assert_eq!(reserved_backend(&worker).await, Some(backend));
    }

    // A round with less than the executor minimum before its deadline sends no BEGIN.
    #[tokio::test]
    async fn a_round_without_time_for_begin_sends_nothing_and_keeps_the_connection() {
        let Some(database) = scratch::scratch_database("heartbeat_round_without_time").await else {
            return;
        };
        let observer = database.connect().await;
        let worker = database_worker(&database).await;
        let backend = reserved_backend(&worker).await.expect("no reserved connection");
        let deadline = Instant::now() + MINIMUM_REMAINING - Duration::from_millis(1);
        let error = worker.0.send_heartbeats(&unowned(), deadline).await.unwrap_err();
        assert_eq!(error.error.to_string(), BEFORE_THE_STATEMENT);
        assert_eq!(error.reason, RoundFailureReason::Timeout);
        let latest = ("idle".into(), "SELECT pg_backend_pid()".into());
        assert_eq!(activity(&observer, backend).await, latest, "the round sent a statement");
        assert_eq!(reserved_backend(&worker).await, Some(backend), "the round discarded it");
    }

    // A round whose deadline passes while its heartbeat statement waits discards the connection,
    // because that statement can still run.
    #[tokio::test]
    async fn a_round_that_outlives_its_heartbeat_statement_discards_the_connection() {
        let Some(database) = scratch::scratch_database("heartbeat_outlived_round").await else {
            return;
        };
        let mut locker = database.connect().await;
        let worker = database_worker(&database).await;
        let backend = reserved_backend(&worker).await.expect("no reserved connection");
        let lock = locker.transaction().await.unwrap();
        // `heartbeat_many_v2` waits on this lock, as in the integration tests.
        lock.batch_execute("LOCK TABLE workhorse.fast_task_runtime IN EXCLUSIVE MODE")
            .await
            .unwrap();
        let deadline = Instant::now() + Duration::from_millis(300);
        worker.0.send_heartbeats(&unowned(), deadline).await.unwrap_err();
        // The keeper takes a replacement at once, so a later backend is a new one.
        assert_ne!(reserved_backend(&worker).await, Some(backend), "the round kept the connection");
        lock.rollback().await.unwrap();
        // The scratch database drop blocks this runtime, so the replacement must not be half open.
        worker.0.heartbeat_connection().unwrap().wait_ready().await;
        worker.0.release_subscription(None).await;
    }
}
