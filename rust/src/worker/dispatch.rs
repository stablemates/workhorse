//! The dispatch loop, which keeps a worker's slots full without one serial claim per task.
//!
//! ADR 0076 describes the design. A claim reserves the slots it asks for, so claimed tasks never
//! exceed the concurrency. With no claim in flight, any free slot starts one. While one is in
//! flight, another starts only once the unreserved free slots reach the refill batch, so a busy
//! worker claims in batches and its claims overlap. Starting a claim never blocks the loop.
//!
//! A fast-tier task that completes can claim its successors in the same statement. It reserves
//! that fused claim through its [`Ticket`] and hands its own slot over to the tasks it claims.
//! With more than one cohort, the slots split into cohorts, and a fused claim fills only its own
//! cohort (rules 10 to 15).
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::FutureExt;
use tokio::sync::{mpsc, Notify};
use tokio::task::{Id, JoinError, JoinSet};
use tokio::time::Instant;

use super::{lock, random_fraction, record, MAX_NOTIFICATION_DELAY_MS};
use crate::Error;

/// What the dispatch loop needs from a worker. The unit tests substitute a fake.
pub(super) trait Dispatch: Send + Sync + 'static {
    type Task: Send + 'static;

    fn concurrency(&self) -> usize;
    fn cohorts(&self) -> usize;
    fn queue_count(&self) -> usize;
    fn paused(&self) -> bool;
    /// Whether no queue is full-tier, so claims can fill one cohort at a time.
    fn fast_tier_only(&self) -> bool;
    /// Whether every queue answered its last claim on the fast tier.
    fn tiers_known(&self) -> bool;
    /// The wait after `consecutive_empty` claims found nothing to run.
    fn poll_delay(&self, consecutive_empty: u32) -> Duration;
    /// Claims up to `limit` tasks, at most `fast_limit` of them from fast-tier queues. A failed
    /// claim reports it and returns what it leased first.
    fn claim(
        &self,
        limit: usize,
        fast_limit: usize,
    ) -> impl Future<Output = Vec<Self::Task>> + Send + 'static;
    /// Starts one claimed task, which holds `ticket` until it ends, and returns whether a
    /// registered handler runs it.
    fn launch(
        &self,
        executions: &mut JoinSet<Result<(), Error>>,
        task: Self::Task,
        ticket: Ticket<Self::Task>,
    ) -> bool;
}

/// Free slots that let a second claim start while one is in flight: a quarter of the concurrency,
/// rounded up.
pub(super) fn refill_batch(concurrency: usize) -> usize {
    concurrency.div_ceil(4)
}

/// The slots of each cohort: the concurrency split evenly, with the remainder going to the first
/// cohorts.
pub(super) fn cohort_capacities(concurrency: usize, cohorts: usize) -> Vec<usize> {
    let cohorts = cohorts.clamp(1, concurrency.max(1));
    (0..cohorts)
        .map(|index| concurrency / cohorts + usize::from(index < concurrency % cohorts))
        .collect()
}

#[derive(Default)]
struct Cohort {
    capacity: usize,
    /// Tasks holding a ticket in this cohort.
    active: usize,
    /// Active tasks whose slot a fused claim has taken over.
    handed_over: usize,
    reserved: usize,
    /// Plain claims in flight for this cohort.
    claims: usize,
}

impl Cohort {
    fn free(&self) -> isize {
        self.capacity as isize - self.active as isize + self.handed_over as isize
            - self.reserved as isize
    }
}

/// The slot accounting the loop and the fused claims of running tasks share.
struct Slots {
    concurrency: usize,
    refill_batch: usize,
    cohorts: Vec<Cohort>,
    reserved: usize,
    /// Plain claims in flight that fill any cohort.
    whole_claims: usize,
    stopping: bool,
    /// Mirrors the loop's empty wait: no fused claim starts while it lasts.
    waiting: bool,
    wake_version: u64,
    /// Fused claims reserved and not yet handed to the loop.
    fused: usize,
}

impl Slots {
    fn free(&self) -> isize {
        let (active, handed_over) =
            self.cohorts.iter().fold((0, 0), |(active, handed_over), cohort| {
                (active + cohort.active, handed_over + cohort.handed_over)
            });
        self.concurrency as isize - active as isize + handed_over as isize - self.reserved as isize
    }

    /// The cohort with the most free slots, the first on a tie.
    fn roomiest(&self) -> usize {
        let mut best = 0;
        for (index, cohort) in self.cohorts.iter().enumerate() {
            if cohort.free() > self.cohorts[best].free() {
                best = index;
            }
        }
        best
    }

    /// Places a claimed task in `preferred` when it has room, and otherwise in the roomiest
    /// cohort.
    fn assign(&mut self, preferred: Option<usize>) -> usize {
        let cohort = match preferred {
            Some(cohort) if self.cohorts[cohort].free() > 0 => cohort,
            _ => self.roomiest(),
        };
        self.cohorts[cohort].active += 1;
        cohort
    }
}

/// A claim that finished outside the loop, and the tasks it hands to the loop to launch.
struct Handoff<T: Send + 'static> {
    tasks: Option<Vec<(T, Ticket<T>)>>,
    wake_version: u64,
}

struct Shared<T: Send + 'static> {
    slots: Mutex<Slots>,
    handoffs: mpsc::UnboundedSender<Handoff<T>>,
    paused: Box<dyn Fn() -> bool + Send + Sync>,
}

/// A running task's hold on its slot. Dropping it frees the slot.
pub(super) struct Ticket<T: Send + 'static> {
    shared: Arc<Shared<T>>,
    cohort: usize,
    handed_over: AtomicBool,
}

impl<T: Send + 'static> Ticket<T> {
    fn new(shared: &Arc<Shared<T>>, cohort: usize) -> Self {
        Self { shared: Arc::clone(shared), cohort, handed_over: AtomicBool::new(false) }
    }

    /// Reserves a fused claim for this task's completion, or returns `None` when the task should
    /// complete without one (ADR 0076, rules 3, 12 and 14).
    ///
    /// The claim may fill the free slots of the task's cohort plus the slot the task hands over.
    /// While a plain claim that can fill that cohort is in flight, it claims only when that
    /// would fill at least a refill batch. A paused worker starts no claim.
    pub(super) fn reserve(&self) -> Option<Reservation<'_, T>> {
        if (self.shared.paused)() {
            return None;
        }
        let mut slots = lock(&self.shared.slots);
        if slots.stopping || slots.waiting || self.handed_over.load(Ordering::SeqCst) {
            return None;
        }
        let cohort = &slots.cohorts[self.cohort];
        let limit = (slots.free().min(cohort.free()) + 1).max(0) as usize;
        if (slots.whole_claims > 0 || cohort.claims > 0) && limit < slots.refill_batch {
            return None;
        }
        slots.reserved += limit;
        slots.cohorts[self.cohort].reserved += limit;
        slots.cohorts[self.cohort].handed_over += 1;
        self.handed_over.store(true, Ordering::SeqCst);
        slots.fused += 1;
        Some(Reservation { ticket: self, limit, wake_version: slots.wake_version, settled: false })
    }
}

impl<T: Send + 'static> Drop for Ticket<T> {
    fn drop(&mut self) {
        let mut slots = lock(&self.shared.slots);
        let cohort = &mut slots.cohorts[self.cohort];
        cohort.active -= 1;
        if *self.handed_over.get_mut() {
            cohort.handed_over -= 1;
        }
    }
}

/// The slots a fused claim holds until it settles.
pub(super) struct Reservation<'a, T: Send + 'static> {
    ticket: &'a Ticket<T>,
    limit: usize,
    wake_version: u64,
    settled: bool,
}

impl<T: Send + 'static> Reservation<'_, T> {
    /// The most tasks the fused claim may take.
    pub(super) fn limit(&self) -> usize {
        self.limit
    }

    /// The cohort the claimed tasks join.
    pub(super) fn cohort(&self) -> usize {
        self.ticket.cohort
    }

    /// Returns the reserved slots and hands the claimed tasks to the loop. `None` means the claim
    /// failed. Returns whether it claimed a task, so the completed task's slot now belongs to
    /// the claimed tasks.
    pub(super) fn settle(mut self, claimed: Option<Vec<T>>) -> bool {
        self.settled = true;
        self.finish(claimed)
    }

    fn finish(&mut self, claimed: Option<Vec<T>>) -> bool {
        let shared = &self.ticket.shared;
        let cohort = self.ticket.cohort;
        let handed_over = claimed.as_ref().is_some_and(|tasks| !tasks.is_empty());
        let unsent = {
            let mut slots = lock(&shared.slots);
            slots.reserved -= self.limit;
            slots.cohorts[cohort].reserved -= self.limit;
            if !handed_over {
                slots.cohorts[cohort].handed_over -= 1;
                self.ticket.handed_over.store(false, Ordering::SeqCst);
            }
            let tasks = claimed.map(|tasks| {
                tasks
                    .into_iter()
                    .map(|task| (task, Ticket::new(shared, slots.assign(Some(cohort)))))
                    .collect()
            });
            let handoff = Handoff { tasks, wake_version: self.wake_version };
            // The loop sees this handoff before it sees the count fall, so it drains every
            // claimed task at stop.
            let unsent = shared.handoffs.send(handoff).err();
            slots.fused -= 1;
            unsent
        };
        // A ticket locks the slots when it drops.
        drop(unsent);
        handed_over
    }
}

impl<T: Send + 'static> Drop for Reservation<'_, T> {
    fn drop(&mut self) {
        if !self.settled {
            self.finish(None);
        }
    }
}

/// A finished claim. `tasks` is `None` when the loop stopped or paused during the notification
/// delay, so no claim was sent.
struct Claimed<T> {
    wake_version: u64,
    tasks: Option<Vec<T>>,
}

/// The slots a plain claim reserved: `limit` in total, and `cohort_limit` in `cohort` when it
/// fills one cohort.
struct PlainClaim {
    limit: usize,
    cohort: Option<usize>,
    cohort_limit: usize,
}

struct Dispatcher<D: Dispatch> {
    worker: Arc<D>,
    shared: Arc<Shared<D::Task>>,
    handoffs: mpsc::UnboundedReceiver<Handoff<D::Task>>,
    claims: JoinSet<Claimed<D::Task>>,
    plain: HashMap<Id, PlainClaim>,
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
    fn new(worker: &Arc<D>) -> Self {
        let concurrency = worker.concurrency();
        let cohorts = cohort_capacities(concurrency, worker.cohorts())
            .into_iter()
            .map(|capacity| Cohort { capacity, ..Cohort::default() })
            .collect();
        let (sender, handoffs) = mpsc::unbounded_channel();
        let slots = Slots {
            concurrency,
            refill_batch: refill_batch(concurrency),
            cohorts,
            reserved: 0,
            whole_claims: 0,
            stopping: false,
            waiting: false,
            wake_version: 0,
            fused: 0,
        };
        Self {
            worker: Arc::clone(worker),
            shared: Arc::new(Shared {
                slots: Mutex::new(slots),
                handoffs: sender,
                paused: Box::new({
                    let worker = Arc::clone(worker);
                    move || worker.paused()
                }),
            }),
            handoffs,
            claims: JoinSet::new(),
            plain: HashMap::new(),
            consecutive_empty: 0,
            wake_version: 0,
            notification_delay_pending: false,
            empty_wait: None,
            stopping: Arc::new(AtomicBool::new(false)),
        }
    }

    fn set_empty_wait(&mut self, empty_wait: Option<(Instant, u64)>) {
        self.empty_wait = empty_wait;
        lock(&self.shared.slots).waiting = empty_wait.is_some();
    }

    fn fill(&mut self) {
        let cohort_dispatch = self.shared_cohorts() > 1 && self.worker.fast_tier_only();
        if cohort_dispatch {
            // Only a fast-tier completion refills its cohort, so one plain claim at a time fills
            // the roomiest cohort (rule 15).
            let (free, cohort, cohort_free) = {
                let slots = lock(&self.shared.slots);
                let cohort = slots.roomiest();
                (slots.free(), cohort, slots.cohorts[cohort].free())
            };
            if self.claims.is_empty() && free > 0 {
                let cohort_limit = free.min(cohort_free).max(0) as usize;
                // Until every queue has answered on the fast tier, a full-tier queue may fill
                // any free slot.
                let limit = if self.worker.tiers_known() { cohort_limit } else { free as usize };
                if limit > 0 {
                    self.start_claim(limit, Some(cohort), cohort_limit);
                }
            }
            return;
        }
        loop {
            let (free, refill_batch) = {
                let slots = lock(&self.shared.slots);
                (slots.free(), slots.refill_batch as isize)
            };
            if free <= 0 || (!self.claims.is_empty() && free < refill_batch) {
                return;
            }
            self.start_claim(free as usize, None, free as usize);
        }
    }

    fn shared_cohorts(&self) -> usize {
        lock(&self.shared.slots).cohorts.len()
    }

    fn start_claim(&mut self, limit: usize, cohort: Option<usize>, cohort_limit: usize) {
        {
            let mut slots = lock(&self.shared.slots);
            slots.reserved += limit;
            match cohort {
                Some(cohort) => {
                    slots.cohorts[cohort].claims += 1;
                    slots.cohorts[cohort].reserved += cohort_limit;
                }
                None => slots.whole_claims += 1,
            }
        }
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
            let tasks = worker.claim(limit, cohort_limit).await;
            Claimed { wake_version, tasks: Some(tasks) }
        });
        self.plain.insert(handle.id(), PlainClaim { limit, cohort, cohort_limit });
    }

    /// Places each claimed task in a cohort and launches it, and reports whether a handler runs
    /// any of them.
    fn launch(
        &self,
        tasks: Vec<D::Task>,
        cohort: Option<usize>,
        executions: &mut JoinSet<Result<(), Error>>,
    ) -> bool {
        let mut handled = false;
        for task in tasks {
            let assigned = lock(&self.shared.slots).assign(cohort);
            let ticket = Ticket::new(&self.shared, assigned);
            handled |= self.worker.launch(executions, task, ticket);
        }
        handled
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
        let cohort = self.plain.remove(&id).and_then(|claim| {
            let mut slots = lock(&self.shared.slots);
            slots.reserved -= claim.limit;
            match claim.cohort {
                Some(cohort) => {
                    slots.cohorts[cohort].claims -= 1;
                    slots.cohorts[cohort].reserved -= claim.cohort_limit;
                }
                None => slots.whole_claims -= 1,
            }
            claim.cohort
        });
        let Some(Claimed { wake_version, tasks }) = claimed else { return };
        let Some(tasks) = tasks else { return };
        // A claimed task holds a lease, so it runs even when the loop is stopping.
        if self.launch(tasks, cohort, executions) {
            self.consecutive_empty = 0;
            self.set_empty_wait(None);
            return;
        }
        // A claim that only handed its tasks back made no progress, so it backs off like an empty
        // one. Claiming again at once would spin on a task no handler here can run.
        self.back_off(wake_version);
    }

    /// Launches the tasks a fused claim handed over.
    fn receive(&mut self, handoff: Handoff<D::Task>, executions: &mut JoinSet<Result<(), Error>>) {
        let Some(tasks) = handoff.tasks else { return };
        let empty = tasks.is_empty();
        let mut handled = false;
        for (task, ticket) in tasks {
            handled |= self.worker.launch(executions, task, ticket);
        }
        if handled {
            self.consecutive_empty = 0;
        } else if empty && self.worker.queue_count() == 1 {
            // Another queue may still have work, so only a single-queue worker backs off here.
            self.back_off(handoff.wake_version);
        }
    }

    fn back_off(&mut self, wake_version: u64) {
        self.consecutive_empty = self.consecutive_empty.saturating_add(1);
        if self.empty_wait.is_none() {
            let deadline = Instant::now() + self.worker.poll_delay(self.consecutive_empty);
            self.set_empty_wait(Some((deadline, wake_version)));
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
    let mut dispatcher = Dispatcher::new(worker);
    loop {
        if shutdown.as_mut().now_or_never().is_some() {
            break;
        }
        let wake_at = if worker.paused() {
            Some(Instant::now() + worker.poll_delay(dispatcher.consecutive_empty))
        } else if let Some((deadline, version)) = dispatcher.empty_wait {
            if Instant::now() >= deadline || dispatcher.wake_version != version {
                dispatcher.set_empty_wait(None);
                continue;
            }
            Some(deadline)
        } else {
            dispatcher.fill();
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
            Some(handoff) = dispatcher.handoffs.recv() => dispatcher.receive(handoff, executions),
            () = timer => {}
            () = notification.notified() => {
                dispatcher.wake_version += 1;
                lock(&dispatcher.shared.slots).wake_version = dispatcher.wake_version;
                dispatcher.notification_delay_pending = true;
            }
            () = registry.notified() => {}
        }
    }
    dispatcher.stopping.store(true, Ordering::SeqCst);
    lock(&dispatcher.shared.slots).stopping = true;
    while let Some(result) = dispatcher.claims.join_next_with_id().await {
        dispatcher.settle(result, executions);
    }
    // A fused claim reserved before the stop still hands its tasks over, and they run.
    loop {
        let settled = lock(&dispatcher.shared.slots).fused == 0;
        if settled {
            while let Ok(handoff) = dispatcher.handoffs.try_recv() {
                dispatcher.receive(handoff, executions);
            }
            return;
        }
        let Some(handoff) = dispatcher.handoffs.recv().await else { return };
        dispatcher.receive(handoff, executions);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;

    use tokio::sync::{mpsc, oneshot};

    use super::*;

    const WAIT: Duration = Duration::from_secs(5);

    /// A claimed task. `gate` holds its handler until the test finishes it. A `fuse` task then
    /// completes on the fast tier and asks for a fused claim.
    struct FakeTask {
        handled: bool,
        fuse: bool,
        gate: Option<oneshot::Receiver<()>>,
    }

    impl FakeTask {
        fn ready() -> Self {
            Self { handled: true, fuse: false, gate: None }
        }
    }

    /// A fused claim the fake reports: the limit it reserved, or `None` when it was refused, and
    /// its cohort. The test answers with the claimed tasks, or `None` for a failed claim.
    struct FusedRequest {
        limit: Option<usize>,
        cohort: usize,
        answer: oneshot::Sender<Option<Vec<FakeTask>>>,
    }

    struct Fake {
        concurrency: usize,
        cohorts: usize,
        queue_count: usize,
        fast_tier_only: AtomicBool,
        tiers_known: AtomicBool,
        poll: Duration,
        paused: AtomicBool,
        claims: mpsc::UnboundedSender<ClaimRequest>,
        fused: mpsc::UnboundedSender<FusedRequest>,
        started: Arc<AtomicUsize>,
        released: AtomicUsize,
    }

    impl Dispatch for Fake {
        type Task = FakeTask;

        fn concurrency(&self) -> usize {
            self.concurrency
        }

        fn cohorts(&self) -> usize {
            self.cohorts
        }

        fn queue_count(&self) -> usize {
            self.queue_count
        }

        fn paused(&self) -> bool {
            self.paused.load(Ordering::SeqCst)
        }

        fn fast_tier_only(&self) -> bool {
            self.fast_tier_only.load(Ordering::SeqCst)
        }

        fn tiers_known(&self) -> bool {
            self.tiers_known.load(Ordering::SeqCst)
        }

        fn poll_delay(&self, _: u32) -> Duration {
            self.poll
        }

        fn claim(
            &self,
            limit: usize,
            fast_limit: usize,
        ) -> impl Future<Output = Vec<FakeTask>> + Send + 'static {
            let (answer, answered) = oneshot::channel();
            let _ = self.claims.send((limit, fast_limit, answer));
            async move { answered.await.unwrap_or_default() }
        }

        fn launch(
            &self,
            executions: &mut JoinSet<Result<(), Error>>,
            task: FakeTask,
            ticket: Ticket<FakeTask>,
        ) -> bool {
            if !task.handled {
                self.released.fetch_add(1, Ordering::SeqCst);
                executions.spawn(async move {
                    drop(ticket);
                    Ok(())
                });
                return false;
            }
            self.started.fetch_add(1, Ordering::SeqCst);
            let fused = self.fused.clone();
            executions.spawn(async move {
                if let Some(gate) = task.gate {
                    let _ = gate.await;
                }
                if task.fuse {
                    let reservation = ticket.reserve();
                    let (answer, answered) = oneshot::channel();
                    let _ = fused.send(FusedRequest {
                        limit: reservation.as_ref().map(Reservation::limit),
                        cohort: ticket.cohort,
                        answer,
                    });
                    if let Some(reservation) = reservation {
                        reservation.settle(answered.await.unwrap_or_default());
                    }
                }
                drop(ticket);
                Ok(())
            });
            true
        }
    }

    type ClaimRequest = (usize, usize, oneshot::Sender<Vec<FakeTask>>);

    struct Harness {
        worker: Arc<Fake>,
        claims: mpsc::UnboundedReceiver<ClaimRequest>,
        fused: mpsc::UnboundedReceiver<FusedRequest>,
        notification: Arc<Notify>,
        stop: Option<oneshot::Sender<()>>,
        running: tokio::task::JoinHandle<()>,
    }

    struct Setup {
        concurrency: usize,
        cohorts: usize,
        queue_count: usize,
        fast_tier_only: bool,
        tiers_known: bool,
        poll: Duration,
        paused: bool,
    }

    impl Default for Setup {
        fn default() -> Self {
            Self {
                concurrency: 1,
                cohorts: 1,
                queue_count: 1,
                fast_tier_only: true,
                tiers_known: true,
                poll: Duration::from_secs(60),
                paused: false,
            }
        }
    }

    impl Harness {
        fn start_plain(concurrency: usize, poll: Duration, paused: bool) -> Self {
            Self::start(Setup { concurrency, poll, paused, ..Setup::default() })
        }

        fn start(setup: Setup) -> Self {
            let (sender, claims) = mpsc::unbounded_channel();
            let (fused_sender, fused) = mpsc::unbounded_channel();
            let worker = Arc::new(Fake {
                concurrency: setup.concurrency,
                cohorts: setup.cohorts,
                queue_count: setup.queue_count,
                fast_tier_only: AtomicBool::new(setup.fast_tier_only),
                tiers_known: AtomicBool::new(setup.tiers_known),
                poll: setup.poll,
                paused: AtomicBool::new(setup.paused),
                claims: sender,
                fused: fused_sender,
                started: Arc::new(AtomicUsize::new(0)),
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
            Self { worker, claims, fused, notification, stop: Some(stop), running }
        }

        async fn next_claim(&mut self) -> ClaimRequest {
            tokio::time::timeout(WAIT, self.claims.recv())
                .await
                .expect("the loop never claimed")
                .expect("the loop dropped its claim channel")
        }

        async fn next_fused(&mut self) -> FusedRequest {
            tokio::time::timeout(WAIT, self.fused.recv())
                .await
                .expect("no task completed")
                .expect("the fake dropped its fused channel")
        }

        /// Stops the loop. Claims the test has not answered return nothing.
        async fn stop(mut self) -> Arc<Fake> {
            let _ = self.stop.take().expect("stopped once").send(());
            self.claims.close();
            while self.claims.try_recv().is_ok() {}
            self.fused.close();
            while self.fused.try_recv().is_ok() {}
            tokio::time::timeout(WAIT, &mut self.running)
                .await
                .expect("the loop never stopped")
                .expect("the loop panicked");
            self.worker
        }
    }

    fn gated(count: usize) -> (Vec<FakeTask>, Vec<oneshot::Sender<()>>) {
        gated_with(count, false)
    }

    fn gated_with(count: usize, fuse: bool) -> (Vec<FakeTask>, Vec<oneshot::Sender<()>>) {
        (0..count)
            .map(|_| {
                let (finish, gate) = oneshot::channel();
                (FakeTask { handled: true, fuse, gate: Some(gate) }, finish)
            })
            .unzip()
    }

    async fn settled() {
        tokio::time::sleep(Duration::from_millis(50)).await;
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
        let mut harness = Harness::start_plain(8, Duration::from_secs(60), false);
        let (limit, _, answer) = harness.next_claim().await;
        assert_eq!(limit, 8);
        let (tasks, mut finishers) = gated(8);
        let _ = answer.send(tasks);

        let _ = finishers.remove(0).send(());
        let (second, _, held_second) = harness.next_claim().await;
        assert_eq!(second, 1);
        let _ = finishers.remove(0).send(());
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(harness.claims.try_recv().is_err(), "one free slot started a second claim");
        let _ = finishers.remove(0).send(());
        let (third, _, held_third) = harness.next_claim().await;
        assert_eq!(third, 2, "the refill batch at concurrency 8 is 2");

        let _ = held_second.send(Vec::new());
        let _ = held_third.send(Vec::new());
        drop(finishers);
        harness.stop().await;
    }

    #[tokio::test]
    async fn stopping_still_runs_the_tasks_of_a_claim_in_flight() {
        let mut harness = Harness::start_plain(4, Duration::from_secs(60), false);
        let (limit, _, answer) = harness.next_claim().await;
        assert_eq!(limit, 4);
        let _ = harness.stop.take().expect("not stopped").send(());
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!harness.running.is_finished(), "the loop returned with a claim in flight");
        let tasks = (0..2).map(|_| FakeTask::ready()).collect();
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
        let mut harness = Harness::start_plain(4, Duration::from_millis(10), true);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(harness.claims.try_recv().is_err(), "a paused worker claimed");
        harness.worker.paused.store(false, Ordering::SeqCst);
        let (limit, _, answer) = harness.next_claim().await;
        assert_eq!(limit, 4);
        let _ = answer.send(Vec::new());
        harness.stop().await;
    }

    #[tokio::test]
    async fn an_empty_claim_waits_for_the_poll_interval() {
        let poll = Duration::from_millis(200);
        let mut harness = Harness::start_plain(2, poll, false);
        let (_, _, answer) = harness.next_claim().await;
        let answered = Instant::now();
        let _ = answer.send(Vec::new());
        let (_, _, answer) = harness.next_claim().await;
        let waited = answered.elapsed();
        assert!(waited >= poll, "the next claim came {waited:?} after an empty one");
        let _ = answer.send(Vec::new());
        harness.stop().await;
    }

    #[tokio::test]
    async fn a_notification_ends_the_empty_wait() {
        let mut harness = Harness::start_plain(2, Duration::from_secs(60), false);
        let (_, _, answer) = harness.next_claim().await;
        let _ = answer.send(Vec::new());
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(harness.claims.try_recv().is_err(), "an empty claim did not wait");
        harness.notification.notify_one();
        let (_, _, answer) = harness.next_claim().await;
        let _ = answer.send(Vec::new());
        harness.stop().await;
    }

    #[tokio::test]
    async fn a_claim_of_only_unhandled_tasks_counts_as_empty() {
        let poll = Duration::from_millis(300);
        let mut harness = Harness::start_plain(4, poll, false);
        let (_, _, answer) = harness.next_claim().await;
        let _ = answer.send(vec![FakeTask { handled: false, ..FakeTask::ready() }]);
        tokio::time::sleep(poll / 2).await;
        assert!(harness.claims.try_recv().is_err(), "an unhandled claim claimed again at once");
        let worker = harness.stop().await;
        assert_eq!(worker.released.load(Ordering::SeqCst), 1);
        assert_eq!(worker.started.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_claim_that_ran_a_handler_claims_again_at_once() {
        let mut harness = Harness::start_plain(2, Duration::from_secs(60), false);
        let (_, _, answer) = harness.next_claim().await;
        let _ = answer.send(vec![FakeTask::ready()]);
        let (_, _, answer) = harness.next_claim().await;
        let _ = answer.send(Vec::new());
        let worker = harness.stop().await;
        assert_eq!(worker.started.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn cohorts_split_the_concurrency_with_the_remainder_first() {
        assert_eq!(cohort_capacities(8, 1), [8]);
        assert_eq!(cohort_capacities(16, 2), [8, 8]);
        assert_eq!(cohort_capacities(10, 3), [4, 3, 3]);
        assert_eq!(cohort_capacities(100, 8), [13, 13, 13, 13, 12, 12, 12, 12]);
        assert_eq!(cohort_capacities(3, 3), [1, 1, 1]);
    }

    #[tokio::test]
    async fn plain_claims_fill_one_cohort_at_a_time() {
        let mut harness = Harness::start(Setup { concurrency: 16, cohorts: 2, ..Setup::default() });
        let (limit, fast_limit, answer) = harness.next_claim().await;
        assert_eq!((limit, fast_limit), (8, 8), "the first claim fills cohort 0");
        let (tasks, first) = gated(8);
        let _ = answer.send(tasks);
        let (limit, fast_limit, answer) = harness.next_claim().await;
        assert_eq!((limit, fast_limit), (8, 8), "the second claim fills cohort 1");
        let (tasks, second) = gated(8);
        let _ = answer.send(tasks);
        drop((first, second));
        harness.stop().await;
    }

    #[tokio::test]
    async fn a_full_tier_queue_disables_cohort_claims() {
        let mut harness = Harness::start(Setup {
            concurrency: 16,
            cohorts: 2,
            fast_tier_only: false,
            ..Setup::default()
        });
        let (limit, fast_limit, answer) = harness.next_claim().await;
        assert_eq!((limit, fast_limit), (16, 16), "a full-tier queue fills the whole worker");
        let _ = answer.send(Vec::new());
        harness.stop().await;

        let mut harness = Harness::start(Setup {
            concurrency: 16,
            cohorts: 2,
            tiers_known: false,
            ..Setup::default()
        });
        let (limit, fast_limit, answer) = harness.next_claim().await;
        assert_eq!(
            (limit, fast_limit),
            (16, 8),
            "an unprobed queue may fill any slot, and a fast-tier one only the cohort"
        );
        let _ = answer.send(Vec::new());
        harness.stop().await;
    }

    #[tokio::test]
    async fn a_fused_claim_fills_only_the_free_slots_of_its_cohort() {
        let mut harness = Harness::start(Setup {
            concurrency: 16,
            cohorts: 2,
            queue_count: 2,
            ..Setup::default()
        });
        let (_, _, answer) = harness.next_claim().await;
        let (tasks, mut fused) = gated_with(8, true);
        let _ = answer.send(tasks);
        let (_, _, answer) = harness.next_claim().await;
        let (tasks, mut plain) = gated(8);
        let _ = answer.send(tasks);

        // Cohort 1 frees a slot, which a plain claim reserves, and then frees one more.
        let _ = plain.remove(0).send(());
        let (limit, _, held) = harness.next_claim().await;
        assert_eq!(limit, 1);
        let _ = plain.remove(0).send(());
        settled().await;

        let _ = fused.remove(0).send(());
        let request = harness.next_fused().await;
        assert_eq!(request.cohort, 0);
        assert_eq!(
            request.limit,
            Some(1),
            "cohort 0 has no free slot, so only the completed task's slot refills"
        );
        let _ = request.answer.send(Some(vec![FakeTask::ready()]));
        settled().await;
        assert_eq!(harness.worker.started.load(Ordering::SeqCst), 17);

        let _ = held.send(Vec::new());
        drop((fused, plain));
        harness.stop().await;
    }

    #[tokio::test]
    async fn a_fused_claim_below_the_refill_batch_waits_for_a_plain_claim_in_flight() {
        let mut harness =
            Harness::start(Setup { concurrency: 8, queue_count: 2, ..Setup::default() });
        let (limit, _, answer) = harness.next_claim().await;
        assert_eq!(limit, 8);
        let (tasks, mut fused) = gated_with(8, true);
        let _ = answer.send(tasks);

        let _ = fused.remove(0).send(());
        let request = harness.next_fused().await;
        assert_eq!(request.limit, Some(1), "a full worker with no claim in flight fuses");
        let _ = request.answer.send(Some(Vec::new()));

        // The claim found nothing, so the freed slot starts a plain claim.
        let (limit, _, held) = harness.next_claim().await;
        assert_eq!(limit, 1);
        let _ = fused.remove(0).send(());
        let request = harness.next_fused().await;
        assert_eq!(request.limit, None, "one slot is below the refill batch of 2");

        let _ = held.send(Vec::new());
        drop(fused);
        harness.stop().await;
    }

    #[tokio::test]
    async fn a_paused_worker_starts_no_fused_claim() {
        let mut harness = Harness::start(Setup { concurrency: 2, ..Setup::default() });
        let (_, _, answer) = harness.next_claim().await;
        let (tasks, mut fused) = gated_with(2, true);
        let _ = answer.send(tasks);
        settled().await;
        harness.worker.paused.store(true, Ordering::SeqCst);
        let _ = fused.remove(0).send(());
        let request = harness.next_fused().await;
        assert_eq!(request.limit, None);
        drop(fused);
        harness.stop().await;
    }

    #[tokio::test]
    async fn stopping_runs_the_tasks_of_a_fused_claim_in_flight() {
        let mut harness = Harness::start(Setup { concurrency: 2, ..Setup::default() });
        let (_, _, answer) = harness.next_claim().await;
        let (tasks, mut fused) = gated_with(2, true);
        let _ = answer.send(tasks);
        let _ = fused.remove(0).send(());
        let request = harness.next_fused().await;
        assert_eq!(request.limit, Some(1));

        let _ = harness.stop.take().expect("not stopped").send(());
        settled().await;
        assert!(!harness.running.is_finished(), "the loop returned with a fused claim in flight");
        let _ = request.answer.send(Some(vec![FakeTask::ready()]));
        let _ = fused.remove(0).send(());
        let request = harness.next_fused().await;
        assert_eq!(request.limit, None, "a stopping worker starts no fused claim");
        tokio::time::timeout(WAIT, &mut harness.running)
            .await
            .expect("the loop never stopped")
            .expect("the loop panicked");
        assert_eq!(harness.worker.started.load(Ordering::SeqCst), 3);
        assert!(harness.claims.try_recv().is_err(), "the loop claimed after the stop");
    }
}
