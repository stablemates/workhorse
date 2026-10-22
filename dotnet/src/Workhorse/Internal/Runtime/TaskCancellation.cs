namespace Workhorse.Internal.Runtime;

/// <summary>
/// The cancellation of one attempt: its token and the reason. Only the worker cancels it. The first
/// reason wins.
/// </summary>
internal sealed class TaskCancellation : IDisposable
{
    private const int NoReason = -1;

    private readonly CancellationTokenSource _source = new();
    private int _reason = NoReason;

    /// <summary>The token that the handler receives.</summary>
    internal CancellationToken Token => _source.Token;

    /// <summary>The reason, or <c>null</c> before a cancellation.</summary>
    internal CancelReason? Reason
    {
        get
        {
            var reason = Volatile.Read(ref _reason);
            return reason == NoReason ? null : (CancelReason)reason;
        }
    }

    /// <summary>
    /// Sets <paramref name="reason"/> and then cancels the token. Returns whether this call set the
    /// reason.
    /// </summary>
    /// <remarks>
    /// The heartbeat thread and the drain cancel tokens. The token's callbacks are handler code, so
    /// they run on the thread pool and never on the caller's thread: a callback that blocks must not
    /// hold up a lease renewal or the drain.
    /// </remarks>
    internal bool Cancel(CancelReason reason)
    {
        if (Interlocked.CompareExchange(ref _reason, (int)reason, NoReason) != NoReason)
        {
            return false;
        }

        try
        {
            _ = _source.CancelAsync();
        }
        catch (ObjectDisposedException)
        {
            // The attempt has ended, so nothing reads the token any more.
        }

        return true;
    }

    public void Dispose() => _source.Dispose();
}
