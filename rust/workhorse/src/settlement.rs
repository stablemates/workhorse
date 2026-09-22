use crate::progress::Progress;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Settlement<T> {
    Checkpoint { name: String },
    Timer { name: String },
    Wait { name: String },
    Children { names: Vec<String> },
    Progress(Progress),
    Completed(T),
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettlementError(pub String);
/// Narrow seam owned by the worker. Implementations persist one intent atomically with task settlement.
pub trait SettlementSink<T> {
    fn settle(&mut self, settlement: Settlement<T>) -> Result<(), SettlementError>;
}

#[derive(Debug, Default)]
pub struct SettlementBuffer<T> {
    pub entries: Vec<Settlement<T>>,
}
impl<T> SettlementSink<T> for SettlementBuffer<T> {
    fn settle(&mut self, settlement: Settlement<T>) -> Result<(), SettlementError> {
        self.entries.push(settlement);
        Ok(())
    }
}
