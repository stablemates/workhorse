//! The durable handler context: fenced checkpoints, progress and suspension over PostgreSQL.
//!
//! PostgreSQL owns replay, idempotency and settlement. The context issues one protocol call per
//! durable operation and shares an in-flight call among concurrent callers of the same name.
use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::watch;
use tokio_postgres::Row;

use crate::queue::{exactly_one, Executor};
use crate::sql_catalogue_generated as sql;
use crate::{CancelReason, CancellationToken, ClaimedTask, Error, HandlerError, Operation};

/// The fenced task, its cancellation and its durable operations for one handler invocation.
///
/// It clones cheaply, so a handler can move it into spawned futures.
#[derive(Clone)]
pub struct HandlerContext {
    inner: Arc<Durable>,
}

struct Durable {
    task: Arc<ClaimedTask>,
    cancellation: CancellationToken,
    pool: deadpool_postgres::Pool,
    worker_id: String,
    suspended: AtomicBool,
    calls: InFlight<Error>,
    checkpoints: InFlight<HandlerError>,
}

impl fmt::Debug for HandlerContext {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HandlerContext")
            .field("task", &self.inner.task.id)
            .field("cancellation", &self.inner.cancellation)
            .finish_non_exhaustive()
    }
}

impl HandlerContext {
    pub(crate) fn new(
        task: Arc<ClaimedTask>,
        cancellation: CancellationToken,
        pool: deadpool_postgres::Pool,
        worker_id: String,
    ) -> Self {
        let inner = Durable {
            task,
            cancellation,
            pool,
            worker_id,
            suspended: AtomicBool::new(false),
            calls: InFlight::default(),
            checkpoints: InFlight::default(),
        };
        Self { inner: Arc::new(inner) }
    }

    pub fn task(&self) -> &ClaimedTask {
        &self.inner.task
    }

    pub fn cancellation(&self) -> &CancellationToken {
        &self.inner.cancellation
    }

    /// Whether a durable call suspended the task, which PostgreSQL has then already settled.
    pub(crate) fn suspended(&self) -> bool {
        self.inner.suspended.load(Ordering::Acquire)
    }

    /// Returns the stored value for `name`, or runs `op` once and saves its result immutably.
    pub async fn checkpoint<T, F, Fut>(&self, name: &str, op: F) -> Result<T, HandlerError>
    where
        T: Serialize + DeserializeOwned,
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, HandlerError>>,
    {
        validate_name(name, "checkpoint")?;
        let value = self
            .inner
            .checkpoints
            .run(name, String::new(), unreachable_conflict, || self.run_checkpoint(name, op))
            .await?;
        serde_json::from_value(value).map_err(HandlerError::from)
    }

    async fn run_checkpoint<T, F, Fut>(&self, name: &str, op: F) -> Result<Value, HandlerError>
    where
        T: Serialize,
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, HandlerError>>,
    {
        self.check(Operation::Checkpoint).map_err(named)?;
        let task = &self.inner.task;
        let rows = self.inner.pool.rows(sql::LIST_CHECKPOINT, &[&task.id, &name]).await?;
        if let [row] = rows.as_slice() {
            return Ok(row.try_get::<_, Value>("checkpoint_value")?);
        }
        let value = serde_json::to_value(op().await?)?;
        let row =
            self.call(sql::SAVE_CHECKPOINT_V1, "save_checkpoint_v1", &[&name, &value]).await?;
        match status(&row)?.as_str() {
            "saved" | "existing" => Ok(row.try_get::<_, Value>("checkpoint_value")?),
            other => Err(named(self.refusal(Operation::Checkpoint, name, other))),
        }
    }

    /// The task's latest progress, or `None` when no attempt has reported any.
    pub async fn get_progress<T: DeserializeOwned>(&self) -> Result<Option<T>, Error> {
        let rows = self.inner.pool.rows(sql::LIST_PROGRESS, &[&self.inner.task.id]).await?;
        match rows.as_slice() {
            [] => Ok(None),
            [row] => Ok(Some(serde_json::from_value(row.try_get("progress_value")?)?)),
            _ => Err(Error::invalid("workhorse.task_progress returned more than one row")),
        }
    }

    /// Replaces the task's latest progress under this handler's fenced lease.
    pub async fn set_progress<T: Serialize>(&self, progress: &T) -> Result<(), Error> {
        let value = serde_json::to_value(progress)?;
        self.check(Operation::Progress)?;
        let row = self.call(sql::UPDATE_PROGRESS_V1, "update_progress_v1", &[&value]).await?;
        match status(&row)?.as_str() {
            "updated" | "unchanged" => Ok(()),
            "rate_limited" => {
                let retry_after = row
                    .try_get::<_, Option<String>>("retry_after_ms")?
                    .and_then(|text| text.parse::<u64>().ok())
                    .ok_or_else(|| Error::invalid("rate limited progress has no retry delay"))?;
                Err(Error::ProgressRateLimited { retry_after: Duration::from_millis(retry_after) })
            }
            other => Err(self.refusal(Operation::Progress, "progress", other)),
        }
    }

    /// Fails fast once the handler no longer owns its task.
    pub(crate) fn check(&self, operation: Operation) -> Result<(), Error> {
        if self.suspended() {
            return Err(Error::Suspended);
        }
        match self.inner.cancellation.reason() {
            Some(CancelReason::LeaseLost) => {
                Err(Error::LeaseLost { task_id: self.inner.task.id, operation })
            }
            Some(reason) => Err(Error::Cancelled(reason)),
            None => Ok(()),
        }
    }

    /// Records that PostgreSQL suspended the task and stops the handler.
    pub(crate) fn suspend(&self) -> Error {
        self.inner.suspended.store(true, Ordering::Release);
        self.inner.cancellation.cancel(CancelReason::Suspended);
        Error::Suspended
    }

    /// Runs one fenced protocol call, prefixed with the task, worker and fence.
    pub(crate) async fn call(
        &self,
        statement: &str,
        function: &str,
        params: &[&(dyn tokio_postgres::types::ToSql + Sync)],
    ) -> Result<Row, Error> {
        let task = &self.inner.task;
        let mut all: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> =
            vec![&task.id, &self.inner.worker_id, &task.fence_token];
        all.extend_from_slice(params);
        let mut rows = self.inner.pool.rows(statement, &all).await?;
        exactly_one(&rows, function)?;
        Ok(rows.remove(0))
    }

    /// Maps a refusal status shared by every durable call to its error.
    pub(crate) fn refusal(&self, operation: Operation, name: &str, status: &str) -> Error {
        let name = name.to_owned();
        match status {
            "stale" => Error::LeaseLost { task_id: self.inner.task.id, operation },
            "conflict" => Error::Conflict { operation, name },
            "limit_exceeded" => Error::LimitExceeded { operation, name },
            "already_waiting" => Error::AlreadyWaiting { operation, name },
            _ => Error::UnexpectedStatus { operation, status: status.to_owned() },
        }
    }

    /// Shares one in-flight call among concurrent callers of the same key and request.
    pub(crate) async fn shared<F, Fut>(
        &self,
        operation: Operation,
        key: &str,
        request: String,
        drive: F,
    ) -> Result<Value, Error>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Value, Error>>,
    {
        let name = key.split_once(':').map_or(key, |(_, name)| name);
        let conflict = || Error::Conflict { operation, name: name.to_owned() };
        self.inner.calls.run(key, request, conflict, drive).await
    }
}

/// A batch member's context: its task, cancellation, checkpoints and progress, but no suspension.
#[derive(Clone, Debug)]
pub struct BatchHandlerContext(HandlerContext);

impl BatchHandlerContext {
    pub(crate) fn new(context: HandlerContext) -> Self {
        Self(context)
    }

    pub fn task(&self) -> &ClaimedTask {
        self.0.task()
    }

    pub fn cancellation(&self) -> &CancellationToken {
        self.0.cancellation()
    }

    /// See [`HandlerContext::checkpoint`].
    pub async fn checkpoint<T, F, Fut>(&self, name: &str, op: F) -> Result<T, HandlerError>
    where
        T: Serialize + DeserializeOwned,
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, HandlerError>>,
    {
        self.0.checkpoint(name, op).await
    }

    /// See [`HandlerContext::get_progress`].
    pub async fn get_progress<T: DeserializeOwned>(&self) -> Result<Option<T>, Error> {
        self.0.get_progress().await
    }

    /// See [`HandlerContext::set_progress`].
    pub async fn set_progress<T: Serialize>(&self, progress: &T) -> Result<(), Error> {
        self.0.set_progress(progress).await
    }
}

/// Keeps a lost lease recognisable once a checkpoint error becomes a [`HandlerError`].
fn named(error: Error) -> HandlerError {
    match error {
        Error::LeaseLost { .. } => HandlerError::named("LeaseLostError", error.to_string()),
        other => other.into(),
    }
}

pub(crate) fn status(row: &Row) -> Result<String, Error> {
    Ok(row.try_get::<_, Option<String>>("status")?.unwrap_or_default())
}

/// Checks a durable name's length in characters, as PostgreSQL does.
pub(crate) fn validate_name(name: &str, label: &str) -> Result<(), Error> {
    if (1..=200).contains(&name.chars().count()) {
        Ok(())
    } else {
        Err(Error::invalid(format!("{label} name must contain between 1 and 200 characters")))
    }
}

fn unreachable_conflict() -> HandlerError {
    HandlerError::new("checkpoint calls share one name without a request fingerprint")
}

/// An error a waiting caller can receive a copy of.
trait Shared {
    fn share(&self) -> Self;
}

impl Shared for Error {
    fn share(&self) -> Self {
        Error::share(self)
    }
}

impl Shared for HandlerError {
    fn share(&self) -> Self {
        self.clone()
    }
}

type Outcome<E> = Option<Result<Value, E>>;
type Calls<E> = Mutex<HashMap<String, (String, watch::Receiver<Outcome<E>>)>>;

/// The calls in flight, by key, with the request each one was issued for.
struct InFlight<E> {
    calls: Calls<E>,
}

impl<E> Default for InFlight<E> {
    fn default() -> Self {
        Self { calls: Mutex::default() }
    }
}

/// Removes a driver's entry when its call ends or its future is dropped.
struct Entry<'a, E> {
    calls: &'a Calls<E>,
    key: &'a str,
}

impl<E> Drop for Entry<'_, E> {
    fn drop(&mut self) {
        self.calls.lock().unwrap_or_else(PoisonError::into_inner).remove(self.key);
    }
}

enum Role<E> {
    Drive(watch::Sender<Outcome<E>>),
    Wait(watch::Receiver<Outcome<E>>),
}

impl<E: Shared> InFlight<E> {
    /// Drives `drive` as the first caller of `key`, or awaits the first caller's outcome.
    ///
    /// A different request under a key already in flight is refused with `conflict`. When a
    /// driver is dropped before it finishes, a waiter takes over and drives the call itself.
    async fn run<F, Fut>(
        &self,
        key: &str,
        request: String,
        conflict: impl FnOnce() -> E,
        drive: F,
    ) -> Result<Value, E>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Value, E>>,
    {
        loop {
            match self.join(key, &request) {
                None => return Err(conflict()),
                Some(Role::Drive(sender)) => {
                    let _entry = Entry { calls: &self.calls, key };
                    let result = drive().await;
                    sender.send_replace(Some(share(&result)));
                    return result;
                }
                Some(Role::Wait(mut receiver)) => {
                    // An error means the driver was dropped unfinished, so this caller drives.
                    if let Ok(outcome) = receiver.wait_for(Option::is_some).await {
                        return share(outcome.as_ref().expect("waited for an outcome"));
                    }
                }
            }
        }
    }

    /// Registers the caller as the driver of `key`, or as a waiter; `None` is a conflict.
    fn join(&self, key: &str, request: &str) -> Option<Role<E>> {
        let mut calls = self.calls.lock().unwrap_or_else(PoisonError::into_inner);
        match calls.get(key) {
            Some((existing, _)) if existing != request => None,
            Some((_, receiver)) => Some(Role::Wait(receiver.clone())),
            None => {
                let (sender, receiver) = watch::channel(None);
                calls.insert(key.to_owned(), (request.to_owned(), receiver));
                Some(Role::Drive(sender))
            }
        }
    }
}

fn share<E: Shared>(result: &Result<Value, E>) -> Result<Value, E> {
    match result {
        Ok(value) => Ok(value.clone()),
        Err(error) => Err(error.share()),
    }
}
