//! The dispatch loop, which keeps a worker's slots full without one serial claim per task.
//!
//! ADR 0076 describes the design. A claim reserves the slots it asks for, so claimed tasks never
//! exceed the concurrency. With no claim in flight, any free slot starts one. While one is in
//! flight, another starts only once the unreserved free slots reach the refill batch, so a busy
//! worker claims in batches and its claims overlap. Starting a claim never blocks the loop.
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::FutureExt;
use tokio::sync::Notify;
use tokio::task::{Id, JoinError, JoinSet};
use tokio::time::Instant;

use super::{random_fraction, record, MAX_NOTIFICATION_DELAY_MS};
use crate::Error;

/// What the dispatch loop needs from a worker. The unit tests substitute a fake.
pub(super) trait Dispatch: Send + Sync + 'static {
    type Task: Send + 'static;

    fn concurrency(&self) -> usize;
    fn paused(&self) -> bool;
    /// The wait after `consecutive_empty` claims found nothing to run.
    fn poll_delay(&self, consecutive_empty: u32) -> Duration;
    /// Claims up to `limit` tasks. A failed claim reports it and returns what it leased first.
    fn claim(&self, limit: usize) -> impl Future<Output = Vec<Self::Task>> + Send + 'static;
    /// Starts one claimed task and returns whether a registered handler runs it.
    fn launch(&self, executions: &mut JoinSet<Result<(), Error>>, task: Self::Task) -> bool;
}

/// Free slots that let a second claim start while one is in flight: a quarter of the concurrency,
/// rounded up.
pub(super) fn refill_batch(concurrency: usize) -> usize {
    concurrency.div_ceil(4)
}

/// A finished claim. `tasks` is `None` when the loop stopped or paused during the notification
/// delay, so no claim was sent.
struct Claimed<T> {
    wake_version: u64,
    tasks: Option<Vec<T>>,
}

struct Dispatcher<D: Dispatch> {
    worker: Arc<D>,
    refill_batch: usize,
    claims: JoinSet<Claimed<D::Task>>,
    limits: HashMap<Id, usize>,
    reserved: usize,
    consecutive_empty: u32,
    /// Counts the notifications the loop has observed.
    wake_version: u64,
    notification_delay_pending: bool,
    /// Set by a claim that found nothing to run. No claim starts until its deadline, or until a
    /// notification arrives after that claim started.
    empty_wait: Option<(Instant, u64)>,
    stopping: Arc<AtomicBool>,
}

impl<D: Dispatch> Dispatcher<D> {
    fn free(&self, executions: &JoinSet<Result<(), Error>>) -> usize {
        self.worker.concurrency().saturating_sub(executions.len() + self.reserved)
    }

    fn fill(&mut self, executions: &JoinSet<Result<(), Error>>) {
        loop {
            let free = self.free(executions);
            if free == 0 || (!self.claims.is_empty() && free < self.refill_batch) {
                return;
            }
            self.start_claim(free);
        }
    }

    fn start_claim(&mut self, limit: usize) {
        self.reserved += limit;
        let delayed = std::mem::take(&mut self.notification_delay_pending);
        let wake_version = self.wake_version;
        let worker = Arc::clone(&self.worker);
        let stopping = Arc::clone(&self.stopping);
        let handle = self.claims.spawn(async move {
            if delayed {
                // A short random delay spreads one notification's claims across workers.
                let spread = (random_fraction() * (MAX_NOTIFICATION_DELAY_MS + 1) as f64) as u64;
                tokio::time::sleep(Duration::from_millis(spread)).await;
                if stopping.load(Ordering::SeqCst) || worker.paused() {
                    return Claimed { wake_version, tasks: None };
                }
            }
            let tasks = worker.claim(limit).await;
            Claimed { wake_version, tasks: Some(tasks) }
        });
        self.limits.insert(handle.id(), limit);
    }

    fn settle(
        &mut self,
        result: Result<(Id, Claimed<D::Task>), JoinError>,
        executions: &mut JoinSet<Result<(), Error>>,
    ) {
        let (id, claimed) = match result {
            Ok((id, claimed)) => (id, Some(claimed)),
            Err(error) => {
                tracing::warn!(error = %error, "task claim panicked");
                (error.id(), None)
            }
        };
        self.reserved -= self.limits.remove(&id).unwrap_or(0);
        let Some(Claimed { wake_version, tasks }) = claimed else { return };
        let Some(tasks) = tasks else { return };
        // A claimed task holds a lease, so it runs even when the loop is stopping.
        let mut handled = false;
        for task in tasks {
            handled |= self.worker.launch(executions, task);
        }
        if handled {
            self.consecutive_empty = 0;
            self.empty_wait = None;
            return;
        }
        // A claim that only handed its tasks back made no progress, so it backs off like an empty
        // one. Claiming again at once would spin on a task no handler here can run.
        self.consecutive_empty = self.consecutive_empty.saturating_add(1);
        if self.empty_wait.is_none() {
            let deadline = Instant::now() + self.worker.poll_delay(self.consecutive_empty);
            self.empty_wait = Some((deadline, wake_version));
        }
    }
}

/// Claims and launches tasks until `shutdown` resolves.
///
/// Before it returns, every claim still in flight settles and its tasks join `executions`, so
/// the caller's drain covers them.
pub(super) async fn dispatch<D: Dispatch, F: Future<Output = ()>>(
    worker: &Arc<D>,
    executions: &mut JoinSet<Result<(), Error>>,
    mut shutdown: Pin<&mut F>,
    notification: &Notify,
    registry: &Notify,
    first_error: &mut Option<Error>,
) {
    let mut dispatcher = Dispatcher {
        worker: Arc::clone(worker),
        refill_batch: refill_batch(worker.concurrency()),
        claims: JoinSet::new(),
        limits: HashMap::new(),
        reserved: 0,
        consecutive_empty: 0,
        wake_version: 0,
        notification_delay_pending: false,
        empty_wait: None,
        stopping: Arc::new(AtomicBool::new(false)),
    };
    loop {
        if shutdown.as_mut().now_or_never().is_some() {
            break;
        }
        let wake_at = if worker.paused() {
            Some(Instant::now() + worker.poll_delay(dispatcher.consecutive_empty))
        } else if let Some((deadline, version)) = dispatcher.empty_wait {
            if Instant::now() >= deadline || dispatcher.wake_version != version {
                dispatcher.empty_wait = None;
                continue;
            }
            Some(deadline)
        } else {
            dispatcher.fill(executions);
            None
        };
        let timer = async move {
            match wake_at {
                Some(at) => tokio::time::sleep_until(at).await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            () = shutdown.as_mut() => break,
            Some(result) = executions.join_next() => record(result, first_error),
            Some(result) = dispatcher.claims.join_next_with_id() => {
                dispatcher.settle(result, executions);
            }
            () = timer => {}
            () = notification.notified() => {
                dispatcher.wake_version += 1;
                dispatcher.notification_delay_pending = true;
            }
            () = registry.notified() => {}
        }
    }
    dispatcher.stopping.store(true, Ordering::SeqCst);
    while let Some(result) = dispatcher.claims.join_next_with_id().await {
        dispatcher.settle(result, executions);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;

    use tokio::sync::{mpsc, oneshot};

    use super::*;

    const WAIT: Duration = Duration::from_secs(5);

    /// A claimed task. `gate` holds its handler until the test finishes it.
    struct FakeTask {
        handled: bool,
        gate: Option<oneshot::Receiver<()>>,
    }

    struct Fake {
        concurrency: usize,
        poll: Duration,
        paused: AtomicBool,
        claims: mpsc::UnboundedSender<(usize, oneshot::Sender<Vec<FakeTask>>)>,
        started: AtomicUsize,
        released: AtomicUsize,
    }

    impl Dispatch for Fake {
        type Task = FakeTask;

        fn concurrency(&self) -> usize {
            self.concurrency
        }

        fn paused(&self) -> bool {
            self.paused.load(Ordering::SeqCst)
        }

        fn poll_delay(&self, _: u32) -> Duration {
            self.poll
        }

        fn claim(&self, limit: usize) -> impl Future<Output = Vec<FakeTask>> + Send + 'static {
            let (answer, answered) = oneshot::channel();
            let _ = self.claims.send((limit, answer));
            async move { answered.await.unwrap_or_default() }
        }

        fn launch(&self, executions: &mut JoinSet<Result<(), Error>>, task: FakeTask) -> bool {
            if !task.handled {
                self.released.fetch_add(1, Ordering::SeqCst);
                executions.spawn(async { Ok(()) });
                return false;
            }
            self.started.fetch_add(1, Ordering::SeqCst);
            executions.spawn(async move {
                if let Some(gate) = task.gate {
                    let _ = gate.await;
                }
                Ok(())
            });
            true
        }
    }

    type ClaimRequest = (usize, oneshot::Sender<Vec<FakeTask>>);

    struct Harness {
        worker: Arc<Fake>,
        claims: mpsc::UnboundedReceiver<ClaimRequest>,
        notification: Arc<Notify>,
        stop: Option<oneshot::Sender<()>>,
        running: tokio::task::JoinHandle<()>,
    }

    impl Harness {
        fn start(concurrency: usize, poll: Duration, paused: bool) -> Self {
            let (sender, claims) = mpsc::unbounded_channel();
            let worker = Arc::new(Fake {
                concurrency,
                poll,
                paused: AtomicBool::new(paused),
                claims: sender,
                started: AtomicUsize::new(0),
                released: AtomicUsize::new(0),
            });
            let notification = Arc::new(Notify::new());
            let (stop, stopped) = oneshot::channel::<()>();
            let running = {
                let (worker, notification) = (Arc::clone(&worker), Arc::clone(&notification));
                tokio::spawn(async move {
                    let mut executions = JoinSet::new();
                    let mut first_error = None;
                    let registry = Notify::new();
                    let shutdown = std::pin::pin!(async move {
                        let _ = stopped.await;
                    });
                    dispatch(
                        &worker,
                        &mut executions,
                        shutdown,
                        &notification,
                        &registry,
                        &mut first_error,
                    )
                    .await;
                    while executions.join_next().await.is_some() {}
                })
            };
            Self { worker, claims, notification, stop: Some(stop), running }
        }

        async fn next_claim(&mut self) -> ClaimRequest {
            tokio::time::timeout(WAIT, self.claims.recv())
                .await
                .expect("the loop never claimed")
                .expect("the loop dropped its claim channel")
        }

        /// Stops the loop. Claims the test has not answered return nothing.
        async fn stop(mut self) -> Arc<Fake> {
            let _ = self.stop.take().expect("stopped once").send(());
            self.claims.close();
            while self.claims.try_recv().is_ok() {}
            tokio::time::timeout(WAIT, &mut self.running)
                .await
                .expect("the loop never stopped")
                .expect("the loop panicked");
            self.worker
        }
    }

    fn gated(count: usize) -> (Vec<FakeTask>, Vec<oneshot::Sender<()>>) {
        (0..count)
            .map(|_| {
                let (finish, gate) = oneshot::channel();
                (FakeTask { handled: true, gate: Some(gate) }, finish)
            })
            .unzip()
    }

    #[test]
    fn refill_batch_is_a_quarter_rounded_up() {
        assert_eq!(
            [1, 4, 5, 8, 16, 100].map(refill_batch),
            [1, 1, 2, 2, 4, 25],
            "refill batches for concurrency 1, 4, 5, 8, 16 and 100"
        );
    }

    #[tokio::test]
    async fn a_busy_worker_refills_with_overlapping_batched_claims() {
        let mut harness = Harness::start(8, Duration::from_secs(60), false);
        let (limit, answer) = harness.next_claim().await;
        assert_eq!(limit, 8);
        let (tasks, mut finishers) = gated(8);
        let _ = answer.send(tasks);

        let _ = finishers.remove(0).send(());
        let (second, held_second) = harness.next_claim().await;
        assert_eq!(second, 1);
        let _ = finishers.remove(0).send(());
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(harness.claims.try_recv().is_err(), "one free slot started a second claim");
        let _ = finishers.remove(0).send(());
        let (third, held_third) = harness.next_claim().await;
        assert_eq!(third, 2, "the refill batch at concurrency 8 is 2");

        let _ = held_second.send(Vec::new());
        let _ = held_third.send(Vec::new());
        drop(finishers);
        harness.stop().await;
    }

    #[tokio::test]
    async fn stopping_still_runs_the_tasks_of_a_claim_in_flight() {
        let mut harness = Harness::start(4, Duration::from_secs(60), false);
        let (limit, answer) = harness.next_claim().await;
        assert_eq!(limit, 4);
        let _ = harness.stop.take().expect("not stopped").send(());
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!harness.running.is_finished(), "the loop returned with a claim in flight");
        let tasks = (0..2).map(|_| FakeTask { handled: true, gate: None }).collect();
        let _ = answer.send(tasks);
        tokio::time::timeout(WAIT, &mut harness.running)
            .await
            .expect("the loop never stopped")
            .expect("the loop panicked");
        assert_eq!(harness.worker.started.load(Ordering::SeqCst), 2);
        assert!(harness.claims.try_recv().is_err(), "the loop claimed after the stop");
    }

    #[tokio::test]
    async fn a_paused_worker_starts_no_claim() {
        let mut harness = Harness::start(4, Duration::from_millis(10), true);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(harness.claims.try_recv().is_err(), "a paused worker claimed");
        harness.worker.paused.store(false, Ordering::SeqCst);
        let (limit, answer) = harness.next_claim().await;
        assert_eq!(limit, 4);
        let _ = answer.send(Vec::new());
        harness.stop().await;
    }

    #[tokio::test]
    async fn an_empty_claim_waits_for_the_poll_interval() {
        let poll = Duration::from_millis(200);
        let mut harness = Harness::start(2, poll, false);
        let (_, answer) = harness.next_claim().await;
        let answered = Instant::now();
        let _ = answer.send(Vec::new());
        let (_, answer) = harness.next_claim().await;
        let waited = answered.elapsed();
        assert!(waited >= poll, "the next claim came {waited:?} after an empty one");
        let _ = answer.send(Vec::new());
        harness.stop().await;
    }

    #[tokio::test]
    async fn a_notification_ends_the_empty_wait() {
        let mut harness = Harness::start(2, Duration::from_secs(60), false);
        let (_, answer) = harness.next_claim().await;
        let _ = answer.send(Vec::new());
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(harness.claims.try_recv().is_err(), "an empty claim did not wait");
        harness.notification.notify_one();
        let (_, answer) = harness.next_claim().await;
        let _ = answer.send(Vec::new());
        harness.stop().await;
    }

    #[tokio::test]
    async fn a_claim_of_only_unhandled_tasks_counts_as_empty() {
        let poll = Duration::from_millis(300);
        let mut harness = Harness::start(4, poll, false);
        let (_, answer) = harness.next_claim().await;
        let _ = answer.send(vec![FakeTask { handled: false, gate: None }]);
        tokio::time::sleep(poll / 2).await;
        assert!(harness.claims.try_recv().is_err(), "an unhandled claim claimed again at once");
        let worker = harness.stop().await;
        assert_eq!(worker.released.load(Ordering::SeqCst), 1);
        assert_eq!(worker.started.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_claim_that_ran_a_handler_claims_again_at_once() {
        let mut harness = Harness::start(2, Duration::from_secs(60), false);
        let (_, answer) = harness.next_claim().await;
        let _ = answer.send(vec![FakeTask { handled: true, gate: None }]);
        let (_, answer) = harness.next_claim().await;
        let _ = answer.send(Vec::new());
        let worker = harness.stop().await;
        assert_eq!(worker.started.load(Ordering::SeqCst), 1);
    }
}
