using System.Reflection;
using System.Reflection.Emit;
using System.Text.RegularExpressions;
using Workhorse.AspNetCore.Internal;
using Workhorse.Internal;
using Workhorse.Tests.Testing;
using static Workhorse.Tests.Testing.WorkerHarness;

namespace Workhorse.Tests;

/// <summary>
/// The SDK version that a C# worker registers, and its one reader (ADR 0107, "Governed surface and
/// release"). Each test reads the train version from <c>dotnet/Directory.Build.props</c>, so a wrong
/// version in the assembly fails here and does not pass as the expected value.
/// </summary>
public sealed partial class SdkVersionTests(ScratchDatabase database) : IClassFixture<ScratchDatabase>
{
    private sealed record Order(int OrderId);

    [GeneratedRegex("<Version>([^<]+)</Version>")]
    private static partial Regex VersionElement();

    /// <summary>The train version that <c>Directory.Build.props</c> sets.</summary>
    private static string TrainVersion()
    {
        var match = VersionElement().Match(File.ReadAllText(Repository.Path("dotnet/Directory.Build.props")));
        Assert.True(match.Success, "Directory.Build.props sets the train version");
        return match.Groups[1].Value;
    }

    /// <summary>A dynamic assembly with the informational version <paramref name="version"/>, or none.</summary>
    private static AssemblyBuilder AssemblyWithVersion(string? version)
    {
        var attributes = version is null
            ? []
            : new[]
            {
                new CustomAttributeBuilder(
                    typeof(AssemblyInformationalVersionAttribute).GetConstructor([typeof(string)])!,
                    [version]),
            };
        return AssemblyBuilder.DefineDynamicAssembly(new AssemblyName($"Version{Guid.NewGuid():N}"), AssemblyBuilderAccess.Run, attributes);
    }

    [Fact]
    public void TheSdkVersionIsTheTrainVersionWithoutACommitSuffix()
    {
        Assert.Equal(TrainVersion(), SdkVersion.Current);
        Assert.Equal("csharp", SdkVersion.Language);
    }

    [Fact]
    public void TheVersionIsNullWithoutAnInformationalVersion()
    {
        Assert.Equal("1.2.3", SdkVersion.Read(AssemblyWithVersion(" 1.2.3 ")));
        Assert.Null(SdkVersion.Read(AssemblyWithVersion(null)));
        Assert.Null(SdkVersion.Read(AssemblyWithVersion("")));
        Assert.Null(SdkVersion.Read(AssemblyWithVersion("  ")));
    }

    // The dashboard backend reads its own assembly, because no shipped assembly sees the core
    // internals. Both assemblies take the train version from Directory.Build.props, and this test
    // holds the two readers equal.
    [Fact]
    public void TheDashboardReportsTheSameVersion() =>
        Assert.Equal(SdkVersion.Current, DashboardHost.Version());

    [Fact]
    public async Task AWorkerStartedFromCSharpRegistersCSharpAndTheTrainVersion()
    {
        var queue = UniqueQueue("sdk-version");
        await using var worker = new Worker(database.DataSource, Options(queue, options => options.RegistryInterval = TimeSpan.FromMilliseconds(100)));
        worker.Handle<Order>("registered", (_, _) => Task.CompletedTask);

        await using var running = new RunningWorker(worker);
        await EventuallyAsync(
            async () => await ScalarAsync(database.DataSource, "SELECT count(*) FROM workhorse.worker_registry WHERE worker_id = $1", worker.WorkerId) is 1L,
            "the worker registers");

        Assert.Equal("csharp", await ScalarAsync(database.DataSource, "SELECT sdk_language FROM workhorse.worker_registry WHERE worker_id = $1", worker.WorkerId));
        Assert.Equal(TrainVersion(), await ScalarAsync(database.DataSource, "SELECT sdk_version FROM workhorse.worker_registry WHERE worker_id = $1", worker.WorkerId));
        await running.StopAsync();
    }
}
