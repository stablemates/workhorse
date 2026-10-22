namespace Workhorse.Internal.Runtime;

/// <summary>How the worker settled one attempt. The first submission wins.</summary>
internal enum Outcome
{
    Completed,
    Failed,
    Retry,
    LeaseExpired,
    Released,
    DeadlineExceeded,
    AttemptTimeout,
    Cancelled,
    SuspendedForWait,
    SuspendedForChild,
}

/// <summary>
/// Decides the outcome of one attempt. The first submission wins, whether it comes from the handler,
/// the heartbeat, or the worker.
/// </summary>
internal sealed class Arbiter
{
    private const int None = -1;
    private int _outcome = None;

    internal Outcome? Current
    {
        get
        {
            var outcome = Volatile.Read(ref _outcome);
            return outcome == None ? null : (Outcome)outcome;
        }
    }

    /// <summary>Submits an outcome. Returns whether it won.</summary>
    internal bool Submit(Outcome outcome) => Interlocked.CompareExchange(ref _outcome, (int)outcome, None) == None;
}

/// <summary>
/// One attempt's hold on its lease: the local lease window, the heartbeat membership, and the
/// watchdog. A renewal and the watchdog check the window under one lock, so a renewal cannot move a
/// window that has already ended.
/// </summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage("Design", "CA1001", Justification = "An abandoned handler can still read the token after its attempt ends, so the source is never disposed. It holds no timer.")]
internal sealed class Ownership
{
    private readonly Lock _window = new();
    private readonly CancellationTokenSource _stop = new();
    private long _renewedAt;
    private bool _lapsed;
    private int _released;
    private Action? _unregister;

    internal Ownership(long renewedAt, long leaseNanos)
    {
        _renewedAt = renewedAt;
        LeaseNanos = leaseNanos;
    }

    internal long LeaseNanos { get; }

    /// <summary>Errors of a heartbeat settlement. The attempt throws the first one.</summary>
    internal System.Collections.Concurrent.ConcurrentQueue<Exception> Errors { get; } = new();

    /// <summary>Serializes the settlements that a heartbeat status and the watchdog send.</summary>
    internal SemaphoreSlim Settlement { get; } = new(1, 1);

    /// <summary>1 while a heartbeat settlement waits or runs, so repeated statuses coalesce.</summary>
    internal int Settling;

    /// <summary>Cancelled when the heartbeat stops renewing the lease.</summary>
    internal CancellationToken Stopped => _stop.Token;

    /// <summary>The watchdog, which <see cref="ReleaseAsync"/> waits for.</summary>
    internal Task? Watchdog { get; set; }

    /// <summary>The time of the latest accepted renewal, a <see cref="Monotonic"/> value.</summary>
    internal long RenewedAt => Interlocked.Read(ref _renewedAt);

    internal long LeaseDeadline => RenewedAt + LeaseNanos;

    internal void Start(Action unregister) => _unregister = unregister;

    /// <summary>
    /// Applies an accepted round that left at <paramref name="sentAt"/>. Returns <c>true</c> when the
    /// window had already ended: the round renews nothing, and the caller ends the attempt as the
    /// watchdog would. A late answer never opens the window again.
    /// </summary>
    internal bool Renew(long sentAt)
    {
        lock (_window)
        {
            if (_lapsed || _stop.IsCancellationRequested)
            {
                return false;
            }

            if (LeaseDeadline - Monotonic.Now() <= 0)
            {
                _lapsed = true;
                return true;
            }

            if (sentAt - _renewedAt > 0)
            {
                Interlocked.Exchange(ref _renewedAt, sentAt);
            }

            return false;
        }
    }

    /// <summary>The time left in the window at <paramref name="now"/>, or at most zero once it ended.</summary>
    internal long LeaseRemaining(long now)
    {
        lock (_window)
        {
            return _lapsed ? 0 : LeaseDeadline - now;
        }
    }

    /// <summary>Closes a window that has ended. Returns <c>true</c> for the one caller that closes it.</summary>
    internal bool Lapse()
    {
        lock (_window)
        {
            if (_lapsed)
            {
                return false;
            }

            _lapsed = true;
            return true;
        }
    }

    /// <summary>Stops renewing without a wait for the watchdog. A lapse and a shutdown abandon with this.</summary>
    internal void Abandon()
    {
        _unregister?.Invoke();
        try
        {
            _stop.Cancel();
        }
        catch (AggregateException)
        {
            // Only the watchdog registers on the token, and it ends on its own.
        }
    }

    /// <summary>Stops renewing and waits for the watchdog. Only the first call acts.</summary>
    internal async Task ReleaseAsync()
    {
        if (Interlocked.Exchange(ref _released, 1) != 0)
        {
            return;
        }

        Abandon();
        if (Watchdog is { } watchdog)
        {
            await watchdog.ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
        }
    }
}
