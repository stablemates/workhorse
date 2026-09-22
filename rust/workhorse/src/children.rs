use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChildStatus<T> {
    Pending,
    Succeeded(T),
    Failed(String),
    Cancelled,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChildOutcome<T> {
    All(Vec<T>),
    Partial {
        succeeded: Vec<T>,
        failed: Vec<String>,
        cancelled: usize,
    },
}
#[derive(Debug, Clone)]
pub struct ChildSet<T> {
    children: BTreeMap<String, ChildStatus<T>>,
}

impl<T> Default for ChildSet<T> {
    fn default() -> Self {
        Self {
            children: BTreeMap::new(),
        }
    }
}
impl<T: Clone> ChildSet<T> {
    pub fn add_all<I, N>(&mut self, names: I)
    where
        I: IntoIterator<Item = N>,
        N: Into<String>,
    {
        for name in names {
            self.children
                .entry(name.into())
                .or_insert(ChildStatus::Pending);
        }
    }
    pub fn complete(&mut self, name: &str, status: ChildStatus<T>) -> bool {
        let Some(slot) = self.children.get_mut(name) else {
            return false;
        };
        if !matches!(slot, ChildStatus::Pending) {
            return false;
        }
        *slot = status;
        true
    }
    pub fn is_ready(&self) -> bool {
        self.children
            .values()
            .all(|s| !matches!(s, ChildStatus::Pending))
    }
    pub fn join(&self) -> Option<ChildOutcome<T>> {
        if !self.is_ready() {
            return None;
        }
        let mut ok = Vec::new();
        let mut failed = Vec::new();
        let mut cancelled = 0;
        for status in self.children.values() {
            match status {
                ChildStatus::Succeeded(v) => ok.push(v.clone()),
                ChildStatus::Failed(e) => failed.push(e.clone()),
                ChildStatus::Cancelled => cancelled += 1,
                ChildStatus::Pending => unreachable!(),
            }
        }
        if failed.is_empty() && cancelled == 0 {
            Some(ChildOutcome::All(ok))
        } else {
            Some(ChildOutcome::Partial {
                succeeded: ok,
                failed,
                cancelled,
            })
        }
    }
    pub fn len(&self) -> usize {
        self.children.len()
    }
    pub fn is_empty(&self) -> bool {
        self.children.is_empty()
    }
}
