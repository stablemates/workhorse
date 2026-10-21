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

use super::{lock, millis_i32, sql, ClaimedTask, Inner, RunGate};
use crate::fenced_write::fenced_rows;
use crate::queue::BoundedPool;
use crate::Error;

/// The most completions, and the most claimed tasks, in one statement.
const MAX_BATCH: usize = 100;

/// Whether PostgreSQL accepted the completion, and the tasks its fused claim leased.
type Answer = Result<(bool, Vec<ClaimedTask>), Error>;

struct Entry {
    id: Uuid,
    fence: i64,
    result: Value,
    limit: usize,
    reply: oneshot::Sender<Answer>,
}

/// The claim gate of the run that submitted a batch, by address, so two runs never share one.
type RunKey = usize;

/// Completions waiting for the next statement, keyed by queue, cohort, and run. Each batch keeps the
/// gate of its run, so a batch that outlives its run claims nothing.
#[derive(Default)]
pub(super) struct Batcher {
    pending: Mutex<HashMap<BatchKey, Batch>>,
}

/// The queue, the cohort, and the run of a batch.
type BatchKey = (String, usize, RunKey);

/// The gate of the run that submitted a batch, and its completions.
type Batch = (Option<Arc<RunGate>>, Vec<Entry>);

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
        let gate = self.run_gate();
        let run = gate.as_ref().map_or(0, |gate| Arc::as_ptr(gate) as usize);
        let key = (task.queue.clone(), cohort, run);
        let first = {
            let mut pending = lock(&self.completions.pending);
            let (_, entries) = pending.entry(key.clone()).or_insert_with(|| (gate, Vec::new()));
            entries.push(entry);
            entries.len() == 1
        };
        if first {
            let inner = Arc::clone(self);
            tokio::spawn(async move {
                // Completions that finish before this task runs again join its statement.
                tokio::task::yield_now().await;
                let (gate, entries) =
                    lock(&inner.completions.pending).remove(&key).unwrap_or_default();
                inner.flush(&key.0, gate.as_deref(), entries).await;
            });
        }
        answer
            .await
            .unwrap_or_else(|_| Err(Error::invalid("a completion batch ended without an answer")))
    }

    /// Sends the entries in statements of at most 100 completions that claim at most 100 tasks.
    async fn flush(&self, queue: &str, gate: Option<&RunGate>, entries: Vec<Entry>) {
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
            chunks.into_iter().map(|(chunk, limit)| self.flush_chunk(queue, gate, chunk, limit)),
        )
        .await;
    }

    async fn flush_chunk(
        &self,
        queue: &str,
        gate: Option<&RunGate>,
        mut chunk: Vec<Entry>,
        limit: usize,
    ) {
        // Concurrent statements then delete their runtime rows in one order.
        chunk.sort_unstable_by_key(|entry| entry.id);
        // The fused claim gives up a lock wait before it can deadlock (SM-934). If PostgreSQL
        // still rolls the chunk back as a deadlock victim, fenced_rows sends it again.
        match self.send_chunk(queue, gate, &chunk, limit).await {
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
        gate: Option<&RunGate>,
        chunk: &[Entry],
        limit: usize,
    ) -> Result<(Vec<Uuid>, Vec<ClaimedTask>), Error> {
        let ids: Vec<Uuid> = chunk.iter().map(|entry| entry.id).collect();
        let fences: Vec<i64> = chunk.iter().map(|entry| entry.fence).collect();
        let results: Vec<Value> = chunk.iter().map(|entry| entry.result.clone()).collect();
        let sent_at = Instant::now();
        let statement = (queue, ids.as_slice(), fences.as_slice(), results.as_slice());
        // Only an attempt that can claim asks the gate, and it asks the gate of the run that
        // submitted the batch, after its checkout. A completion that waited while the heartbeat
        // connection went, or while its run ended, then settles and claims nothing (ADR 0071,
        // rule 6). The gate never stops the settlement itself.
        let mut limit = limit;
        let mut rows = None;
        if limit > 0 {
            let allowed = || gate.and_then(RunGate::permit);
            let gated = self.statements().gated(&allowed);
            let sent = self.send_completions(&gated, statement, limit).await;
            if gated.refused() {
                limit = 0;
            } else {
                rows = Some(sent);
            }
        }
        let rows = match rows {
            Some(rows) => rows,
            None => self.send_completions(&self.statements(), statement, 0).await,
        };
        let rows = rows.map_err(Error::translate_fast_tier)?;
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

    /// Sends `complete_many_and_claim_v1` for one chunk through `executor`, claiming up to `limit`.
    async fn send_completions(
        &self,
        executor: &BoundedPool<'_>,
        (queue, ids, fences, results): (&str, &[Uuid], &[i64], &[Value]),
        limit: usize,
    ) -> Result<Vec<tokio_postgres::Row>, Error> {
        fenced_rows(
            executor,
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
    }
}
