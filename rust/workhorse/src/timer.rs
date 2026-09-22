use std::collections::BTreeMap;
use std::time::{Duration, SystemTime};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DurableTimer {
    pub name: String,
    pub due_at: SystemTime,
    fired: bool,
}
impl DurableTimer {
    pub fn is_ready(&self, now: SystemTime) -> bool {
        self.fired || now >= self.due_at
    }
    pub fn fired(&self) -> bool {
        self.fired
    }
}

#[derive(Debug, Clone, Default)]
pub struct TimerRegistry {
    timers: BTreeMap<String, DurableTimer>,
}
impl TimerRegistry {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn wait(
        &mut self,
        name: impl Into<String>,
        delay: Duration,
        now: SystemTime,
    ) -> DurableTimer {
        let name = name.into();
        if let Some(timer) = self.timers.get(&name) {
            return timer.clone();
        }
        let timer = DurableTimer {
            name: name.clone(),
            due_at: now + delay,
            fired: false,
        };
        self.timers.insert(name, timer.clone());
        timer
    }
    pub fn observe(&mut self, name: &str, now: SystemTime) -> Option<DurableTimer> {
        let timer = self.timers.get_mut(name)?;
        if now >= timer.due_at {
            timer.fired = true;
        }
        Some(timer.clone())
    }
    pub fn get(&self, name: &str) -> Option<&DurableTimer> {
        self.timers.get(name)
    }
}
