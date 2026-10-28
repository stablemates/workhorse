using Workhorse.Internal.Runtime;

namespace Workhorse.Tests.Internal.Runtime;

/// <summary>The first-submission rule of one attempt's outcome, and its one exception.</summary>
public sealed class ArbiterTests
{
    /// <summary>
    /// SM-1884: a late heartbeat round can submit a cancellation request first. If PostgreSQL then
    /// refuses the acknowledgement, the worker settled nothing, so the attempt reports a lost lease.
    /// </summary>
    [Fact]
    public void ReplacesARefusedCancellationWithALostLeaseAndKeepsEveryOtherOutcome()
    {
        var arbiter = new Arbiter();
        arbiter.Submit(Outcome.Cancelled);
        arbiter.RefuseCancellation();
        Assert.Equal(Outcome.LeaseExpired, arbiter.Current);

        var settled = new Arbiter();
        settled.Submit(Outcome.DeadlineExceeded);
        settled.RefuseCancellation();
        Assert.Equal(Outcome.DeadlineExceeded, settled.Current);
    }
}
