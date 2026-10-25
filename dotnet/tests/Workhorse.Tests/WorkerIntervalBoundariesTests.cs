using Npgsql;

namespace Workhorse.Tests;

/// <summary>
/// SM-1668 PAR-09 (ADR 0112). With a live subscription, an explicit poll interval is the fallback
/// interval, so the 5,000 ms cap does not apply; without one, the cap applies before the jitter. A
/// registered worker cuts the wait to its registry interval. The maintenance, routine, and registry
/// intervals accept 100 through 2,147,483,647 ms.
/// </summary>
public sealed class WorkerIntervalBoundariesTests
{
    private static Worker UnconnectedWorker(Action<WorkerOptions> configure)
    {
        // The worker opens no connection here, so the address is never reached.
        var dataSource = NpgsqlDataSource.Create("Host=127.0.0.1;Port=1;Database=workhorse;Username=workhorse");
        var options = new WorkerOptions { Queues = ["intervals"], SharedHeartbeats = true };
        configure(options);
        return new Worker(dataSource, options);
    }

    [Theory]
    [InlineData(true, 0.9, 27_000L)]
    [InlineData(true, 1.1, 33_000L)]
    [InlineData(false, 0.9, 4_500L)]
    [InlineData(false, 1.1, 5_500L)]
    public void AnExplicitPollIntervalIsCappedOnlyWhileTheWorkerPolls(bool listening, double jitter, long wait) =>
        Assert.Equal(wait, Worker.DispatchWaitMillis(listening, 4, 30_000, 30_000, 0, jitter));

    [Theory]
    [InlineData(true, 0.9)]
    [InlineData(false, 1.1)]
    public void ARegisteredWorkerCutsTheJitteredWaitToTheRegistryInterval(bool listening, double jitter) =>
        Assert.Equal(5_000L, Worker.DispatchWaitMillis(listening, 4, 30_000, 30_000, 5_000, jitter));

    [Theory]
    [InlineData(100L * TimeSpan.TicksPerMillisecond)]
    [InlineData((99L * TimeSpan.TicksPerMillisecond) + 5_000)]
    [InlineData(2_147_483_647L * TimeSpan.TicksPerMillisecond)]
    public async Task AnIntervalFrom100MsThroughTheSqlIntegerLimitIsAccepted(long ticks)
    {
        var interval = TimeSpan.FromTicks(ticks);
        await using var worker = UnconnectedWorker(options =>
        {
            options.MaintenanceInterval = interval;
            options.MaintenanceRoutineInterval = interval;
            options.RegistryInterval = interval;
        });
    }

    public static TheoryData<string, long> Refused()
    {
        var data = new TheoryData<string, long>();
        foreach (var option in new[] { "MaintenanceInterval", "MaintenanceRoutineInterval", "RegistryInterval" })
        {
            foreach (var ticks in new[] { 0L, 99L * TimeSpan.TicksPerMillisecond, 2_147_483_648L * TimeSpan.TicksPerMillisecond, -TimeSpan.TicksPerMillisecond })
            {
                data.Add(option, ticks);
            }
        }

        return data;
    }

    [Theory]
    [MemberData(nameof(Refused))]
    public void AnIntervalOutsideTheRangeIsRefused(string option, long ticks)
    {
        var interval = TimeSpan.FromTicks(ticks);
        var error = Assert.Throws<ArgumentException>(() => UnconnectedWorker(options =>
            typeof(WorkerOptions).GetProperty(option)!.SetValue(options, interval)));
        Assert.Contains(option, error.Message, StringComparison.Ordinal);
    }

    // SM-1778 (ADR 0112): every SDK accepts an explicit poll interval from 1 through 2,147,483,647
    // ms. A null PollInterval keeps the default.
    [Theory]
    [InlineData(TimeSpan.TicksPerMillisecond)]
    [InlineData(TimeSpan.TicksPerMillisecond / 2)]
    [InlineData(2_147_483_647L * TimeSpan.TicksPerMillisecond)]
    public async Task APollIntervalFrom1MsThroughTheSqlIntegerLimitIsAccepted(long ticks)
    {
        await using var worker = UnconnectedWorker(options => options.PollInterval = TimeSpan.FromTicks(ticks));
    }

    [Theory]
    [InlineData(0L)]
    [InlineData(4_000L)]
    [InlineData(2_147_483_648L * TimeSpan.TicksPerMillisecond)]
    [InlineData(-TimeSpan.TicksPerMillisecond)]
    public void APollIntervalOutsideTheRangeIsRefused(long ticks)
    {
        var error = Assert.Throws<ArgumentException>(() =>
            UnconnectedWorker(options => options.PollInterval = TimeSpan.FromTicks(ticks)));
        Assert.Contains(nameof(WorkerOptions.PollInterval), error.Message, StringComparison.Ordinal);
    }
}
