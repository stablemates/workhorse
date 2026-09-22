use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WaitKind {
    Signal,
    HumanDecision,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Approve,
    Reject,
    Custom(String),
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WaitResult<T> {
    Pending,
    Resolved(T),
}
#[derive(Debug, Clone)]
struct Wait<T> {
    kind: WaitKind,
    result: Option<T>,
}

#[derive(Debug, Clone)]
pub struct WaitRegistry<T> {
    waits: BTreeMap<String, Wait<T>>,
}

impl<T> Default for WaitRegistry<T> {
    fn default() -> Self {
        Self { waits: BTreeMap::new() }
    }
}
impl<T: Clone> WaitRegistry<T> {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn wait(&mut self, name: impl Into<String>, kind: WaitKind) -> WaitResult<T> {
        let name = name.into();
        let wait = self.waits.entry(name).or_insert(Wait { kind, result: None });
        wait.result.clone().map_or(WaitResult::Pending, WaitResult::Resolved)
    }
    pub fn resolve(&mut self, name: &str, value: T) -> bool {
        let Some(wait) = self.waits.get_mut(name) else {
            return false;
        };
        if wait.result.is_some() {
            return false;
        }
        wait.result = Some(value);
        true
    }
    pub fn kind(&self, name: &str) -> Option<&WaitKind> {
        self.waits.get(name).map(|w| &w.kind)
    }
    pub fn is_resolved(&self, name: &str) -> bool {
        self.waits.get(name).is_some_and(|w| w.result.is_some())
    }
}
