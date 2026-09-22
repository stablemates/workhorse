//! Rust worker lifecycle runtime. SQL ownership remains authoritative; `Client` is the
//! deliberately small seam for the SM-16A client foundation.
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub type TaskId = String;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Task {
    pub id: TaskId,
    pub queue: String,
    pub rank: i32,
    pub payload: Vec<u8>,
    pub fence: u64,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Lease {
    pub task: Task,
    pub worker_id: String,
    pub fence: u64,
    pub expires_at: Instant,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClientError {
    Unavailable,
    Fenced,
    Other(String),
}

/// Stable integration seam. SM-16A's SQL client only needs to implement these operations.
pub trait Client: Send + Sync + 'static {
    fn claim(
        &self,
        worker: &str,
        queues: &[String],
        limit: usize,
    ) -> Result<Vec<Task>, ClientError>;
    fn heartbeat(&self, worker: &str, task: &TaskId, fence: u64) -> Result<(), ClientError>;
    fn cancel_requested(&self, worker: &str) -> Result<Vec<TaskId>, ClientError>;
    fn complete(&self, worker: &str, task: &TaskId, fence: u64) -> Result<(), ClientError>;
    fn run_maintenance_v1(&self, worker: &str) -> Result<(), ClientError>;
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Telemetry {
    pub claimed: u64,
    pub completed: u64,
    pub fenced: u64,
    pub heartbeats: u64,
    pub cancellations: u64,
    pub polls: u64,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkerInfo {
    pub id: String,
    pub queues: Vec<String>,
    pub paused: bool,
    pub draining: bool,
}

pub struct Worker<C: Client> {
    client: Arc<C>,
    id: String,
    queues: Vec<String>,
    batch: usize,
    lease: Duration,
    state: Mutex<State>,
    telemetry: Mutex<Telemetry>,
    notify: Arc<(Mutex<u64>, std::sync::Condvar)>,
}
struct State {
    paused: bool,
    draining: bool,
    active: HashMap<TaskId, Lease>,
    cancelled: HashSet<TaskId>,
    cursor: usize,
}
impl<C: Client> Worker<C> {
    pub fn new(client: Arc<C>, id: impl Into<String>, queues: Vec<String>) -> Self {
        Self {
            client,
            id: id.into(),
            queues,
            batch: 1,
            lease: Duration::from_secs(30),
            state: Mutex::new(State {
                paused: false,
                draining: false,
                active: HashMap::new(),
                cancelled: HashSet::new(),
                cursor: 0,
            }),
            telemetry: Mutex::new(Telemetry::default()),
            notify: Arc::new((Mutex::new(0), std::sync::Condvar::new())),
        }
    }
    pub fn with_batch_size(mut self, n: usize) -> Self {
        self.batch = n.max(1);
        self
    }
    pub fn with_lease(mut self, d: Duration) -> Self {
        self.lease = d;
        self
    }
    pub fn info(&self) -> WorkerInfo {
        let s = self.state.lock().unwrap();
        WorkerInfo {
            id: self.id.clone(),
            queues: self.queues.clone(),
            paused: s.paused,
            draining: s.draining,
        }
    }
    pub fn telemetry(&self) -> Telemetry {
        self.telemetry.lock().unwrap().clone()
    }
    pub fn pause(&self) {
        self.state.lock().unwrap().paused = true;
    }
    pub fn resume(&self) {
        let mut s = self.state.lock().unwrap();
        if !s.draining {
            s.paused = false;
        }
        self.wake();
    }
    pub fn request_drain(&self) {
        self.state.lock().unwrap().draining = true;
    }
    pub fn is_drained(&self) -> bool {
        let s = self.state.lock().unwrap();
        s.draining && s.active.is_empty()
    }
    pub fn notify(&self) {
        self.wake();
    }
    fn wake(&self) {
        let (lock, cv) = &*self.notify;
        *lock.lock().unwrap() += 1;
        cv.notify_all();
    }
    /// Fairly rotates the queue list and claims a bounded batch.
    pub fn poll(&self) -> Result<Vec<Lease>, ClientError> {
        let (paused, draining, start) = {
            let mut s = self.state.lock().unwrap();
            let p = s.paused;
            let d = s.draining;
            let n = self.queues.len();
            let st = s.cursor;
            if n > 0 {
                s.cursor = (st + self.batch) % n;
            }
            (p, d, st)
        };
        self.telemetry.lock().unwrap().polls += 1;
        if paused || draining || self.queues.is_empty() {
            return Ok(Vec::new());
        }
        let mut qs = self.queues.clone();
        let rotation = start.min(qs.len());
        qs.rotate_left(rotation);
        let tasks = self.client.claim(&self.id, &qs, self.batch)?;
        let now = Instant::now();
        let mut out = Vec::with_capacity(tasks.len());
        let mut s = self.state.lock().unwrap();
        for task in tasks {
            let lease = Lease {
                fence: task.fence,
                worker_id: self.id.clone(),
                expires_at: now + self.lease,
                task,
            };
            s.active.insert(lease.task.id.clone(), lease.clone());
            out.push(lease);
        }
        self.telemetry.lock().unwrap().claimed += out.len() as u64;
        Ok(out)
    }
    pub fn heartbeat(&self, id: &TaskId) -> Result<(), ClientError> {
        let lease = {
            self.state
                .lock()
                .unwrap()
                .active
                .get(id)
                .cloned()
                .ok_or(ClientError::Fenced)?
        };
        if Instant::now() >= lease.expires_at {
            return Err(ClientError::Fenced);
        }
        self.client.heartbeat(&self.id, id, lease.fence)?;
        let mut s = self.state.lock().unwrap();
        if let Some(l) = s.active.get_mut(id) {
            l.expires_at = Instant::now() + self.lease;
        }
        self.telemetry.lock().unwrap().heartbeats += 1;
        Ok(())
    }
    /// Removes expired leases before handlers can settle them. The fence is left to SQL.
    pub fn watchdog(&self) -> Vec<TaskId> {
        let now = Instant::now();
        let mut s = self.state.lock().unwrap();
        let expired = s
            .active
            .iter()
            .filter(|(_, l)| l.expires_at <= now)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in &expired {
            s.active.remove(id);
        }
        self.telemetry.lock().unwrap().fenced += expired.len() as u64;
        expired
    }
    pub fn deliver_cancellation(&self) -> Result<Vec<TaskId>, ClientError> {
        let ids = self.client.cancel_requested(&self.id)?;
        let mut s = self.state.lock().unwrap();
        for id in &ids {
            s.cancelled.insert(id.clone());
        }
        self.telemetry.lock().unwrap().cancellations += ids.len() as u64;
        Ok(ids)
    }
    pub fn is_cancelled(&self, id: &TaskId) -> bool {
        self.state.lock().unwrap().cancelled.contains(id)
    }
    pub fn complete(&self, id: &TaskId) -> Result<(), ClientError> {
        let lease = self
            .state
            .lock()
            .unwrap()
            .active
            .get(id)
            .cloned()
            .ok_or(ClientError::Fenced)?;
        self.client.complete(&self.id, id, lease.fence)?;
        self.state.lock().unwrap().active.remove(id);
        self.telemetry.lock().unwrap().completed += 1;
        Ok(())
    }
    /// Dispatches a claimed batch in order. A handler error leaves the lease available for
    /// the caller's retry policy; successful handlers settle through the SQL fence.
    pub fn dispatch_batch<F>(
        &self,
        leases: Vec<Lease>,
        mut handler: F,
    ) -> Result<usize, ClientError>
    where
        F: FnMut(&Task) -> Result<(), ClientError>,
    {
        let mut completed = 0;
        for lease in leases {
            if self.is_cancelled(&lease.task.id) {
                continue;
            }
            handler(&lease.task)?;
            self.complete(&lease.task.id)?;
            completed += 1;
        }
        Ok(completed)
    }
    pub fn maintenance(&self) -> Result<(), ClientError> {
        self.client.run_maintenance_v1(&self.id)
    }
    pub fn wait_for_notification(&self, timeout: Duration) -> bool {
        let (lock, cv) = &*self.notify;
        let mut n = lock.lock().unwrap();
        if *n > 0 {
            *n = 0;
            return true;
        }
        let (mut n, _) = cv.wait_timeout(n, timeout).unwrap();
        if *n > 0 {
            *n = 0;
            true
        } else {
            false
        }
    }
}

pub struct Registry<C: Client> {
    workers: Mutex<HashMap<String, Arc<Worker<C>>>>,
}
impl<C: Client> Default for Registry<C> {
    fn default() -> Self {
        Self {
            workers: Mutex::new(HashMap::new()),
        }
    }
}
impl<C: Client> Registry<C> {
    pub fn register(&self, w: Arc<Worker<C>>) {
        self.workers.lock().unwrap().insert(w.info().id.clone(), w);
    }
    pub fn pause(&self, id: &str) -> bool {
        self.workers
            .lock()
            .unwrap()
            .get(id)
            .map(|w| {
                w.pause();
                true
            })
            .unwrap_or(false)
    }
    pub fn resume(&self, id: &str) -> bool {
        self.workers
            .lock()
            .unwrap()
            .get(id)
            .map(|w| {
                w.resume();
                true
            })
            .unwrap_or(false)
    }
    pub fn get(&self, id: &str) -> Option<Arc<Worker<C>>> {
        self.workers.lock().unwrap().get(id).cloned()
    }
    pub fn prune(&self) {
        self.workers.lock().unwrap().retain(|_, w| !w.is_drained());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fake {
        tasks: Mutex<VecDeque<Task>>,
        maint: Mutex<u32>,
    }
    impl Client for Fake {
        fn claim(&self, _: &str, _: &[String], n: usize) -> Result<Vec<Task>, ClientError> {
            let mut q = self.tasks.lock().unwrap();
            Ok((0..n).filter_map(|_| q.pop_front()).collect())
        }
        fn heartbeat(&self, _: &str, _: &TaskId, _: u64) -> Result<(), ClientError> {
            Ok(())
        }
        fn cancel_requested(&self, _: &str) -> Result<Vec<TaskId>, ClientError> {
            Ok(vec!["cancel".into()])
        }
        fn complete(&self, _: &str, _: &TaskId, _: u64) -> Result<(), ClientError> {
            Ok(())
        }
        fn run_maintenance_v1(&self, _: &str) -> Result<(), ClientError> {
            *self.maint.lock().unwrap() += 1;
            Ok(())
        }
    }
    fn worker() -> Worker<Fake> {
        Worker::new(
            Arc::new(Fake {
                tasks: Mutex::new(VecDeque::from([Task {
                    id: "a".into(),
                    queue: "q".into(),
                    rank: 1,
                    payload: vec![],
                    fence: 2,
                }])),
                maint: Mutex::new(0),
            }),
            "w",
            vec!["q".into()],
        )
        .with_batch_size(2)
    }
    #[test]
    fn bounded_claim_and_settle() {
        let w = worker();
        let ls = w.poll().unwrap();
        assert_eq!(ls.len(), 1);
        w.heartbeat(&"a".into()).unwrap();
        w.complete(&"a".into()).unwrap();
        assert_eq!(w.telemetry().completed, 1)
    }
    #[test]
    fn cancellation_is_delivered() {
        let w = worker();
        assert_eq!(w.deliver_cancellation().unwrap(), vec!["cancel"]);
        assert!(w.is_cancelled(&"cancel".into()));
    }
    #[test]
    fn dispatch_settles_batch() {
        let w = worker();
        let ls = w.poll().unwrap();
        assert_eq!(w.dispatch_batch(ls, |_| Ok(())).unwrap(), 1);
    }
    #[test]
    fn pause_and_drain_stop_claims() {
        let w = worker();
        w.pause();
        assert!(w.poll().unwrap().is_empty());
        w.resume();
        w.request_drain();
        assert!(w.poll().unwrap().is_empty());
    }
}
