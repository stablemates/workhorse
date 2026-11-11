using Npgsql;
using Workhorse.Tests.Testing;

namespace Workhorse.Tests.Conformance;

/// <summary>
/// The entry point of <c>scripts/cross-sdk-replay.ts</c>. It runs one phase of a
/// <c>durable-script</c> fixture against a database that the harness owns, and the harness sets its
/// environment. The test returns at once when the harness did not start it.
/// </summary>
public sealed class CrossSdkPhaseTests
{
    [Fact]
    public async Task RunsOnePhaseOfACrossSdkDurableScriptFixture()
    {
        var phase = Environment.GetEnvironmentVariable("WORKHORSE_CROSS_SDK_PHASE");
        if (phase is null)
        {
            return;
        }

        var id = Environment.GetEnvironmentVariable("WORKHORSE_CROSS_SDK_FIXTURE")!;
        // The parse of the scratch-database helper, so both phases get the same options.
        var connection = ScratchTemplate.Parse(new Uri(Environment.GetEnvironmentVariable("WORKHORSE_CROSS_SDK_DATABASE_URL")!)).ConnectionString;
        var fixtures = (List<object?>)Json.Parse(await File.ReadAllTextAsync(Repository.Path("protocol/v1/runtime.json"), TestContext.Current.CancellationToken))!;
        var fixture = fixtures.Select(entry => Runner.Object(entry, "fixture")).Single(entry => Matcher.Same(entry["id"], id));
        await using var dataSource = NpgsqlDataSource.Create(connection);
        await new DurableScript(() => new NpgsqlDataSourceBuilder(connection), dataSource).RunAsync(fixture, phase);
    }
}
