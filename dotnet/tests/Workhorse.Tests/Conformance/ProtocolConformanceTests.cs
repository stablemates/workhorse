using Workhorse.Tests.Testing;

namespace Workhorse.Tests.Conformance;

/// <summary>
/// The .NET conformance lane: every <c>protocol/v1</c> fixture runs through the C# SDK, and the run
/// must agree with <c>expected-unsupported.json</c>. The counterpart of the JVM
/// <c>ProtocolConformanceTest</c>.
/// </summary>
public sealed class ProtocolConformanceTests(ScratchDatabase database) : IClassFixture<ScratchDatabase>
{
    private static string Protocol => Repository.Path("protocol/v1");

    [Fact]
    public async Task ExecutesEveryProtocolFixtureAndAgreesWithTheExpectedUnsupportedList()
    {
        _ = database.DataSource;
        var runner = new Runner(Catalogue.Load(Protocol), Ledger.Load(Repository.Path(Ledger.Path)), Protocol, new ConformanceDatabases(database));
        var problems = await runner.RunAsync();
        await Console.Error.WriteLineAsync(runner.Report());
        Assert.True(problems.Count == 0, ".NET protocol conformance disagrees with its list:\n  " + string.Join("\n  ", problems));
    }

    [Fact]
    public void FailsTheRunForAnUnlistedFailingFixture() =>
        Assert.Equal(
            ["requests/a does not pass and is not listed: wrong column"],
            Reconcile(["requests/a"], new() { ["requests/a"] = Outcome.Failed("wrong column") }));

    [Fact]
    public void FailsTheRunForAnUnlistedUnsupportedFixture() =>
        Assert.Equal(
            ["runtime/a does not pass and is not listed: no worker"],
            Reconcile(["runtime/a"], new() { ["runtime/a"] = Outcome.Unsupported("no worker") }));

    [Fact]
    public void FailsTheRunForAListedFixtureThatPasses() =>
        Assert.Equal(
            ["requests/a now passes; remove it from the expected-unsupported list (SM-900)"],
            Reconcile(["requests/a"], new() { ["requests/a"] = Outcome.Passed() }, ("requests/a", "SM-900")));

    [Fact]
    public void AcceptsAListedFailingFixtureAndASkippedFixture() =>
        Assert.Empty(Reconcile(
            ["requests/a", "scenarios/b"],
            new() { ["requests/a"] = Outcome.Failed("wrong column"), ["scenarios/b"] = Outcome.Skipped("no database") },
            ("requests/a", "SM-900")));

    [Fact]
    public void RequiresEachEntryToNameADeclaredFixtureOnceWithAnIssue() =>
        Assert.Equal(
            [
                "requests/a is listed twice",
                "requests/gone names tracking issue \"WH-12\", not SM-<number>",
                "requests/gone is listed but no protocol/v1 fixture declares it",
            ],
            Reconcile(
                ["requests/a"],
                new() { ["requests/a"] = Outcome.Failed("x") },
                ("requests/a", "SM-900"),
                ("requests/a", "SM-900"),
                ("requests/gone", "WH-12")));

    [Fact]
    public void FailsTheRunForADeclaredFixtureThatNeverRan() =>
        Assert.Equal(
            ["requests/b was never executed"],
            Reconcile(["requests/a", "requests/b"], new() { ["requests/a"] = Outcome.Passed() }));

    [Fact]
    public void ListsOnlyRuntimeFixturesThatAnOpenSliceOwns()
    {
        foreach (var entry in Ledger.Load(Repository.Path(Ledger.Path)))
        {
            Assert.StartsWith("runtime/", entry.Fixture, StringComparison.Ordinal);
            Assert.Contains(entry.Issue, RuntimeFixtures.OpenSlices);
        }
    }

    [Fact]
    public void FailsTheRunForAnUnclassifiedProtocolFile()
    {
        var directory = Directory.CreateTempSubdirectory("workhorse-protocol-");
        try
        {
            foreach (var file in Directory.EnumerateFiles(Protocol))
            {
                File.Copy(file, Path.Combine(directory.FullName, Path.GetFileName(file)));
            }

            File.WriteAllText(Path.Combine(directory.FullName, "leases.json"), "[]");
            var failure = Assert.Throws<Failure>(() => Catalogue.Load(directory.FullName));
            Assert.Equal("protocol/v1 holds files the .NET runner does not classify: leases.json; execute them or name them as metadata", failure.Message);
        }
        finally
        {
            directory.Delete(recursive: true);
        }
    }

    [Fact]
    public void FailsTheRunForMissingManifestCoverage() =>
        Assert.Equal(
            "SQL protocol fixtures lack coverage: claim",
            Runner.ManifestCoverage(
                Json.Members(("coverage", new List<object?> { "enqueue", "claim" }), ("runtimeCoverage", new List<object?>())),
                new HashSet<string>(["enqueue"], StringComparer.Ordinal)));

    [Fact]
    public void RejectsAnInterpreterStepThatAcceptsAValueTheFixtureRejects()
    {
        var step = Json.Members(("id", "reject"), ("expect", Json.Members(("$type", "any"))), ("actual", true), ("rejects", true));
        var fixture = Json.Members(("id", "self-test"), ("steps", new List<object?> { step }), ("errors", new List<object?>()));
        var failure = Assert.Throws<Failure>(() => Runner.RunInterpreter(fixture));
        Assert.Equal("self-test/reject accepted a value the fixture rejects", failure.Message);
    }

    [Fact]
    public void ComparesNumbersByValue()
    {
        Assert.True(Matcher.Same(1L, 1.0));
        Assert.True(Matcher.Same(1.5, 1.50));
        Assert.False(Matcher.Same(1L, 1.5));
        Assert.True(Matcher.Same(System.Numerics.BigInteger.Pow(10, 20), 1e20));
    }

    [Fact]
    public void ParsesAJsonHintAndRefusesAHintThatIsNotJson()
    {
        var expected = Json.Members(("code", "P1001"), ("message", "m"), ("hint", Json.Members(("queue", "q"))));
        Runner.AssertErrorValue(expected, Json.Members(("code", "P1001"), ("message", "m"), ("hint", "{\"queue\":\"q\"}")), new Dictionary<string, object?>(), "here");
        Assert.Throws<Failure>(() =>
            Runner.AssertErrorValue(expected, Json.Members(("code", "P1001"), ("message", "m"), ("hint", "{\"queue\":\"other\"}")), new Dictionary<string, object?>(), "here"));
        Assert.Throws<Failure>(() =>
            Runner.AssertErrorValue(expected, Json.Members(("code", "P1001"), ("message", "m")), new Dictionary<string, object?>(), "here"));
        Assert.Throws<Failure>(() =>
            Runner.AssertErrorValue(expected, Json.Members(("code", "P1001"), ("message", "m"), ("hint", "not json")), new Dictionary<string, object?>(), "here"));
    }

    private static IReadOnlyList<string> Reconcile(string[] declared, Dictionary<string, Outcome> outcomes, params (string Fixture, string Issue)[] listed) =>
        Ledger.Reconcile(
            declared.ToHashSet(StringComparer.Ordinal),
            outcomes,
            [.. listed.Select(entry => new Ledger.Entry(entry.Fixture, entry.Issue, "tracked"))]);
}
