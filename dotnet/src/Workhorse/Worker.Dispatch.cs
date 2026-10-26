using System.Collections.Concurrent;
using System.Text.Json;
using Workhorse.Internal;
using Workhorse.Internal.Database;
using Workhorse.Internal.Runtime;
using Workhorse.Internal.Telemetry;

namespace Workhorse;

public sealed partial class Worker
{
    private const long MaxEmptyPollMs = 5_000;
    private const int NotificationClaimDelayMs = 50;
    private static readonly JsonElement JsonNull = JsonDocument.Parse("null").RootElement.Clone();

    /// <summary>The cohort of a plain claim that fills the whole worker.</summary>
    private const int Whole = -1;

    /// <summary>
    /// Guards the slot accounting, the queue tiers, and the claim order, which handler tasks share
    /// with the dispatch loop and with fast-tier completions.
    /// </summary>
    private readonly Lock _stateLock = new();

    /// <summary>The claim order that dispatch gave each admitted task. A batch coordinator sorts by it.</summary>
    private readonly ConcurrentDictionary<(Guid TaskId, long FenceToken), long> _claimOrder = new();
    private Slots? _slotState;
    private long _dispatchSequence;
    private long _nextQueue;
    private int _notified;
    private volatile Listener.Subscription? _listener;

    /// <summary>Whether the latest run's listener listens now. A test reads it.</summary>
    internal bool ListeningForTests => _listener is { IsListening: true };

    /// <summary>The slot accounting. It outlives a run, so a handler that an incomplete stop abandoned keeps its slot.</summary>
    private Slots SlotState => _slotState ??= new Slots(Concurrency, _refillBatch, Cohorts);

    /// <summary>
    /// One plain claim: its limit, its cohort (<see cref="Whole"/> for the whole worker), and the
    /// slots that it reserved in that cohort.
    /// </summary>
    private sealed record ClaimPlan(int Limit, int Cohort, int CohortLimit);

    /// <summary>What one claim returned.</summary>
    private sealed record ClaimResult(ClaimPlan Plan, List<Claimed> Claimed, long WakeVersion, Exception? Error);

    /// <summary>
    /// One claimed task, its payload text, the monotonic time that its claim left, and whether a
    /// fast-tier statement claimed it. Only such a task completes through the fused statement.
    /// </summary>
    private sealed record Claimed(ClaimedTask Task, string Payload, long StartedAt, bool FastClaimed = false);

    /// <summary>The claims that started and have not answered. A test reads it.</summary>
    internal int ClaimsInFlight;

    /// <summary>The claims that have answered. A test reads it to know that a claim found nothing.</summary>
    internal int ClaimsAnswered;

    /// <summary>
    /// Keeps the slots full without one serial claim round trip for each task (ADR 0076). A claim
    /// reserves the slots that it asks for, so claimed tasks never exceed the concurrency. With no
    /// claim in flight, any free slot starts one. While one is in flight, another starts only once the
    /// free slots reach the refill batch.
    /// </summary>
    private async Task<bool> DispatchAsync(bool continuous, RunState run, Listener.Subscription? listener)
    {
        lock (_stateLock)
        {
            run.Listener = listener;
        }

        _listener = listener;

        var inFlight = 0;
        try
        {
            while (true)
            {
                _wake.Reset();
                while (run.Results.TryDequeue(out var result))
                {
                    inFlight--;
                    SettleClaim(result, run);
                }

                RefreshRegistrationIfDue(run);
                Exception? claimError;
                bool passEnded;
                int empty;
                EmptyWait? emptyWait;
                lock (_stateLock)
                {
                    claimError = run.ClaimError;
                    passEnded = run.PassEnded;
                    empty = run.Empty;
                    emptyWait = run.EmptyWait;
                }

                if (StopRequested(run) || !run.Errors.IsEmpty || claimError is not null || !run.MaintenanceErrors.IsEmpty)
                {
                    break;
                }

                if (!continuous && passEnded)
                {
                    break;
                }

                if (continuous)
                {
                    // Maintenance does not depend on free slots or on a pause: a worker whose
                    // handlers hold every slot still ticks, fires its schedules, and offers the
                    // retention routines (ADR 0072, ADR 0078).
                    StartMaintenance(run);
                }

                if (IsPaused)
                {
                    if (!continuous)
                    {
                        break;
                    }

                    // A pause ends the empty wait, so a resume claims at once.
                    lock (_stateLock)
                    {
                        run.EmptyWait = null;
                    }

                    await _wake.WaitAsync(LoopWait(DispatchWait(run), continuous, run)).ConfigureAwait(false);
                    continue;
                }

                if (emptyWait is not null)
                {
                    var remaining = emptyWait.Deadline - Monotonic.Now();
                    if (remaining <= 0 || (emptyWait.Version is { } seen && seen != _wake.Version))
                    {
                        lock (_stateLock)
                        {
                            if (ReferenceEquals(run.EmptyWait, emptyWait))
                            {
                                run.EmptyWait = null;
                            }
                        }
                    }
                    else
                    {
                        await _wake.WaitAsync(LoopWait(remaining, continuous, run)).ConfigureAwait(false);
                    }

                    continue;
                }

                if (!run.GateOpen)
                {
                    // The claim gate is closed. A pass of RunOnceAsync ends here. A long run waits for
                    // the replacement connection, whose arrival wakes this loop, and its maintenance
                    // still runs.
                    if (!continuous)
                    {
                        break;
                    }

                    StartMaintenance(run);
                }
                else if (PlanClaim(inFlight, run) is not null)
                {
                    if (continuous)
                    {
                        StartMaintenance(run);
                    }
                    else if (!await StepAsync(RunMaintenanceIfDueAsync, run, "maintenance").ConfigureAwait(false))
                    {
                        break;
                    }

                    var wakeVersion = _wake.Version;
                    while (ReserveClaim(inFlight, run) is { } plan)
                    {
                        inFlight++;
                        StartClaim(plan, wakeVersion, empty > 0, run);
                    }
                }

                await _wake.WaitAsync(LoopWait(DispatchWait(run), continuous, run)).ConfigureAwait(false);
            }
        }
        finally
        {
            run.Deadline = ShutdownDeadline(run);
            // Tasks that an in-flight claim returns hold leases, so they run before the drain. The
            // wait lasts one unwind window at least, so a zero grace still takes a claim that is about
            // to return. A claim that returns later is not run: its leases expire.
            var now = Monotonic.Now();
            var claimDeadline = Math.Min(now + Math.Max(run.Deadline - now, UnwindWindowNanos), run.Deadline + UnwindWindowNanos);
            // A fused claim of a fast-tier completion holds leases too, so the wait covers it.
            while (inFlight > 0 || Volatile.Read(ref run.FusedClaims) > 0)
            {
                if (!run.Results.TryDequeue(out var result))
                {
                    var remaining = claimDeadline - Monotonic.Now();
                    if (remaining <= 0)
                    {
                        WorkerLog.ClaimsAbandoned(_logger, inFlight + Volatile.Read(ref run.FusedClaims));
                        CloseClaims(run);
                        ReleaseLateClaims(run);
                        break;
                    }

                    _wake.Reset();
                    if (run.Results.IsEmpty && (inFlight > 0 || Volatile.Read(ref run.FusedClaims) > 0))
                    {
                        await _wake.WaitAsync(Math.Min(remaining, IdleCheckNanos)).ConfigureAwait(false);
                    }

                    continue;
                }

                inFlight--;
                SettleClaim(result, run);
            }

            CloseClaims(run);
        }

        lock (_stateLock)
        {
            if (run.ClaimError is { } error)
            {
                throw error;
            }

            return run.ClaimedAny;
        }
    }

    /// <summary>
    /// The wait of one dispatch pass, which ends when the next maintenance tick falls due. A pass
    /// that still runs wakes the loop when it ends, so the wait does not shorten for it.
    /// </summary>
    private long LoopWait(long wait, bool continuous, RunState run)
    {
        if (!continuous || run.Maintenance is { IsCompleted: false })
        {
            return wait;
        }

        var last = Interlocked.Read(ref _maintenanceAt);
        var due = last == Never ? 0 : last + Monotonic.Millis(_maintenanceMs) - Monotonic.Now();
        return Math.Min(wait, Math.Max(Monotonic.Millis(1), due));
    }

    private ClaimPlan? PlanClaim(int inFlight, RunState run)
    {
        lock (_stateLock)
        {
            return Plan(inFlight, run);
        }
    }

    /// <summary>Plans the next claim and reserves its slots under one lock.</summary>
    private ClaimPlan? ReserveClaim(int inFlight, RunState run)
    {
        lock (_stateLock)
        {
            var plan = Plan(inFlight, run);
            if (plan is not null)
            {
                SlotState.Reserve(plan);
            }

            return plan;
        }
    }

    /// <summary>
    /// Plans the next plain claim, or returns <c>null</c>. With one cohort, or while a queue answers
    /// on the full tier, a claim takes every free slot of the worker (ADR 0076, rules 1 to 9 and 15).
    /// Otherwise one claim at a time leaves, for the roomiest cohort (rule 14). The caller holds the
    /// state lock.
    /// </summary>
    private ClaimPlan? Plan(int inFlight, RunState run)
    {
        var slots = SlotState;
        var free = slots.Free;
        if (free <= 0 || !run.GateOpen)
        {
            return null;
        }

        if (Cohorts == 1 || _fullTierUntil.Count > 0)
        {
            return inFlight > 0 && free < _refillBatch ? null : new ClaimPlan(free, Whole, free);
        }

        if (inFlight > 0)
        {
            return null;
        }

        var cohort = slots.Roomiest();
        var cohortLimit = Math.Min(free, slots.CohortFree(cohort));
        if (_queues.All(_fastTierQueues.Contains))
        {
            return cohortLimit > 0 ? new ClaimPlan(cohortLimit, cohort, cohortLimit) : null;
        }

        // A claim that still has to learn a queue's tier reserves every free slot, so a queue that
        // answers on the full tier fills them all.
        return new ClaimPlan(free, cohort, Math.Max(0, cohortLimit));
    }

    /// <summary>
    /// Gives a claimed task a slot and a handler task. The caller holds the state lock, so the slot
    /// and the reservation that it came from change together. The task joins
    /// <paramref name="cohort"/> while that cohort has a free slot, and the roomiest cohort
    /// otherwise. A claimed task always runs, even after a stop or a pause, because its lease is
    /// already held.
    /// </summary>
    private void Admit(Claimed claimed, int cohort, RunState run)
    {
        var slots = SlotState;
        var chosen = cohort == Whole || slots.CohortFree(cohort) <= 0 ? slots.Roomiest() : cohort;
        slots.Busy[chosen]++;
        slots.BusyTotal++;
        // Dispatch assigns the claim order here. A batch coordinator cannot read the arrival order off
        // its own lock, because handler tasks reach that lock in thread-pool order.
        _claimOrder[(claimed.Task.Id, claimed.Task.FenceToken)] = _dispatchSequence++;
        var task = new Active(claimed, run) { Cohort = chosen };
        _active[task] = 0;
        _ = Task.Run(() => RunClaimedTaskAsync(task));
    }

    /// <summary>Frees the slot of an attempt that ended or never started.</summary>
    private void ReleaseSlot(Active task)
    {
        lock (_stateLock)
        {
            var slots = SlotState;
            slots.Busy[task.Cohort]--;
            slots.BusyTotal--;
            if (task.HandedOver)
            {
                task.HandedOver = false;
                slots.HandedOver[task.Cohort]--;
                slots.HandedOverTotal--;
            }

            _claimOrder.TryRemove((task.Task.Id, task.Task.FenceToken), out _);
        }

        LeaveBatch(task.Task);
    }

    /// <summary>Admits the tasks that one claim returned, and records whether it made progress.</summary>
    private void SettleClaim(ClaimResult result, RunState run)
    {
        lock (_stateLock)
        {
            SlotState.Unreserve(result.Plan);
            // A claimed task holds a lease, so it runs even when the loop stops or failed.
            foreach (var claimed in result.Claimed)
            {
                Admit(claimed, result.Plan.Cohort, run);
            }

            SettleClaimProgress(run, result.Claimed, result.WakeVersion, result.Error);
        }
    }

    /// <summary>Records whether a claim made progress. The caller holds the state lock.</summary>
    private void SettleClaimProgress(RunState run, List<Claimed> claimed, long wakeVersion, Exception? error)
    {
        if (error is IsolationLevelException isolation)
        {
            // The data source runs above read committed. The worker logs it and claims again later.
            WorkerLog.ClaimIsolation(_logger, isolation.IsolationLevel);
            run.Empty++;
            run.EmptyWait = new EmptyWait(Monotonic.Now() + DispatchWait(run), null);
            return;
        }

        if (error is not null)
        {
            run.ClaimError ??= error;
            return;
        }

        if (claimed.Any(task => HasHandler(task.Task.Type)))
        {
            run.Empty = 0;
            run.ClaimedAny = true;
            run.EmptyWait = null;
            return;
        }

        // A claim that only handed its tasks back made no progress, so it backs off as an empty claim
        // does instead of spinning on a task that no handler here runs.
        run.Empty++;
        run.PassEnded = true;
        var deadline = Monotonic.Now() + DispatchWait(run);
        if (claimed.Count == 0)
        {
            run.EmptyWait ??= new EmptyWait(deadline, wakeVersion);
        }
        else if (run.EmptyWait is null || run.EmptyWait.Version is not null)
        {
            // A release wait. Each release notifies the queue, so a wake does not end this wait.
            run.EmptyWait = new EmptyWait(deadline, null);
        }
    }

    private bool HasHandler(string taskType)
    {
        lock (_handlers)
        {
            return _handlers.ContainsKey(taskType);
        }
    }

    /// <summary>Runs one claim on the thread pool. The dispatch loop already reserved its slots.</summary>
    private void StartClaim(ClaimPlan plan, long wakeVersion, bool backingOff, RunState run)
    {
        // The notification delay spreads idle workers that one notification woke together. A worker
        // whose last claim found work would claim now anyway, so it skips the delay (SM-933).
        var delayed = Interlocked.Exchange(ref _notified, 0) == 1 && backingOff;
        Interlocked.Increment(ref ClaimsInFlight);
        _ = Task.Run(async () =>
        {
            var claimed = new List<Claimed>();
            Exception? error = null;
            try
            {
                if (delayed)
                {
                    await Task.Delay(Random.Shared.Next(NotificationClaimDelayMs + 1)).ConfigureAwait(false);
                }

                // A worker paused or stopped during the delay sends no claim, and nor does a run whose
                // claim gate closed.
                var withdrawn = (delayed && (StopRequested(run) || IsPaused)) || !run.GateOpen;
                if (!withdrawn)
                {
                    await ClaimAcrossQueuesAsync(run, plan.Limit, claimed, plan.Cohort == Whole ? plan.Limit : plan.CohortLimit)
                        .ConfigureAwait(false);
                }
            }
            catch (Exception failure)
            {
                error = failure;
            }
            finally
            {
                Interlocked.Decrement(ref ClaimsInFlight);
                Interlocked.Increment(ref ClaimsAnswered);
                run.Results.Enqueue(new ClaimResult(plan, claimed, wakeVersion, error));
                _wake.Signal();
                if (!run.ClaimsOpen)
                {
                    ReleaseLateClaims(run);
                }
            }
        });
    }

    /// <summary>
    /// Claims from each queue at most once, one queue further on each call. A later queue's error
    /// keeps the leases already taken. The gate is read again before each queue. Fast-tier queues
    /// together give at most <paramref name="fastLimit"/> tasks, the free slots of one cohort.
    /// </summary>
    private async Task ClaimAcrossQueuesAsync(RunState run, int limit, List<Claimed> claimed, int fastLimit)
    {
        var start = (int)(Interlocked.Increment(ref _nextQueue) % _queues.Length);
        for (var offset = 0; offset < _queues.Length && claimed.Count < limit && run.GateOpen; offset++)
        {
            var queue = _queues[(start + offset) % _queues.Length];
            using var span = WorkerTelemetry.StartClaim(queue);
            var probedAt = Monotonic.Now();
            if (await ClaimFastAsync(run, queue, Math.Min(limit, fastLimit) - claimed.Count).ConfigureAwait(false) is { } fast)
            {
                WorkerTelemetry.Claimed(span, queue, probedAt, fast, 0, static entry => entry.Task, fullTier: false);
                claimed.AddRange(fast);
                continue;
            }

            // The local lease window starts when the claim goes out, after the wait for the pool, so a
            // slow pool cannot spend the lease before PostgreSQL grants it.
            var startedAt = 0L;
            IReadOnlyList<Row> rows = [];
            var permitted = false;
            var watch = WatchStatement("claim");
            try
            {
                await using var connection = await DataSources.OpenAsync(_dataSource, CancellationToken.None).ConfigureAwait(false);
                // The gate is read again on the open connection, just before the claim goes out,
                // because the heartbeat can lose its connection while the open waits for the pool.
                permitted = run.AcquireClaimPermit();
                if (permitted)
                {
                    startedAt = Monotonic.Now();
                    rows = await Sql.RowsAsync(
                            connection,
                            SqlCatalogue.ClaimManyV1,
                            [Parameters.Text(queue), Parameters.Text(WorkerId), Parameters.Integer(limit - claimed.Count), Parameters.Integer(_leaseMs)],
                            CancellationToken.None)
                        .ConfigureAwait(false);
                }
            }
            finally
            {
                watch?.Dispose();
                if (permitted)
                {
                    run.ReleaseClaimPermit();
                }
            }

            var first = claimed.Count;
            claimed.AddRange(rows.Select(row => ClaimedOf(row, queue, startedAt, fastClaimed: false)));
            if (permitted)
            {
                // The claim duration starts at the probe, so it holds a rejected fast probe and the
                // wait for the pool, as on the JVM. The lease window starts at startedAt.
                WorkerTelemetry.Claimed(span, queue, probedAt, claimed, first, static entry => entry.Task, fullTier: true);
            }
        }
    }

    private static Claimed ClaimedOf(Row row, string queue, long startedAt, bool fastClaimed) =>
        new(ClaimedTaskOf(row, queue), row.Text("payload") ?? "null", startedAt, fastClaimed);

    private static ClaimedTask ClaimedTaskOf(Row row, string queue) => new()
    {
        Id = row.RequiredUuid("task_id"),
        Queue = queue,
        Type = row.RequiredText("task_type"),
        Priority = row.RequiredInteger("priority"),
        Payload = row.Json("payload") ?? JsonNull,
        ContractVersion = row.Text("contract_version"),
        ResultMaxBytes = row.Long("result_max_bytes"),
        RedactErrorDetails = row.Boolean("redact_error_details") ?? false,
        TraceContext = row.Json("trace_context"),
        Attempt = row.RequiredInteger("attempt"),
        MaxAttempts = row.RequiredInteger("max_attempts"),
        RetryPolicy = row.Json("retry_policy"),
        DeadlineAt = row.Instant("deadline_at"),
        ExecutionTimeout = row.Long("execution_timeout_ms") is { } timeout ? TimeSpan.FromMilliseconds(timeout) : null,
        AttemptTimeoutAt = row.Instant("attempt_timeout_at"),
        FenceToken = row.RequiredLong("fence_token"),
        LeaseExpiresAt = row.Instant("lease_expires_at"),
    };

    private void NotifyWake()
    {
        Interlocked.Exchange(ref _notified, 1);
        _wake.Bump();
    }

    /// <summary>
    /// The wait before the next claim. A listening worker waits for a notification; a polling worker
    /// backs off exponentially while claims come back empty. When the subscription is lost, the
    /// backoff restarts: the empty claims of the live period do not count.
    /// </summary>
    private long DispatchWait(RunState run)
    {
        bool listening;
        int empty;
        lock (_stateLock)
        {
            listening = run.Listener is { IsListening: true };
            if (!listening && run.ListenedAtLastWait)
            {
                run.Empty = Math.Min(run.Empty, 1);
            }

            run.ListenedAtLastWait = listening;
            empty = run.Empty;
        }

        return Monotonic.Millis(DispatchWaitMillis(
            listening, empty, _pollMs, _notificationPollMs, _registryMs, 0.9 + (0.2 * Random.Shared.NextDouble())));
    }

    /// <summary>
    /// The wait after an empty claim, in milliseconds (ADR 0112). With a live subscription it is the
    /// notification base, without backoff or cap, so an explicit poll interval keeps its value.
    /// Without one, the base doubles for each empty claim after the first, up to the 5,000 ms cap.
    /// Then the jitter factor applies, and a registered worker cuts the wait to its registry
    /// interval, because it refreshes the registry from the dispatch loop.
    /// </summary>
    internal static long DispatchWaitMillis(
        bool listening, int empty, long pollMs, long notificationPollMs, long registryMs, double jitter)
    {
        long milliseconds;
        if (listening)
        {
            milliseconds = notificationPollMs;
        }
        else
        {
            var doublings = Math.Min(Math.Max(0, empty - 1), 20);
            milliseconds = Math.Min(MaxEmptyPollMs, pollMs << doublings);
        }

        milliseconds = Math.Max(1, (long)Math.Round(milliseconds * jitter));
        if (registryMs > 0)
        {
            milliseconds = Math.Min(milliseconds, registryMs);
        }

        return milliseconds;
    }

    /// <summary>Ends the claims of <paramref name="run"/>.</summary>
    private void CloseClaims(RunState run)
    {
        lock (_stateLock)
        {
            run.ClaimsOpen = false;
        }
    }

    /// <summary>
    /// Gives back the slots of claims that returned after the stop abandoned them. Their tasks do not
    /// run: their leases expire. Each result is dequeued once, so its slots go back once.
    /// </summary>
    private void ReleaseLateClaims(RunState run)
    {
        while (run.Results.TryDequeue(out var late))
        {
            lock (_stateLock)
            {
                SlotState.Unreserve(late.Plan);
            }
        }
    }

    /// <summary>
    /// The worker's slot accounting, which the dispatch loop and fast-tier completions share. Every
    /// field changes under the state lock. A slot is busy while its task is admitted, reserved while a
    /// claim for it is in flight, and handed over once a completion claimed a task into it. A
    /// handed-over slot counts as free, because the task that fills it is already admitted. On the
    /// fast tier the slots split into cohorts (ADR 0076, rule 10).
    /// </summary>
    private sealed class Slots
    {
        internal Slots(int concurrency, int refillBatch, int cohorts)
        {
            Concurrency = concurrency;
            RefillBatch = refillBatch;
            // The first cohorts take the remainder, so sizes differ by at most one slot.
            Capacity = [.. Enumerable.Range(0, cohorts).Select(cohort => (concurrency / cohorts) + (cohort < concurrency % cohorts ? 1 : 0))];
            Busy = new int[cohorts];
            HandedOver = new int[cohorts];
            Reserved = new int[cohorts];
            Claims = new int[cohorts];
        }

        internal int Concurrency { get; }

        internal int RefillBatch { get; }

        internal int[] Capacity { get; }

        internal int[] Busy { get; }

        internal int[] HandedOver { get; }

        internal int[] Reserved { get; }

        /// <summary>The plain claims in flight for each cohort.</summary>
        internal int[] Claims { get; }

        internal int BusyTotal { get; set; }

        internal int HandedOverTotal { get; set; }

        internal int ReservedTotal { get; set; }

        /// <summary>The plain claims in flight for the whole worker.</summary>
        internal int WholeClaims { get; set; }

        internal int Free => Concurrency - BusyTotal + HandedOverTotal - ReservedTotal;

        internal int CohortFree(int cohort) => Capacity[cohort] - Busy[cohort] + HandedOver[cohort] - Reserved[cohort];

        /// <summary>The cohort with the most free slots, the lowest index on a tie.</summary>
        internal int Roomiest()
        {
            var best = 0;
            for (var cohort = 1; cohort < Capacity.Length; cohort++)
            {
                if (CohortFree(cohort) > CohortFree(best))
                {
                    best = cohort;
                }
            }

            return best;
        }

        internal void Reserve(ClaimPlan plan)
        {
            ReservedTotal += plan.Limit;
            if (plan.Cohort == Whole)
            {
                WholeClaims++;
            }
            else
            {
                Claims[plan.Cohort]++;
                Reserved[plan.Cohort] += plan.CohortLimit;
            }
        }

        internal void Unreserve(ClaimPlan plan)
        {
            ReservedTotal -= plan.Limit;
            if (plan.Cohort == Whole)
            {
                WholeClaims--;
            }
            else
            {
                Claims[plan.Cohort]--;
                Reserved[plan.Cohort] -= plan.CohortLimit;
            }
        }
    }
}
