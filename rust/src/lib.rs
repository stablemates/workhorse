//! Workhorse Rust client.
//!
//! PostgreSQL owns queue state and every lifecycle decision. This crate issues the versioned
//! protocol calls through a caller-supplied [`Executor`], so a transaction executor makes a
//! call part of the caller's transaction.
mod admin;
pub mod compatibility;
pub mod contracts;
#[cfg(feature = "dashboard")]
pub mod dashboard;
pub mod durable_context;
pub mod durable_postgres;
mod error;
pub mod policies;
mod queue;
mod sql_catalogue_generated;
mod telemetry;
mod types;
mod worker;

pub use admin::*;
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
pub use worker::{
    run_worker_process, BatchItem, BatchOptions, BatchResult, CancellationToken, ClaimedTask,
    HandlerContext, HandlerError, RegistrationErrorHook, RetryDelay, Worker, WorkerOptions,
};
