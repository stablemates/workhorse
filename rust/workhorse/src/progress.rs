#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Progress {
    pub sequence: u64,
    pub value: String,
}
#[derive(Debug, Clone, Default)]
pub struct ProgressStore {
    latest: Option<Progress>,
    next_sequence: u64,
}
impl ProgressStore {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn publish(&mut self, value: impl Into<String>) -> Progress {
        self.next_sequence += 1;
        let p = Progress {
            sequence: self.next_sequence,
            value: value.into(),
        };
        self.latest = Some(p.clone());
        p
    }
    pub fn latest(&self) -> Option<&Progress> {
        self.latest.as_ref()
    }
}
