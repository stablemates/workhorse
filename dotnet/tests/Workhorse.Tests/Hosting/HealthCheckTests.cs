using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Npgsql;
using Workhorse.Hosting;
using Workhorse.Hosting.Internal;
using Workhorse.Tests.Testing;
using static Workhorse.Tests.Testing.WorkerHarness;

namespace Workhorse.Tests.Hosting;

/// <summary>The <c>workhorse</c> health check (ADR 0107, "Hosting and dependency injection").</summary>
public sealed class HealthCheckTests(ScratchDatabase database)
{
    private static CancellationToken Token => TestContext.Current.CancellationToken;

    [Fact]
    public async Task ACompatibleDatabaseIsHealthy()
    {
        using var host = HostWithHealthCheck(database.DataSource);
        var report = await host.Services.GetRequiredService<HealthCheckService>().CheckHealthAsync(Token);

        var entry = report.Entries["workhorse"];
        Assert.Equal(HealthStatus.Healthy, entry.Status);
        Assert.False(entry.Data.ContainsKey("state"));
    }

    [Fact]
    public async Task AnUnavailableDatabaseIsUnhealthyAndARecoveredOneIsHealthyAgain()
    {
        var target = new NpgsqlConnectionStringBuilder(database.DataSource.ConnectionString);
        await using var proxy = new FaultProxy(target.Host!, target.Port);
        await using var dataSource = database.CreateDataSource(builder =>
        {
            builder.Host = "127.0.0.1";
            builder.Port = proxy.Port;
            builder.Pooling = false;
            builder.Timeout = 3;
        });
        using var host = HostWithHealthCheck(dataSource);
        var health = host.Services.GetRequiredService<HealthCheckService>();
        Assert.Equal(HealthStatus.Healthy, (await health.CheckHealthAsync(Token)).Status);

        await proxy.FreezeAsync(refuseConnections: true);
        var down = (await health.CheckHealthAsync(Token)).Entries["workhorse"];
        Assert.Equal(HealthStatus.Unhealthy, down.Status);
        Assert.Equal("The Workhorse database is unavailable", down.Description);
        Assert.NotNull(down.Exception);

        // The check runs the query each time, so no cached result hides the recovery.
        proxy.Thaw();
        Assert.Equal(HealthStatus.Healthy, (await health.CheckHealthAsync(Token)).Status);
    }

    [Fact]
    public async Task ADatabaseWithoutTheSchemaIsUnhealthy()
    {
        await using var noSchema = database.CreateDataSource(builder => builder.Database = "postgres");
        using var host = HostWithHealthCheck(noSchema);
        var entry = (await host.Services.GetRequiredService<HealthCheckService>().CheckHealthAsync(Token)).Entries["workhorse"];

        Assert.Equal(HealthStatus.Unhealthy, entry.Status);
        Assert.IsType<CompatibilityException>(entry.Exception);
    }

    [Fact]
    public async Task AWorkerThatAbandonedHandlersOrFailedIsUnhealthy()
    {
        await using var worker = new Worker(database.DataSource, Options(UniqueQueue("health")));
        var queue = new Queue(database.DataSource);
        var context = new HealthCheckContext
        {
            Registration = new HealthCheckRegistration("workhorse", _ => throw new InvalidOperationException(), null, null),
        };

        var state = new WorkerState();
        state.Started(worker);
        var check = new WorkhorseHealthCheck(new WorkhorseDataSource(database.DataSource), queue, state);
        var running = await check.CheckHealthAsync(context, Token);
        Assert.Equal(HealthStatus.Healthy, running.Status);
        Assert.Equal("running", running.Data["state"]);
        Assert.Equal(worker.WorkerId, running.Data["workerId"]);

        state.Ended(stopRequested: true);
        Assert.Equal(HealthStatus.Healthy, (await check.CheckHealthAsync(context, Token)).Status);

        state.Faulted(new ShutdownIncompleteException(2));
        var abandoned = await check.CheckHealthAsync(context, Token);
        Assert.Equal(HealthStatus.Unhealthy, abandoned.Status);
        Assert.Equal("abandoned", abandoned.Data["state"]);

        state.Ended(stopRequested: false);
        var ended = await check.CheckHealthAsync(context, Token);
        Assert.Equal(HealthStatus.Unhealthy, ended.Status);
        Assert.Equal("failed", ended.Data["state"]);
    }

    private static Microsoft.Extensions.Hosting.IHost HostWithHealthCheck(NpgsqlDataSource dataSource)
    {
        var testing = new HostingTesting(dataSource, UniqueQueue("health"));
        testing.Services.AddHealthChecks().AddWorkhorse();
        return testing.Build();
    }
}
