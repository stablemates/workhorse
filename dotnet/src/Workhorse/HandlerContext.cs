using Workhorse.Internal.Runtime;

namespace Workhorse;

/// <summary>
/// What a handler receives with its payload: the claimed task, its cancellation token, and the cause
/// of a cancellation (ADR 0107, "<c>CancelReason</c> is on the context").
/// </summary>
/// <remarks>
/// Only the SDK derives from this class, so it can gain members without a breaking change. The
/// durable methods follow in a later minor.
/// </remarks>
public abstract class HandlerContext
{
    private readonly TaskCancellation _cancellation;

    private protected HandlerContext(ClaimedTask task, TaskCancellation cancellation)
    {
        Task = task;
        _cancellation = cancellation;
    }

    /// <summary>The task that the handler runs.</summary>
    public ClaimedTask Task { get; }

    /// <summary>
    /// The token that the worker cancels when the attempt must stop. The worker sets
    /// <see cref="CancelReason"/> before it cancels the token.
    /// </summary>
    public CancellationToken CancellationToken => _cancellation.Token;

    /// <summary>Why the worker cancelled <see cref="CancellationToken"/>, or <c>null</c> before that.</summary>
    public CancelReason? CancelReason => _cancellation.Reason;

    internal TaskCancellation Cancellation => _cancellation;
}
