//! Request and result types shared by the client and, later, the worker.
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use uuid::Uuid;

/// A retry policy document PostgreSQL validates, for example
/// `{"type": "fixed", "delayMs": 1000}`.
pub type RetryPolicy = Map<String, Value>;

/// PostgreSQL's versioned `queue_health_v1` document.
pub type QueueHealth = Map<String, Value>;

macro_rules! string_enum {
    ($(#[$meta:meta])* $name:ident { $($variant:ident => $value:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub enum $name {
            $(#[serde(rename = $value)] $variant),+
        }

        impl $name {
            /// The protocol's wire value.
            pub fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $value),+
                }
            }

            #[allow(dead_code)]
            pub(crate) fn parse(value: &str) -> Option<Self> {
                match value {
                    $($value => Some(Self::$variant),)+
                    _ => None,
                }
            }
        }
    };
}

string_enum!(
    /// PostgreSQL's durable disposition for one enqueue request.
    EnqueueOutcome {
        Accepted => "accepted",
        Replayed => "replayed",
        Replaced => "replaced",
        NonReplaceable => "non_replaceable",
        Coalesced => "coalesced",
    }
);

string_enum!(
    /// Why PostgreSQL retained a debounced task instead of replacing it.
    EnqueueNonReplaceableReason {
        IncompatibleKeyMode => "incompatible_key_mode",
        NotPending => "not_pending",
        WindowElapsedPending => "window_elapsed_pending",
    }
);

string_enum!(
    /// Whether a debounce replacement resets or preserves the original window.
    DebounceSchedule {
        Reset => "reset",
        Preserve => "preserve",
    }
);

string_enum!(
    /// What a dependent does after a prerequisite settles.
    DependencyTerminalPolicy {
        Release => "release",
        Cancel => "cancel",
        Fail => "fail",
    }
);

string_enum!(
    /// How a schedule handles occurrences missed between worker evaluations.
    ScheduleCatchupPolicy {
        Skip => "skip",
        Latest => "latest",
        All => "all",
    }
);

string_enum!(
    /// PostgreSQL's disposition for a cancellation request.
    CancelStatus {
        Canceled => "canceled",
        CancelRequested => "cancel_requested",
        AlreadyTerminal => "already_terminal",
        NotFound => "not_found",
    }
);

string_enum!(
    /// PostgreSQL's durable lifecycle state for a task.
    TaskState {
        Blocked => "blocked",
        Scheduled => "scheduled",
        Ready => "ready",
        Active => "active",
        Succeeded => "succeeded",
        Failed => "failed",
        Canceled => "canceled",
    }
);

string_enum!(
    /// PostgreSQL's disposition for a delivered signal.
    SignalDeliveryStatus {
        Delivered => "delivered",
        Duplicate => "duplicate",
        NotWaiting => "not_waiting",
        AlreadyDelivered => "already_delivered",
        Stale => "stale",
        NotFound => "not_found",
    }
);

string_enum!(
    /// PostgreSQL's disposition for a human wait completion.
    HumanWaitCompletionStatus {
        Completed => "completed",
        Duplicate => "duplicate",
        NotWaiting => "not_waiting",
        AlreadyCompleted => "already_completed",
        Stale => "stale",
        NotFound => "not_found",
    }
);

/// Retains one canonical request under a scoped key.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Idempotency {
    pub key: String,
    pub scope: String,
    pub ttl_ms: i64,
}

impl Idempotency {
    /// A key in the `default` scope retained for one day.
    pub fn new(key: impl Into<String>) -> Self {
        Self { key: key.into(), scope: "default".into(), ttl_ms: 86_400_000 }
    }
}

/// Replaces a pending keyed task during a PostgreSQL-owned window.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Debounce {
    pub key: String,
    pub scope: String,
    pub window_ms: i64,
    pub schedule: DebounceSchedule,
}

impl Debounce {
    /// A key in the `default` scope.
    pub fn new(key: impl Into<String>, window_ms: i64, schedule: DebounceSchedule) -> Self {
        Self { key: key.into(), scope: "default".into(), window_ms, schedule }
    }
}

/// Accepts at most one equivalent keyed task during a PostgreSQL-owned window.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Throttle {
    pub key: String,
    pub scope: String,
    pub window_ms: i64,
}

impl Throttle {
    /// A key in the `default` scope.
    pub fn new(key: impl Into<String>, window_ms: i64) -> Self {
        Self { key: key.into(), scope: "default".into(), window_ms }
    }
}

/// Prerequisite tasks and the terminal outcomes a dependent accepts from each.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dependencies {
    pub prerequisite_task_ids: Vec<Uuid>,
    pub on_success: DependencyTerminalPolicy,
    pub on_failure: DependencyTerminalPolicy,
    pub on_cancellation: DependencyTerminalPolicy,
}

/// Controls a task's initial dispatch and durable acceptance behaviour.
#[derive(Clone, Debug, PartialEq)]
pub struct EnqueueOptions {
    /// `None` uses the queue's default queue name.
    pub queue: Option<String>,
    /// Between 0 and 100; higher runs first.
    pub priority: i32,
    pub concurrency_key: Option<String>,
    /// Names a deployment-synchronized budget shared across queues.
    pub budget: Option<String>,
    /// `None` makes a task ready now, or lets a keyed mode choose its window.
    pub run_at: Option<DateTime<Utc>>,
    pub deadline: Option<DateTime<Utc>>,
    pub execution_timeout_ms: Option<i64>,
    /// Zero selects the default of 25.
    pub max_attempts: i32,
    pub retry_policy: Option<RetryPolicy>,
    pub tags: Vec<String>,
    pub idempotency: Option<Idempotency>,
    pub debounce: Option<Debounce>,
    pub throttle: Option<Throttle>,
    pub dependencies: Option<Dependencies>,
}

impl Default for EnqueueOptions {
    fn default() -> Self {
        Self {
            queue: None,
            priority: 0,
            concurrency_key: None,
            budget: None,
            run_at: None,
            deadline: None,
            execution_timeout_ms: None,
            max_attempts: 25,
            retry_policy: None,
            tags: Vec::new(),
            idempotency: None,
            debounce: None,
            throttle: None,
            dependencies: None,
        }
    }
}

/// One task submitted through an atomic enqueue batch.
#[derive(Clone, Debug, PartialEq)]
pub struct EnqueueRequest {
    pub task_type: String,
    pub payload: Value,
    pub options: EnqueueOptions,
}

impl EnqueueRequest {
    /// A request with default options.
    pub fn new(task_type: impl Into<String>, payload: Value) -> Self {
        Self { task_type: task_type.into(), payload, options: EnqueueOptions::default() }
    }

    pub fn with_options(mut self, options: EnqueueOptions) -> Self {
        self.options = options;
        self
    }
}

/// A task's stable identity and PostgreSQL's durable enqueue disposition.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EnqueueResult {
    pub task_id: Uuid,
    pub outcome: EnqueueOutcome,
    /// Set only when `outcome` is [`EnqueueOutcome::NonReplaceable`].
    pub reason: Option<EnqueueNonReplaceableReason>,
}

/// Safe lifecycle metadata for a cancellation; payload and worker ownership stay private.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CancelResult {
    pub status: CancelStatus,
    pub task_id: Uuid,
    pub state: Option<TaskState>,
    pub current_attempt: Option<i32>,
    pub requested_at: Option<DateTime<Utc>>,
    pub requested_by: Option<String>,
    pub reason: Option<String>,
    pub finished_at: Option<DateTime<Utc>>,
}

/// Retry identity and audit attribution for a signal or human wait delivery.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeliveryOptions {
    /// Between 1 and 512 UTF-8 bytes; a retry with the same key is a duplicate.
    pub idempotency_key: String,
    /// Between 1 and 200 characters.
    pub requested_by: String,
}

impl DeliveryOptions {
    pub fn new(idempotency_key: impl Into<String>, requested_by: impl Into<String>) -> Self {
        Self { idempotency_key: idempotency_key.into(), requested_by: requested_by.into() }
    }
}

/// PostgreSQL's disposition for [`crate::Queue::send_signal`].
#[derive(Clone, Debug, PartialEq)]
pub struct SignalDeliveryResult {
    pub status: SignalDeliveryStatus,
    pub task_id: Uuid,
    pub name: String,
    pub payload: Option<Value>,
    pub delivered_at: Option<DateTime<Utc>>,
    pub delivered_by: Option<String>,
}

/// PostgreSQL's disposition for [`crate::Queue::complete_human_wait`].
#[derive(Clone, Debug, PartialEq)]
pub struct HumanWaitCompletionResult {
    pub status: HumanWaitCompletionStatus,
    pub task_id: Uuid,
    pub name: String,
    pub payload: Option<Value>,
    pub completed_at: Option<DateTime<Utc>>,
    pub completed_by: Option<String>,
}

/// The task created for each recurring occurrence.
#[derive(Clone, Debug, PartialEq)]
pub struct ScheduledTask {
    pub task_type: String,
    pub payload: Value,
    /// `None` uses the queue's default queue name.
    pub queue: Option<String>,
    pub priority: i32,
    pub concurrency_key: Option<String>,
    /// Zero selects the default of 25.
    pub max_attempts: i32,
    pub retry_policy: Option<RetryPolicy>,
}

impl ScheduledTask {
    pub fn new(task_type: impl Into<String>, payload: Value) -> Self {
        Self {
            task_type: task_type.into(),
            payload,
            queue: None,
            priority: 0,
            concurrency_key: None,
            max_attempts: 25,
            retry_policy: None,
        }
    }
}

/// One desired recurring schedule.
#[derive(Clone, Debug, PartialEq)]
pub struct ScheduleDefinition {
    pub name: String,
    /// A five-field cron expression.
    pub schedule: String,
    /// An IANA time zone; `UTC` by default.
    pub timezone: String,
    pub catchup_policy: ScheduleCatchupPolicy,
    pub enabled: bool,
    pub task: ScheduledTask,
}

impl ScheduleDefinition {
    pub fn new(name: impl Into<String>, schedule: impl Into<String>, task: ScheduledTask) -> Self {
        Self {
            name: name.into(),
            schedule: schedule.into(),
            timezone: "UTC".into(),
            catchup_policy: ScheduleCatchupPolicy::Skip,
            enabled: true,
            task,
        }
    }
}
