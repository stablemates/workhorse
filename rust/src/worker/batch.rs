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
use crate::telemetry::{Attribute, Histogram};
use crate::{BatchItem, BatchOptions, BatchResult, Executor, HandlerContext, HandlerError};

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
        let (arrival, first_arrival, full) = {
            let mut pending = lock(&self.pending);
            let arrival = pending.next;
            pending.next += 1;
            let members = pending.queues.entry(queue.clone()).or_default();
            members.push(Member {
                arrival,
                arrived: Instant::now(),
                item: BatchItem { payload, context },
                result: sender,
            });
            (arrival, members[0].arrived, members.len() >= self.options.max_size)
        };
        if full || self.options.linger.is_zero() {
            self.take_and_dispatch(&queue);
        } else {
            let linger = tokio::time::sleep_until(first_arrival + self.options.linger);
            tokio::select! {
                result = &mut receiver => return result.unwrap_or_else(|_| Err(abandoned())),
                () = linger => self.take_and_dispatch(&queue),
                () = cancellation.cancelled() => {
                    self.remove(&queue, arrival);
                    return Err(cancelled());
                }
            }
        }
        tokio::select! {
            result = &mut receiver => result.unwrap_or_else(|_| Err(abandoned())),
            () = cancellation.cancelled() => {
                self.remove(&queue, arrival);
                Err(cancelled())
            }
        }
    }

    /// Removes up to `max_size` members, ordered by priority and then arrival.
    fn take_and_dispatch(self: &Arc<Self>, queue: &str) {
        let batch = {
            let mut pending = lock(&self.pending);
            let Some(members) = pending.queues.get_mut(queue) else { return };
            let size = self.options.max_size.min(members.len());
            let mut batch: Vec<_> = members.drain(..size).collect();
            if members.is_empty() {
                pending.queues.remove(queue);
            }
            batch.sort_by(|left, right| {
                right
                    .item
                    .context
                    .task()
                    .priority
                    .cmp(&left.item.context.task().priority)
                    .then(left.arrival.cmp(&right.arrival))
            });
            batch
        };
        if !batch.is_empty() {
            tokio::spawn(Arc::clone(self).dispatch(batch));
        }
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

    async fn dispatch(self: Arc<Self>, batch: Vec<Member<P, R>>) {
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
        if let Err(error) = self
            .worker
            .pool
            .rows(statement, &[&batch_id, &ids, &attempts, &fences, &self.worker.worker_id])
            .await
        {
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
