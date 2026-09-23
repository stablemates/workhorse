//! One batched lease renewal per interval for every task a worker owns.
//!
//! Each worker reserves one pooled connection for its rounds before handlers can exhaust the pool.
//! A statement that fails or outlives the interval discards that connection, and the next round
//! acquires a fresh one. Go shares one reserved connection per pool; a Rust worker holds its own.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::json;
use tokio::sync::{mpsc, Notify};
use tokio::time::{timeout, Instant};
use uuid::Uuid;

use super::{Inner, OwnershipStatus};
use crate::sql_catalogue_generated as sql;
use crate::telemetry::{Attribute, Counter};
use crate::{Error, Executor};

/// What one round reports to the supervising execution.
pub(super) enum Beat {
    /// PostgreSQL accepted the renewal sent at this instant, which is when the new lease started.
    Renewed(Instant),
    Rejected(OwnershipStatus),
}

#[derive(Default)]
pub(super) struct Heartbeats {
    state: Mutex<State>,
    wake: Notify,
    reserved: tokio::sync::Mutex<Option<deadpool_postgres::Object>>,
}

#[derive(Default)]
struct State {
    members: HashMap<Uuid, (i64, mpsc::Sender<Beat>)>,
    running: bool,
}

impl Heartbeats {
    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl Inner {
    /// Takes the round connection now; a pool that cannot lend one is asked again by the first round.
    pub(super) async fn reserve_heartbeat_connection(&self) {
        if self.options.shared_heartbeats {
            return;
        }
        let mut reserved = self.heartbeats.reserved.lock().await;
        if reserved.is_none() {
            *reserved =
                timeout(self.heartbeat_interval, self.pool.get()).await.ok().and_then(Result::ok);
        }
    }

    pub(super) async fn release_heartbeat_connection(&self) {
        self.heartbeats.reserved.lock().await.take();
    }

    pub(super) fn register_heartbeat(
        self: &Arc<Self>,
        task: Uuid,
        fence: i64,
    ) -> mpsc::Receiver<Beat> {
        let (sender, receiver) = mpsc::channel(4);
        let mut state = self.heartbeats.state();
        state.members.insert(task, (fence, sender));
        if !state.running {
            state.running = true;
            tokio::spawn(Arc::clone(self).run_heartbeats());
        }
        receiver
    }

    pub(super) fn unregister_heartbeat(&self, task: Uuid) {
        let mut state = self.heartbeats.state();
        state.members.remove(&task);
        if state.members.is_empty() {
            self.heartbeats.wake.notify_one();
        }
    }

    /// Drops every renewal at once, so the abandoned tasks expire and PostgreSQL recovers them.
    pub(super) fn abandon_heartbeats(&self) {
        self.heartbeats.state().members.clear();
        self.heartbeats.wake.notify_one();
    }

    async fn run_heartbeats(self: Arc<Self>) {
        loop {
            tokio::select! {
                () = tokio::time::sleep(self.heartbeat_interval) => {}
                () = self.heartbeats.wake.notified() => {}
            }
            let members: Vec<(Uuid, i64)> = {
                let mut state = self.heartbeats.state();
                if state.members.is_empty() {
                    state.running = false;
                    return;
                }
                state.members.iter().map(|(task, (fence, _))| (*task, *fence)).collect()
            };
            if let Err(error) = self.heartbeat_round(&members).await {
                tracing::warn!(error = %error, workhorse.worker.id = %self.worker_id, "heartbeat round failed; retrying");
            }
        }
    }

    async fn heartbeat_round(&self, members: &[(Uuid, i64)]) -> Result<(), Error> {
        let lease_ms = self.options.lease_duration.as_millis() as u64;
        let payload = json!(members
            .iter()
            .map(|(task, fence)| json!({"taskId": task, "fenceToken": fence.to_string(), "leaseMs": lease_ms}))
            .collect::<Vec<_>>());
        let sent_at = Instant::now();
        let params: [&(dyn tokio_postgres::types::ToSql + Sync); 2] = [&self.worker_id, &payload];
        // A shared round borrows like any other statement. A round on the reserved connection is
        // bounded by the interval, so a statement stalled on it cannot hold the next round.
        let expired = || Error::invalid("heartbeat round exceeded the heartbeat interval");
        let rows = if self.options.shared_heartbeats {
            self.pool.rows(sql::HEARTBEAT_MANY_V1, &params).await?
        } else {
            let mut reserved = self.heartbeats.reserved.lock().await;
            // A replacement is borrowed like any other statement's connection, because opening one
            // can outlast a short interval. Only the statement it runs is bounded.
            if reserved.is_none() {
                *reserved = Some(self.pool.get().await?);
            }
            let connection = reserved.as_ref().expect("reserved above");
            match timeout(self.heartbeat_interval, connection.rows(sql::HEARTBEAT_MANY_V1, &params))
                .await
                .map_err(|_| expired())
                .and_then(|rows| rows)
            {
                Ok(rows) => rows,
                Err(error) => {
                    // A failed round discards the connection instead of returning it to the pool.
                    if let Some(connection) = reserved.take() {
                        drop(deadpool_postgres::Object::take(connection));
                    }
                    return Err(error);
                }
            }
        };
        let mut statuses = HashMap::with_capacity(rows.len());
        for row in &rows {
            let task: String = row.try_get("task_id")?;
            let status: String = row.try_get("status")?;
            statuses.insert(task, OwnershipStatus::parse(Some(&status))?);
        }
        let state = self.heartbeats.state();
        for (task, _) in members {
            let Some((_, sender)) = state.members.get(task) else { continue };
            let status = statuses.get(&task.to_string()).copied().unwrap_or(OwnershipStatus::Stale);
            if status == OwnershipStatus::Accepted {
                let _ = sender.try_send(Beat::Renewed(sent_at));
                continue;
            }
            self.metrics.add(
                Counter::HeartbeatFailures,
                1.0,
                &[("workhorse.heartbeat.status", Attribute::Text(status.as_str()))],
            );
            tracing::info!(
                event.name = "workhorse.task.heartbeat_rejected",
                workhorse.task.id = %task,
                workhorse.worker.id = %self.worker_id,
                workhorse.heartbeat.status = status.as_str(),
                "Task heartbeat rejected"
            );
            let _ = sender.try_send(Beat::Rejected(status));
        }
        Ok(())
    }
}
