using Npgsql;

namespace Workhorse.Tests;

/// <summary>
/// SM-1758 (the .NET part of SM-1668 PAR-07): a pooled data source reports its <c>Max Pool Size</c>,
/// so the size caps the default cohorts. The cap is that size minus the listener and the heartbeat
/// connection. An explicit cohort count is never capped, and without pooling the size is unknown, so
/// the default is not capped. Building a worker opens no connection.
/// </summary>
public sealed class WorkerCohortsTests
{
    private static Task<int> CohortsAsync(int poolSize, int concurrency, Action<WorkerOptions>? configure = null) =>
        CohortsAsync(builder => builder.MaxPoolSize = poolSize, concurrency, configure);

    private static async Task<int> CohortsAsync(Action<NpgsqlConnectionStringBuilder> pool, int concurrency, Action<WorkerOptions>? configure = null)
    {
        // The worker opens no connection here, so the address is never reached.
        var connection = new NpgsqlConnectionStringBuilder("Host=127.0.0.1;Port=1;Database=workhorse;Username=workhorse");
        pool(connection);
        await using var dataSource = NpgsqlDataSource.Create(connection);
        var options = new WorkerOptions { Queues = ["cohorts"], Concurrency = concurrency };
        configure?.Invoke(options);
        await using var worker = new Worker(dataSource, options);
        return worker.Cohorts;
    }

    private static void WithoutPooling(NpgsqlConnectionStringBuilder builder)
    {
        builder.Pooling = false;
        builder.MaxPoolSize = 4;
    }

    [Theory]
    [InlineData(64, 3, 1)]
    [InlineData(64, 4, 2)]
    [InlineData(64, 6, 4)]
    [InlineData(64, 10, 8)]
    [InlineData(64, 50, 8)]
    [InlineData(4, 50, 1)]
    public async Task ADeclaredPoolSizeCapsTheDefaultAfterTheListenerAndTheHeartbeatConnection(int concurrency, int poolSize, int cohorts) =>
        Assert.Equal(cohorts, await CohortsAsync(poolSize, concurrency));

    [Fact]
    public async Task PollingOnlyAndSharedHeartbeatsReserveNoConnection()
    {
        Assert.Equal(3, await CohortsAsync(4, 64, options => options.PollingOnly = true));
        Assert.Equal(3, await CohortsAsync(4, 64, options => options.SharedHeartbeats = true));
        Assert.Equal(4, await CohortsAsync(4, 64, options =>
        {
            options.SharedHeartbeats = true;
            options.PollingOnly = true;
        }));

        // Under the opt-out, a pool of 1 lends no listener, so the worker polls.
        Assert.Equal(1, await CohortsAsync(1, 64, options => options.SharedHeartbeats = true));
        Assert.Equal(1, await CohortsAsync(2, 64, options => options.SharedHeartbeats = true));
    }

    [Fact]
    public async Task AnExplicitCountAndAnUnknownSizeStayUncapped()
    {
        Assert.Equal(8, await CohortsAsync(4, 64, options => options.Cohorts = 8));
        Assert.Equal(64, await CohortsAsync(3, 64, options => options.Cohorts = 64));
        // Without pooling, the worker ignores a Max Pool Size that the connection string states.
        Assert.Equal(8, await CohortsAsync(WithoutPooling, 64));
        Assert.Equal(8, await CohortsAsync(WithoutPooling, 64, options => options.SharedHeartbeats = true));

        // Npgsql reports its default Max Pool Size of 100, so the cap leaves the default unchanged.
        Assert.Equal(8, await CohortsAsync(_ => { }, 64));
    }
}
