//! Batches the fast-tier completions that finish together into one `complete_many_and_claim_v1`
//! statement per queue and cohort (ADR 0076, rule 12).
//!
//! Each completion may also claim successors for its cohort. The statement claims the sum of
//! those limits, and each completion receives its own share in submission order.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio::sync::oneshot;
use tokio::time::Instant;
use uuid::Uuid;

use super::{lock, millis_i32, sql, ClaimedTask, Inner};
use crate::{Error, Executor};

/// The most completions, and the most claimed tasks, in one statement.
const MAX_BATCH: usize = 100;

/// How many times a statement that PostgreSQL chose as a deadlock victim is sent again.
const DEADLOCK_RETRIES: usize = 3;

/// Whether PostgreSQL accepted the completion, and the tasks its fused claim leased.
type Answer = Result<(bool, Vec<ClaimedTask>), Error>;

struct Entry {
    id: Uuid,
    fence: i64,
    result: Value,
    limit: usize,
    reply: oneshot::Sender<Answer>,
}

/// Completions waiting for the next statement, keyed by queue and cohort.
#[derive(Default)]
pub(super) struct Batcher {
    pending: Mutex<HashMap<(String, usize), Vec<Entry>>>,
}

impl Inner {
    /// Completes a fast-tier attempt and claims up to `limit` tasks from its queue, sharing one
    /// statement with the other completions of `cohort` that finish in the same scheduler turn.
    pub(super) async fn complete_batched(
        self: &Arc<Self>,
        task: &ClaimedTask,
        result: Value,
        limit: usize,
        cohort: usize,
    ) -> Answer {
        let (reply, answer) = oneshot::channel();
        let entry = Entry {
            id: task.id,
            fence: task.fence_token,
            result,
            limit: limit.min(MAX_BATCH),
            reply,
        };
        let key = (task.queue.clone(), cohort);
        let first = {
            let mut pending = lock(&self.completions.pending);
            let entries = pending.entry(key.clone()).or_default();
            entries.push(entry);
            entries.len() == 1
        };
        if first {
            let inner = Arc::clone(self);
            tokio::spawn(async move {
                // Completions that finish before this task runs again join its statement.
                tokio::task::yield_now().await;
                let entries = lock(&inner.completions.pending).remove(&key).unwrap_or_default();
                inner.flush(&key.0, entries).await;
            });
        }
        answer
            .await
            .unwrap_or_else(|_| Err(Error::invalid("a completion batch ended without an answer")))
    }

    /// Sends the entries in statements of at most 100 completions that claim at most 100 tasks.
    async fn flush(&self, queue: &str, entries: Vec<Entry>) {
        let mut chunks: Vec<(Vec<Entry>, usize)> = Vec::new();
        for entry in entries {
            match chunks.last_mut() {
                Some((chunk, limit))
                    if chunk.len() < MAX_BATCH && *limit + entry.limit <= MAX_BATCH =>
                {
                    *limit += entry.limit;
                    chunk.push(entry);
                }
                _ => {
                    let limit = entry.limit;
                    chunks.push((vec![entry], limit));
                }
            }
        }
        futures_util::future::join_all(
            chunks.into_iter().map(|(chunk, limit)| self.flush_chunk(queue, chunk, limit)),
        )
        .await;
    }

    async fn flush_chunk(&self, queue: &str, mut chunk: Vec<Entry>, limit: usize) {
        // Concurrent statements then delete their runtime rows in one order.
        chunk.sort_unstable_by_key(|entry| entry.id);
        let mut answer = self.send_chunk(queue, &chunk, limit).await;
        // A fused claim can keep a lock on a row that a concurrent claim has just leased, so two
        // statements can deadlock. PostgreSQL rolls the victim back whole, so it can be sent again.
        for _ in 0..DEADLOCK_RETRIES {
            match &answer {
                Err(error) if error.sqlstate() == Some("40P01") => {
                    answer = self.send_chunk(queue, &chunk, limit).await;
                }
                _ => break,
            }
        }
        match answer {
            Ok((accepted, claimed)) => {
                let mut claimed = claimed.into_iter();
                for entry in chunk {
                    let share = claimed.by_ref().take(entry.limit).collect();
                    let _ = entry.reply.send(Ok((accepted.contains(&entry.id), share)));
                }
            }
            Err(error) => {
                for entry in chunk {
                    let _ = entry.reply.send(Err(error.share()));
                }
            }
        }
    }

    async fn send_chunk(
        &self,
        queue: &str,
        chunk: &[Entry],
        limit: usize,
    ) -> Result<(Vec<Uuid>, Vec<ClaimedTask>), Error> {
        let ids: Vec<Uuid> = chunk.iter().map(|entry| entry.id).collect();
        let fences: Vec<i64> = chunk.iter().map(|entry| entry.fence).collect();
        let results: Vec<Value> = chunk.iter().map(|entry| entry.result.clone()).collect();
        let sent_at = Instant::now();
        let rows = self
            .pool
            .rows(
                sql::COMPLETE_MANY_AND_CLAIM_V1,
                &[
                    &self.worker_id,
                    &ids,
                    &fences,
                    &results,
                    &queue,
                    &(limit as i32),
                    &millis_i32(self.options.lease_duration),
                ],
            )
            .await
            .map_err(Error::translate_fast_tier)?;
        // The first row carries every accepted id; a stale fence leaves its task out of it.
        let accepted = match rows.first() {
            Some(row) => row.try_get::<_, Option<Vec<Uuid>>>("accepted")?.unwrap_or_default(),
            None => Vec::new(),
        };
        let mut claimed = Vec::new();
        if limit > 0 {
            // A claim that finds nothing still returns one row, with every claim column null.
            let mut rows_claimed = Vec::with_capacity(rows.len());
            for row in rows {
                if row.try_get::<_, Option<Uuid>>("task_id")?.is_some() {
                    rows_claimed.push(row);
                }
            }
            self.claimed_tasks(&rows_claimed, queue, sent_at, true, &mut claimed)?;
        }
        Ok((accepted, claimed))
    }
}
