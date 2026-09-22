//! PostgreSQL-backed worker lifecycle. PostgreSQL owns task state, leases, fences, and retries.
use async_trait::async_trait;
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio_postgres::Client as PgClient;

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

/// Stable async seam. Implementations call the versioned SQL protocol; no queue state is local.
#[async_trait]
pub trait Client: Send + Sync + 'static {
    async fn claim(
        &self,
        worker: &str,
        queues: &[String],
        limit: usize,
        lease_ms: i32,
    ) -> Result<Vec<Task>, ClientError>;
    async fn heartbeat(
        &self,
        worker: &str,
        task: &TaskId,
        fence: u64,
        lease_ms: i32,
    ) -> Result<(), ClientError>;
    async fn cancel_requested(&self, worker: &str) -> Result<Vec<TaskId>, ClientError>;
    async fn complete(&self, worker: &str, task: &TaskId, fence: u64) -> Result<(), ClientError>;
    async fn retry_or_dead_letter(
        &self,
        worker: &str,
        task: &TaskId,
        fence: u64,
        error: serde_json::Value,
    ) -> Result<(), ClientError>;
    async fn run_maintenance_v1(&self, worker: &str) -> Result<(), ClientError>;
    async fn register(
        &self,
        worker: &str,
        queues: &[String],
        lease_ms: i32,
        heartbeat_ms: i32,
    ) -> Result<bool, ClientError>;
    async fn paused(&self, worker: &str) -> Result<bool, ClientError>;
    async fn deregister(&self, worker: &str) -> Result<(), ClientError>;
}

/// Adapter over SM-16A's tokio-postgres client and the canonical SQL protocol.
pub struct PostgresClient {
    db: Arc<PgClient>,
}
impl PostgresClient {
    pub fn new(db: Arc<PgClient>) -> Self {
        Self { db }
    }
}
#[async_trait]
impl Client for PostgresClient {
    async fn claim(
        &self,
        worker: &str,
        queues: &[String],
        limit: usize,
        lease_ms: i32,
    ) -> Result<Vec<Task>, ClientError> {
        let mut out = Vec::new();
        for q in queues.iter().take(limit) {
            let rows = self.db.query("SELECT task_id, priority, payload, fence_token FROM workhorse.claim_many_v1($1,$2,$3,$4)", &[q, &worker, &((limit - out.len()).max(1) as i32), &lease_ms]).await.map_err(|e| ClientError::Other(e.to_string()))?;
            for r in rows {
                out.push(Task {
                    id: r
                        .try_get::<_, uuid::Uuid>("task_id")
                        .map_err(|e| ClientError::Other(e.to_string()))?
                        .to_string(),
                    queue: q.clone(),
                    rank: r.try_get("priority").unwrap_or(0),
                    payload: serde_json::to_vec(
                        &r.try_get::<_, serde_json::Value>("payload")
                            .unwrap_or(serde_json::Value::Null),
                    )
                    .unwrap_or_default(),
                    fence: r
                        .try_get::<_, i64>("fence_token")
                        .map_err(|e| ClientError::Other(e.to_string()))?
                        as u64,
                });
                if out.len() >= limit {
                    break;
                }
            }
            if out.len() >= limit {
                break;
            }
        }
        Ok(out)
    }
    async fn heartbeat(
        &self,
        worker: &str,
        task: &TaskId,
        fence: u64,
        lease_ms: i32,
    ) -> Result<(), ClientError> {
        let id = task.parse::<uuid::Uuid>().map_err(|e| ClientError::Other(e.to_string()))?;
        let status: String = self
            .db
            .query_one(
                "SELECT workhorse.heartbeat_v1($1,$2,$3,$4)",
                &[&id, &worker, &(fence as i64), &lease_ms],
            )
            .await
            .map_err(|e| ClientError::Other(e.to_string()))?
            .get(0);
        if status == "accepted" {
            Ok(())
        } else {
            Err(ClientError::Fenced)
        }
    }
    async fn cancel_requested(&self, worker: &str) -> Result<Vec<TaskId>, ClientError> {
        let rows=self.db.query("SELECT task_id FROM workhorse.task_runtime WHERE state='active' AND worker_id=$1 AND cancel_requested_at IS NOT NULL",&[&worker]).await.map_err(|e|ClientError::Other(e.to_string()))?;
        Ok(rows
            .into_iter()
            .filter_map(|r| r.try_get::<_, uuid::Uuid>(0).ok().map(|x| x.to_string()))
            .collect())
    }
    async fn complete(&self, worker: &str, task: &TaskId, fence: u64) -> Result<(), ClientError> {
        let id = task.parse::<uuid::Uuid>().map_err(|e| ClientError::Other(e.to_string()))?;
        let ok: bool = self
            .db
            .query_one("SELECT workhorse.complete_v1($1,$2,$3)", &[&id, &worker, &(fence as i64)])
            .await
            .map_err(|e| ClientError::Other(e.to_string()))?
            .get(0);
        if ok {
            Ok(())
        } else {
            Err(ClientError::Fenced)
        }
    }
    async fn retry_or_dead_letter(
        &self,
        worker: &str,
        task: &TaskId,
        fence: u64,
        error: serde_json::Value,
    ) -> Result<(), ClientError> {
        let id = task.parse::<uuid::Uuid>().map_err(|e| ClientError::Other(e.to_string()))?;
        let ok: bool = self
            .db
            .query_one(
                "SELECT workhorse.fail_v1($1,$2,$3,$4)",
                &[&id, &worker, &(fence as i64), &error],
            )
            .await
            .map_err(|e| ClientError::Other(e.to_string()))?
            .get(0);
        if ok {
            Ok(())
        } else {
            Err(ClientError::Fenced)
        }
    }
    async fn run_maintenance_v1(&self, worker: &str) -> Result<(), ClientError> {
        self.db
            .execute("SELECT workhorse.run_maintenance_v1($1)", &[&worker])
            .await
            .map(|_| ())
            .map_err(|e| ClientError::Other(e.to_string()))
    }
    async fn register(
        &self,
        worker: &str,
        queues: &[String],
        lease_ms: i32,
        heartbeat_ms: i32,
    ) -> Result<bool, ClientError> {
        let id = uuid::Uuid::new_v4();
        self.db.query_one("SELECT workhorse.register_worker_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)",&[&worker,&id,&"rust-worker",&1,&queues,&Vec::<String>::new(),&1,&lease_ms,&heartbeat_ms,&1000i32,&60000i32,&1000i32,&1000i32,&0i32,&false,&workhorse_client::CLIENT_PROTOCOL_VERSION,&"rust",&env!("CARGO_PKG_VERSION")]).await.map_err(|e|ClientError::Other(e.to_string())).map(|r|r.get(0))
    }
    async fn paused(&self, worker: &str) -> Result<bool, ClientError> {
        self.db
            .query_one(
                "SELECT paused FROM workhorse.worker_registry WHERE worker_id=$1",
                &[&worker],
            )
            .await
            .map(|r| r.get(0))
            .map_err(|e| ClientError::Other(e.to_string()))
    }
    async fn deregister(&self, worker: &str) -> Result<(), ClientError> {
        self.db
            .execute("SELECT workhorse.deregister_worker_v1($1)", &[&worker])
            .await
            .map(|_| ())
            .map_err(|e| ClientError::Other(e.to_string()))
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Telemetry {
    pub claimed: u64,
    pub completed: u64,
    pub failed: u64,
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
struct State {
    paused: bool,
    draining: bool,
    active: HashMap<TaskId, Lease>,
    cancelled: HashSet<TaskId>,
    cursor: usize,
}
pub struct Worker<C: Client> {
    client: Arc<C>,
    id: String,
    queues: Vec<String>,
    batch: usize,
    lease: Duration,
    state: Mutex<State>,
    telemetry: Mutex<Telemetry>,
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
        self.state.lock().unwrap().paused = true
    }
    pub fn request_drain(&self) {
        self.state.lock().unwrap().draining = true
    }
    pub fn is_drained(&self) -> bool {
        let s = self.state.lock().unwrap();
        s.draining && s.active.is_empty()
    }
    pub async fn start(&self) -> Result<(), ClientError> {
        let paused = self
            .client
            .register(
                &self.id,
                &self.queues,
                self.lease.as_millis() as i32,
                (self.lease.as_millis() / 3) as i32,
            )
            .await?;
        self.state.lock().unwrap().paused = paused;
        Ok(())
    }
    pub async fn poll(&self) -> Result<Vec<Lease>, ClientError> {
        let (paused, draining, start) = {
            let mut s = self.state.lock().unwrap();
            let n = self.queues.len();
            let st = s.cursor;
            if n > 0 {
                s.cursor = (st + self.batch) % n;
            }
            (s.paused, s.draining, st)
        };
        self.telemetry.lock().unwrap().polls += 1;
        if paused || draining {
            return Ok(vec![]);
        }
        let mut qs = self.queues.clone();
        let rotation = start.min(qs.len());
        qs.rotate_left(rotation);
        let tasks =
            self.client.claim(&self.id, &qs, self.batch, self.lease.as_millis() as i32).await?;
        let now = Instant::now();
        let mut out = Vec::new();
        let mut s = self.state.lock().unwrap();
        for task in tasks {
            let l = Lease {
                fence: task.fence,
                worker_id: self.id.clone(),
                expires_at: now + self.lease,
                task,
            };
            s.active.insert(l.task.id.clone(), l.clone());
            out.push(l)
        }
        self.telemetry.lock().unwrap().claimed += out.len() as u64;
        Ok(out)
    }
    pub async fn heartbeat(&self, id: &TaskId) -> Result<(), ClientError> {
        let l = self.state.lock().unwrap().active.get(id).cloned().ok_or(ClientError::Fenced)?;
        if Instant::now() >= l.expires_at {
            return Err(ClientError::Fenced);
        }
        self.client.heartbeat(&self.id, id, l.fence, self.lease.as_millis() as i32).await?;
        if let Some(x) = self.state.lock().unwrap().active.get_mut(id) {
            x.expires_at = Instant::now() + self.lease
        }
        self.telemetry.lock().unwrap().heartbeats += 1;
        Ok(())
    }
    pub async fn deliver_cancellation(&self) -> Result<Vec<TaskId>, ClientError> {
        let ids = self.client.cancel_requested(&self.id).await?;
        let mut s = self.state.lock().unwrap();
        for id in &ids {
            s.cancelled.insert(id.clone());
        }
        self.telemetry.lock().unwrap().cancellations += ids.len() as u64;
        Ok(ids)
    }
    pub async fn complete(&self, id: &TaskId) -> Result<(), ClientError> {
        let l = self.state.lock().unwrap().active.get(id).cloned().ok_or(ClientError::Fenced)?;
        self.client.complete(&self.id, id, l.fence).await?;
        self.state.lock().unwrap().active.remove(id);
        self.telemetry.lock().unwrap().completed += 1;
        Ok(())
    }
    pub async fn fail(&self, id: &TaskId, error: serde_json::Value) -> Result<(), ClientError> {
        let l = self.state.lock().unwrap().active.get(id).cloned().ok_or(ClientError::Fenced)?;
        self.client.retry_or_dead_letter(&self.id, id, l.fence, error).await?;
        self.state.lock().unwrap().active.remove(id);
        self.telemetry.lock().unwrap().failed += 1;
        Ok(())
    }
    pub async fn dispatch_batch<F, Fut>(
        &self,
        leases: Vec<Lease>,
        mut handler: F,
    ) -> Result<usize, ClientError>
    where
        F: FnMut(&Task) -> Fut,
        Fut: std::future::Future<Output = Result<(), ClientError>>,
    {
        let mut n = 0;
        for l in leases {
            if self.state.lock().unwrap().cancelled.contains(&l.task.id) {
                continue;
            }
            match handler(&l.task).await {
                Ok(()) => {
                    self.complete(&l.task.id).await?;
                    n += 1
                }
                Err(e) => {
                    self.fail(&l.task.id, serde_json::json!({"error":format!("{e:?}")})).await?
                }
            }
        }
        Ok(n)
    }
    pub async fn maintenance(&self) -> Result<(), ClientError> {
        self.client.run_maintenance_v1(&self.id).await
    }
    pub async fn drain(&self) -> Result<(), ClientError> {
        self.request_drain();
        while !self.is_drained() {
            tokio::task::yield_now().await
        }
        self.client.deregister(&self.id).await
    }
}

pub struct Registry<C: Client> {
    workers: Mutex<HashMap<String, Arc<Worker<C>>>>,
}
impl<C: Client> Default for Registry<C> {
    fn default() -> Self {
        Self { workers: Mutex::new(HashMap::new()) }
    }
}
impl<C: Client> Registry<C> {
    pub fn register(&self, worker: Arc<Worker<C>>) {
        self.workers.lock().unwrap().insert(worker.info().id.clone(), worker);
    }
    pub async fn pause(&self, id: &str) -> Result<bool, ClientError> {
        let w = self.workers.lock().unwrap().get(id).cloned();
        if let Some(w) = w {
            w.pause();
            Ok(true)
        } else {
            Ok(false)
        }
    }
    pub async fn refresh_pause(&self, id: &str) -> Result<bool, ClientError> {
        let w = self.workers.lock().unwrap().get(id).cloned();
        if let Some(w) = w {
            let paused = w.client.paused(id).await?;
            w.state.lock().unwrap().paused = paused;
            Ok(paused)
        } else {
            Ok(false)
        }
    }
    pub fn prune(&self) {
        self.workers.lock().unwrap().retain(|_, w| !w.is_drained());
    }
}
