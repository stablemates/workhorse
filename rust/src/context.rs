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
use tokio::sync::watch;
use tokio_postgres::Row;

use crate::fenced_write::fenced_rows;
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

    /// The pool unfenced reads go through.
    pub(crate) fn pool(&self) -> &deadpool_postgres::Pool {
        &self.inner.pool
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
        let value = finite_json(&op().await?, "Checkpoint")?;
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
        let mut rows = fenced_rows(&self.inner.pool, statement, &all).await?;
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
fn finite_json<T: Serialize + ?Sized>(value: &T, label: &str) -> Result<Value, Error> {
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

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use serde_json::json;

    use super::*;
    use crate::{ChildTaskRequest, EnqueueOptions};

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
        HandlerContext::new(Arc::new(task), cancellation, pool, "worker".into())
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
