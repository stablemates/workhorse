using Workhorse.Internal.Runtime;

namespace Workhorse.Tests.Internal.Runtime;

/// <summary>
/// SM-1745: the heartbeat statement and each idle gap of a round get one quarter of the time left.
/// The last quarter stays for COMMIT and the settings statement, as in every SDK (SM-1633).
/// </summary>
public sealed class HeartbeatRoundTimeoutsTests
{
    [Theory]
    [InlineData(100, "18")]
    [InlineData(10_000, "1875")]
    public void ARoundThatStartsOnTimeGetsOneQuarterOfItsBound(long intervalMs, string quarter)
    {
        // .NET measures the time left before BEGIN, so a round that starts on time has its whole
        // bound left: 75 ms at 100 ms and 7,500 ms at 10 s.
        var remaining = Heartbeat.RoundBoundNanos(Monotonic.Millis(intervalMs));

        Assert.Equal((quarter, quarter), HeldConnection.RoundTimeouts(remaining));
    }

    [Theory]
    [InlineData(8_000_000, "2")]
    [InlineData(3_000_000, "1")]
    [InlineData(999_000, "1")]
    [InlineData(750_000_000, "187")]
    [InlineData(2_250_000_000, "562")]
    public void EachBudgetIsOneQuarterOfTheTimeLeftAndAtLeastOneMillisecond(long remainingNanos, string quarter) =>
        Assert.Equal((quarter, quarter), HeldConnection.RoundTimeouts(remainingNanos));
}
