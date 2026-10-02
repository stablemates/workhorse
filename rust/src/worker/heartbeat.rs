//! One batched lease renewal per interval for every task a worker owns.
//!
//! Each worker reserves one pooled connection for its rounds before handlers can exhaust the pool.
//! A statement that fails or outlives the interval discards that connection, and the next round
//! acquires a fresh one. Go shares one reserved connection per pool; a Rust worker holds its own.
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::json;
use tokio::sync::{mpsc, Notify};
use tokio::time::{timeout, timeout_at, Instant};
use uuid::Uuid;

use super::{Inner, OwnershipStatus};
use crate::fenced_write::fenced_rows;
use crate::sql_catalogue_generated as sql;
use crate::telemetry::{Attribute, Counter};
use crate::Error;

/// What one round reports to the supervising execution.
pub(super) enum Beat {
    /// PostgreSQL accepted the renewal sent at this instant, which is when the new lease started.
    Renewed(Instant),
    Rejected(OwnershipStatus),
}

/// One task's place in the rounds. Dropping it, including with a dropped execution, stops renewals.
pub(super) struct Membership {
    inner: Arc<Inner>,
    task: Uuid,
    fence: i64,
    pub(super) beats: mpsc::Receiver<Beat>,
}

impl Membership {
    /// Stops renewing this claim. A later claim of the same task under another fence stays.
    pub(super) fn leave(&self) {
        let heartbeats = &self.inner.heartbeats;
        let mut state = heartbeats.state();
        if state.members.get(&self.task).is_some_and(|(fence, _)| *fence == self.fence) {
            state.members.remove(&self.task);
        }
        if state.members.is_empty() {
            heartbeats.wake.notify_one();
        }
    }
}

impl Drop for Membership {
    fn drop(&mut self) {
        self.leave();
    }
}

#[derive(Default)]
pub(super) struct Heartbeats {
    state: Mutex<State>,
    wake: Notify,
    reserved: tokio::sync::Mutex<Option<deadpool_postgres::Object>>,
    /// Set when a stop gave up waiting for a round, so that round releases the connection.
    release_pending: AtomicBool,
}

#[derive(Default)]
struct State {
    members: HashMap<Uuid, (i64, mpsc::Sender<Beat>)>,
    running: bool,
    task: Option<tokio::task::JoinHandle<()>>,
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
        self.heartbeats.release_pending.store(false, Ordering::SeqCst);
        if reserved.is_none() {
            *reserved =
                timeout(self.heartbeat_interval, self.pool.get()).await.ok().and_then(Result::ok);
        }
    }

    /// Releases the round connection, waiting for a round in flight until `deadline` at most.
    ///
    /// A round that outlives the deadline releases the connection itself when it ends.
    pub(super) async fn release_heartbeat_connection(&self, deadline: Option<Instant>) {
        self.heartbeats.release_pending.store(true, Ordering::SeqCst);
        let mut reserved = match deadline {
            Some(deadline) => match timeout_at(deadline, self.heartbeats.reserved.lock()).await {
                Ok(reserved) => reserved,
                Err(_) => {
                    tracing::warn!(workhorse.worker.id = %self.worker_id, "heartbeat round outlived the shutdown cleanup window");
                    return;
                }
            },
            None => self.heartbeats.reserved.lock().await,
        };
        reserved.take();
        self.heartbeats.release_pending.store(false, Ordering::SeqCst);
    }

    /// Adds `task` to the rounds until the returned membership leaves or is dropped.
    pub(super) fn register_heartbeat(self: &Arc<Self>, task: Uuid, fence: i64) -> Membership {
        let (sender, beats) = mpsc::channel(4);
        let mut state = self.heartbeats.state();
        state.members.insert(task, (fence, sender));
        if !state.running {
            state.running = true;
            state.task = Some(tokio::spawn(Arc::clone(self).run_heartbeats()));
        }
        Membership { inner: Arc::clone(self), task, fence, beats }
    }

    /// Drops every renewal at once, so the abandoned tasks expire and PostgreSQL recovers them.
    pub(super) fn abandon_heartbeats(&self) {
        self.heartbeats.state().members.clear();
        self.heartbeats.wake.notify_one();
    }

    /// The latest heartbeat loop, which ends once it finds no members.
    pub(super) fn heartbeat_loop(&self) -> Option<tokio::task::JoinHandle<()>> {
        self.heartbeats.state().task.take()
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
            fenced_rows(&self.pool, sql::HEARTBEAT_MANY_V1, &params).await?
        } else {
            let mut reserved = self.heartbeats.reserved.lock().await;
            // A replacement is borrowed like any other statement's connection, because opening one
            // can outlast a short interval. Only the statement it runs is bounded.
            if reserved.is_none() {
                *reserved = Some(self.pool.get().await?);
            }
            let connection = reserved.as_ref().expect("reserved above");
            let rows = timeout(
                self.heartbeat_interval,
                fenced_rows(connection, sql::HEARTBEAT_MANY_V1, &params),
            )
            .await
            .map_err(|_| expired())
            .and_then(|rows| rows);
            if rows.is_err() {
                // A failed round discards the connection instead of returning it to the pool.
                if let Some(connection) = reserved.take() {
                    drop(deadpool_postgres::Object::take(connection));
                }
            }
            if self.heartbeats.release_pending.swap(false, Ordering::SeqCst) {
                reserved.take();
            }
            rows?
        };
        let mut statuses = HashMap::with_capacity(rows.len());
        for row in &rows {
            let task: String = row.try_get("task_id")?;
            let status: String = row.try_get("status")?;
            statuses.insert(task, OwnershipStatus::parse(Some(&status))?);
        }
        self.deliver_heartbeats(members, &statuses, sent_at);
        Ok(())
    }

    /// Delivers a completed round only to the same claims that sent it.
    fn deliver_heartbeats(
        &self,
        members: &[(Uuid, i64)],
        statuses: &HashMap<String, OwnershipStatus>,
        sent_at: Instant,
    ) {
        let state = self.heartbeats.state();
        for (task, sent_fence) in members {
            let Some((current_fence, sender)) = state.members.get(task) else { continue };
            // A suspension can resume this task while the old round is still in flight.
            if current_fence != sent_fence {
                continue;
            }
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
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Worker, WorkerOptions};

    fn worker() -> Worker {
        let manager = deadpool_postgres::Manager::new(
            "postgresql://localhost/unused".parse().unwrap(),
            tokio_postgres::NoTls,
        );
        let pool = deadpool_postgres::Pool::builder(manager).max_size(3).build().unwrap();
        Worker::new(
            pool,
            WorkerOptions {
                queues: vec!["unused".into()],
                polling_only: true,
                ..WorkerOptions::default()
            },
        )
        .unwrap()
    }

    #[tokio::test(start_paused = true)]
    async fn a_delayed_round_cannot_reach_a_resumed_claim() {
        for status in [
            Some(OwnershipStatus::Accepted),
            Some(OwnershipStatus::Stale),
            Some(OwnershipStatus::CancelRequested),
            Some(OwnershipStatus::DeadlineExceeded),
            Some(OwnershipStatus::TimeoutExceeded),
            None,
        ] {
            let worker = worker();
            let task = Uuid::new_v4();
            let other = Uuid::new_v4();
            let mut suspended = worker.0.register_heartbeat(task, 1);
            let mut unchanged = worker.0.register_heartbeat(other, 1);
            // The round snapshots fence 1, then the parent suspends and resumes at fence 2.
            let members = [(task, 1), (other, 1)];
            suspended.leave();
            let mut resumed = worker.0.register_heartbeat(task, 2);
            let sent_at = Instant::now();
            let mut statuses = HashMap::from([(other.to_string(), OwnershipStatus::Accepted)]);
            if let Some(status) = status {
                statuses.insert(task.to_string(), status);
            }
            worker.0.deliver_heartbeats(&members, &statuses, sent_at);
            assert!(
                matches!(resumed.beats.try_recv(), Err(mpsc::error::TryRecvError::Empty)),
                "a response for fence 1 reached fence 2"
            );
            assert!(matches!(
                suspended.beats.try_recv(),
                Err(mpsc::error::TryRecvError::Disconnected)
            ));
            assert!(matches!(unchanged.beats.try_recv(), Ok(Beat::Renewed(at)) if at == sent_at));
            // Leaving the old execution again must preserve the new membership.
            drop(suspended);
            worker.0.deliver_heartbeats(&[(task, 2)], &statuses, sent_at);
            match status.unwrap_or(OwnershipStatus::Stale) {
                OwnershipStatus::Accepted => assert!(
                    matches!(resumed.beats.try_recv(), Ok(Beat::Renewed(at)) if at == sent_at)
                ),
                expected => assert!(
                    matches!(resumed.beats.try_recv(), Ok(Beat::Rejected(actual)) if actual == expected)
                ),
            }
        }
    }
}
