use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckpointError {
    EmptyName,
}

/// Replayable values for one handler invocation. A name is immutable: once written, a
/// checkpoint is always returned and its producer is never called again.
#[derive(Debug, Clone)]
pub struct CheckpointStore<T> {
    values: BTreeMap<String, T>,
}

impl<T> Default for CheckpointStore<T> {
    fn default() -> Self {
        Self {
            values: BTreeMap::new(),
        }
    }
}

impl<T: Clone> CheckpointStore<T> {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn replay_or_run<F>(
        &mut self,
        name: impl Into<String>,
        producer: F,
    ) -> Result<T, CheckpointError>
    where
        F: FnOnce() -> T,
    {
        let name = name.into();
        if name.is_empty() {
            return Err(CheckpointError::EmptyName);
        }
        if let Some(value) = self.values.get(&name) {
            return Ok(value.clone());
        }
        let value = producer();
        self.values.insert(name, value.clone());
        Ok(value)
    }

    pub fn get(&self, name: &str) -> Option<&T> {
        self.values.get(name)
    }
    pub fn len(&self) -> usize {
        self.values.len()
    }
    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }
}
