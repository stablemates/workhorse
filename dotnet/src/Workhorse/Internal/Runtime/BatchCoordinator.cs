namespace Workhorse.Internal.Runtime;

/// <summary>
/// Groups the tasks of one batch handler. The counterpart of Ruby's and the JVM's
/// <c>BatchCoordinator</c>.
/// </summary>
/// <remarks>
/// Each member runs on its own handler task, under its own lease, and joins its queue's waiting
/// list. The member that fills a batch, or whose linger ends first, runs the handler for the whole
/// batch. The others wait for their outcomes. Each member then settles its own attempt with its own
/// outcome. A member waits for its outcome even when its own token is cancelled, because another
/// member can already have taken it into a batch whose handler runs its payload.
/// </remarks>
internal sealed class BatchCoordinator
{
    /// <summary>How often a lingering member checks for the last arrival while the worker stops.</summary>
    private static readonly long DrainPollNanos = Monotonic.Millis(50);

    private readonly IHost _host;
    private readonly string _taskType;
    private readonly int _maxSize;
    private readonly long _lingerNanos;
    private readonly Func<IReadOnlyList<Member>, CancellationToken, Task<IReadOnlyList<BatchHandlerOutcome>>> _handler;
    private readonly Lock _lock = new();
    private readonly Dictionary<string, List<Member>> _pending = new(StringComparer.Ordinal);
    private readonly HashSet<(Guid TaskId, long FenceToken)> _entered = [];
    private TaskCompletionSource _changed = NewSignal();

    internal BatchCoordinator(
        IHost host,
        string taskType,
        BatchOptions options,
        Func<IReadOnlyList<Member>, CancellationToken, Task<IReadOnlyList<BatchHandlerOutcome>>> handler)
    {
        _host = host;
        _taskType = taskType;
        _maxSize = options.MaxSize;
        _lingerNanos = Monotonic.Nanos(options.Linger);
        _handler = handler;
    }

    /// <summary>What the coordinator needs from its worker.</summary>
    internal interface IHost
    {
        /// <summary>Whether the worker drains.</summary>
        bool Draining { get; }

        /// <summary>The claim order that dispatch gave an attempt. An attempt that dispatch never saw sorts last.</summary>
        long ClaimOrder(ClaimedTask task);

        /// <summary>
        /// Whether the worker drains and every attempt of <paramref name="taskType"/> that it admitted
        /// from <paramref name="queue"/> is in <paramref name="entered"/>, by task ID and fence token.
        /// No later member can join a batch then. The caller holds the coordinator's lock.
        /// </summary>
        bool ArrivalsComplete(string taskType, string queue, IReadOnlySet<(Guid TaskId, long FenceToken)> entered);

        /// <summary>
        /// Whether the drain abandoned the attempt of <paramref name="task"/>, or the attempt already
        /// ended. Its lease is no longer renewed, so no application code may run its payload.
        /// </summary>
        bool Abandoned(ClaimedTask task);

        /// <summary>Logs one batch as it starts.</summary>
        void BatchDispatched(string taskType, IReadOnlyList<ClaimedTask> tasks, bool full, long lingerMs);

        /// <summary>Records the dispatch or failure evidence of a batch. A failure only logs.</summary>
        Task RecordEvidenceAsync(bool failure, Guid batchId, string taskType, IReadOnlyList<ClaimedTask> tasks, bool full);
    }

    /// <summary>One task that waits in the coordinator.</summary>
    internal sealed class Member(HandlerContext context, object? payload, long order)
    {
        internal long ArrivedAt { get; } = Monotonic.Now();

        internal long Order { get; } = order;

        internal object? Payload { get; } = payload;

        internal HandlerContext HandlerContext { get; } = context;

        internal BatchHandlerContext Context { get; } = new(context);

        internal ClaimedTask Task => HandlerContext.Task;

        internal TaskCompletionSource<object?> Result { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }

    /// <summary>Wakes every lingering member, because the worker began to stop.</summary>
    internal void Flush() => Signal();

    /// <summary>
    /// Forgets the arrival of the attempt of <paramref name="task"/> when that attempt ends. A member counts as
    /// arrived until then, also while its settlement waits, so the drain does not wait for it as for a
    /// task that has not reached the coordinator yet.
    /// </summary>
    internal void Leave(ClaimedTask task)
    {
        lock (_lock)
        {
            // A retry of the same task has another fence token, so this attempt cannot remove it.
            _entered.Remove((task.Id, task.FenceToken));
        }

        Signal();
    }

    /// <summary>
    /// Runs one member: decodes its payload, joins a batch, lingers, and returns the member's result
    /// or throws its error. The arrival counts before the decode, so an attempt whose payload does not
    /// decode does not hold the drain.
    /// </summary>
    internal async Task<object?> RunAsync(HandlerContext context, Func<object?> decode)
    {
        lock (_lock)
        {
            _entered.Add((context.Task.Id, context.Task.FenceToken));
        }

        var member = new Member(context, decode(), _host.ClaimOrder(context.Task));
        var queue = member.Task.Queue;
        List<Member> batch;
        long firstArrivedAt;
        lock (_lock)
        {
            if (!_pending.TryGetValue(queue, out var waiting))
            {
                waiting = [];
                _pending[queue] = waiting;
            }

            // Every member enters in order, so the prefix of the waiting list is the next batch.
            var index = 0;
            while (index < waiting.Count && Compare(waiting[index], member) <= 0)
            {
                index++;
            }

            waiting.Insert(index, member);
            firstArrivedAt = waiting.Min(other => other.ArrivedAt);
            batch = waiting.Count >= _maxSize ? Take(queue) : [];
        }

        try
        {
            await DispatchAsync(batch).ConfigureAwait(false);
            // A member that the full batch left behind lingers too. Once its linger ends, it runs every
            // batch ahead of it and then its own, so no member waits for a later arrival.
            if (!await LingerAsync(member, queue, firstArrivedAt + _lingerNanos).ConfigureAwait(false))
            {
                while (true)
                {
                    List<Member>? next;
                    lock (_lock)
                    {
                        next = _pending.TryGetValue(queue, out var waiting) && waiting.Contains(member) ? Take(queue) : null;
                    }

                    if (next is null)
                    {
                        break;
                    }

                    await DispatchAsync(next).ConfigureAwait(false);
                }
            }

            return await member.Result.Task.ConfigureAwait(false);
        }
        finally
        {
            lock (_lock)
            {
                // A member that leaves on an unexpected error must not join a later batch.
                if (_pending.TryGetValue(queue, out var waiting) && waiting.Remove(member) && waiting.Count == 0)
                {
                    _pending.Remove(queue);
                }
            }
        }
    }

    /// <summary>Descending task priority, then claim order.</summary>
    private static int Compare(Member left, Member right)
    {
        var priority = right.Task.Priority.CompareTo(left.Task.Priority);
        return priority != 0 ? priority : left.Order.CompareTo(right.Order);
    }

    private static TaskCompletionSource NewSignal() => new(TaskCreationOptions.RunContinuationsAsynchronously);

    /// <summary>
    /// Waits until <paramref name="member"/> settles, its linger ends at <paramref name="end"/>, or the
    /// worker stops with every member it claimed already here. Returns whether the member settled.
    /// </summary>
    private async Task<bool> LingerAsync(Member member, string queue, long end)
    {
        while (true)
        {
            if (member.Result.Task.IsCompleted)
            {
                return true;
            }

            Task changed;
            bool complete;
            lock (_lock)
            {
                changed = _changed.Task;
                complete = _host.ArrivalsComplete(_taskType, queue, _entered);
            }

            var remaining = end - Monotonic.Now();
            if (remaining <= 0 || complete)
            {
                return member.Result.Task.IsCompleted;
            }

            if (_host.Draining)
            {
                remaining = Math.Min(remaining, DrainPollNanos);
            }

            try
            {
                await Task.WhenAny(member.Result.Task, changed).WaitAsync(Monotonic.Span(remaining)).ConfigureAwait(false);
            }
            catch (TimeoutException)
            {
                // The linger, or the drain poll, ended. The loop reads the state again.
            }
        }
    }

    /// <summary>Removes the next batch from a queue's waiting list. The caller holds the lock.</summary>
    private List<Member> Take(string queue)
    {
        if (!_pending.TryGetValue(queue, out var waiting))
        {
            return [];
        }

        var count = Math.Min(_maxSize, waiting.Count);
        var batch = waiting.GetRange(0, count);
        waiting.RemoveRange(0, count);
        if (waiting.Count == 0)
        {
            _pending.Remove(queue);
        }

        return batch;
    }

    /// <summary>Runs one batch and settles each of its members. Every member settles, whatever fails.</summary>
    private async Task DispatchAsync(List<Member> batch)
    {
        if (batch.Count == 0)
        {
            return;
        }

        try
        {
            await DispatchBatchAsync(batch).ConfigureAwait(false);
        }
        catch (Exception error)
        {
            // The worker's logging or evidence code threw outside the handler. A member on another
            // task waits for its result, so each member that has none fails with the error.
            foreach (var member in batch)
            {
                member.Result.TrySetException(error);
            }
        }
        finally
        {
            Signal();
        }
    }

    private async Task DispatchBatchAsync(List<Member> batch)
    {
        var batchId = Guid.NewGuid();
        var full = batch.Count == _maxSize;
        var tasks = batch.Select(member => member.Task).ToList();
        var lingerMs = Math.Max(0, (Monotonic.Now() - batch.Min(member => member.ArrivedAt)) / 1_000_000);
        _host.BatchDispatched(_taskType, tasks, full, lingerMs);
        await _host.RecordEvidenceAsync(failure: false, batchId, _taskType, tasks, full).ConfigureAwait(false);
        if (batch.Any(member => _host.Abandoned(member.Task)))
        {
            // The drain abandoned the attempts while the evidence waited. Their leases are no longer
            // renewed, so the handler must not run their payloads.
            foreach (var member in batch)
            {
                member.Result.TrySetException(new OperationCanceledException(member.Context.CancellationToken));
            }

            return;
        }

        using var cancellation = new BatchCancellation(batch);
        IReadOnlyList<BatchHandlerOutcome> outcomes;
        try
        {
            outcomes = Validate(await _handler(batch, cancellation.Token).ConfigureAwait(false), batch.Count);
        }
        catch (Exception error)
        {
            await _host.RecordEvidenceAsync(failure: true, batchId, _taskType, tasks, full).ConfigureAwait(false);
            foreach (var member in batch)
            {
                member.Result.TrySetException(ForMember(error, member, cancellation.Token));
            }

            return;
        }

        for (var index = 0; index < batch.Count; index++)
        {
            switch (outcomes[index])
            {
                case BatchSucceeded succeeded:
                    batch[index].Result.TrySetResult(succeeded.Result);
                    break;
                case BatchFailed failed:
                    batch[index].Result.TrySetException(ForMember(failed.Error, batch[index], cancellation.Token));
                    break;
            }
        }
    }

    /// <summary>
    /// The error that one member settles with. A cancellation of the batch token is a cancellation of
    /// the member's own token, so a member that stopped for the shutdown goes back to its queue.
    /// </summary>
    private static Exception ForMember(Exception error, Member member, CancellationToken batchToken) =>
        error is OperationCanceledException cancelled && cancelled.CancellationToken == batchToken && batchToken.CanBeCanceled
            ? new OperationCanceledException(cancelled.Message, cancelled, member.Context.CancellationToken)
            : error;

    /// <summary>
    /// The handler's outcomes, if they are one non-null outcome for each member. Otherwise every
    /// member fails with the error that this method throws.
    /// </summary>
    private IReadOnlyList<BatchHandlerOutcome> Validate(IReadOnlyList<BatchHandlerOutcome>? outcomes, int expected)
    {
        if (outcomes is null)
        {
            throw new WorkhorseException($"Batch handler for {_taskType} returned no outcome list");
        }

        if (outcomes.Count != expected)
        {
            throw new WorkhorseException($"Batch handler for {_taskType} returned {outcomes.Count} outcomes for {expected} tasks");
        }

        for (var index = 0; index < expected; index++)
        {
            if (outcomes[index] is not (BatchSucceeded or BatchFailed))
            {
                throw new WorkhorseException($"Batch handler for {_taskType} returned an invalid outcome at index {index}");
            }
        }

        return outcomes;
    }

    private void Signal()
    {
        TaskCompletionSource changed;
        lock (_lock)
        {
            changed = _changed;
            _changed = NewSignal();
        }

        changed.TrySetResult();
    }

    /// <summary>The batch token, cancelled once the worker cancelled the token of every member.</summary>
    private sealed class BatchCancellation : IDisposable
    {
        private readonly CancellationTokenSource _source = new();
        private readonly List<CancellationTokenRegistration> _registrations = [];
        private int _live;

        internal BatchCancellation(List<Member> batch)
        {
            _live = batch.Count;
            foreach (var member in batch)
            {
                _registrations.Add(member.Context.CancellationToken.Register(OneCancelled));
            }
        }

        internal CancellationToken Token => _source.Token;

        public void Dispose()
        {
            foreach (var registration in _registrations)
            {
                registration.Dispose();
            }

            _source.Dispose();
        }

        private void OneCancelled()
        {
            if (Interlocked.Decrement(ref _live) == 0)
            {
                try
                {
                    _source.Cancel();
                }
                catch (ObjectDisposedException)
                {
                    // The batch already ended.
                }
            }
        }
    }
}
