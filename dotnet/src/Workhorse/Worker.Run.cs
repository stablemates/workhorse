using System.Collections.Concurrent;
using System.Runtime.ExceptionServices;
using Npgsql;
using Workhorse.Internal;
using Workhorse.Internal.Database;
using Workhorse.Internal.Runtime;
using Workhorse.Internal.Telemetry;

namespace Workhorse;

public sealed partial class Worker
{
    private const long Never = long.MinValue;

    /// <summary>The unwind window after the shutdown grace (ADR 0107, "Shutdown").</summary>
    private static readonly long UnwindWindowNanos = Monotonic.Millis(250);

    private static readonly long IdleCheckNanos = Monotonic.Millis(50);

    /// <summary>The floor of the startup budget <c>max(heartbeat, 5 s)</c> (ADR 0071, rule 3).</summary>
    private const long StartupBudgetFloorMs = 5_000;

    /// <summary>The wait for the listener to give its connection back, inside the total stop time.</summary>
    private static readonly long ListenerCloseNanos = Monotonic.Millis(200);

    private readonly Lock _registryLock = new();
    private long _generation;
    private bool _registered;
    private Task _registryWrite = Task.CompletedTask;
    private long _lastRegistryAt = Never;
    private long _maintenanceAt = Never;
    private long _routineAt = Never;
    private Guid _instanceId = Guid.NewGuid();
    private volatile bool _draining;

    /// <summary>The state of one run that handler and claim tasks share with the dispatch loop.</summary>
    private sealed class RunState(long version, long generation)
    {
        private readonly Lock _permitLock = new();
        private int _claimPermits;

        internal long Version { get; } = version;

        internal long Generation { get; } = generation;

        internal ConcurrentQueue<Exception> Errors { get; } = new();

        internal ConcurrentQueue<Exception> MaintenanceErrors { get; } = new();

        internal ConcurrentQueue<ClaimResult> Results { get; } = new();

        /// <summary>
        /// Cancelled at the end of the stop. The settlements of the run's attempts use it, never the
        /// handler's token (ADR 0107, "Cancellation and statements").
        /// </summary>
        internal CancellationTokenSource StopPath { get; } = new();

        /// <summary>False once the dispatch loop stops its wait for the claims in flight.</summary>
        internal volatile bool ClaimsOpen = true;

        /// <summary>True once an attempt of this run failed in the worker's own code.</summary>
        internal volatile bool Failed;

        /// <summary>The heartbeat reservation of the run. The claim gate reads it.</summary>
        internal volatile Heartbeat.Reservation? Reservation;

        internal volatile bool Ended;

        // The dispatch progress of the run. It changes under the state lock.
        internal Listener.Subscription? Listener;
        internal int Empty;
        internal EmptyWait? EmptyWait;
        internal bool PassEnded;
        internal bool ClaimedAny;
        internal Exception? ClaimError;
        internal Task? Maintenance;

        /// <summary>The fused claims of fast-tier completions in flight. It changes under the state lock.</summary>
        internal int FusedClaims;

        /// <summary>The end of the shutdown grace, or 0 until the run stops claiming.</summary>
        internal long Deadline;

        /// <summary>
        /// The claim gate of the run: open while the run has not ended, the stop has not abandoned
        /// its claims, and its own heartbeat reservation holds a usable connection (ADR 0071, rule 6).
        /// </summary>
        internal bool GateOpen => !Ended && ClaimsOpen && Reservation is { Connected: true };

        /// <summary>
        /// Takes a claim permit when the gate is open. The check and the permit are one step, so a
        /// run that ends after the check keeps its reservation until the claim settles.
        /// </summary>
        internal bool AcquireClaimPermit()
        {
            lock (_permitLock)
            {
                if (!GateOpen)
                {
                    return false;
                }

                _claimPermits++;
                return true;
            }
        }

        internal void ReleaseClaimPermit()
        {
            Heartbeat.Reservation? close = null;
            lock (_permitLock)
            {
                _claimPermits--;
                if (Ended && _claimPermits == 0)
                {
                    close = Reservation;
                }
            }

            close?.Dispose();
        }

        /// <summary>
        /// Ends the run's hold on its reservation, and closes the gate. With a claim permit active,
        /// the last permit closes the reservation when its statement settles. Nothing waits for that.
        /// </summary>
        internal void EndReservation()
        {
            Heartbeat.Reservation? close;
            lock (_permitLock)
            {
                Ended = true;
                if (_claimPermits > 0)
                {
                    return;
                }

                close = Reservation;
            }

            close?.Dispose();
        }
    }

    /// <summary>An empty-claim wait. A <c>null</c> version marks a release wait, which a wake does not end.</summary>
    private sealed record EmptyWait(long Deadline, long? Version);

    private bool StopRequested(long version) => Interlocked.Read(ref _stopVersion) != version;

    private bool StopRequested(RunState run) => run.Failed || StopRequested(run.Version);

    private async Task<bool> RunLoopAsync(bool continuous, long version)
    {
        try
        {
            return await RunLoopOnceAsync(continuous, version).ConfigureAwait(false);
        }
        finally
        {
            // The deadline belongs to this run's stop.
            Interlocked.Exchange(ref _stopDeadline, Never);
        }
    }

    private RunState StartRun(long version)
    {
        lock (_registryLock)
        {
            _registered = false;
            _remotelyPaused = false;
            return new RunState(version, Interlocked.Increment(ref _generation));
        }
    }

    private async Task<bool> RunLoopOnceAsync(bool continuous, long version)
    {
        if (!StopRequested(version))
        {
            Interlocked.Exchange(ref _stopDeadline, Never);
        }

        var run = StartRun(version);
        // ADR 0071 rule 3: within one startup budget, the worker reserves the heartbeat connection,
        // and then borrows one ordinary connection for the compatibility query. The listener starts
        // between the two steps, and its wait uses none of the budget.
        var listens = continuous && !_pollingOnly && PoolLendsListener();
        var startupDeadline = Monotonic.Now() + Monotonic.Millis(Math.Max(_heartbeatMs, StartupBudgetFloorMs));
        if (await ReserveHeartbeatAsync(run, startupDeadline, listens).ConfigureAwait(false) is null)
        {
            return false;
        }

        Listener.Subscription? listener = null;
        var ready = false;
        try
        {
            if (listens)
            {
                var failed = 0;
                listener = Listener.Shared(_dataSource).Subscribe(
                    _queues,
                    NotifyWake,
                    error =>
                    {
                        Volatile.Write(ref failed, 1);
                        OnNotificationError(error);
                    },
                    Monotonic.Millis(_notificationPollMs));
                var listenerStart = Monotonic.Now();
                await AwaitListenerAsync(listener, () => Volatile.Read(ref failed) == 1, run, startupDeadline).ConfigureAwait(false);
                startupDeadline += Monotonic.Now() - listenerStart;
            }

            ready = await CheckReadinessAsync(run, startupDeadline, listens).ConfigureAwait(false);
        }
        finally
        {
            if (!ready)
            {
                if (listener is not null)
                {
                    await listener.CloseAsync(Monotonic.Now()).ConfigureAwait(false);
                }

                run.EndReservation();
            }
        }

        if (!ready)
        {
            return false;
        }

        if (continuous && !_pollingOnly && listener is null)
        {
            WorkerLog.PollingOnly(_logger, WorkerId);
        }

        _instanceId = Guid.NewGuid();
        _draining = false;
        bool claimedAny;
        int abandoned;
        try
        {
            await StepAsync(() => RegistryStep(() => RefreshRegistrationAsync(force: true, run.Generation)), run, "registration").ConfigureAwait(false);
            WorkerLog.Started(_logger, Concurrency, _queueText);
            if (continuous && !StopRequested(run))
            {
                // ADR 0078: a long-running worker starts its first claim beside its startup maintenance.
                StartMaintenance(run);
            }

            claimedAny = await DispatchAsync(continuous, run, listener).ConfigureAwait(false);
        }
        finally
        {
            if (run.Deadline == 0)
            {
                run.Deadline = ShutdownDeadline(run);
            }

            // The total stop time is the grace plus one unwind window. Every wait below ends by then.
            var end = run.Deadline + UnwindWindowNanos;
            if (run.Maintenance is { } maintenance)
            {
                await JoinUntilAsync(maintenance, run.Deadline, "maintenance").ConfigureAwait(false);
            }

            if (listener is not null)
            {
                await listener.CloseAsync(Math.Min(end, Monotonic.Now() + ListenerCloseNanos)).ConfigureAwait(false);
            }

            try
            {
                _draining = true;
                await JoinUntilAsync(RegistryStep(() => RefreshRegistrationAsync(force: true, run.Generation)), run.Deadline, "draining registration")
                    .ConfigureAwait(false);
                abandoned = await DrainAsync(run, run.Deadline, end).ConfigureAwait(false);
            }
            finally
            {
                run.EndReservation();
            }

            // The deregistration waits for the draining registration, so a late registration cannot
            // recreate the row of a stopped worker.
            var stoppedInstance = _instanceId;
            await JoinUntilAsync(RegistryStep(() => DeregisterAsync(run.Generation, stoppedInstance)), end, "deregistration").ConfigureAwait(false);
            // The cancellation can contact PostgreSQL's cancel endpoint for a settlement that still
            // waits, so its wait ends with the total stop time too, and nothing waits for it after.
            await JoinUntilAsync(run.StopPath.CancelAsync(), end, "settlement cancellation").ConfigureAwait(false);
            WorkerLog.Stopped(_logger, _queueText, abandoned);
        }

        if (abandoned > 0)
        {
            throw new ShutdownIncompleteException(abandoned);
        }

        if (run.MaintenanceErrors.TryPeek(out var maintenanceError))
        {
            ExceptionDispatchInfo.Throw(maintenanceError);
        }

        if (run.Errors.TryPeek(out var error))
        {
            ExceptionDispatchInfo.Throw(error);
        }

        return claimedAny;
    }

    /// <summary>
    /// Whether the pool can lend the shared listener a connection (SM-1585). Under the opt-out, the
    /// listener starts only on a pool of a known size of at least 2.
    /// </summary>
    private bool PoolLendsListener() => !_sharedHeartbeats || _poolMaxSize >= 2;

    private static string StartupBudgetText(bool listens) =>
        (listens
            ? " All workers on one NpgsqlDataSource share one heartbeat connection and one listener connection, so the pool needs at least 3 connections: the listener, the heartbeat, and one for each statement in flight."
            : " All workers on one NpgsqlDataSource share one heartbeat connection, so the pool needs at least 2 connections: the heartbeat and one for each statement in flight.")
        + " Make the pool larger, or set SharedHeartbeats to open a connection for each heartbeat round.";

    /// <summary>
    /// Reserves the heartbeat connection and waits for it until the end of the startup budget. A stop
    /// that passes its deadline ends the wait, and the method then returns <c>null</c>.
    /// </summary>
    private async Task<Heartbeat.Reservation?> ReserveHeartbeatAsync(RunState run, long deadline, bool listens)
    {
        var budgetMs = (deadline - Monotonic.Now()) / 1_000_000;
        var reservation = _heartbeat.Reserve(Monotonic.Millis(_heartbeatMs), _wake.Bump);
        bool StopPassed() => StopDeadlinePassed(run);
        if (await reservation.AwaitAsync(deadline, StopPassed).ConfigureAwait(false))
        {
            run.Reservation = reservation;
            return reservation;
        }

        var failure = reservation.LastFailure;
        reservation.Dispose();
        if (StopRequested(run))
        {
            if (StopPassed())
            {
                WorkerLog.StopStepAbandoned(_logger, "heartbeat reservation");
            }

            return null;
        }

        var message = $"The worker got no heartbeat connection from its NpgsqlDataSource within its startup budget of {budgetMs} ms, so it does not start."
            + StartupBudgetText(listens);
        throw new WorkerStartupException(message, failure);
    }

    /// <summary>
    /// Waits until the listener holds its connection or listens, until it reports a failure, or until
    /// <paramref name="deadline"/>. The listener is best effort: if it does not listen yet, the
    /// worker logs one warning and polls.
    /// </summary>
    private async Task AwaitListenerAsync(Listener.Subscription listener, Func<bool> failed, RunState run, long deadline)
    {
        while (!listener.IsListening && !listener.HoldsConnection && !failed() && !StopDeadlinePassed(run) && deadline - Monotonic.Now() > 0)
        {
            await Task.Delay(Monotonic.Span(Math.Min(deadline - Monotonic.Now(), IdleCheckNanos))).ConfigureAwait(false);
        }

        if (!listener.IsListening && !StopRequested(run))
        {
            WorkerLog.PollingOnly(_logger, WorkerId);
        }
    }

    /// <summary>
    /// The readiness check of ADR 0071: while the reserved connections are held, it borrows one
    /// ordinary connection, runs the compatibility query, and gives the connection back. It ends by
    /// <paramref name="deadline"/>. Under shared heartbeats it runs the compatibility check alone.
    /// Returns <c>false</c> when a stop passed its deadline first.
    /// </summary>
    private async Task<bool> CheckReadinessAsync(RunState run, long deadline, bool listens)
    {
        using var budget = new CancellationTokenSource();
        if (!_sharedHeartbeats)
        {
            budget.CancelAfter(Monotonic.Span(deadline - Monotonic.Now()));
        }

        var check = CheckCompatibilityAsync(budget.Token);
        // The wait itself ends at the budget. The token alone does not bound the check: Npgsql's
        // cancellation can wait for an unreachable endpoint, or without limit with a Cancellation
        // Timeout of 0. A check that outlives the wait keeps its connection until it ends, and then
        // disposes of it; nothing waits for it.
        var outOfBudget = false;
        while (!check.IsCompleted)
        {
            if (StopDeadlinePassed(run))
            {
                WorkerLog.StopStepAbandoned(_logger, "compatibility check");
                Abandon(check);
                return false;
            }

            if (!_sharedHeartbeats && deadline - Monotonic.Now() <= 0)
            {
                outOfBudget = true;
                Abandon(check);
                break;
            }

            await Task.WhenAny(check, Task.Delay(Monotonic.Span(IdleCheckNanos))).ConfigureAwait(false);
        }

        if (!outOfBudget)
        {
            try
            {
                await check.ConfigureAwait(false);
                return true;
            }
            catch (OperationCanceledException) when (budget.IsCancellationRequested)
            {
                // The budget ended while the check waited for a connection.
            }
        }

        if (StopRequested(run))
        {
            return false;
        }

        var budgetMs = Math.Max(_heartbeatMs, StartupBudgetFloorMs);
        throw new WorkerStartupException(
            $"The worker got no ordinary connection from its NpgsqlDataSource for its startup check within its startup budget of {budgetMs} ms, "
            + "while it held its reserved connections, so it does not start." + StartupBudgetText(listens));
    }

    /// <summary>Observes the result of a task that nothing waits for any more.</summary>
    private static void Abandon(Task task) =>
        _ = task.ContinueWith(ended => _ = ended.Exception, CancellationToken.None, TaskContinuationOptions.OnlyOnFaulted, TaskScheduler.Default);

    private async Task CheckCompatibilityAsync(CancellationToken cancellationToken)
    {
        await using var connection = await DataSources.OpenAsync(_dataSource, cancellationToken).ConfigureAwait(false);
        if (await Compatibility.EvaluateAsync(connection, cancellationToken).ConfigureAwait(false) is { } refusal)
        {
            throw new CompatibilityException(refusal);
        }
    }

    /// <summary>Whether the stop of <paramref name="run"/> has passed its deadline.</summary>
    private bool StopDeadlinePassed(RunState run)
    {
        var stop = StopDeadline(run);
        return stop != Never && Monotonic.Now() - stop >= 0;
    }

    /// <summary>The end of the shutdown grace: the deadline of the current stop, or one grace from now.</summary>
    private long ShutdownDeadline(RunState run)
    {
        var deadline = StopDeadline(run);
        return deadline != Never ? deadline : Monotonic.Now() + _shutdownGraceNanos;
    }

    /// <summary>
    /// The deadline of a stop that this run sees, or <see cref="Never"/>. A stop with no deadline gets
    /// one here, one grace from the moment the run sees it.
    /// </summary>
    private long StopDeadline(RunState run)
    {
        if (!StopRequested(run))
        {
            return Never;
        }

        Interlocked.CompareExchange(ref _stopDeadline, Monotonic.Now() + _shutdownGraceNanos, Never);
        return Interlocked.Read(ref _stopDeadline);
    }

    /// <summary>
    /// Waits for <paramref name="body"/>. The wait ends early only when a stop passes its deadline, so
    /// a stalled statement cannot keep the stop from the drain. Returns <c>false</c> then.
    /// </summary>
    private async Task<bool> StepAsync(Func<Task> body, RunState run, string name)
    {
        var task = body();
        while (!task.IsCompleted)
        {
            if (StopDeadlinePassed(run))
            {
                WorkerLog.StopStepAbandoned(_logger, name);
                return false;
            }

            await Task.WhenAny(task, Task.Delay(Monotonic.Span(IdleCheckNanos))).ConfigureAwait(false);
        }

        await task.ConfigureAwait(false);
        return true;
    }

    private async Task JoinUntilAsync(Task task, long deadline, string step)
    {
        var remaining = deadline - Monotonic.Now();
        if (!task.IsCompleted && remaining > 0)
        {
            await task.WaitAsync(Monotonic.Span(remaining)).ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
        }

        if (!task.IsCompleted)
        {
            WorkerLog.StopStepAbandoned(_logger, step);
        }
    }

    /// <summary>Starts a maintenance pass when none runs, so a slow pass never holds up dispatch or a stop.</summary>
    private void StartMaintenance(RunState run)
    {
        if (run.Maintenance is { IsCompleted: false })
        {
            return;
        }

        // A pass that is not due yet starts no task. The pass checks the interval again itself.
        var last = Interlocked.Read(ref _maintenanceAt);
        if (last != Never && Monotonic.Now() - last < Monotonic.Millis(_maintenanceMs))
        {
            return;
        }

        run.Maintenance = Task.Run(async () =>
        {
            try
            {
                if (Interlocked.Read(ref _generation) == run.Generation)
                {
                    await RunMaintenanceIfDueAsync().ConfigureAwait(false);
                }
            }
            catch (Exception error)
            {
                // ADR 0078: a failed pass ends the run.
                run.MaintenanceErrors.Enqueue(error);
            }
            finally
            {
                _wake.Signal();
            }
        });
    }

    /// <summary>
    /// Runs one maintenance pass when its interval elapsed. The interval restarts only after a pass
    /// succeeds, so a failed pass runs again.
    /// </summary>
    private async Task RunMaintenanceIfDueAsync()
    {
        var now = Monotonic.Now();
        var last = Interlocked.Read(ref _maintenanceAt);
        if (last != Never && now - last < Monotonic.Millis(_maintenanceMs))
        {
            return;
        }

        var routine = Interlocked.Read(ref _routineAt);
        var routineDue = routine == Never || now - routine >= Monotonic.Millis(_routineMs);
        // The first pass of a loop has no earlier run, so it records no drift.
        if (last != Never)
        {
            WorkerTelemetry.MaintenanceDriftOf(now - last, _maintenanceMs, "tick");
        }

        if (routineDue && routine != Never)
        {
            WorkerTelemetry.MaintenanceDriftOf(now - routine, _routineMs, "background_routines");
        }

        using (var pass = WorkerTelemetry.StartMaintenance())
        await using (var connection = await DataSources.OpenAsync(_dataSource, CancellationToken.None).ConfigureAwait(false))
        {
            foreach (var row in await Sql.RowsAsync(connection, SqlCatalogue.TickV1, [Parameters.Integer(100), Parameters.Integer(100)], CancellationToken.None)
                .ConfigureAwait(false))
            {
                pass.Phase(row);
            }

            if (routineDue)
            {
                Interlocked.Exchange(ref _routineAt, now);
                foreach (var row in await Sql.RowsAsync(connection, SqlCatalogue.RunMaintenanceV1, [Parameters.Timestamptz(DateTimeOffset.UtcNow)], CancellationToken.None)
                    .ConfigureAwait(false))
                {
                    pass.Phase(row);
                }
            }
        }

        Interlocked.Exchange(ref _maintenanceAt, now);
        if (_scheduleNamespaces.Length > 0)
        {
            await FireSchedulesAsync().ConfigureAwait(false);
        }
    }

    private async Task FireSchedulesAsync()
    {
        IReadOnlyList<Row> rows;
        await using (var connection = await DataSources.OpenAsync(_dataSource, CancellationToken.None).ConfigureAwait(false))
        {
            rows = await Sql.RowsAsync(
                    connection,
                    SqlCatalogue.FireDueSchedulesV2,
                    [Parameters.TextArray(_scheduleNamespaces), Parameters.Timestamptz(null), Parameters.Integer(_scheduleCatchupLimit), Parameters.Bigint(_maintenanceMs)],
                    CancellationToken.None)
                .ConfigureAwait(false);
        }

        var now = DateTimeOffset.UtcNow;
        foreach (var row in rows)
        {
            WorkerTelemetry.ScheduleFiredOf(row, now);
            if (row.Text("task_id") is { } taskId && _logger.IsEnabled(Microsoft.Extensions.Logging.LogLevel.Information))
            {
                var @namespace = row.Text("namespace");
                var schedule = row.Text("schedule_name");
                WorkerLog.ScheduleFired(_logger, @namespace, schedule, taskId);
            }
        }
    }

    /// <summary>Starts a registry refresh when its interval elapsed and no earlier write still runs.</summary>
    private void RefreshRegistrationIfDue(RunState run)
    {
        var last = Interlocked.Read(ref _lastRegistryAt);
        if (_registryMs == 0 || (last != Never && Monotonic.Now() - last < Monotonic.Millis(_registryMs)))
        {
            return;
        }

        lock (_registryLock)
        {
            if (!_registryWrite.IsCompleted)
            {
                return;
            }
        }

        _ = RegistryStep(() => RefreshRegistrationAsync(force: false, run.Generation));
    }

    /// <summary>
    /// Starts a registry write after the write before it, so the draining registration and the
    /// deregistration reach PostgreSQL in that order.
    /// </summary>
    private Task RegistryStep(Func<Task> body)
    {
        lock (_registryLock)
        {
            var before = _registryWrite;
            var next = Task.Run(async () =>
            {
                await before.ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
                await body().ConfigureAwait(false);
            });
            _registryWrite = next;
            return next;
        }
    }

    private async Task RefreshRegistrationAsync(bool force, long generation)
    {
        if (_registryMs == 0 || Interlocked.Read(ref _generation) != generation)
        {
            return;
        }

        var now = Monotonic.Now();
        var last = Interlocked.Read(ref _lastRegistryAt);
        if (!force && last != Never && now - last < Monotonic.Millis(_registryMs))
        {
            return;
        }

        Interlocked.Exchange(ref _lastRegistryAt, now);
        var slots = _active.Count;
        var stopping = _draining;
        IReadOnlyList<Row> rows;
        try
        {
            await using var connection = await DataSources.OpenAsync(_dataSource, CancellationToken.None).ConfigureAwait(false);
            if (Interlocked.Read(ref _generation) != generation)
            {
                return;
            }

            rows = await Sql.RowsAsync(
                    connection,
                    SqlCatalogue.RegisterWorkerV1,
                    [
                        Parameters.Text(WorkerId),
                        Parameters.Uuid(_instanceId),
                        Parameters.Text(_hostname),
                        Parameters.Integer(Environment.ProcessId),
                        Parameters.TextArray(_queues),
                        Parameters.TextArray(_scheduleNamespaces),
                        Parameters.Integer(Concurrency),
                        Parameters.Integer(_leaseMs),
                        Parameters.Integer((int)_heartbeatMs),
                        Parameters.Integer((int)_pollMs),
                        Parameters.Integer((int)_maintenanceMs),
                        Parameters.Integer((int)_routineMs),
                        Parameters.Integer((int)_registryMs),
                        Parameters.Integer(slots),
                        Parameters.Boolean(stopping),
                        Parameters.Integer(SqlCatalogue.ClientProtocolVersion),
                        Parameters.Text(SdkVersion.Language),
                        Parameters.Text(SdkVersion.Current),
                    ],
                    CancellationToken.None)
                .ConfigureAwait(false);
        }
        catch (Exception error) when (error is WorkhorseException or NpgsqlException or InvalidOperationException or IOException)
        {
            WorkerLog.RegistrationFailed(_logger, error);
            OnRegistrationError(error);
            return;
        }

        var paused = rows.Count > 0 && rows[0].Boolean("paused") == true;
        bool changed;
        lock (_registryLock)
        {
            // A response that arrives after a later run started belongs to its own run, which ended.
            if (Interlocked.Read(ref _generation) != generation)
            {
                return;
            }

            changed = _remotelyPaused != paused;
            _remotelyPaused = paused;
            _registered = true;
        }

        if (changed)
        {
            if (paused)
            {
                WorkerLog.Paused(_logger, "remotely", _queueText);
            }
            else
            {
                WorkerLog.Resumed(_logger, "remotely", _queueText);
            }

            _wake.Bump();
        }
    }

    /// <summary>Deletes the registry row of the run. <c>deregister_worker_v2</c> keeps a row that a later run replaced.</summary>
    private async Task DeregisterAsync(long generation, Guid instance)
    {
        lock (_registryLock)
        {
            if (Interlocked.Read(ref _generation) != generation || !_registered)
            {
                return;
            }

            _registered = false;
        }

        try
        {
            await using var connection = await DataSources.OpenAsync(_dataSource, CancellationToken.None).ConfigureAwait(false);
            await Sql.RowsAsync(connection, SqlCatalogue.DeregisterWorkerV2, [Parameters.Text(WorkerId), Parameters.Uuid(instance)], CancellationToken.None)
                .ConfigureAwait(false);
        }
        catch (Exception error) when (error is WorkhorseException or NpgsqlException or InvalidOperationException or IOException)
        {
            // The registry expires a worker that stops reporting.
        }
    }

    /// <summary>
    /// Waits until the shutdown deadline, cancels what still runs with
    /// <see cref="CancelReason.Shutdown"/>, and gives it one unwind window. Returns the number of
    /// handlers abandoned after that window.
    /// </summary>
    private async Task<int> DrainAsync(RunState run, long deadline, long end)
    {
        // A lingering batch cannot grow once claims stop, so it runs as soon as its members arrive.
        FlushBatches();
        await WaitUntilIdleAsync(deadline).ConfigureAwait(false);
        // A task that the thread pool never started has no handler to unwind, so its release starts
        // before the unwind window. No handler ran, so the task goes back without an attempt.
        var unstarted = new List<Active>();
        foreach (var task in _active.Keys)
        {
            if (task.AbandonUnstarted())
            {
                _active.TryRemove(task, out _);
                ReleaseSlot(task);
                unstarted.Add(task);
            }
        }

        var releases = unstarted.Count == 0 ? null : Task.Run(async () =>
        {
            foreach (var task in unstarted)
            {
                try
                {
                    await ReleaseOwnedAsync(task.Task, new Arbiter(), run.StopPath.Token).ConfigureAwait(false);
                }
                catch (Exception error) when (error is WorkhorseException or OperationCanceledException or NpgsqlException)
                {
                    WorkerLog.ReleaseFailed(_logger, task.Task.Id, error);
                }
            }
        });

        var remaining = _active.Keys.ToList();
        if (remaining.Count > 0)
        {
            foreach (var task in remaining)
            {
                task.Cancellation.Cancel(CancelReason.Shutdown);
            }

            await WaitUntilIdleAsync(Math.Min(Monotonic.Now() + UnwindWindowNanos, end)).ConfigureAwait(false);
        }

        var abandoned = 0;
        foreach (var task in _active.Keys)
        {
            abandoned++;
            // The flag goes up before the ownership is read. An attempt that publishes its ownership
            // later reads the flag after that, so one of the two sides always stops the renewal.
            task.Abandoned = true;
            task.Ownership?.Abandon();
        }

        if (releases is not null)
        {
            await JoinUntilAsync(releases, end, "unstarted release").ConfigureAwait(false);
        }

        return abandoned;
    }

    private async Task WaitUntilIdleAsync(long deadline)
    {
        while (!_active.IsEmpty)
        {
            var remaining = deadline - Monotonic.Now();
            if (remaining <= 0)
            {
                return;
            }

            _wake.Reset();
            if (_active.IsEmpty)
            {
                return;
            }

            await _wake.WaitAsync(Math.Min(remaining, IdleCheckNanos)).ConfigureAwait(false);
        }
    }
}
