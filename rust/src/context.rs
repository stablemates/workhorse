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
use serde::{ser, Serialize};
use serde_json::Value;
use tokio::sync::{watch, OnceCell};
use tokio_postgres::Row;

use crate::checkpoint_input::checkpoint_input_fingerprint;
use crate::enqueue::EnqueueClient;
use crate::fenced_write::fenced_rows;
use crate::queue::{exactly_one, Executor};
use crate::sql_catalogue_generated as sql;
use crate::task_groups::{TaskGroupContext, TaskGroupLink};
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
    /// The longest wait of a checkout for a context statement (ADR 0071, rule 8).
    checkout: std::time::Duration,
    worker_id: String,
    suspended: AtomicBool,
    calls: InFlight<Error>,
    checkpoints: InFlight<HandlerError>,
    task_group: OnceCell<Option<TaskGroupLink>>,
    /// Prepares the requests a member task adds to its group, with this invocation's contracts.
    group_enqueue: EnqueueClient,
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
        checkout: std::time::Duration,
        worker_id: String,
    ) -> Self {
        // A task group add with no queue goes to the queue of the member task that adds it.
        let group_enqueue = EnqueueClient::new(task.queue.as_str());
        let inner = Durable {
            task,
            cancellation,
            pool,
            checkout,
            worker_id,
            suspended: AtomicBool::new(false),
            calls: InFlight::default(),
            checkpoints: InFlight::new(inputs_agree),
            task_group: OnceCell::new(),
            group_enqueue,
        };
        Self { inner: Arc::new(inner) }
    }

    pub fn task(&self) -> &ClaimedTask {
        &self.inner.task
    }

    pub fn cancellation(&self) -> &CancellationToken {
        &self.inner.cancellation
    }

    /// The pool that the statements of the context go through. A checkout waits for the bound of
    /// the worker at most, so a full pool cannot hold a context statement without a deadline.
    pub(crate) fn pool(&self) -> crate::queue::BoundedPool<'_> {
        crate::queue::BoundedPool::new(&self.inner.pool, self.inner.checkout)
    }

    pub(crate) fn worker_id(&self) -> &str {
        &self.inner.worker_id
    }

    /// The task group of this task, read at most once per invocation.
    pub(crate) fn task_group_link(&self) -> &OnceCell<Option<TaskGroupLink>> {
        &self.inner.task_group
    }

    pub(crate) fn group_enqueue(&self) -> &EnqueueClient {
        &self.inner.group_enqueue
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
        self.fast_tier_guard("checkpoints").map_err(named)?;
        validate_name(name, "checkpoint")?;
        self.shared_checkpoint(name, None, op).await
    }

    /// As [`HandlerContext::checkpoint`], and also stores the fingerprint of `input` with the
    /// result (ADR 0098).
    ///
    /// If the stored checkpoint, or an overlapping call with the same name, has the fingerprint of
    /// a different input, the call fails with [`Error::CheckpointInputConflict`] and `op` does not
    /// run. A stored checkpoint or a call without an input is not compared.
    /// [`checkpoint_input_fingerprint`] computes the fingerprint.
    pub async fn checkpoint_with_input<T, I, F, Fut>(
        &self,
        name: &str,
        input: &I,
        op: F,
    ) -> Result<T, HandlerError>
    where
        T: Serialize + DeserializeOwned,
        I: Serialize + ?Sized,
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, HandlerError>>,
    {
        self.fast_tier_guard("checkpoints").map_err(named)?;
        validate_name(name, "checkpoint")?;
        let fingerprint = checkpoint_input_fingerprint(input)?;
        self.shared_checkpoint(name, Some(fingerprint), op).await
    }

    async fn shared_checkpoint<T, F, Fut>(
        &self,
        name: &str,
        fingerprint: Option<String>,
        op: F,
    ) -> Result<T, HandlerError>
    where
        T: Serialize + DeserializeOwned,
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, HandlerError>>,
    {
        // An overlapping call with one name joins the call in flight if their inputs agree.
        let request = fingerprint.clone().unwrap_or_default();
        let conflict = |stored: &str| self.input_conflict(name, stored, &request);
        let value = self
            .inner
            .checkpoints
            .run(name, request.clone(), conflict, || {
                self.run_checkpoint(name, fingerprint.as_deref(), op)
            })
            .await?;
        serde_json::from_value(value).map_err(HandlerError::from)
    }

    async fn run_checkpoint<T, F, Fut>(
        &self,
        name: &str,
        fingerprint: Option<&str>,
        op: F,
    ) -> Result<Value, HandlerError>
    where
        T: Serialize,
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, HandlerError>>,
    {
        self.check(Operation::Checkpoint).map_err(named)?;
        let task = &self.inner.task;
        let rows = self.pool().rows(sql::GET_CHECKPOINT, &[&task.id, &name]).await?;
        if let [row] = rows.as_slice() {
            let stored = row.try_get::<_, Option<String>>("input_fingerprint")?;
            if let (Some(stored), Some(requested)) = (stored.as_deref(), fingerprint) {
                if !inputs_agree(stored, requested) {
                    return Err(self.input_conflict(name, stored, requested));
                }
            }
            return Ok(row.try_get::<_, Value>("checkpoint_value")?);
        }
        let value = finite_json(&op().await?, "Checkpoint")?;
        let params: [&(dyn tokio_postgres::types::ToSql + Sync); 3] = [&name, &value, &fingerprint];
        let row = self.call(sql::SAVE_CHECKPOINT_V2, "save_checkpoint_v2", &params).await?;
        match status(&row)?.as_str() {
            "saved" | "existing" => Ok(row.try_get::<_, Value>("checkpoint_value")?),
            "input_conflict" => {
                let stored = row.try_get::<_, Option<String>>("input_fingerprint")?;
                let stored = stored.unwrap_or_default();
                Err(self.input_conflict(name, &stored, fingerprint.unwrap_or_default()))
            }
            other => Err(named(self.refusal(Operation::Checkpoint, name, other))),
        }
    }

    fn input_conflict(&self, name: &str, stored: &str, requested: &str) -> HandlerError {
        HandlerError::from(Error::CheckpointInputConflict {
            task_id: self.inner.task.id,
            name: name.to_owned(),
            stored_fingerprint: stored.to_owned(),
            requested_fingerprint: requested.to_owned(),
        })
    }

    /// The task's latest progress, or `None` when no attempt has reported any.
    pub async fn get_progress<T: DeserializeOwned>(&self) -> Result<Option<T>, Error> {
        let rows = self.pool().rows(sql::LIST_PROGRESS, &[&self.inner.task.id]).await?;
        match rows.as_slice() {
            [] => Ok(None),
            [row] => Ok(Some(serde_json::from_value(row.try_get("progress_value")?)?)),
            _ => Err(Error::invalid("workhorse.task_progress returned more than one row")),
        }
    }

    /// Replaces the task's latest progress under this handler's fenced lease.
    pub async fn set_progress<T: Serialize>(&self, progress: &T) -> Result<(), Error> {
        self.fast_tier_guard("progress")?;
        let value = finite_json(progress, "Progress")?;
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

    /// Refuses durable execution state on a fast-tier task before any round trip.
    ///
    /// A fast-tier task has no checkpoints, progress, waits or children (ADR 0077). Refusing
    /// locally fails the attempt with a clear error instead of a PostgreSQL refusal.
    pub(crate) fn fast_tier_guard(&self, feature: &str) -> Result<(), Error> {
        let task = &self.inner.task;
        if !task.fast_tier {
            return Ok(());
        }
        Err(Error::FastTierUnsupported {
            queue: task.queue.clone(),
            feature: feature.into(),
            ordinal: None,
        })
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
        let mut rows = fenced_rows(&self.pool(), statement, &all).await?;
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
        let conflict = |_: &str| Error::Conflict { operation, name: name.to_owned() };
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

    /// See [`HandlerContext::checkpoint_with_input`].
    pub async fn checkpoint_with_input<T, I, F, Fut>(
        &self,
        name: &str,
        input: &I,
        op: F,
    ) -> Result<T, HandlerError>
    where
        T: Serialize + DeserializeOwned,
        I: Serialize + ?Sized,
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, HandlerError>>,
    {
        self.0.checkpoint_with_input(name, input, op).await
    }

    /// See [`HandlerContext::get_progress`].
    pub async fn get_progress<T: DeserializeOwned>(&self) -> Result<Option<T>, Error> {
        self.0.get_progress().await
    }

    /// See [`HandlerContext::set_progress`].
    pub async fn set_progress<T: Serialize>(&self, progress: &T) -> Result<(), Error> {
        self.0.set_progress(progress).await
    }

    /// See [`HandlerContext::task_group`]. A task group add does not suspend, so a batch member
    /// can read its group and add tasks to it.
    pub fn task_group(&self) -> TaskGroupContext<'_> {
        self.0.task_group()
    }
}

/// Keeps a lost lease and a fast-tier refusal recognisable once a checkpoint error becomes a
/// [`HandlerError`].
fn named(error: Error) -> HandlerError {
    match error {
        Error::LeaseLost { .. } => HandlerError::named("LeaseLostError", error.to_string()),
        Error::FastTierUnsupported { .. } => {
            HandlerError::named("FastTierUnsupportedError", error.to_string())
        }
        other => other.into(),
    }
}

/// Encodes a checkpoint or progress value, refusing `NaN` and the infinities at any depth.
///
/// `serde_json` encodes a non-finite float as `null`, so a value typed as a number would read
/// back as `null` and fail to decode on every replay.
pub(crate) fn finite_json<T: Serialize + ?Sized>(value: &T, label: &str) -> Result<Value, Error> {
    if let Err(Walk::NonFinite) = value.serialize(FiniteNumbers) {
        return Err(Error::invalid(format!("{label} value must contain only finite numbers")));
    }
    Ok(serde_json::to_value(value)?)
}

/// Why the walk over a value stopped. `serde_json` reports any reason but a non-finite number.
#[derive(Debug)]
enum Walk {
    NonFinite,
    Custom,
}

impl fmt::Display for Walk {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::NonFinite => "non-finite number",
            Self::Custom => "value refused to serialize",
        })
    }
}

impl std::error::Error for Walk {}

impl ser::Error for Walk {
    fn custom<T: fmt::Display>(_: T) -> Self {
        Self::Custom
    }
}

/// A serializer that writes nothing and stops at the first non-finite float, key or value.
struct FiniteNumbers;

macro_rules! accept {
    ($($method:ident: $type:ty),* $(,)?) => {
        $(fn $method(self, _: $type) -> Result<(), Walk> { Ok(()) })*
    };
}

impl ser::Serializer for FiniteNumbers {
    type Ok = ();
    type Error = Walk;
    type SerializeSeq = Self;
    type SerializeTuple = Self;
    type SerializeTupleStruct = Self;
    type SerializeTupleVariant = Self;
    type SerializeMap = Self;
    type SerializeStruct = Self;
    type SerializeStructVariant = Self;

    accept!(
        serialize_bool: bool,
        serialize_i8: i8,
        serialize_i16: i16,
        serialize_i32: i32,
        serialize_i64: i64,
        serialize_i128: i128,
        serialize_u8: u8,
        serialize_u16: u16,
        serialize_u32: u32,
        serialize_u64: u64,
        serialize_u128: u128,
        serialize_char: char,
        serialize_str: &str,
        serialize_bytes: &[u8],
        serialize_unit_struct: &'static str,
    );

    fn serialize_f32(self, value: f32) -> Result<(), Walk> {
        if value.is_finite() {
            Ok(())
        } else {
            Err(Walk::NonFinite)
        }
    }

    fn serialize_f64(self, value: f64) -> Result<(), Walk> {
        if value.is_finite() {
            Ok(())
        } else {
            Err(Walk::NonFinite)
        }
    }

    fn serialize_none(self) -> Result<(), Walk> {
        Ok(())
    }

    fn serialize_some<T: Serialize + ?Sized>(self, value: &T) -> Result<(), Walk> {
        value.serialize(self)
    }

    fn serialize_unit(self) -> Result<(), Walk> {
        Ok(())
    }

    fn serialize_unit_variant(self, _: &'static str, _: u32, _: &'static str) -> Result<(), Walk> {
        Ok(())
    }

    fn serialize_newtype_struct<T: Serialize + ?Sized>(
        self,
        _: &'static str,
        value: &T,
    ) -> Result<(), Walk> {
        value.serialize(self)
    }

    fn serialize_newtype_variant<T: Serialize + ?Sized>(
        self,
        _: &'static str,
        _: u32,
        _: &'static str,
        value: &T,
    ) -> Result<(), Walk> {
        value.serialize(self)
    }

    fn serialize_seq(self, _: Option<usize>) -> Result<Self, Walk> {
        Ok(self)
    }

    fn serialize_tuple(self, _: usize) -> Result<Self, Walk> {
        Ok(self)
    }

    fn serialize_tuple_struct(self, _: &'static str, _: usize) -> Result<Self, Walk> {
        Ok(self)
    }

    fn serialize_tuple_variant(
        self,
        _: &'static str,
        _: u32,
        _: &'static str,
        _: usize,
    ) -> Result<Self, Walk> {
        Ok(self)
    }

    fn serialize_map(self, _: Option<usize>) -> Result<Self, Walk> {
        Ok(self)
    }

    fn serialize_struct(self, _: &'static str, _: usize) -> Result<Self, Walk> {
        Ok(self)
    }

    fn serialize_struct_variant(
        self,
        _: &'static str,
        _: u32,
        _: &'static str,
        _: usize,
    ) -> Result<Self, Walk> {
        Ok(self)
    }
}

macro_rules! walk_elements {
    ($($trait:ident :: $method:ident),* $(,)?) => {
        $(impl ser::$trait for FiniteNumbers {
            type Ok = ();
            type Error = Walk;

            fn $method<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), Walk> {
                value.serialize(FiniteNumbers)
            }

            fn end(self) -> Result<(), Walk> {
                Ok(())
            }
        })*
    };
}

walk_elements!(
    SerializeSeq::serialize_element,
    SerializeTuple::serialize_element,
    SerializeTupleStruct::serialize_field,
    SerializeTupleVariant::serialize_field,
);

impl ser::SerializeMap for FiniteNumbers {
    type Ok = ();
    type Error = Walk;

    fn serialize_key<T: Serialize + ?Sized>(&mut self, key: &T) -> Result<(), Walk> {
        key.serialize(FiniteNumbers)
    }

    fn serialize_value<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), Walk> {
        value.serialize(FiniteNumbers)
    }

    fn end(self) -> Result<(), Walk> {
        Ok(())
    }
}

macro_rules! walk_fields {
    ($($trait:ident),* $(,)?) => {
        $(impl ser::$trait for FiniteNumbers {
            type Ok = ();
            type Error = Walk;

            fn serialize_field<T: Serialize + ?Sized>(
                &mut self,
                _: &'static str,
                value: &T,
            ) -> Result<(), Walk> {
                value.serialize(FiniteNumbers)
            }

            fn end(self) -> Result<(), Walk> {
                Ok(())
            }
        })*
    };
}

walk_fields!(SerializeStruct, SerializeStructVariant);

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

/// Whether two checkpoint input fingerprints agree. An empty fingerprint is a call or a stored
/// checkpoint without an input, which never conflicts.
fn inputs_agree(stored: &str, requested: &str) -> bool {
    stored.is_empty() || requested.is_empty() || stored == requested
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
    /// Whether a caller with the second request can share a call issued for the first.
    agree: fn(&str, &str) -> bool,
}

impl<E> InFlight<E> {
    fn new(agree: fn(&str, &str) -> bool) -> Self {
        Self { calls: Mutex::default(), agree }
    }
}

impl<E> Default for InFlight<E> {
    fn default() -> Self {
        Self::new(|existing, request| existing == request)
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
    /// A request that does not agree with the one in flight under `key` is refused with
    /// `conflict`, which receives the request in flight. When a driver is dropped before it
    /// finishes, a waiter takes over and drives the call itself.
    async fn run<F, Fut>(
        &self,
        key: &str,
        request: String,
        conflict: impl FnOnce(&str) -> E,
        drive: F,
    ) -> Result<Value, E>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Value, E>>,
    {
        loop {
            match self.join(key, &request) {
                Err(existing) => return Err(conflict(&existing)),
                Ok(Role::Drive(sender)) => {
                    let _entry = Entry { calls: &self.calls, key };
                    let result = drive().await;
                    sender.send_replace(Some(share(&result)));
                    return result;
                }
                Ok(Role::Wait(mut receiver)) => {
                    // An error means the driver was dropped unfinished, so this caller drives.
                    if let Ok(outcome) = receiver.wait_for(Option::is_some).await {
                        return share(outcome.as_ref().expect("waited for an outcome"));
                    }
                }
            }
        }
    }

    /// Registers the caller as the driver of `key`, or as a waiter. A conflict returns the
    /// request in flight.
    fn join(&self, key: &str, request: &str) -> Result<Role<E>, String> {
        let mut calls = self.calls.lock().unwrap_or_else(PoisonError::into_inner);
        match calls.get(key) {
            Some((existing, _)) if !(self.agree)(existing, request) => Err(existing.clone()),
            Some((_, receiver)) => Ok(Role::Wait(receiver.clone())),
            None => {
                let (sender, receiver) = watch::channel(None);
                calls.insert(key.to_owned(), (request.to_owned(), receiver));
                Ok(Role::Drive(sender))
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

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use serde_json::json;

    use super::*;
    use crate::{ChildTaskRequest, EnqueueOptions};

    /// The checkout bound that the test contexts get from their worker.
    const CHECKOUT: Duration = Duration::from_secs(5);

    /// A pool over a database that does not exist, so any round trip fails with a pool error.
    fn unreachable_pool() -> deadpool_postgres::Pool {
        let mut config = deadpool_postgres::Config::new();
        config.dbname = Some("unused".into());
        config.create_pool(Some(deadpool_postgres::Runtime::Tokio1), tokio_postgres::NoTls).unwrap()
    }

    fn fast_context() -> HandlerContext {
        context(true, CancellationToken::default(), unreachable_pool())
    }

    fn context(
        fast_tier: bool,
        cancellation: CancellationToken,
        pool: deadpool_postgres::Pool,
    ) -> HandlerContext {
        let task = ClaimedTask {
            id: uuid::Uuid::new_v4(),
            task_type: "fast".into(),
            queue: "fast-queue".into(),
            priority: 0,
            payload: json!({}),
            contract_version: None,
            result_max_bytes: None,
            redact_error_details: false,
            trace_context: None,
            attempt: 1,
            max_attempts: 1,
            retry_policy: json!({}),
            deadline_at: None,
            execution_timeout: None,
            attempt_timeout_at: None,
            fence_token: 1,
            lease_expires_at: Utc::now(),
            claim_sent_at: tokio::time::Instant::now(),
            fast_tier,
        };
        HandlerContext::new(Arc::new(task), cancellation, pool, CHECKOUT, "worker".into())
    }

    /// A pool over a server that accepts connections and never answers the handshake.
    async fn stalled_pool() -> (deadpool_postgres::Pool, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((socket, _)) = listener.accept().await {
                held.push(socket);
            }
        });
        let mut config = deadpool_postgres::Config::new();
        config.host = Some("127.0.0.1".into());
        config.port = Some(port);
        config.dbname = Some("unused".into());
        config.user = Some("unused".into());
        let pool = config
            .create_pool(Some(deadpool_postgres::Runtime::Tokio1), tokio_postgres::NoTls)
            .unwrap();
        (pool, server)
    }

    fn refused(error: Error, expected: &str) {
        match error {
            Error::FastTierUnsupported { queue, feature, ordinal: None } => {
                assert_eq!((queue.as_str(), feature.as_str()), ("fast-queue", expected));
            }
            other => panic!("expected a fast-tier refusal for {expected}, got {other:?}"),
        }
    }

    // Each refusal must come before a round trip: a call that reached the unreachable pool would
    // fail with a pool error instead.
    #[tokio::test]
    async fn a_fast_task_is_refused_durable_state_without_a_round_trip() {
        let context = fast_context();
        let child = || ChildTaskRequest::new("child", "leaf", &json!({})).unwrap();
        refused(context.set_progress(&json!({})).await.unwrap_err(), "progress");
        refused(context.sleep("pause", Duration::from_secs(1)).await.unwrap_err(), "durable waits");
        refused(context.sleep_until("pause", Utc::now()).await.unwrap_err(), "durable waits");
        let signal = context.wait_for_signal::<Value>("go", None).await.unwrap_err();
        refused(signal, "signal waits");
        let human = context.wait_for_human::<_, Value>("review", &json!({}), None).await;
        refused(human.unwrap_err(), "human waits");
        let child_run = context
            .run_child::<_, Value>("child", "leaf", &json!({}), EnqueueOptions::default())
            .await;
        refused(child_run.unwrap_err(), "child tasks");
        refused(context.run_children(vec![child()]).await.unwrap_err(), "child tasks");
        refused(context.run_children_all(vec![child()]).await.unwrap_err(), "child tasks");

        let checkpoint = context.checkpoint("step", || async { Ok(1) }).await.unwrap_err();
        assert_eq!(checkpoint.name.as_deref(), Some("FastTierUnsupportedError"));
        assert_eq!(checkpoint.message, "Fast-tier queue fast-queue does not support checkpoints");
    }

    #[derive(Serialize)]
    struct Reading {
        name: &'static str,
        value: f64,
    }

    fn non_finite(error: Error, label: &str) {
        match error {
            Error::InvalidArgument(message) => {
                assert_eq!(message, format!("{label} value must contain only finite numbers"));
            }
            other => panic!("expected {label} to refuse a non-finite number, got {other:?}"),
        }
    }

    #[test]
    fn a_non_finite_float_is_refused_at_any_depth() {
        non_finite(finite_json(&f64::NAN, "Checkpoint").unwrap_err(), "Checkpoint");
        non_finite(finite_json(&f32::INFINITY, "Checkpoint").unwrap_err(), "Checkpoint");
        let field = Reading { name: "load", value: f64::INFINITY };
        non_finite(finite_json(&field, "Progress").unwrap_err(), "Progress");
        non_finite(finite_json(&vec![1.0, f64::NEG_INFINITY], "Progress").unwrap_err(), "Progress");
        let deep = HashMap::from([("readings", vec![Some(f64::NAN)])]);
        non_finite(finite_json(&deep, "Progress").unwrap_err(), "Progress");

        let finite = Reading { name: "load", value: 1.5 };
        assert_eq!(
            finite_json(&finite, "Progress").unwrap(),
            json!({ "name": "load", "value": 1.5 })
        );
        // A value JSON cannot encode for another reason keeps serde_json's error.
        let keyed = HashMap::from([((1, 2), 3)]);
        assert!(matches!(finite_json(&keyed, "Progress"), Err(Error::Json(_))));
    }

    // Any round trip would fail on the unreachable pool with a pool error instead.
    #[tokio::test]
    async fn progress_with_a_non_finite_float_is_refused_without_a_round_trip() {
        let context = context(false, CancellationToken::default(), unreachable_pool());
        let batch = BatchHandlerContext::new(context.clone());
        let field = Reading { name: "load", value: f64::INFINITY };
        let list = vec![1.0, f64::NEG_INFINITY];
        non_finite(context.set_progress(&f64::NAN).await.unwrap_err(), "Progress");
        non_finite(context.set_progress(&field).await.unwrap_err(), "Progress");
        non_finite(context.set_progress(&list).await.unwrap_err(), "Progress");
        non_finite(batch.set_progress(&f64::NAN).await.unwrap_err(), "Progress");
        non_finite(batch.set_progress(&field).await.unwrap_err(), "Progress");
        non_finite(batch.set_progress(&list).await.unwrap_err(), "Progress");
    }

    // SM-1572: a context statement waits for a pooled connection for the checkout bound of its
    // worker, not without a limit. The server never answers, so the checkout cannot end any other
    // way. Paused time reaches the bound as soon as every task waits.
    #[tokio::test(start_paused = true)]
    async fn a_context_statement_waits_for_its_checkout_bound_at_most() {
        let (pool, server) = stalled_pool().await;
        let context = context(false, CancellationToken::default(), pool);
        let started = tokio::time::Instant::now();
        let read = tokio::time::timeout(CHECKOUT * 12, context.get_progress::<Value>())
            .await
            .expect("the checkout waited without a limit");
        assert!(
            matches!(
                read,
                Err(Error::Pool(deadpool_postgres::PoolError::Timeout(
                    deadpool_postgres::TimeoutType::Wait
                )))
            ),
            "{read:?}"
        );
        assert_eq!(started.elapsed(), CHECKOUT);
        server.abort();
    }

    // The first call waits on the stalled server, so an overlapping call with one name can only
    // join it or conflict with it.
    #[tokio::test]
    async fn an_overlapping_checkpoint_with_a_different_input_conflicts() {
        let (pool, server) = stalled_pool().await;
        let context = context(false, CancellationToken::default(), pool);
        let charge = json!({ "amountCents": 1000 });
        let driver = tokio::spawn({
            let context = context.clone();
            let charge = charge.clone();
            async move {
                context.checkpoint_with_input("charge", &charge, || async { Ok(json!(1)) }).await
            }
        });
        tokio::time::sleep(Duration::from_millis(50)).await;

        let discounted = json!({ "amountCents": 900 });
        let conflict = context
            .checkpoint_with_input::<Value, _, _, _>("charge", &discounted, || async {
                panic!("a conflicting call ran its operation")
            })
            .await
            .unwrap_err();
        assert_eq!(conflict.name.as_deref(), Some("CheckpointInputConflictError"));
        assert!(conflict.is_conflict(), "an input conflict must fail the task for good");
        let expected = format!(
            "Checkpoint charge for task {} stores the result of a different input",
            context.task().id
        );
        assert_eq!(conflict.message, expected);

        // The same input and a call without an input join the call in flight.
        let bound = Duration::from_millis(100);
        let same = context
            .checkpoint_with_input::<Value, _, _, _>("charge", &charge, || async { Ok(json!(2)) });
        assert!(tokio::time::timeout(bound, same).await.is_err(), "the same input did not join");
        let plain = context.checkpoint::<Value, _, _>("charge", || async { Ok(json!(3)) });
        assert!(tokio::time::timeout(bound, plain).await.is_err(), "a plain call did not join");
        driver.abort();
        server.abort();
    }

    #[tokio::test]
    async fn a_checkpoint_input_with_a_non_finite_number_is_refused_without_a_round_trip() {
        let context = context(false, CancellationToken::default(), unreachable_pool());
        let refused = context
            .checkpoint_with_input::<Value, _, _, _>("charge", &f64::NAN, || async {
                panic!("a refused call ran its operation")
            })
            .await
            .unwrap_err();
        assert_eq!(refused.message, "Checkpoint input value must contain only finite numbers");
        assert!(!refused.is_conflict());
    }

    // Any round trip would wait on the stalled server, so only a check before the contract
    // lookups returns within the bound.
    #[tokio::test]
    async fn a_canceled_handler_creates_no_child_without_a_responsive_database() {
        let (pool, server) = stalled_pool().await;
        let cancellation = CancellationToken::default();
        cancellation.cancel(CancelReason::LeaseLost);
        let context = context(false, cancellation, pool);
        let child = || ChildTaskRequest::new("child", "leaf", &json!({})).unwrap();
        let bound = Duration::from_millis(500);
        let lease_lost = |result: Result<Result<(), Error>, _>, operation| match result {
            Ok(Err(Error::LeaseLost { operation: lost, .. })) => assert_eq!(lost, operation),
            Ok(other) => panic!("expected {operation:?} to lose its lease, got {other:?}"),
            Err(_) => panic!("{operation:?} waited on the stalled database"),
        };
        let payload = json!({});
        let options = EnqueueOptions::default();
        let run_child = context.run_child::<_, Value>("child", "leaf", &payload, options);
        let run_child = tokio::time::timeout(bound, run_child).await;
        lease_lost(run_child.map(|result| result.map(drop)), Operation::RunChild);
        let set = tokio::time::timeout(bound, context.run_children(vec![child()])).await;
        lease_lost(set.map(|result| result.map(drop)), Operation::RunChildren);
        let all = tokio::time::timeout(bound, context.run_children_all(vec![child()])).await;
        lease_lost(all.map(|result| result.map(drop)), Operation::RunChildren);
        server.abort();
    }
}
