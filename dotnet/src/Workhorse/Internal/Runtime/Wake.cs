namespace Workhorse.Internal.Runtime;

/// <summary>
/// Wakes the dispatch loop. A signal that arrives between <see cref="Reset"/> and
/// <see cref="WaitAsync"/> is not lost, because the wait then returns at once. The version moves on
/// each <see cref="Bump"/>, so an empty-claim wait can tell a state change from an older one.
/// </summary>
internal sealed class Wake
{
    private readonly Lock _lock = new();
    private TaskCompletionSource _signal = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private long _version;

    /// <summary>The number of state changes so far.</summary>
    internal long Version => Interlocked.Read(ref _version);

    /// <summary>Ends the current wait, or the next one.</summary>
    internal void Signal()
    {
        TaskCompletionSource signal;
        lock (_lock)
        {
            signal = _signal;
        }

        signal.TrySetResult();
    }

    /// <summary>Records a state change, and ends the current or next wait.</summary>
    internal void Bump()
    {
        Interlocked.Increment(ref _version);
        Signal();
    }

    /// <summary>Forgets a signal that a wait has seen.</summary>
    internal void Reset()
    {
        lock (_lock)
        {
            if (_signal.Task.IsCompleted)
            {
                _signal = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            }
        }
    }

    /// <summary>Waits until a signal or for <paramref name="nanos"/>.</summary>
    internal async Task WaitAsync(long nanos)
    {
        Task signal;
        lock (_lock)
        {
            signal = _signal.Task;
        }

        if (signal.IsCompleted || nanos <= 0)
        {
            return;
        }

        await signal.WaitAsync(Monotonic.Span(nanos)).ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
    }
}
