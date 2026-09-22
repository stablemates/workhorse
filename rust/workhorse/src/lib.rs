//! Durable handler state primitives.
//!
//! This crate deliberately contains no PostgreSQL client or worker lease code. The worker
//! supplies persistence and settlement through [`settlement::SettlementSink`].
pub mod checkpoint;
pub mod children;
pub mod context;
pub mod progress;
pub mod settlement;
pub mod timer;
pub mod wait;

pub use checkpoint::{CheckpointError, CheckpointStore};
pub use children::{ChildOutcome, ChildSet, ChildStatus};
pub use context::HandlerContext;
pub use progress::{Progress, ProgressStore};
pub use settlement::{Settlement, SettlementBuffer, SettlementError, SettlementSink};
pub use timer::{DurableTimer, TimerRegistry};
pub use wait::{Decision, WaitKind, WaitRegistry, WaitResult};
