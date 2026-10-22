using Workhorse.Internal.Runtime;

namespace Workhorse.Tests.Durable;

/// <summary>The cancellation of a suspension when another outcome wins the arbiter first (ADR 0107, "Suspension").</summary>
public sealed class SuspensionTests
{
    /// <summary>
    /// A durable write records the release. The lease watchdog then wins the arbiter, sees the
    /// release, and leaves the token alone. The suspension loses the arbiter and still cancels the
    /// token with <see cref="CancelReason.Suspended"/>.
    /// </summary>
    [Fact]
    public void ASuspensionThatLosesTheArbiterStillCancelsTheToken()
    {
        var arbiter = new Arbiter();
        using var cancellation = new TaskCancellation();
        var ownership = new Ownership(Monotonic.Now(), Monotonic.Millis(1_000));
        arbiter.Release(Outcome.SuspendedForWait);
        Worker.ExpireLease(ownership, arbiter, cancellation);
        Assert.False(cancellation.Token.IsCancellationRequested);

        var suspension = Worker.SuspendAttempt(arbiter, cancellation, Outcome.SuspendedForWait);

        Assert.Equal(Outcome.LeaseExpired, arbiter.Current);
        Assert.True(arbiter.Suspended);
        Assert.True(cancellation.Token.IsCancellationRequested);
        Assert.Equal(CancelReason.Suspended, cancellation.Reason);
        Assert.Equal(cancellation.Token, suspension.CancellationToken);
    }

    [Fact]
    public void ASuspensionKeepsTheReasonOfAnEarlierCancellation()
    {
        var arbiter = new Arbiter();
        using var cancellation = new TaskCancellation();
        arbiter.Submit(Outcome.Cancelled);
        cancellation.Cancel(CancelReason.Requested);

        Worker.SuspendAttempt(arbiter, cancellation, Outcome.SuspendedForChild);

        Assert.Equal(Outcome.SuspendedForChild, arbiter.Released);
        Assert.Equal(CancelReason.Requested, cancellation.Reason);
    }
}
