namespace Workhorse;

/// <summary>
/// Why the cancellation token of a task was cancelled. The worker sets it before it cancels the
/// token (ADR 0107, "<c>CancelReason</c> is on the context").
/// </summary>
public enum CancelReason
{
    /// <summary>An operator or a caller requested cancellation.</summary>
    Requested,

    /// <summary>The task passed its absolute deadline.</summary>
    DeadlineExceeded,

    /// <summary>The attempt passed its execution timeout.</summary>
    ExecutionTimeout,

    /// <summary>Another attempt owns the task now.</summary>
    LeaseLost,

    /// <summary>The handler suspended on a durable wait or a child join.</summary>
    Suspended,

    /// <summary>The worker is shutting down.</summary>
    Shutdown,
}

/// <summary>A handler observed its cancellation.</summary>
public sealed class CancelledException : WorkhorseException
{
    /// <summary>An exception for the cancellation reason.</summary>
    public CancelledException(CancelReason reason)
        : base($"task cancelled: {(Enum.IsDefined(reason) ? Internal.Wire.Text(reason) : reason.ToString())}")
    {
        Reason = reason;
    }

    /// <summary>Why the task was cancelled.</summary>
    public CancelReason Reason { get; }
}

/// <summary>The shutdown grace elapsed while handlers were still running.</summary>
public sealed class ShutdownIncompleteException : WorkhorseException
{
    /// <summary>An exception for the number of abandoned tasks.</summary>
    public ShutdownIncompleteException(int abandoned)
        : base($"shutdown grace elapsed with {abandoned} tasks still running")
    {
        Abandoned = abandoned;
    }

    /// <summary>The number of tasks that were still running.</summary>
    public int Abandoned { get; }
}

/// <summary>
/// A worker with the dedicated heartbeat connection could not reserve that connection, or could
/// not borrow a connection for its readiness check, within its startup budget. The message names
/// the pool, the budget, and the <c>SharedHeartbeats</c> opt-out. A pool error is the inner exception.
/// </summary>
public sealed class WorkerStartupException : WorkhorseException
{
    /// <summary>An exception with <paramref name="message"/>.</summary>
    public WorkerStartupException(string message)
        : base(message)
    {
    }

    /// <summary>An exception with <paramref name="message"/> and the pool error.</summary>
    public WorkerStartupException(string message, Exception? innerException)
        : base(message, innerException)
    {
    }
}
