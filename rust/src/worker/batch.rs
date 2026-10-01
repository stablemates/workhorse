//! A process-local rendezvous that hands tasks of one type to a handler together.
//!
//! Each member keeps its own claim, lease and settlement. The batch only shares one handler call,
//! and each member waits for its positional outcome or its own cancellation.
use std::collections::HashMap;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::BoxFuture;
use futures_util::FutureExt;
use serde_json::Value;
use tokio::sync::oneshot;
use tokio::time::Instant;
use uuid::Uuid;

use super::handler::{self, ErasedHandler};
use super::{lock, sql, Inner, Worker};
use crate::fenced_write::fenced_rows;
use crate::telemetry::{Attribute, Histogram};
use crate::{
    BatchHandlerContext, BatchItem, BatchOptions, BatchResult, HandlerContext, HandlerError,
};

const MAX_BATCH_SIZE: usize = 100;
const MAX_BATCH_LINGER: Duration = Duration::from_secs(60);

type BatchHandler<P, R> =
    Arc<dyn Fn(Vec<BatchItem<P>>) -> BoxFuture<'static, Vec<BatchResult<R>>> + Send + Sync>;

struct Member<P, R> {
    arrival: u64,
    arrived: Instant,
    item: BatchItem<P>,
    result: oneshot::Sender<Result<R, HandlerError>>,
}

struct Pending<P, R> {
    next: u64,
    queues: HashMap<String, Vec<Member<P, R>>>,
}

struct Coordinator<P, R> {
    worker: Arc<Inner>,
    task_type: String,
    options: BatchOptions,
    handler: BatchHandler<P, R>,
    pending: Mutex<Pending<P, R>>,
    /// Runs with the arrival's number once it has released the lock it was added under.
    #[cfg(test)]
    arrived: Box<dyn Fn(u64) + Send + Sync>,
}

impl Worker {
    /// Registers a batch handler for `task_type`, replacing any earlier handler.
    ///
    /// The handler returns one [`BatchResult`] per item, in item order.
    ///
    /// # Panics
    ///
    /// Panics when `task_type` is empty, when `max_size` is outside 1 to 100 or above the
    /// worker's concurrency, or when `linger` is not whole milliseconds up to 60 seconds.
    pub fn handle_batch<P, R, F, Fut>(
        &self,
        task_type: &str,
        options: BatchOptions,
        handler: F,
    ) -> &Self
    where
        P: serde::de::DeserializeOwned + Send + 'static,
        R: serde::Serialize + Send + 'static,
        F: Fn(Vec<BatchItem<P>>) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Vec<BatchResult<R>>> + Send + 'static,
    {
        assert!(!task_type.is_empty(), "worker task type must not be empty");
        assert!(
            (1..=MAX_BATCH_SIZE).contains(&options.max_size),
            "batch maximum size must be between 1 and {MAX_BATCH_SIZE}"
        );
        assert!(
            options.max_size <= self.0.options.concurrency,
            "batch maximum size must not exceed worker concurrency"
        );
        assert!(
            options.linger <= MAX_BATCH_LINGER && super::whole_millis(options.linger),
            "batch linger must be a whole number of milliseconds between zero and 1m0s"
        );
        let handler = Arc::new(handler);
        let coordinator = Arc::new(Coordinator {
            worker: Arc::clone(&self.0),
            task_type: task_type.into(),
            options,
            handler: Arc::new(move |items: Vec<BatchItem<P>>| handler(items).boxed()),
            pending: Mutex::new(Pending { next: 0, queues: HashMap::new() }),
            #[cfg(test)]
            arrived: Box::new(|_| {}),
        });
        let erased: ErasedHandler = Arc::new(move |payload: Value, context: HandlerContext| {
            let coordinator = Arc::clone(&coordinator);
            async move {
                let payload = handler::decode(payload)?;
                coordinator.join(payload, context).await.and_then(handler::encode)
            }
            .boxed()
        });
        self.0
            .handlers
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(task_type.into(), erased);
        self
    }
}

impl<P: Send + 'static, R: Send + 'static> Coordinator<P, R> {
    async fn join(self: Arc<Self>, payload: P, context: HandlerContext) -> Result<R, HandlerError> {
        let queue = context.task().queue.clone();
        let cancellation = context.cancellation().clone();
        let (sender, mut receiver) = oneshot::channel();
        // The arrival that fills the batch takes it under the same lock that added it. A separate
        // take would let a concurrent arrival take this member's batch and leave its own behind.
        let (arrival, first_arrival, batch) = {
            let mut pending = lock(&self.pending);
            let arrival = pending.next;
            pending.next += 1;
            let members = pending.queues.entry(queue.clone()).or_default();
            members.push(Member {
                arrival,
                arrived: Instant::now(),
                item: BatchItem { payload, context: BatchHandlerContext::new(context) },
                result: sender,
            });
            let first_arrival = members[0].arrived;
            let ready = members.len() >= self.options.max_size || self.options.linger.is_zero();
            (
                arrival,
                first_arrival,
                ready.then(|| self.take(&mut pending, &queue, arrival)).flatten(),
            )
        };
        #[cfg(test)]
        (self.arrived)(arrival);
        // The member that dispatches runs the callback in its own execution, so the callback holds
        // that slot and the shutdown drain counts it, whatever happens to the member's cancellation.
        if let Some(batch) = batch {
            self.dispatch(batch).await;
        } else {
            let linger = tokio::time::sleep_until(first_arrival + self.options.linger);
            tokio::select! {
                result = &mut receiver => return result.unwrap_or_else(|_| Err(abandoned())),
                () = linger => {
                    let batch = self.take(&mut lock(&self.pending), &queue, arrival);
                    if let Some(batch) = batch {
                        self.dispatch(batch).await;
                    }
                }
                () = cancellation.cancelled() => {
                    self.remove(&queue, arrival);
                    return Err(cancelled());
                }
            }
        }
        tokio::select! {
            biased;
            result = &mut receiver => result.unwrap_or_else(|_| Err(abandoned())),
            () = cancellation.cancelled() => {
                self.remove(&queue, arrival);
                Err(cancelled())
            }
        }
    }

    /// Removes every member pending on `queue`, ordered by priority and then arrival.
    ///
    /// A queue never holds a full batch between arrivals, so the batch always fits. Only a member
    /// still pending takes it: a member another callback already took would otherwise run a second
    /// callback before it could take the outcome the first one delivered.
    fn take(
        &self,
        pending: &mut Pending<P, R>,
        queue: &str,
        arrival: u64,
    ) -> Option<Vec<Member<P, R>>> {
        let members = pending.queues.get(queue)?;
        if !members.iter().any(|member| member.arrival == arrival) {
            return None;
        }
        let mut batch = pending.queues.remove(queue)?;
        batch.sort_by(|left, right| {
            right
                .item
                .context
                .task()
                .priority
                .cmp(&left.item.context.task().priority)
                .then(left.arrival.cmp(&right.arrival))
        });
        Some(batch)
    }

    fn remove(&self, queue: &str, arrival: u64) {
        let mut pending = lock(&self.pending);
        if let Some(members) = pending.queues.get_mut(queue) {
            members.retain(|member| member.arrival != arrival);
            if members.is_empty() {
                pending.queues.remove(queue);
            }
        }
    }

    async fn dispatch(&self, batch: Vec<Member<P, R>>) {
        let queue = batch[0].item.context.task().queue.clone();
        let full = batch.len() == self.options.max_size;
        let linger =
            batch.iter().map(|member| member.arrived).min().unwrap_or_else(Instant::now).elapsed();
        let attributes = [
            ("workhorse.queue.name", Attribute::Text(&queue)),
            ("workhorse.task.type", Attribute::Text(&self.task_type)),
            ("workhorse.handler.batch.full", Attribute::Bool(full)),
        ];
        let linger_ms = linger.as_secs_f64() * 1000.0;
        self.worker.metrics.record(Histogram::BatchSize, batch.len() as f64, &attributes);
        self.worker.metrics.record(Histogram::BatchLinger, linger_ms, &attributes);
        tracing::debug!(
            event.name = "workhorse.handler.batch_dispatched",
            workhorse.queue.name = %queue,
            workhorse.task.type = %self.task_type,
            workhorse.worker.id = %self.worker.worker_id,
            workhorse.handler.batch.size = batch.len(),
            workhorse.handler.batch.linger = linger_ms,
            workhorse.handler.batch.full = full,
            "Batch dispatched"
        );
        let batch_id = Uuid::new_v4();
        let mut items = Vec::with_capacity(batch.len());
        let mut senders = Vec::with_capacity(batch.len());
        for member in batch {
            let task = member.item_task();
            senders.push((member.result, task));
            items.push(member.item);
        }
        let tasks: Vec<_> = senders.iter().map(|(_, task)| *task).collect();
        self.record(sql::RECORD_BATCH_DISPATCH_V1, batch_id, &tasks).await;
        let expected = items.len();
        let outcomes = AssertUnwindSafe((self.handler)(items))
            .catch_unwind()
            .await
            .map_err(|panic| HandlerError::from_panic(&self.task_type, true, panic))
            .and_then(|outcomes| {
                if outcomes.len() == expected {
                    return Ok(outcomes);
                }
                Err(HandlerError::new(format!(
                    "batch handler for {} returned {} outcomes for {expected} tasks",
                    self.task_type,
                    outcomes.len()
                )))
            });
        match outcomes {
            Ok(outcomes) => {
                for ((sender, _), outcome) in senders.into_iter().zip(outcomes) {
                    let _ = sender.send(match outcome {
                        BatchResult::Succeeded(value) => Ok(value),
                        BatchResult::Failed(error) => Err(error),
                    });
                }
            }
            Err(error) => {
                self.record(sql::RECORD_BATCH_FAILURE_V1, batch_id, &tasks).await;
                for (sender, _) in senders {
                    let _ = sender.send(Err(error.clone()));
                }
            }
        }
    }

    /// Records batch membership for operators; a failed write never affects settlement.
    async fn record(&self, statement: &str, batch_id: Uuid, tasks: &[(Uuid, i32, i64)]) {
        let (mut ids, mut attempts, mut fences) = (Vec::new(), Vec::new(), Vec::new());
        for &(id, attempt, fence) in tasks {
            ids.push(id);
            attempts.push(attempt);
            fences.push(fence);
        }
        let params: [&(dyn tokio_postgres::types::ToSql + Sync); 5] =
            [&batch_id, &ids, &attempts, &fences, &self.worker.worker_id];
        if let Err(error) = fenced_rows(&self.worker.pool, statement, &params).await {
            tracing::debug!(error = %error, "batch membership was not recorded");
        }
    }
}

impl<P, R> Member<P, R> {
    fn item_task(&self) -> (Uuid, i32, i64) {
        let task = self.item.context.task();
        (task.id, task.attempt, task.fence_token)
    }
}

fn cancelled() -> HandlerError {
    HandlerError::named("Cancelled", "batch member was cancelled before its batch finished")
}

fn abandoned() -> HandlerError {
    HandlerError::named("BatchAbandoned", "batch dispatch ended without an outcome for this task")
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use tokio::sync::{mpsc, Semaphore};
    use tokio::task::JoinHandle;

    use super::*;
    use crate::worker::handler::CancellationToken;
    use crate::{ClaimedTask, WorkerOptions};

    const LINGER: Duration = Duration::from_secs(1);

    /// A pool whose every connection fails at once, so a membership record never waits.
    fn pool() -> deadpool_postgres::Pool {
        let mut config = deadpool_postgres::Config::new();
        config.host = Some("/nonexistent-workhorse-socket".into());
        config.dbname = Some("unused".into());
        config.create_pool(Some(deadpool_postgres::Runtime::Tokio1), tokio_postgres::NoTls).unwrap()
    }

    fn coordinator<F, Fut>(handler: F) -> Arc<Coordinator<i64, i64>>
    where
        F: Fn(Vec<BatchItem<i64>>) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Vec<BatchResult<i64>>> + Send + 'static,
    {
        observed(handler, |_| {})
    }

    /// A coordinator that runs `arrived` with each arrival's number once that arrival has released
    /// the lock it was added under.
    fn observed<F, Fut>(
        handler: F,
        arrived: impl Fn(u64) + Send + Sync + 'static,
    ) -> Arc<Coordinator<i64, i64>>
    where
        F: Fn(Vec<BatchItem<i64>>) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Vec<BatchResult<i64>>> + Send + 'static,
    {
        let options =
            WorkerOptions { concurrency: 3, shared_heartbeats: true, ..Default::default() };
        let worker = Worker::new(pool(), options).unwrap();
        Arc::new(Coordinator {
            worker: Arc::clone(&worker.0),
            task_type: "batch".into(),
            options: BatchOptions { max_size: 2, linger: LINGER },
            handler: Arc::new(move |items| handler(items).boxed()),
            pending: Mutex::new(Pending { next: 0, queues: HashMap::new() }),
            arrived: Box::new(arrived),
        })
    }

    fn join(coordinator: &Arc<Coordinator<i64, i64>>, payload: i64) -> JoinHandle<i64> {
        let task = ClaimedTask {
            id: Uuid::new_v4(),
            task_type: "batch".into(),
            queue: "queue".into(),
            priority: 0,
            payload: payload.into(),
            contract_version: None,
            result_max_bytes: None,
            redact_error_details: false,
            trace_context: None,
            attempt: 1,
            max_attempts: 1,
            retry_policy: Value::Null,
            deadline_at: None,
            execution_timeout: None,
            attempt_timeout_at: None,
            fence_token: 1,
            lease_expires_at: Utc::now(),
            claim_sent_at: Instant::now(),
            fast_tier: false,
        };
        let token = CancellationToken::default();
        let context = HandlerContext::new(Arc::new(task), token, pool(), "worker".into());
        let joined = Arc::clone(coordinator).join(payload, context);
        tokio::spawn(async move { joined.await.unwrap() })
    }

    fn pending(coordinator: &Coordinator<i64, i64>) -> usize {
        lock(&coordinator.pending).queues.get("queue").map_or(0, Vec::len)
    }

    fn times_ten(items: &[BatchItem<i64>]) -> Vec<BatchResult<i64>> {
        items.iter().map(|item| BatchResult::Succeeded(item.payload * 10)).collect()
    }

    // The second member is held after it releases the lock it was added under, until the third has
    // arrived. A take apart from the insertion would let the third take the first two and leave its
    // own member pending with no linger to wake it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_member_that_fills_a_batch_dispatches_its_own() {
        let (called, mut calls) = mpsc::unbounded_channel();
        let (arrivals, mut arrived) = mpsc::unbounded_channel();
        let (third_arrived, third) = std::sync::mpsc::channel();
        let third = Mutex::new(third);
        let handler = move |items: Vec<BatchItem<i64>>| {
            let _ = called.send(items.iter().map(|item| item.payload).collect::<Vec<_>>());
            let results = times_ten(&items);
            async move { results }
        };
        let coordinator = observed(handler, move |arrival| {
            let _ = arrivals.send(arrival);
            match arrival {
                // The second member waits for the third. The bound only keeps a broken run finite.
                1 => drop(lock(&third).recv_timeout(Duration::from_secs(5))),
                2 => drop(third_arrived.send(())),
                _ => {}
            }
        });
        let first = join(&coordinator, 1);
        assert_eq!(arrived.recv().await, Some(0));
        let second = join(&coordinator, 2);
        assert_eq!(arrived.recv().await, Some(1));
        let third = join(&coordinator, 3);
        for (member, expected) in [(first, 10), (second, 20), (third, 30)] {
            let outcome = tokio::time::timeout(LINGER * 5, member).await;
            assert_eq!(outcome.expect("a member never received its outcome").unwrap(), expected);
        }
        assert_eq!(calls.recv().await.unwrap(), vec![1, 2]);
        assert_eq!(calls.recv().await.unwrap(), vec![3]);
    }

    // The first member's linger ends while the full batch it belongs to is still running and a
    // third member waits. Taking that third member would hold the first behind a second callback.
    #[tokio::test(start_paused = true)]
    async fn a_member_taken_by_one_callback_never_waits_on_the_next() {
        let gates = [Arc::new(Semaphore::new(0)), Arc::new(Semaphore::new(0))];
        let held = gates.clone();
        let (called, mut calls) = mpsc::unbounded_channel();
        let coordinator = coordinator(move |items: Vec<BatchItem<i64>>| {
            // The full batch holds the first gate; the third member's batch holds the second.
            let gate = Arc::clone(&held[usize::from(items.len() == 1)]);
            let _ = called.send(items.iter().map(|item| item.payload).collect::<Vec<_>>());
            let results = times_ten(&items);
            async move {
                let _permit = gate.acquire().await.unwrap();
                results
            }
        });
        let first = join(&coordinator, 1);
        tokio::task::yield_now().await;
        let second = join(&coordinator, 2);
        assert_eq!(calls.recv().await.unwrap(), vec![1, 2]);
        tokio::time::advance(LINGER / 2).await;
        let third = join(&coordinator, 3);
        tokio::task::yield_now().await;
        assert_eq!(pending(&coordinator), 1, "the third member is pending");
        // Only the first member's linger has ended; the third member's ends half a linger later.
        tokio::time::advance(LINGER / 2 + Duration::from_millis(1)).await;
        tokio::task::yield_now().await;
        assert_eq!(pending(&coordinator), 1, "the first member's linger took the third member");
        gates[0].add_permits(1);
        for (member, expected) in [(first, 10), (second, 20)] {
            let outcome = tokio::time::timeout(LINGER / 10, member).await;
            assert_eq!(outcome.expect("a member waited on the next callback").unwrap(), expected);
        }
        gates[1].add_permits(1);
        assert_eq!(tokio::time::timeout(LINGER * 5, third).await.unwrap().unwrap(), 30);
        assert_eq!(calls.recv().await.unwrap(), vec![3]);
    }
}
