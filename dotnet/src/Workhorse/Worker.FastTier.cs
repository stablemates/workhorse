using Npgsql;
using Workhorse.Internal;
using Workhorse.Internal.Database;
using Workhorse.Internal.Runtime;
using Workhorse.Internal.Telemetry;

namespace Workhorse;

public sealed partial class Worker
{
    /// <summary>How long a queue that rejected a fast-tier statement is claimed as full-tier before the next probe.</summary>
    private static readonly long TierProbeNanos = Monotonic.Millis(30_000);

    /// <summary>The most completions, and the largest claim limit, of one fused statement.</summary>
    private const int CompletionBatchLimit = 100;

    /// <summary>The queues that rejected a fast-tier statement, each until its next probe. It changes under the state lock.</summary>
    private readonly Dictionary<string, long> _fullTierUntil = new(StringComparer.Ordinal);

    /// <summary>The queues that answered a fast-tier statement. It changes under the state lock.</summary>
    private readonly HashSet<string> _fastTierQueues = new(StringComparer.Ordinal);

    /// <summary>Guards <see cref="_pendingCompletions"/>.</summary>
    private readonly Lock _completionLock = new();

    /// <summary>The completions that wait for the next statement of each key.</summary>
    private readonly Dictionary<CompletionKey, List<PendingCompletion>> _pendingCompletions = [];

    /// <summary>Receives each fused statement: its completions, its claim limit, and the tasks that it claimed. A test sets it.</summary>
    internal Action<FusedStatement>? FusedStatementHook;

    /// <summary>One fused statement, as <see cref="FusedStatementHook"/> receives it.</summary>
    internal sealed record FusedStatement(int Completions, int ClaimLimit, int Claimed);

    /// <summary>The completions that wait behind a statement in flight. A test reads it.</summary>
    internal int CompletionsWaiting
    {
        get
        {
            lock (_completionLock)
            {
                return _pendingCompletions.Values.Sum(waiting => waiting.Count);
            }
        }
    }

    /// <summary>
    /// The fused claim that one fast-tier completion reserved: its limit, its cohort, and the wake
    /// version when it reserved. A zero limit reserves nothing.
    /// </summary>
    private sealed record CompletionClaim(int Limit, int Cohort, long WakeVersion);

    /// <summary>
    /// The statement key of batched completions: one statement for each queue, cohort, and run. A
    /// statement settles only the attempts of one run, so it uses that run's stop-path token.
    /// </summary>
    private sealed record CompletionKey(string Queue, int Cohort, RunState Run);

    /// <summary>
    /// Claims through the fast tier, or returns <c>null</c> when the queue is on the full tier. The
    /// fast claim is <c>complete_many_and_claim_v1</c> with no completions. A full-tier queue rejects
    /// it, and the worker then claims that queue through <c>claim_many_v1</c> until the next probe.
    /// </summary>
    private async Task<List<Claimed>?> ClaimFastAsync(RunState run, string queue, int limit)
    {
        var probedAt = Monotonic.Now();
        lock (_stateLock)
        {
            if (_fullTierUntil.TryGetValue(queue, out var until) && until - probedAt > 0)
            {
                return null;
            }
        }

        if (limit <= 0)
        {
            return [];
        }

        IReadOnlyList<Row> rows;
        var sentAt = 0L;
        var permit = new ClaimPermit(run);
        try
        {
            await using var connection = await DataSources.OpenAsync(_dataSource, CancellationToken.None).ConfigureAwait(false);
            // The claim gate is read on the open connection before each attempt, a resend after a
            // deadlock too. A run whose heartbeat lost its connection meanwhile sends nothing. The
            // local lease window starts when the statement goes out, after the wait for the pool.
            rows = await Sql.FencedRowsAsync(
                    connection,
                    SqlCatalogue.CompleteManyAndClaimV1,
                    () =>
                    {
                        if (!permit.Admit())
                        {
                            throw new ClaimWithdrawnException();
                        }

                        sentAt = Monotonic.Now();
                        return FusedParameters([], [], [], queue, limit);
                    },
                    CancellationToken.None)
                .ConfigureAwait(false);
        }
        catch (ClaimWithdrawnException)
        {
            return [];
        }
        catch (FastTierUnsupportedException)
        {
            MarkFullTier(queue, probedAt);
            return null;
        }
        finally
        {
            permit.Release();
        }

        MarkFastTier(queue);
        // A claim that finds nothing still returns one row, with every claim column null.
        var claimed = rows.Where(row => row.Has("task_id") && row.Text("task_id") is not null)
            .Select(row => ClaimedOf(row, queue, sentAt, fastClaimed: true))
            .ToList();
        FusedStatementHook?.Invoke(new FusedStatement(0, limit, claimed.Count));
        return claimed;
    }

    private NpgsqlParameter[] FusedParameters(Guid[] ids, long[] fences, string[] results, string queue, int limit) =>
    [
        Parameters.Text(WorkerId),
        Parameters.UuidArray(ids),
        Parameters.BigintArray(fences),
        Parameters.JsonArray(results),
        Parameters.Text(queue),
        Parameters.Integer(limit),
        Parameters.Integer(_leaseMs),
    ];

    private void MarkFullTier(string queue, long sentAt)
    {
        lock (_stateLock)
        {
            _fullTierUntil[queue] = sentAt + TierProbeNanos;
            _fastTierQueues.Remove(queue);
        }
    }

    private void MarkFastTier(string queue)
    {
        lock (_stateLock)
        {
            _fullTierUntil.Remove(queue);
            _fastTierQueues.Add(queue);
        }
    }

    /// <summary>
    /// The tier read of a durable context. A task that a fast-tier statement claimed is on the fast
    /// tier, so its context reads nothing. <c>claim_many_v1</c> claims a queue that moved to the fast
    /// tier during the probe interval with no tier marker, so the context of such a task reads
    /// <c>queue_control</c> on its first durable call. The tier cannot change while the queue has a
    /// live task, so one answer holds for the attempt.
    /// </summary>
    private Func<CancellationToken, Task<bool>> TierRead(Active task)
    {
        if (task.Claimed.FastClaimed)
        {
            return FastClaimedTier;
        }

        var queue = task.Task.Queue;
        return cancellationToken => FastTierAsync(queue, cancellationToken);
    }

    private static Task<bool> FastClaimedTier(CancellationToken cancellationToken) => Task.FromResult(true);

    /// <summary>
    /// Completes an attempt and reports whether PostgreSQL accepted it. A task that a fast-tier
    /// statement claimed completes through the batched fused statement (ADR 0077). Every other task
    /// completes through <c>complete_v1</c>.
    /// </summary>
    private async Task<bool> CompleteAttemptAsync(Active task, string encoded, CancellationToken cancellationToken)
    {
        if (!task.Claimed.FastClaimed || await CompleteFastAsync(task, encoded).ConfigureAwait(false) is not { } accepted)
        {
            var row = await FencedRowAsync(SqlCatalogue.CompleteV1, task.Task, () => [Parameters.Json(encoded)], cancellationToken).ConfigureAwait(false);
            return row.Boolean("accepted") == true;
        }

        return accepted;
    }

    /// <summary>
    /// Completes a fast-tier attempt through the batched statement, and refills its slot. Completions
    /// of one queue and cohort that arrive while its statement is in flight share the next one. The
    /// statement also claims tasks into the slots that this call set aside. Returns <c>null</c> when
    /// the queue left the fast tier after the claim, so the attempt completes through
    /// <c>complete_v1</c> instead.
    /// </summary>
    private async Task<bool?> CompleteFastAsync(Active task, string encoded)
    {
        var reservation = ReserveCompletionClaim(task);
        var pending = new PendingCompletion(task.Task, new ClaimPermit(task.Run), encoded, reservation.Limit);
        try
        {
            await SendBatchedCompletionAsync(pending, new CompletionKey(task.Task.Queue, reservation.Cohort, task.Run)).ConfigureAwait(false);
        }
        finally
        {
            // A withheld claim settles as a failed one does: the reserved slots go back, and the queue
            // does not count as empty.
            SettleCompletionClaim(task, reservation, pending.Error is not null || pending.Withheld ? null : pending.Claimed);
        }

        if (pending.Error is { } error)
        {
            System.Runtime.ExceptionServices.ExceptionDispatchInfo.Throw(error);
        }

        return pending.FullTier ? null : pending.Accepted;
    }

    /// <summary>
    /// Sets aside the slots that a completion's fused claim can fill (ADR 0076, rules 12 and 13). The
    /// claim asks for the free slots of the task's cohort plus the slot that the task leaves. It claims
    /// nothing while the worker stops, pauses, or waits after an empty claim, and it waits for the
    /// refill batch while another claim for the cohort is in flight.
    /// </summary>
    private CompletionClaim ReserveCompletionClaim(Active task)
    {
        var run = task.Run;
        lock (_stateLock)
        {
            var idle = new CompletionClaim(0, task.Cohort, _wake.Version);
            if (!run.ClaimsOpen || StopRequested(run) || !run.Errors.IsEmpty || IsPaused || run.ClaimError is not null
                || run.EmptyWait is not null || !run.GateOpen)
            {
                return idle;
            }

            var slots = SlotState;
            var limit = Math.Min(slots.Free, slots.CohortFree(task.Cohort)) + 1;
            var claiming = slots.WholeClaims > 0 || slots.Claims[task.Cohort] > 0;
            if (limit <= 0 || (claiming && limit < slots.RefillBatch))
            {
                return idle;
            }

            slots.ReservedTotal += limit;
            slots.Reserved[task.Cohort] += limit;
            run.FusedClaims++;
            task.HandedOver = true;
            slots.HandedOverTotal++;
            slots.HandedOver[task.Cohort]++;
            return idle with { Limit = limit };
        }
    }

    /// <summary>
    /// Releases a fused claim's reservation and starts the tasks that it claimed in its cohort.
    /// <paramref name="returned"/> is <c>null</c> when the completion failed, or when the claim gate
    /// withheld its claim. A result that returns after the claims of its run ended is abandoned, as a
    /// plain claim is: its tasks do not run, and their leases expire.
    /// </summary>
    private void SettleCompletionClaim(Active task, CompletionClaim reservation, List<Claimed>? returned)
    {
        if (reservation.Limit == 0)
        {
            return;
        }

        var run = task.Run;
        var abandoned = false;
        lock (_stateLock)
        {
            var claimed = returned;
            if (claimed is { Count: > 0 } && !run.ClaimsOpen)
            {
                abandoned = true;
                claimed = null;
            }

            var slots = SlotState;
            slots.ReservedTotal -= reservation.Limit;
            slots.Reserved[reservation.Cohort] -= reservation.Limit;
            run.FusedClaims--;
            // A claimed task took over this handler's slot. Without one, the slot stays this
            // handler's until it returns.
            if ((claimed is null || claimed.Count == 0) && task.HandedOver)
            {
                task.HandedOver = false;
                slots.HandedOverTotal--;
                slots.HandedOver[reservation.Cohort]--;
            }

            var handled = false;
            foreach (var next in claimed ?? [])
            {
                Admit(next, reservation.Cohort, run);
                handled |= HasHandler(next.Task.Type);
            }

            if (handled)
            {
                run.ClaimedAny = true;
                run.Empty = 0;
            }
            else if (claimed is { Count: 0 } && _queues.Length == 1)
            {
                // The fused claim asks one queue only, so it proves that queue empty when this worker
                // has no other.
                run.Empty++;
                run.PassEnded = true;
                run.EmptyWait ??= new EmptyWait(Monotonic.Now() + DispatchWait(run), reservation.WakeVersion);
            }
        }

        if (abandoned)
        {
            WorkerLog.ClaimsAbandoned(_logger, 1);
        }

        _wake.Signal();
    }

    /// <summary>
    /// Sends a completion in the next statement of its key, and waits for its result. One statement
    /// for each key is in flight. The first completion sends its own at once. Those that arrive
    /// meanwhile wait, and the first of them sends them all together when the statement returns.
    /// </summary>
    private async Task SendBatchedCompletionAsync(PendingCompletion pending, CompletionKey key)
    {
        List<PendingCompletion>? batch;
        lock (_completionLock)
        {
            if (_pendingCompletions.TryGetValue(key, out var waiting))
            {
                waiting.Add(pending);
                batch = null;
            }
            else
            {
                _pendingCompletions[key] = [];
                batch = [pending];
            }
        }

        if (batch is null)
        {
            await pending.Done.Task.ConfigureAwait(false);
            if (!pending.Lead)
            {
                return;
            }

            lock (_completionLock)
            {
                batch = _pendingCompletions[key];
                _pendingCompletions[key] = [];
            }
        }

        try
        {
            await FlushCompletionsAsync(key.Queue, batch, key.Run.StopPath.Token).ConfigureAwait(false);
        }
        finally
        {
            lock (_completionLock)
            {
                var waiting = _pendingCompletions[key];
                if (waiting.Count == 0)
                {
                    _pendingCompletions.Remove(key);
                }
                else
                {
                    waiting[0].Lead = true;
                    waiting[0].Done.TrySetResult();
                }
            }
        }
    }

    /// <summary>
    /// Completes a batch in statements within the protocol's array and claim limits. A failed
    /// statement fails only the completions that it carried.
    /// </summary>
    private async Task FlushCompletionsAsync(string queue, List<PendingCompletion> batch, CancellationToken cancellationToken)
    {
        var start = 0;
        while (start < batch.Count)
        {
            var finish = start;
            var claimLimit = 0;
            while (finish < batch.Count && finish - start < CompletionBatchLimit && claimLimit + batch[finish].Limit <= CompletionBatchLimit)
            {
                claimLimit += batch[finish].Limit;
                finish++;
            }

            var chunk = batch.GetRange(start, finish - start);
            start = finish;
            try
            {
                await SendCompletionChunkAsync(queue, chunk, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception error)
            {
                foreach (var member in chunk)
                {
                    member.Error = error;
                }
            }
            finally
            {
                foreach (var member in chunk)
                {
                    member.Done.TrySetResult();
                }
            }
        }
    }

    /// <summary>
    /// Sends one <c>complete_many_and_claim_v1</c> statement and answers every completion in it. The
    /// chunk names its tasks in task ID order, so two statements lock shared runtime rows in the same
    /// order. A deadlock rolls the statement back with <c>40P01</c>, and the fenced write sends it
    /// again. The statement takes the run's stop-path token, never a handler's token (ADR 0107).
    /// </summary>
    private async Task SendCompletionChunkAsync(string queue, List<PendingCompletion> chunk, CancellationToken cancellationToken)
    {
        chunk.Sort((left, right) => string.CompareOrdinal(left.Task.Id.ToString(), right.Task.Id.ToString()));
        var probedAt = Monotonic.Now();
        var sentAt = probedAt;
        var sentLimit = 0;
        IReadOnlyList<Row> rows;
        try
        {
            // The claim limit is read on the open connection before each attempt, a resend too. Each
            // completion claims only while the claim gate of its own run is open. The statement then
            // still settles every completion, with a claim limit of 0 when no gate is open.
            await using var connection = await DataSources.OpenAsync(_dataSource, cancellationToken).ConfigureAwait(false);
            rows = await Sql.FencedRowsAsync(
                    connection,
                    SqlCatalogue.CompleteManyAndClaimV1,
                    () =>
                    {
                        // The local lease window of a claimed task starts when the statement goes out.
                        sentAt = Monotonic.Now();
                        sentLimit = 0;
                        foreach (var member in chunk)
                        {
                            member.Withheld = member.Limit > 0 && !member.Permit.Admit();
                            sentLimit += member.Withheld ? 0 : member.Limit;
                        }

                        return FusedParameters(
                            [.. chunk.Select(member => member.Task.Id)],
                            [.. chunk.Select(member => member.Task.FenceToken)],
                            [.. chunk.Select(member => member.Encoded)],
                            queue,
                            sentLimit);
                    },
                    cancellationToken)
                .ConfigureAwait(false);
        }
        catch (FastTierUnsupportedException)
        {
            MarkFullTier(queue, probedAt);
            foreach (var member in chunk)
            {
                member.FullTier = true;
            }

            return;
        }
        finally
        {
            // The statement settled, so each fused claim of the chunk gives back its permit.
            foreach (var member in chunk)
            {
                member.Permit.Release();
            }
        }

        MarkFastTier(queue);
        // Only the first row carries the accepted completions. A statement that claims nothing still
        // returns that row, with every claim column null.
        var accepted = rows.Count > 0 && rows[0].Value("accepted") is Guid[] ids ? ids.ToHashSet() : [];
        var claimed = rows.Where(row => row.Text("task_id") is not null).Select(row => ClaimedOf(row, queue, sentAt, fastClaimed: true)).ToList();
        FusedStatementHook?.Invoke(new FusedStatement(chunk.Count, sentLimit, claimed.Count));
        // A fused claim has no claim span of its own, as on the JVM. Its metrics count as a claim's,
        // from before the wait for the pool and before the first send, as the JVM measures them.
        if (sentLimit > 0)
        {
            WorkerTelemetry.Claimed(null, queue, probedAt, claimed, 0, static entry => entry.Task, fullTier: false);
        }

        // Claimed tasks go to the completions in order, each up to the slots that it reserved. A claim
        // that the gate withheld gets no task, and proves nothing about the queue.
        var offset = 0;
        foreach (var member in chunk)
        {
            member.Accepted = accepted.Contains(member.Task.Id);
            var end = Math.Min(claimed.Count, offset + (member.Withheld ? 0 : member.Limit));
            member.Claimed = claimed.GetRange(offset, end - offset);
            offset = end;
        }
    }

    /// <summary>
    /// One completion that waits for a batched <c>complete_many_and_claim_v1</c> statement. The
    /// statement's sender fills the answer and then completes <see cref="Done"/>. <see cref="Lead"/>
    /// makes a waiting completion the sender of the next statement.
    /// </summary>
    private sealed class PendingCompletion(ClaimedTask task, ClaimPermit permit, string encoded, int limit)
    {
        internal ClaimedTask Task { get; } = task;

        /// <summary>The claim permit of the fused claim, for the run of the attempt.</summary>
        internal ClaimPermit Permit { get; } = permit;

        internal string Encoded { get; } = encoded;

        internal int Limit { get; } = limit;

        internal TaskCompletionSource Done { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        internal volatile bool Accepted;
        internal volatile bool FullTier;
        internal volatile bool Lead;

        /// <summary>True when the claim gate of the attempt's run withheld this completion's claim.</summary>
        internal volatile bool Withheld;
        internal volatile Exception? Error;
        internal List<Claimed> Claimed = [];
    }

    /// <summary>
    /// A claim permit that a statement checks before each send, a resend too. The first check takes
    /// the run's permit. A later check reads the gate again. The release gives the permit back once.
    /// </summary>
    private sealed class ClaimPermit(RunState run)
    {
        private bool _held;

        internal bool Admit()
        {
            if (!_held)
            {
                _held = run.AcquireClaimPermit();
                return _held;
            }

            return run.GateOpen;
        }

        internal void Release()
        {
            if (_held)
            {
                _held = false;
                run.ReleaseClaimPermit();
            }
        }
    }

    /// <summary>The claim gate closed before the fast claim went out.</summary>
    private sealed class ClaimWithdrawnException : Exception;
}
