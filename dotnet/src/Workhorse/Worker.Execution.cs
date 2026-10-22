using System.Collections.Concurrent;
using System.Runtime.ExceptionServices;
using System.Text.Json;
using Npgsql;
using Workhorse.Internal;
using Workhorse.Internal.Contracts;
using Workhorse.Internal.Database;
using Workhorse.Internal.Durable;
using Workhorse.Internal.Json;
using Workhorse.Internal.Runtime;
using Workhorse.Internal.Telemetry;

namespace Workhorse;

public sealed partial class Worker
{
    private const int CauseDepth = 16;
    private static readonly long ExpirationRetryNanos = Monotonic.Millis(5);
    private static readonly TimeSpan MaxDelaySlice = TimeSpan.FromDays(1);

    /// <summary>The compiled result schema of each contract version, or the reason that it is unusable.</summary>
    private readonly ConcurrentDictionary<(string Type, string Version), ContractSchema> _resultContracts = new();

    /// <summary>One admitted attempt: its claim, its cancellation, and its lease ownership.</summary>
    private sealed class Active(Claimed claimed, RunState run)
    {
        private const int Queued = 0;
        private const int Started = 1;
        private const int AbandonedUnstarted = 2;
        private int _state;

        internal Claimed Claimed { get; } = claimed;

        internal ClaimedTask Task => Claimed.Task;

        internal RunState Run { get; } = run;

        internal TaskCancellation Cancellation { get; } = new();

        internal volatile Ownership? Ownership;

        /// <summary>Set by the drain for an attempt that still runs at the end of the unwind window.</summary>
        internal volatile bool Abandoned;

        /// <summary>The slot cohort of the attempt. A fused completion hands its slot over under the state lock.</summary>
        internal int Cohort;

        internal bool HandedOver;

        /// <summary>Starts the attempt, unless the drain abandoned it first.</summary>
        internal bool Begin() => Interlocked.CompareExchange(ref _state, Started, Queued) == Queued;

        /// <summary>Keeps a queued attempt from starting. Returns whether it was still queued.</summary>
        internal bool AbandonUnstarted() => Interlocked.CompareExchange(ref _state, AbandonedUnstarted, Queued) == Queued;
    }

    /// <summary>The attempts that the worker admitted and that have not ended. A test reads it.</summary>
    internal int ActiveAttempts => _active.Count;

    private async Task RunClaimedTaskAsync(Active task)
    {
        if (!task.Begin())
        {
            // The drain abandoned this task before it started, and it already freed the slot.
            return;
        }

        var arbiter = new Arbiter();
        var telemetry = WorkerTelemetry.StartAttempt(task.Task);
        try
        {
            await ExecuteAsync(task, arbiter).ConfigureAwait(false);
        }
        catch (LeaseLostException)
        {
            // Another attempt owns the task, so this attempt has nothing left to write.
        }
        catch (Exception error)
        {
            // Only the worker's own statements reach here, never a handler exception. The run drains
            // and reports the first one.
            WorkerTelemetry.HandlerError(task.Task, error.GetType().FullName ?? error.GetType().Name);
            task.Run.Errors.Enqueue(error);
            task.Run.Failed = true;
            _wake.Bump();
        }
        finally
        {
            try
            {
                telemetry?.Finish(arbiter.Released ?? arbiter.Current);
            }
            finally
            {
                // A measurement callback of a listener can throw. The slot still goes back.
                _active.TryRemove(task, out _);
                ReleaseSlot(task);
                _wake.Signal();
            }
        }
    }

    private async Task ExecuteAsync(Active task, Arbiter arbiter)
    {
        Registration? registration;
        lock (_handlers)
        {
            _handlers.TryGetValue(task.Task.Type, out registration);
        }

        var token = task.Run.StopPath.Token;
        if (registration is null)
        {
            // A task type with no handler goes back to its queue, so another worker can claim it.
            WorkerLog.HandlerMissing(_logger, task.Task.Type, task.Task.Id);
            await ReleaseOwnedAsync(task.Task, arbiter, token).ConfigureAwait(false);
            return;
        }

        var claimed = task.Task;
        var cancellation = task.Cancellation;
        var ownership = new Ownership(task.Claimed.StartedAt, Monotonic.Millis(_leaseMs));
        Own(task, ownership, arbiter);
        task.Ownership = ownership;
        if (task.Abandoned)
        {
            // The drain abandoned the attempt before it published its ownership. The lease expires.
            ownership.Abandon();
            return;
        }

        string encoded;
        try
        {
            var context = new DurableContext(this, task, arbiter, TierRead(task));
            var result = await registration.Invoke(context, task.Claimed.Payload).ConfigureAwait(false);
            // A suspended attempt ignores its result, so the worker neither encodes nor checks it.
            encoded = arbiter.Suspended ? "null" : await EncodeResultAsync(claimed, result, token).ConfigureAwait(false);
        }
        catch (Exception error)
        {
            // Every handler exception settles the attempt. None leaves RunAsync (ADR 0107).
            if (await FinishOwnershipAsync(claimed, ownership, arbiter, token).ConfigureAwait(false))
            {
                // A handler that threw another exception after a durable call suspended it still suspends.
                if (arbiter.Suspended && error is not SuspensionException)
                {
                    DurableLog.SignalSwallowed(_logger, claimed.Id);
                }

                return;
            }

            // A handler that stopped for the shutdown returns the task without charging the attempt.
            if (cancellation.Reason == CancelReason.Shutdown && ShutdownCancellation(error, cancellation.Token))
            {
                await ReleaseOwnedAsync(claimed, arbiter, token).ConfigureAwait(false);
                return;
            }

            await SettleFailureAsync(claimed, error, arbiter, token).ConfigureAwait(false);
            return;
        }
        finally
        {
            await ownership.ReleaseAsync().ConfigureAwait(false);
        }

        if (await FinishOwnershipAsync(claimed, ownership, arbiter, token).ConfigureAwait(false))
        {
            // A handler that returned after a durable call suspended it still suspends (ADR 0107).
            if (arbiter.Suspended)
            {
                DurableLog.SignalSwallowed(_logger, claimed.Id);
            }

            return;
        }

        await CompleteAsync(task, encoded, arbiter, token).ConfigureAwait(false);
    }

    /// <summary>
    /// The JSON text of a handler result, after the checks that keep a refusal of PostgreSQL from
    /// ending the run: a NUL character, the payload contract's result schema, and the result limit.
    /// Each refusal throws here, so it fails the attempt.
    /// </summary>
    private async Task<string> EncodeResultAsync(ClaimedTask task, object? result, CancellationToken cancellationToken)
    {
        var encoded = _codec.Serialize(result, $"{task.Type} result");
        using var document = JsonDocument.Parse(encoded);
        if (HoldsNul(document.RootElement))
        {
            throw new ArgumentException($"{task.Type} result contains a NUL character, which PostgreSQL jsonb cannot store");
        }

        if (task.ContractVersion is { } version)
        {
            var schema = await ResultSchemaAsync(task.Type, version, cancellationToken).ConfigureAwait(false);
            if (!schema.Valid(document.RootElement))
            {
                throw new ContractValidationException(task.Type, version, "result");
            }
        }

        if (task.ResultMaxBytes is { } limit)
        {
            var actual = JsonbSize.Of(encoded);
            if (actual > limit)
            {
                throw new ValueSizeLimitException(task.Type, "result", actual, limit);
            }
        }

        return encoded;
    }

    /// <summary>
    /// The compiled result schema of a contract version. A definition that is missing, or that holds
    /// no <c>result</c> member, or whose schema does not compile, throws
    /// <see cref="ContractUnavailableException"/>, which fails the attempt as the JVM does.
    /// </summary>
    private async Task<ContractSchema> ResultSchemaAsync(string taskType, string version, CancellationToken cancellationToken)
    {
        if (_resultContracts.TryGetValue((taskType, version), out var cached))
        {
            return cached;
        }

        IReadOnlyList<Row> rows;
        await using (var connection = await DataSources.OpenAsync(_dataSource, cancellationToken).ConfigureAwait(false))
        {
            rows = await Sql.RowsAsync(connection, SqlCatalogue.GetContractDefinitionV1, [Parameters.Text(taskType), Parameters.Text(version)], cancellationToken)
                .ConfigureAwait(false);
        }

        if (rows.Count != 1 || rows[0].Json("schema") is not { ValueKind: JsonValueKind.Object } document
            || !document.TryGetProperty("result", out var result))
        {
            throw new ContractUnavailableException(taskType, version);
        }

        ContractSchema schema;
        try
        {
            schema = new ContractSchema(result);
        }
        catch (ArgumentException)
        {
            throw new ContractUnavailableException(taskType, version);
        }

        return _resultContracts.GetOrAdd((taskType, version), schema);
    }

    private static bool HoldsNul(JsonElement element) => element.ValueKind switch
    {
        JsonValueKind.String => element.GetString()!.Contains('\0', StringComparison.Ordinal),
        JsonValueKind.Array => element.EnumerateArray().Any(HoldsNul),
        JsonValueKind.Object => element.EnumerateObject().Any(member => member.Name.Contains('\0', StringComparison.Ordinal) || HoldsNul(member.Value)),
        _ => false,
    };

    private async Task CompleteAsync(Active active, string encoded, Arbiter arbiter, CancellationToken cancellationToken)
    {
        var task = active.Task;
        bool accepted;
        using (var span = WorkerTelemetry.StartComplete(task))
        {
            accepted = await CompleteAttemptAsync(active, encoded, cancellationToken).ConfigureAwait(false);
            WorkerTelemetry.Completed(span, task, accepted);
        }

        if (accepted)
        {
            WorkerLog.Completed(_logger, task.Id);
            arbiter.Submit(Outcome.Completed);
            return;
        }

        WorkerLog.CompletionRejected(_logger, task.Id);
        if (await AcknowledgeCancelAsync(task, cancellationToken).ConfigureAwait(false))
        {
            arbiter.Submit(Outcome.Cancelled);
            return;
        }

        arbiter.Submit(Outcome.LeaseExpired);
        throw new LeaseLostException(task.Id, "complete");
    }

    /// <summary>Hands an owned task back to PostgreSQL without charging the attempt.</summary>
    private async Task ReleaseOwnedAsync(ClaimedTask task, Arbiter arbiter, CancellationToken cancellationToken)
    {
        var row = await FencedRowAsync(SqlCatalogue.ReleaseOwnedV1, task, () => [], cancellationToken).ConfigureAwait(false);
        var status = row.Text("status");
        WorkerTelemetry.HandlerSpanOutcome(task, status);
        WorkerLog.ReleaseProcessed(_logger, task.Id, status);
        if (status == "released")
        {
            arbiter.Submit(Outcome.Released);
            return;
        }

        await SettleStatusAsync(task, status, arbiter, "release", "not_due", Outcome.LeaseExpired, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Records a handler failure. PostgreSQL retries or fails the task by its retry policy.</summary>
    private async Task SettleFailureAsync(ClaimedTask task, Exception error, Arbiter arbiter, CancellationToken cancellationToken)
    {
        var envelope = FailureEnvelope.Write(error, task.RedactErrorDetails);
        int? delay = null;
        if (error is ConflictException)
        {
            // A durable replay conflict is terminal (ADR 0098).
            delay = -1;
        }
        else if (_retryDelay?.Invoke(task.Attempt, task) is { } chosen)
        {
            delay = (int)Math.Clamp(Math.Round(chosen.TotalMilliseconds), 0, int.MaxValue);
        }

        Row row;
        using (var span = WorkerTelemetry.StartFailure(task, error))
        {
            row = await FencedRowAsync(SqlCatalogue.FailV1, task, () => [Parameters.Json(envelope), Parameters.Integer(delay)], cancellationToken).ConfigureAwait(false);
            WorkerTelemetry.Failed(span, task, row.Text("state"));
        }

        var state = row.Text("state");
        var errorType = FailureEnvelope.Name(error);
        WorkerLog.FailureProcessed(_logger, task.Id, state, errorType);
        if (state is "ready" or "scheduled")
        {
            arbiter.Submit(Outcome.Retry);
            return;
        }

        await SettleStatusAsync(task, state, arbiter, "fail", "failed", Outcome.Failed, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>
    /// Submits the outcome for a status that the worker's own write returned. A cancel request is
    /// acknowledged; a lost lease throws <see cref="LeaseLostException"/>.
    /// </summary>
    private async Task SettleStatusAsync(
        ClaimedTask task, string? status, Arbiter arbiter, string operation, string neutral, Outcome neutralOutcome, CancellationToken cancellationToken)
    {
        if (status == neutral)
        {
            arbiter.Submit(neutralOutcome);
            return;
        }

        var outcome = OutcomeFor(status, operation);
        if (outcome == Outcome.Cancelled && !await AcknowledgeCancelAsync(task, cancellationToken).ConfigureAwait(false))
        {
            throw new LeaseLostException(task.Id, operation);
        }

        arbiter.Submit(outcome);
        if (outcome == Outcome.LeaseExpired)
        {
            throw new LeaseLostException(task.Id, operation);
        }
    }

    private static Outcome OutcomeFor(string? status, string operation) => status switch
    {
        "cancel_requested" => Outcome.Cancelled,
        "deadline_exceeded" => Outcome.DeadlineExceeded,
        "timeout_exceeded" => Outcome.AttemptTimeout,
        "stale" => Outcome.LeaseExpired,
        _ => throw new UnexpectedStatusException(operation, status),
    };

    private async Task<bool> AcknowledgeCancelAsync(ClaimedTask task, CancellationToken cancellationToken)
    {
        var row = await FencedRowAsync(SqlCatalogue.AcknowledgeCancelV1, task, () => [], cancellationToken).ConfigureAwait(false);
        var accepted = row.Boolean("accepted") == true;
        WorkerLog.CancellationAcknowledged(_logger, task.Id, accepted);
        return accepted;
    }

    /// <summary>
    /// Stops renewing, and reports whether the heartbeat already decided the attempt. Throws the
    /// heartbeat's error when it failed and nothing decided the attempt.
    /// </summary>
    private async Task<bool> FinishOwnershipAsync(ClaimedTask task, Ownership ownership, Arbiter arbiter, CancellationToken cancellationToken)
    {
        await ownership.ReleaseAsync().ConfigureAwait(false);
        // A task that a durable write released needs nothing more from the worker, whichever
        // outcome won: the heartbeat reports that release as a lost lease.
        if (arbiter.Released is not null)
        {
            return true;
        }

        switch (arbiter.Current)
        {
            case Outcome.SuspendedForWait or Outcome.SuspendedForChild or Outcome.DeadlineExceeded or Outcome.AttemptTimeout:
                return true;
            case Outcome.Cancelled:
                if (!await AcknowledgeCancelAsync(task, cancellationToken).ConfigureAwait(false))
                {
                    throw new LeaseLostException(task.Id, "cancel");
                }

                return true;
            case Outcome.LeaseExpired:
                throw new LeaseLostException(task.Id, "heartbeat");
        }

        if (ownership.Errors.TryPeek(out var error))
        {
            ExceptionDispatchInfo.Throw(error);
        }

        return false;
    }

    /// <summary>
    /// Whether <paramref name="error"/>, or an error that it wraps, shows that the handler saw the
    /// shutdown: an <see cref="OperationCanceledException"/> that carries the handler's own token
    /// (ADR 0107), or a <see cref="CancelledException"/> with <see cref="CancelReason.Shutdown"/>. An
    /// unrelated cancellation, such as a timeout of the handler's own, fails the attempt. The walk
    /// stays bounded against a cyclic chain.
    /// </summary>
    private static bool ShutdownCancellation(Exception error, CancellationToken token)
    {
        var current = error;
        for (var depth = 0; depth < CauseDepth && current is not null; depth++)
        {
            if (current is OperationCanceledException cancelled && cancelled.CancellationToken == token)
            {
                return true;
            }

            if (current is CancelledException { Reason: CancelReason.Shutdown })
            {
                return true;
            }

            current = current is AggregateException { InnerExceptions.Count: 1 } aggregate ? aggregate.InnerExceptions[0] : current.InnerException;
        }

        return false;
    }

    /// <summary>
    /// Runs a fenced write on a connection of its own. The statement takes the stop-path token, never
    /// the handler's token (ADR 0107, "Cancellation and statements").
    /// </summary>
    private async Task<Row> FencedRowAsync(SqlCatalogue.Statement statement, ClaimedTask task, Func<NpgsqlParameter[]> rest, CancellationToken cancellationToken)
    {
        await using var connection = await DataSources.OpenAsync(_dataSource, cancellationToken).ConfigureAwait(false);
        var rows = await Sql.FencedRowsAsync(
                connection,
                statement,
                // A parameter belongs to one command, so each resend after a deadlock builds new ones.
                () => [Parameters.Uuid(task.Id), Parameters.Text(WorkerId), Parameters.Bigint(task.FenceToken), .. rest()],
                cancellationToken)
            .ConfigureAwait(false);
        return rows.Count == 1 ? rows[0] : throw new WorkhorseException($"{statement.Name} returned {rows.Count} rows");
    }

    /// <summary>
    /// Registers the attempt with the heartbeat, and starts its lease watchdog and its deadline
    /// watch. They are two tasks, so a deadline settlement that waits for a row lock cannot delay the
    /// local end of the lease window.
    /// </summary>
    private void Own(Active task, Ownership ownership, Arbiter arbiter)
    {
        var member = new LeaseMember(this, task, ownership, arbiter);
        ownership.Start(_heartbeat.Register(member));
        ownership.Watchdog = Task.WhenAll(
            Task.Run(() => WatchLeaseAsync(task, ownership, arbiter)),
            Task.Run(() => WatchDeadlineAsync(task, ownership, arbiter)));
    }

    /// <summary>
    /// Ends the attempt locally when its lease window ends without an accepted renewal (ADR 0071).
    /// The lease leaves the heartbeat set at that moment, so it is not renewed again (SM-1445).
    /// </summary>
    private static async Task WatchLeaseAsync(Active task, Ownership ownership, Arbiter arbiter)
    {
        try
        {
            while (true)
            {
                var remaining = ownership.LeaseRemaining(Monotonic.Now());
                if (remaining > 0)
                {
                    await Task.Delay(Monotonic.Span(remaining), ownership.Stopped).ConfigureAwait(false);
                    continue;
                }

                // A late accepted answer can close the window first. It then ends the attempt itself.
                if (ownership.Lapse())
                {
                    ExpireLease(ownership, arbiter, task.Cancellation);
                }

                return;
            }
        }
        catch (OperationCanceledException) when (ownership.Stopped.IsCancellationRequested)
        {
            // The heartbeat stopped renewing, so the watchdog ends.
        }
    }

    /// <summary>
    /// Asks PostgreSQL to settle the task's deadline or the attempt's execution timeout when one
    /// passes, and asks again shortly while PostgreSQL answers <c>not_due</c>.
    /// </summary>
    private async Task WatchDeadlineAsync(Active task, Ownership ownership, Arbiter arbiter)
    {
        if (Earliest(task.Task.DeadlineAt, task.Task.AttemptTimeoutAt) is not { } expirationAt)
        {
            return;
        }

        try
        {
            var dueAt = expirationAt;
            while (true)
            {
                await DelayUntilAsync(dueAt, ownership.Stopped).ConfigureAwait(false);
                string? status;
                await ownership.Settlement.WaitAsync(ownership.Stopped).ConfigureAwait(false);
                try
                {
                    status = await SettleExpirationAsync(task, arbiter).ConfigureAwait(false);
                }
                finally
                {
                    ownership.Settlement.Release();
                }

                if (status != "not_due")
                {
                    return;
                }

                dueAt = DateTimeOffset.UtcNow + Monotonic.Span(ExpirationRetryNanos);
            }
        }
        catch (OperationCanceledException) when (ownership.Stopped.IsCancellationRequested)
        {
            // The heartbeat stopped renewing, so the attempt has ended or lost its lease.
        }
        catch (Exception error)
        {
            FailAttempt(ownership, task.Cancellation, error);
        }
    }

    /// <summary>
    /// Waits until <paramref name="dueAt"/>. A timer takes at most about 49.7 days, and a deadline
    /// can be later, so the wait runs in slices and reads the clock again before each one.
    /// </summary>
    private static async Task DelayUntilAsync(DateTimeOffset dueAt, CancellationToken cancellationToken)
    {
        while (true)
        {
            var remaining = dueAt - DateTimeOffset.UtcNow;
            if (remaining <= TimeSpan.Zero)
            {
                return;
            }

            await Task.Delay(remaining < MaxDelaySlice ? remaining : MaxDelaySlice, cancellationToken).ConfigureAwait(false);
        }
    }

    private static DateTimeOffset? Earliest(DateTimeOffset? first, DateTimeOffset? second) =>
        first is null ? second : second is null ? first : first < second ? first : second;

    /// <summary>Ends an attempt whose local lease window closed without an accepted renewal.</summary>
    internal static void ExpireLease(Ownership ownership, Arbiter arbiter, TaskCancellation cancellation)
    {
        arbiter.Submit(Outcome.LeaseExpired);
        // The lease leaves the heartbeat set now, so it is not renewed again (SM-1445).
        ownership.Abandon();
        // A durable write released the task, and the suspension sets its own cancel reason.
        if (arbiter.Released is not null)
        {
            return;
        }

        cancellation.Cancel(CancelReason.LeaseLost);
    }

    private static void FailAttempt(Ownership ownership, TaskCancellation cancellation, Exception error)
    {
        ownership.Errors.Enqueue(error);
        cancellation.Cancel(CancelReason.LeaseLost);
    }

    private async Task<string?> SettleExpirationAsync(Active task, Arbiter arbiter)
    {
        var row = await FencedRowAsync(SqlCatalogue.ExpireOwnedTelemetryV1, task.Task, () => [], task.Run.StopPath.Token).ConfigureAwait(false);
        var status = row.Text("status");
        if (status == "not_due")
        {
            return status;
        }

        WorkerTelemetry.Expired(task.Task, row);
        WorkerLog.OwnershipExpired(_logger, task.Task.Id, status);
        DeliverStatus(status, arbiter, task.Cancellation);
        return status;
    }

    /// <summary>
    /// Submits the outcome that a heartbeat or expiration status names, and cancels the handler with
    /// the matching reason (ADR 0074).
    /// </summary>
    private static void DeliverStatus(string? status, Arbiter arbiter, TaskCancellation cancellation)
    {
        // A durable write released the task, so a status about the released lease changes nothing.
        if (status == "accepted" || arbiter.Released is not null)
        {
            return;
        }

        var outcome = OutcomeFor(status, "heartbeat");
        arbiter.Submit(outcome);
        cancellation.Cancel(outcome switch
        {
            Outcome.Cancelled => CancelReason.Requested,
            Outcome.DeadlineExceeded => CancelReason.DeadlineExceeded,
            Outcome.AttemptTimeout => CancelReason.ExecutionTimeout,
            _ => CancelReason.LeaseLost,
        });
    }

    /// <summary>One attempt in the heartbeat set.</summary>
    private sealed class LeaseMember(Worker worker, Active task, Ownership ownership, Arbiter arbiter) : Heartbeat.IMember
    {
        public string WorkerId => worker.WorkerId;

        public Guid TaskId => task.Task.Id;

        public long FenceToken => task.Task.FenceToken;

        public int LeaseMs => worker._leaseMs;

        public long IntervalNanos => Monotonic.Millis(worker._heartbeatMs);

        public long LeaseEndsAt => ownership.LeaseDeadline;

        public void Renew(long sentAt)
        {
            if (ownership.Renew(sentAt))
            {
                ExpireLease(ownership, arbiter, task.Cancellation);
            }
        }

        public void Settle(string status)
        {
            WorkerTelemetry.HeartbeatRejected(status);
            WorkerLog.HeartbeatRejected(worker._logger, task.Task.Id, status);
            // Another transaction held the row. The round renewed nothing and gave no verdict.
            if (status == "busy")
            {
                return;
            }

            // The settlement can wait for this attempt's lock and send a statement, so it runs off the
            // heartbeat thread. A status that arrives while one settlement waits adds nothing.
            if (Interlocked.CompareExchange(ref ownership.Settling, 1, 0) != 0)
            {
                return;
            }

            _ = Task.Run(async () =>
            {
                await ownership.Settlement.WaitAsync().ConfigureAwait(false);
                try
                {
                    if (status is "deadline_exceeded" or "timeout_exceeded")
                    {
                        await worker.SettleExpirationAsync(task, arbiter).ConfigureAwait(false);
                    }
                    else
                    {
                        DeliverStatus(status, arbiter, task.Cancellation);
                    }
                }
                catch (Exception error)
                {
                    FailAttempt(ownership, task.Cancellation, error);
                }
                finally
                {
                    ownership.Settlement.Release();
                    Interlocked.Exchange(ref ownership.Settling, 0);
                }
            });
        }

        public void Fail(Exception error) => FailAttempt(ownership, task.Cancellation, error);
    }
}
