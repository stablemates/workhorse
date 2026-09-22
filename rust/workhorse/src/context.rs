use crate::{
    checkpoint::CheckpointStore,
    children::{ChildSet, ChildStatus},
    progress::{Progress, ProgressStore},
    settlement::{Settlement, SettlementError, SettlementSink},
    timer::{DurableTimer, TimerRegistry},
    wait::{Decision, WaitKind, WaitRegistry, WaitResult},
};
use std::time::{Duration, SystemTime};

/// Handler-local durable state. Persistence is intentionally delegated to the worker seam.
#[derive(Debug)]
pub struct HandlerContext<T> {
    pub checkpoints: CheckpointStore<T>,
    pub timers: TimerRegistry,
    pub waits: WaitRegistry<T>,
    pub children: ChildSet<T>,
    pub progress: ProgressStore,
}
impl<T: Clone> Default for HandlerContext<T> {
    fn default() -> Self {
        Self {
            checkpoints: CheckpointStore::new(),
            timers: TimerRegistry::new(),
            waits: WaitRegistry::new(),
            children: ChildSet::default(),
            progress: ProgressStore::new(),
        }
    }
}
impl<T: Clone> HandlerContext<T> {
    pub fn checkpoint<F>(
        &mut self,
        name: impl Into<String>,
        producer: F,
    ) -> Result<T, crate::CheckpointError>
    where
        F: FnOnce() -> T,
    {
        self.checkpoints.replay_or_run(name, producer)
    }
    pub fn timer(
        &mut self,
        name: impl Into<String>,
        delay: Duration,
        now: SystemTime,
    ) -> DurableTimer {
        self.timers.wait(name, delay, now)
    }
    pub fn signal(&mut self, name: impl Into<String>) -> WaitResult<T> {
        self.waits.wait(name, WaitKind::Signal)
    }
    pub fn human_decision(&mut self, name: impl Into<String>) -> WaitResult<T> {
        self.waits.wait(name, WaitKind::HumanDecision)
    }
    pub fn resolve_signal(&mut self, name: &str, value: T) -> bool {
        self.waits.resolve(name, value)
    }
    pub fn resolve_decision(&mut self, name: &str, decision: Decision) -> bool
    where
        T: From<Decision>,
    {
        self.waits.resolve(name, decision.into())
    }
    pub fn fan_out<I, N>(&mut self, names: I)
    where
        I: IntoIterator<Item = N>,
        N: Into<String>,
    {
        self.children.add_all(names);
    }
    pub fn child_fan_out<I, N>(&mut self, names: I)
    where
        I: IntoIterator<Item = N>,
        N: Into<String>,
    {
        self.fan_out(names);
    }
    pub fn child_complete(&mut self, name: &str, status: ChildStatus<T>) -> bool {
        self.children.complete(name, status)
    }
    pub fn join_children(&self) -> Option<crate::children::ChildOutcome<T>> {
        self.children.join()
    }
    pub fn report_progress(&mut self, value: impl Into<String>) -> Progress {
        self.progress.publish(value)
    }
    pub fn settle<S: SettlementSink<T>>(
        &self,
        sink: &mut S,
        settlement: Settlement<T>,
    ) -> Result<(), SettlementError> {
        sink.settle(settlement)
    }
}
