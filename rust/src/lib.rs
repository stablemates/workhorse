//! Workhorse Rust client.
//!
//! PostgreSQL owns queue state and every lifecycle decision. This crate issues the versioned
//! protocol calls through a caller-supplied [`Executor`], so a transaction executor makes a
//! call part of the caller's transaction.
mod admin;
mod children;
pub mod compatibility;
mod context;
pub mod contracts;
#[cfg(feature = "dashboard")]
pub mod dashboard;
mod error;
pub mod policies;
mod queue;
mod sql_catalogue_generated;
mod telemetry;
mod types;
mod waits;
mod worker;

pub use admin::*;
pub use children::{ChildOutcome, ChildTaskRequest, FailureEnvelope};
pub use context::{BatchHandlerContext, HandlerContext};
pub use deadpool_postgres;
pub use error::{
    CancelReason, DependencyCycleDetails, DependencyLimitDetails, Error,
    IdempotencyConflictDetails, Operation, PurgeConflictDetails, RedriveConflictDetails,
};
pub use queue::{Executor, Queue};
pub use sql_catalogue_generated::{
    CLIENT_PROTOCOL_VERSION, MAXIMUM_SCHEMA_VERSION as MAX_SCHEMA_VERSION, MAX_ENQUEUE_BATCH_SIZE,
    MINIMUM_SCHEMA_VERSION as MIN_SCHEMA_VERSION,
};
pub use types::*;
pub use waits::{HumanOutcome, SignalOutcome};
pub use worker::{
    run_worker_process, BatchItem, BatchOptions, BatchResult, CancellationToken, ClaimedTask,
    HandlerError, RegistrationErrorHook, RetryDelay, Worker, WorkerOptions,
};
