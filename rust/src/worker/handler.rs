//! What a handler receives and returns: the claimed task, its cancellation and its error.
use std::fmt;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use chrono::{DateTime, Utc};
use futures_util::future::BoxFuture;
use serde_json::Value;
use uuid::Uuid;

use crate::{BatchHandlerContext, CancelReason, HandlerContext};

/// One task the worker owns under a fenced lease.
#[non_exhaustive]
#[derive(Clone, Debug)]
pub struct ClaimedTask {
    pub id: Uuid,
    pub task_type: String,
    pub queue: String,
    pub priority: i32,
    pub payload: Value,
    pub contract_version: Option<String>,
    pub result_max_bytes: Option<i32>,
    pub redact_error_details: bool,
    pub trace_context: Option<Value>,
    pub attempt: i32,
    pub max_attempts: i32,
    pub retry_policy: Value,
    pub deadline_at: Option<DateTime<Utc>>,
    pub execution_timeout: Option<Duration>,
    pub attempt_timeout_at: Option<DateTime<Utc>>,
    pub fence_token: i64,
    pub lease_expires_at: DateTime<Utc>,
    /// When the claim was sent, which bounds the first lease locally.
    pub(crate) claim_sent_at: tokio::time::Instant,
    /// Whether the task came from a fast-tier queue (ADR 0077). Its handler cannot use durable
    /// execution state, and its completion takes the batched path.
    pub(crate) fast_tier: bool,
}

/// Fires once, with the first reason, when the worker stops a handler.
#[derive(Clone, Debug, Default)]
pub struct CancellationToken {
    token: tokio_util::sync::CancellationToken,
    reason: Arc<OnceLock<CancelReason>>,
}

impl CancellationToken {
    pub fn is_cancelled(&self) -> bool {
        self.token.is_cancelled()
    }

    /// Why the token fired, or `None` while the handler still owns the task.
    pub fn reason(&self) -> Option<CancelReason> {
        self.reason.get().copied()
    }

    /// Resolves when the token fires.
    pub async fn cancelled(&self) {
        self.token.cancelled().await;
    }

    pub(crate) fn cancel(&self, reason: CancelReason) {
        let _ = self.reason.set(reason);
        self.token.cancel();
    }
}

/// A handler failure, submitted through the task's persisted retry policy.
///
/// Any `std::error::Error` converts into it, so a handler can use `?`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HandlerError {
    pub name: Option<String>,
    pub message: String,
    pub stack: Option<String>,
}

impl HandlerError {
    pub fn new(message: impl Into<String>) -> Self {
        Self { name: None, message: message.into(), stack: None }
    }

    pub fn named(name: impl Into<String>, message: impl Into<String>) -> Self {
        Self { name: Some(name.into()), ..Self::new(message) }
    }

    pub(crate) fn from_panic(
        task_type: &str,
        batch: bool,
        panic: Box<dyn std::any::Any + Send>,
    ) -> Self {
        let detail = panic
            .downcast_ref::<&str>()
            .map(|value| (*value).to_owned())
            .or_else(|| panic.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "non-string panic".into());
        let kind = if batch { "batch handler" } else { "handler" };
        Self::named("HandlerPanic", format!("{kind} for {task_type} panicked: {detail}"))
    }
}

impl fmt::Display for HandlerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.name {
            Some(name) => write!(formatter, "{name}: {}", self.message),
            None => formatter.write_str(&self.message),
        }
    }
}

impl<E: std::error::Error> From<E> for HandlerError {
    fn from(error: E) -> Self {
        Self::new(error.to_string())
    }
}

/// Bounds one process-local batch rendezvous.
#[derive(Clone, Copy, Debug)]
pub struct BatchOptions {
    /// Between 1 and 100, and no larger than the worker's concurrency.
    pub max_size: usize,
    /// How long the first member waits for more, in whole milliseconds up to 60 seconds.
    pub linger: Duration,
}

/// One claimed member of a batch and its independent fenced context.
#[derive(Debug)]
pub struct BatchItem<P> {
    pub payload: P,
    pub context: BatchHandlerContext,
}

/// One member's explicit outcome, returned by position.
#[derive(Debug)]
pub enum BatchResult<R> {
    Succeeded(R),
    Failed(HandlerError),
}

pub(crate) type HandlerResult = Result<Value, HandlerError>;
pub(crate) type ErasedHandler =
    Arc<dyn Fn(Value, HandlerContext) -> BoxFuture<'static, HandlerResult> + Send + Sync>;

/// Decodes a payload, or fails the attempt through the retry policy.
pub(crate) fn decode<P: serde::de::DeserializeOwned>(payload: Value) -> Result<P, HandlerError> {
    serde_json::from_value(payload)
        .map_err(|error| HandlerError::named("PayloadDecodeError", error.to_string()))
}

pub(crate) fn encode<R: serde::Serialize>(result: R) -> HandlerResult {
    serde_json::to_value(result)
        .map_err(|error| HandlerError::named("ResultEncodeError", error.to_string()))
}
