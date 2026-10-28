using Npgsql;

namespace Workhorse.Tests;

/// <summary>
/// SM-1902: a worker needs a pool of at least 3 connections: the listener, the heartbeat
/// connection, and one statement. A pooled data source reports its <c>Max Pool Size</c>, so a
/// smaller pool fails at construction. Without pooling, Npgsql has no client-side limit, and the
/// readiness check at startup is the guard. Nothing here reaches PostgreSQL: the address is a
/// closed port.
/// </summary>
public sealed class WorkerPoolSizeTests
{
    private static NpgsqlDataSource DataSource(Action<NpgsqlConnectionStringBuilder> pool)
    {
        var connection = new NpgsqlConnectionStringBuilder("Host=127.0.0.1;Port=1;Database=workhorse;Username=workhorse;Timeout=1");
        pool(connection);
        return NpgsqlDataSource.Create(connection);
    }

    [Theory]
    [InlineData(1, false)]
    [InlineData(2, false)]
    [InlineData(1, true)]
    [InlineData(2, true)]
    public async Task AWorkerRefusesAPoolBelowThree(int size, bool pollingOnly)
    {
        await using var small = DataSource(builder => builder.MaxPoolSize = size);
        var refusal = Assert.Throws<ArgumentException>(() =>
            new Worker(small, new WorkerOptions { Queues = ["pool"], PollingOnly = pollingOnly }));

        Assert.StartsWith(
            $"Worker needs a pool with a known maximum size of at least 3 connections (found {size}). "
            + "Give the worker a pool with a maximum size of at least 3.",
            refusal.Message,
            StringComparison.Ordinal);
        Assert.Equal("dataSource", refusal.ParamName);
        Assert.DoesNotContain("SharedHeartbeats", refusal.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AWorkerAcceptsAPoolOfThree()
    {
        await using var pool = DataSource(builder => builder.MaxPoolSize = 3);
        await using var worker = new Worker(pool, new WorkerOptions { Queues = ["pool"] });
        Assert.Equal("pool", Assert.Single(worker.Queues));
    }

    /// <summary>
    /// Without pooling, the worker does not read <c>Max Pool Size</c>, so construction passes. The
    /// readiness check then refuses the start, and its error states the size rule and the next step.
    /// </summary>
    [Fact]
    public async Task WithoutPoolingTheReadinessCheckIsTheGuard()
    {
        await using var unpooled = DataSource(builder =>
        {
            builder.Pooling = false;
            builder.MaxPoolSize = 1;
        });
        // A lease of 3 s gives a heartbeat of 1 s, so the startup budget is its floor of 5 s.
        await using var worker = new Worker(unpooled, new WorkerOptions { Queues = ["pool"], Lease = TimeSpan.FromSeconds(3) });

        var refusal = await Assert.ThrowsAsync<WorkerStartupException>(() => worker.RunAsync(TestContext.Current.CancellationToken));
        Assert.Contains("The data source does not pool, so its size is unknown.", refusal.Message, StringComparison.Ordinal);
        Assert.EndsWith("Grow the pool, or check that the database accepts connections.", refusal.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("SharedHeartbeats", refusal.Message, StringComparison.Ordinal);
    }
}
