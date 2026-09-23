//! The crate's one structured error type (ADR 0074).
use std::fmt;
use std::time::Duration;

use serde::Deserialize;
use uuid::Uuid;

use crate::compatibility::CompatibilityCode;

/// The client or worker call that observed a protocol outcome.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operation {
    Enqueue,
    Cancel,
    SendSignal,
    CompleteHumanWait,
    Health,
    SyncSchedules,
    SyncContracts,
    Redrive,
    Claim,
    Complete,
    Fail,
    Heartbeat,
    Release,
    RegisterWorker,
    Maintenance,
    Checkpoint,
    Sleep,
    WaitForSignal,
    WaitForHuman,
    RunChild,
    RunChildren,
    Progress,
}

impl fmt::Display for Operation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Enqueue => "enqueue",
            Self::Cancel => "cancel",
            Self::SendSignal => "send signal",
            Self::CompleteHumanWait => "complete human wait",
            Self::Health => "health",
            Self::SyncSchedules => "sync schedules",
            Self::SyncContracts => "sync contracts",
            Self::Redrive => "redrive",
            Self::Claim => "claim",
            Self::Complete => "complete",
            Self::Fail => "fail",
            Self::Heartbeat => "heartbeat",
            Self::Release => "release",
            Self::RegisterWorker => "register worker",
            Self::Maintenance => "maintenance",
            Self::Checkpoint => "checkpoint",
            Self::Sleep => "sleep",
            Self::WaitForSignal => "wait for signal",
            Self::WaitForHuman => "wait for human",
            Self::RunChild => "run child",
            Self::RunChildren => "run children",
            Self::Progress => "progress",
        })
    }
}

/// Why a cancellation token fired.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CancelReason {
    Requested,
    DeadlineExceeded,
    ExecutionTimeout,
    LeaseLost,
    Suspended,
    Shutdown,
}

/// PostgreSQL's retained-key conflict diagnosis for SQLSTATE `P1001`.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct IdempotencyConflictDetails {
    pub scope: String,
    pub key_preview: String,
    pub key_digest: String,
    pub key_length: i64,
    pub existing_task_id: String,
    pub ordinal: i64,
    pub conflicting_fields: Vec<String>,
    pub stored_request_digest: String,
    pub rejected_request_digest: String,
}

/// PostgreSQL's bounded description of a rejected cycle, SQLSTATE `P1003`.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct DependencyCycleDetails {
    pub dependent_task_id: String,
    pub prerequisite_task_id: String,
    pub cycle_task_ids: Vec<String>,
    pub truncated: bool,
}

/// PostgreSQL's dependency limit diagnosis, SQLSTATE `P1005`.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct DependencyLimitDetails {
    pub task_id: String,
    /// `prerequisites`, `dependents`, or `unresolved_dependents`.
    pub limit: String,
    pub max: i64,
}

/// PostgreSQL's retained-request conflict diagnosis for a redrive, SQLSTATE `P1002`.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct RedriveConflictDetails {
    pub source_task_id: String,
    pub existing_target_task_id: Option<String>,
    pub request_id_preview: String,
    pub request_id_digest: String,
    pub request_id_length: i64,
    pub conflicting_fields: Vec<String>,
    pub stored_request_digest: String,
    pub rejected_request_digest: String,
}

/// PostgreSQL's retained-request conflict diagnosis for a queue purge, SQLSTATE `P1006`.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct PurgeConflictDetails {
    pub queue: String,
    pub request_id_preview: String,
    pub request_id_digest: String,
    pub request_id_length: i64,
    pub conflicting_fields: Vec<String>,
    pub stored_request_digest: String,
    pub rejected_request_digest: String,
}

#[non_exhaustive]
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("workhorse compatibility check refused: {code}")]
    Compatibility { code: CompatibilityCode },
    #[error("{operation} lost the lease for task {task_id}")]
    LeaseLost { task_id: Uuid, operation: Operation },
    #[error("{operation} {name} conflicts with a different retained request")]
    Conflict { operation: Operation, name: String },
    #[error("{operation} {name} exceeded its limit")]
    LimitExceeded { operation: Operation, name: String },
    #[error("{operation} {name} is already waiting")]
    AlreadyWaiting { operation: Operation, name: String },
    #[error("child result of {result_bytes} bytes exceeds the {limit_bytes} byte limit")]
    ChildResultLimitExceeded { result_bytes: i64, limit_bytes: i64 },
    #[error("progress is rate limited; retry after {retry_after:?}")]
    ProgressRateLimited { retry_after: Duration },
    #[error("PostgreSQL rejected a materially different idempotent enqueue")]
    EnqueueIdempotencyConflict { details: Box<IdempotencyConflictDetails> },
    #[error("PostgreSQL rejected a cyclic task dependency")]
    DependencyCycle { details: Box<DependencyCycleDetails> },
    #[error("PostgreSQL rejected a task dependency limit")]
    DependencyLimitExceeded { details: Box<DependencyLimitDetails> },
    #[error("PostgreSQL rejected a materially different idempotent redrive")]
    RedriveIdempotencyConflict { details: Box<RedriveConflictDetails> },
    #[error("PostgreSQL rejected a materially different idempotent queue purge")]
    PurgeIdempotencyConflict { details: Box<PurgeConflictDetails> },
    #[error("{task_type} payload does not satisfy contract version {version}")]
    ContractValidation { task_type: String, version: String },
    #[error("{task_type} contract version {version} is unavailable")]
    ContractUnavailable { task_type: String, version: String },
    #[error("contract policy changed again while retrying enqueue")]
    ContractPolicyChanged,
    #[error("signal {name} for task {task_id} received a different request for a retained idempotency key")]
    SignalIdempotencyConflict { task_id: Uuid, name: String },
    #[error("human wait {name} for task {task_id} received a different completion for a retained idempotency key")]
    HumanWaitIdempotencyConflict { task_id: Uuid, name: String },
    #[error("{operation} returned unexpected status {status:?}")]
    UnexpectedStatus { operation: Operation, status: String },
    #[error("task cancelled: {0:?}")]
    Cancelled(CancelReason),
    #[error("shutdown grace elapsed with {abandoned} tasks still running")]
    ShutdownIncomplete { abandoned: usize },
    #[error("postgres: {0}")]
    Postgres(#[from] tokio_postgres::Error),
    #[error("pool: {0}")]
    Pool(#[from] deadpool_postgres::PoolError),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    InvalidArgument(String),
    #[doc(hidden)]
    #[error("task suspended")]
    Suspended,
}

impl Error {
    pub(crate) fn invalid(message: impl Into<String>) -> Self {
        Self::InvalidArgument(message.into())
    }

    /// A copy for a concurrent caller that shared this call; driver errors keep only their text.
    pub(crate) fn share(&self) -> Self {
        match self {
            Self::LeaseLost { task_id, operation } => {
                Self::LeaseLost { task_id: *task_id, operation: *operation }
            }
            Self::Conflict { operation, name } => {
                Self::Conflict { operation: *operation, name: name.clone() }
            }
            Self::LimitExceeded { operation, name } => {
                Self::LimitExceeded { operation: *operation, name: name.clone() }
            }
            Self::AlreadyWaiting { operation, name } => {
                Self::AlreadyWaiting { operation: *operation, name: name.clone() }
            }
            Self::ChildResultLimitExceeded { result_bytes, limit_bytes } => {
                Self::ChildResultLimitExceeded {
                    result_bytes: *result_bytes,
                    limit_bytes: *limit_bytes,
                }
            }
            Self::ProgressRateLimited { retry_after } => {
                Self::ProgressRateLimited { retry_after: *retry_after }
            }
            Self::UnexpectedStatus { operation, status } => {
                Self::UnexpectedStatus { operation: *operation, status: status.clone() }
            }
            Self::Cancelled(reason) => Self::Cancelled(*reason),
            Self::Suspended => Self::Suspended,
            other => Self::InvalidArgument(other.to_string()),
        }
    }

    /// The SQLSTATE of a PostgreSQL error, if this is one.
    pub fn sqlstate(&self) -> Option<&str> {
        match self {
            Self::Postgres(error) => error.code().map(|code| code.code()),
            Self::Pool(deadpool_postgres::PoolError::Backend(error)) => {
                error.code().map(|code| code.code())
            }
            _ => None,
        }
    }

    /// Maps SQLSTATE `P1001`, `P1003` and `P1005` to their structured variants.
    pub(crate) fn translate_enqueue(error: tokio_postgres::Error) -> Self {
        let Some(database) = error.as_db_error() else {
            return error.into();
        };
        let detail = database.detail().unwrap_or("{}");
        match database.code().code() {
            "P1001" => Self::EnqueueIdempotencyConflict {
                details: Box::new(serde_json::from_str(detail).unwrap_or_default()),
            },
            "P1003" => Self::DependencyCycle {
                details: Box::new(serde_json::from_str(detail).unwrap_or_default()),
            },
            "P1005" => Self::DependencyLimitExceeded {
                details: Box::new(serde_json::from_str(detail).unwrap_or_default()),
            },
            _ => error.into(),
        }
    }

    /// Maps SQLSTATE `P1002` and `P1006` to their structured variants.
    pub(crate) fn translate_admin(self) -> Self {
        let database = match &self {
            Self::Postgres(error) => error.as_db_error(),
            Self::Pool(deadpool_postgres::PoolError::Backend(error)) => error.as_db_error(),
            _ => None,
        };
        let Some((code, detail)) =
            database.map(|database| (database.code().code(), database.detail().unwrap_or("{}")))
        else {
            return self;
        };
        match code {
            "P1002" => Self::RedriveIdempotencyConflict {
                details: Box::new(serde_json::from_str(detail).unwrap_or_default()),
            },
            "P1006" => Self::PurgeIdempotencyConflict {
                details: Box::new(serde_json::from_str(detail).unwrap_or_default()),
            },
            _ => self,
        }
    }
}
