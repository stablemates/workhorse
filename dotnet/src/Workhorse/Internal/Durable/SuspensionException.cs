namespace Workhorse.Internal.Durable;

/// <summary>
/// Unwinds a handler that a durable wait or a child join suspended (ADR 0107, "Suspension"). It
/// derives from <see cref="OperationCanceledException"/> and carries the token of the handler, so
/// <c>finally</c> blocks and <c>using</c> declarations run, and code that treats cancellation
/// correctly does not log it as a failure. The worker decides by the arbiter, not by this exception:
/// a handler that catches it and returns still suspends.
/// </summary>
internal sealed class SuspensionException : OperationCanceledException
{
    internal SuspensionException(CancellationToken token)
        : base("task handler suspended", token)
    {
    }
}
