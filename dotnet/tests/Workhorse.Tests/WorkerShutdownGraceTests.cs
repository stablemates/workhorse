using System.Reflection;
using Npgsql;

namespace Workhorse.Tests;

/// <summary>
/// SM-1668 PAR-09: .NET accepts a shutdown grace from 0 through 1 day after half-up rounding. A zero
/// grace sets the stop deadline when the stop starts, so the drain waits for no handler, and the
/// whole stop ends within the 250 ms unwind window.
/// </summary>
public sealed class WorkerShutdownGraceTests
{
    private static Worker UnconnectedWorker(TimeSpan grace)
    {
        // The worker opens no connection here, so the address is never reached.
        var dataSource = NpgsqlDataSource.Create("Host=127.0.0.1;Port=1;Database=workhorse;Username=workhorse");
        return new Worker(dataSource, new WorkerOptions { Queues = ["grace"], ShutdownGrace = grace });
    }

    private static long GraceNanos(Worker worker) =>
        (long)typeof(Worker).GetField("_shutdownGraceNanos", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(worker)!;

    [Theory]
    [InlineData(0L, 0L)]
    [InlineData(4_999L, 0L)]
    [InlineData(TimeSpan.TicksPerMillisecond, 1_000_000L)]
    [InlineData(TimeSpan.TicksPerDay, 86_400_000_000_000L)]
    public async Task AGraceFromZeroThroughOneDayIsAccepted(long ticks, long nanos)
    {
        await using var worker = UnconnectedWorker(TimeSpan.FromTicks(ticks));
        Assert.Equal(nanos, GraceNanos(worker));
    }

    [Theory]
    [InlineData(-1L)]
    [InlineData(-TimeSpan.TicksPerMillisecond)]
    [InlineData(TimeSpan.TicksPerDay + TimeSpan.TicksPerMillisecond)]
    public void ANegativeGraceOrOneAboveOneDayIsRefused(long ticks) =>
        Assert.Throws<ArgumentException>(() => UnconnectedWorker(TimeSpan.FromTicks(ticks)));

    [Fact]
    public void AnInfiniteGraceIsRefused() =>
        Assert.Throws<ArgumentException>(() => UnconnectedWorker(Timeout.InfiniteTimeSpan));
}
