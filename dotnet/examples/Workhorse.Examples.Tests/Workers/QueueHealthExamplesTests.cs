using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Workhorse.Examples.Tests.Testing;
using Workhorse.Examples.Workers;
using Workhorse.Tests.Testing;

namespace Workhorse.Examples.Tests.Workers;

/// <summary>Runs the C# snippets of the site page about queue health.</summary>
public sealed class QueueHealthExamplesTests(ScratchDatabase scratch)
{
    [Fact]
    public async Task TheSnapshotHasAStatusLevel()
    {
        var db = ExampleDatabase.Shared(scratch);
        var health = await new QueueHealthExamples(db.Queue).CheckHealthAsync();
        var level = health.Snapshot["status"].GetProperty("level").GetString();
        Assert.NotNull(level);
    }

    [Fact]
    public async Task TheHealthCheckReportsACompatibleDatabaseAsHealthy()
    {
        var db = ExampleDatabase.Shared(scratch);
        using var host = QueueHealthExamples.HealthCheckHost([], db.DataSource);
        var report = await host.Services.GetRequiredService<HealthCheckService>().CheckHealthAsync(TestContext.Current.CancellationToken);
        Assert.Equal(HealthStatus.Healthy, report.Entries["workhorse"].Status);
    }
}
