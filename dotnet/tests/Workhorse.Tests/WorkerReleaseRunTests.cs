using Workhorse.Internal.Runtime;

namespace Workhorse.Tests;

/// <summary>
/// SM-1905 (ADR 0126). Each release puts its task behind the other ready tasks, so the continuous
/// loop claims again at once until a task comes back or the release run reaches its limit.
/// </summary>
public sealed class WorkerReleaseRunTests
{
    private static readonly Guid Repeated = Guid.NewGuid();

    [Fact]
    public void ClaimsAgainAfterAReleasedOnlyClaimAndWaitsWhenATaskComesBack()
    {
        var run = new ReleaseRun();
        Assert.Equal(ReleaseRunStep.ClaimAgain, run.Settle([Repeated], continuous: true));
        Assert.Equal(ReleaseRunStep.ReleaseWait, run.Settle([Repeated], continuous: true));
        Assert.Equal(0, run.Claims);
    }

    [Fact]
    public void StartsTheReleaseWaitAfterTheReleaseRunLimit()
    {
        var run = new ReleaseRun();
        for (var index = 1; index < ReleaseRun.Limit; index++)
        {
            Assert.Equal(ReleaseRunStep.ClaimAgain, run.Settle([Guid.NewGuid()], continuous: true));
        }

        Assert.Equal(ReleaseRunStep.ReleaseWait, run.Settle([Guid.NewGuid()], continuous: true));
    }

    [Fact]
    public void StartsTheReleaseWaitAfterAnEmptyClaimInsideARunAndAnEmptyWaitOutsideOne()
    {
        var run = new ReleaseRun();
        run.Settle([Repeated], continuous: true);
        Assert.Equal(ReleaseRunStep.ReleaseWait, run.Settle([], continuous: true));
        Assert.Equal(ReleaseRunStep.EmptyWait, run.Settle([], continuous: true));
    }

    [Fact]
    public void ARunThatEndsAtAHandlerStartsAgain()
    {
        var run = new ReleaseRun();
        run.Settle([Repeated], continuous: true);
        run.End();
        Assert.Equal(ReleaseRunStep.ClaimAgain, run.Settle([Repeated], continuous: true));
        Assert.Equal(1, run.Claims);
    }

    [Fact]
    public void ASinglePassEndsAtItsFirstReleasedOnlyClaim()
    {
        var run = new ReleaseRun();
        Assert.Equal(ReleaseRunStep.ReleaseWait, run.Settle([Repeated], continuous: false));
        Assert.Equal(ReleaseRunStep.EmptyWait, run.Settle([], continuous: false));
    }
}
