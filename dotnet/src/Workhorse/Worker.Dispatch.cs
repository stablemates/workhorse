using System.Text.Json;
using Workhorse.Internal;
using Workhorse.Internal.Database;
using Workhorse.Internal.Runtime;

namespace Workhorse;

public sealed partial class Worker
{
    private const long MaxEmptyPollMs = 5_000;
    private const int NotificationClaimDelayMs = 50;
    private static readonly JsonElement JsonNull = JsonDocument.Parse("null").RootElement.Clone();

    /// <summary>
    /// Guards the slot accounting, which handler tasks share with the dispatch loop. A slot is busy
    /// while its task is admitted, and reserved while a claim for it is in flight. The accounting
    /// outlives a run, so a handler that an incomplete stop abandoned keeps its slot in the next run.
    /// </summary>
    private readonly Lock _stateLock = new();
    private int _busy;
    private int _reserved;
    private long _nextQueue;
    private int _notified;
    private volatile Listener.Subscription? _listener;

    /// <summary>Whether the latest run's listener listens now. A test reads it.</summary>
    internal bool ListeningForTests => _listener is { IsListening: true };

    /// <summary>One plain claim and the slots that it reserved.</summary>
    private sealed record ClaimPlan(int Limit);

    /// <summary>What one claim returned.</summary>
    private sealed record ClaimResult(ClaimPlan Plan, List<Claimed> Claimed, long WakeVersion, Exception? Error);

    /// <summary>One claimed task, its payload text, and the monotonic time that its claim left.</summary>
    private sealed record Claimed(ClaimedTask Task, string Payload, long StartedAt);

    /// <summary>The claims that started and have not answered. A test reads it.</summary>
    internal int ClaimsInFlight;

    /// <summary>The claims that have answered. A test reads it to know that a claim found nothing.</summary>
    internal int ClaimsAnswered;

    private int FreeSlots => Concurrency - _busy - _reserved;

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

                    await _wake.WaitAsync(LoopWait(DispatchWait(empty, listener), continuous, run)).ConfigureAwait(false);
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

                await _wake.WaitAsync(LoopWait(DispatchWait(empty, listener), continuous, run)).ConfigureAwait(false);
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
            while (inFlight > 0)
            {
                if (!run.Results.TryDequeue(out var result))
                {
                    var remaining = claimDeadline - Monotonic.Now();
                    if (remaining <= 0)
                    {
                        WorkerLog.ClaimsAbandoned(_logger, inFlight);
                        CloseClaims(run);
                        ReleaseLateClaims(run);
                        break;
                    }

                    _wake.Reset();
                    if (run.Results.IsEmpty)
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
                _reserved += plan.Limit;
            }

            return plan;
        }
    }

    /// <summary>Plans the next claim, or returns <c>null</c>. The caller holds the state lock.</summary>
    private ClaimPlan? Plan(int inFlight, RunState run)
    {
        var free = FreeSlots;
        if (free <= 0 || !run.GateOpen || (inFlight > 0 && free < _refillBatch))
        {
            return null;
        }

        return new ClaimPlan(free);
    }

    /// <summary>Admits the tasks that one claim returned, and records whether it made progress.</summary>
    private void SettleClaim(ClaimResult result, RunState run)
    {
        lock (_stateLock)
        {
            _reserved -= result.Plan.Limit;
            // A claimed task holds a lease, so it runs even when the loop stops or failed.
            foreach (var claimed in result.Claimed)
            {
                Admit(claimed, run);
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
            run.EmptyWait = new EmptyWait(Monotonic.Now() + DispatchWait(run.Empty, run.Listener), null);
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
        var deadline = Monotonic.Now() + DispatchWait(run.Empty, run.Listener);
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
                    await ClaimAcrossQueuesAsync(run, plan.Limit, claimed).ConfigureAwait(false);
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
    /// keeps the leases already taken. The gate is read again before each queue.
    /// </summary>
    private async Task ClaimAcrossQueuesAsync(RunState run, int limit, List<Claimed> claimed)
    {
        var start = (int)(Interlocked.Increment(ref _nextQueue) % _queues.Length);
        for (var offset = 0; offset < _queues.Length && claimed.Count < limit && run.GateOpen; offset++)
        {
            var queue = _queues[(start + offset) % _queues.Length];
            // The local lease window starts when the claim goes out, after the wait for the pool, so a
            // slow pool cannot spend the lease before PostgreSQL grants it.
            var startedAt = 0L;
            IReadOnlyList<Row> rows = [];
            var permitted = false;
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
                if (permitted)
                {
                    run.ReleaseClaimPermit();
                }
            }

            claimed.AddRange(rows.Select(row => new Claimed(ClaimedTaskOf(row, queue), row.Text("payload") ?? "null", startedAt)));
        }
    }

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
    /// backs off exponentially while claims come back empty.
    /// </summary>
    private long DispatchWait(int empty, Listener.Subscription? listener)
    {
        long milliseconds;
        if (listener is { IsListening: true })
        {
            milliseconds = _notificationPollMs;
        }
        else
        {
            var doublings = Math.Min(Math.Max(0, empty - 1), 20);
            milliseconds = Math.Min(MaxEmptyPollMs, _pollMs << doublings);
        }

        milliseconds = Math.Max(1, (long)Math.Round(milliseconds * (0.9 + (0.2 * Random.Shared.NextDouble()))));
        if (_registryMs > 0)
        {
            milliseconds = Math.Min(milliseconds, _registryMs);
        }

        return Monotonic.Millis(milliseconds);
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
                _reserved -= late.Plan.Limit;
            }
        }
    }
}
