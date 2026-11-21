using System.Text.Json;
using Microsoft.Extensions.Logging;
using Workhorse.DemoWorker;

namespace Workhorse.Tests.DemoWorker;

/// <summary>The demo log file of the .NET worker, in the record format of the TypeScript demo exporter.</summary>
public sealed class DemoLogFileTests : IDisposable
{
    private static readonly string[] Queues = ["q1", "q2"];

    private readonly string _directory = Directory.CreateTempSubdirectory("workhorse-demo-log-").FullName;

    public void Dispose() => Directory.Delete(_directory, recursive: true);

    private static Func<string, string?> Environment(params (string Name, string Value)[] values) =>
        name => values.FirstOrDefault(value => value.Name == name).Value;

    [Fact]
    public void ItNeedsADirectoryAndAServiceName()
    {
        Assert.Null(DemoLogFile.FromEnvironment(Environment()));
        Assert.Null(DemoLogFile.FromEnvironment(Environment(("WORKHORSE_DEMO_LOG_DIRECTORY", "/tmp/x"))));
    }

    [Fact]
    public void ItRefusesAnInvalidSize()
    {
        var error = Assert.Throws<ArgumentException>(() => DemoLogFile.FromEnvironment(Environment(
            ("WORKHORSE_DEMO_LOG_DIRECTORY", "/tmp/x"),
            ("WORKHORSE_DEMO_SERVICE_NAME", "w"),
            ("WORKHORSE_DEMO_LOG_MAX_BYTES", "0"))));
        Assert.Contains("WORKHORSE_DEMO_LOG_MAX_BYTES", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ItFormatsUtcMilliseconds() =>
        Assert.Equal("2026-11-21T15:12:55.802Z", DemoLogFile.Timestamp(DateTimeOffset.FromUnixTimeMilliseconds(1_795_273_975_802)));

    [Fact]
    public void ItWritesTheEventNameAndTheTemplateValues()
    {
        var file = DemoLogFile.FromEnvironment(Environment(
            ("WORKHORSE_DEMO_LOG_DIRECTORY", _directory),
            ("WORKHORSE_DEMO_SERVICE_NAME", "workhorse-demo-worker-dotnet"),
            ("WORKHORSE_DEMO_ENV", "test env")))!;
        using var provider = new DemoLogFileProvider(file);
        var logger = provider.CreateLogger("Workhorse.Worker");
        var state = new List<KeyValuePair<string, object?>>
        {
            new("Concurrency", 6),
            new("Queues", Queues),
            new("{OriginalFormat}", "Worker started with concurrency {Concurrency} on queues {Queues}"),
        };
        logger.Log(
            LogLevel.Information,
            new EventId(1, "workhorse.worker.started"),
            state,
            null,
            (_, _) => "Worker started with concurrency 6 on queues q1,q2");

        var lines = File.ReadAllLines(Path.Combine(_directory, "test_env", "workhorse-demo-worker-dotnet.ndjson"));
        var line = Assert.Single(lines);
        using var record = JsonDocument.Parse(line);
        var root = record.RootElement;
        Assert.Equal(
            ["timestamp", "observedTimestamp", "severityText", "severityNumber", "eventName", "body", "attributes", "resource", "scope"],
            root.EnumerateObject().Select(property => property.Name));
        Assert.Equal("INFO", root.GetProperty("severityText").GetString());
        Assert.Equal(9, root.GetProperty("severityNumber").GetInt32());
        Assert.Equal("workhorse.worker.started", root.GetProperty("eventName").GetString());
        Assert.Equal("Worker started with concurrency 6 on queues q1,q2", root.GetProperty("body").GetString());
        Assert.Equal("""{"Concurrency":6,"Queues":["q1","q2"]}""", root.GetProperty("attributes").GetRawText());
        Assert.Equal("workhorse-demo-worker-dotnet", root.GetProperty("resource").GetProperty("service.name").GetString());
        Assert.Equal("test env", root.GetProperty("resource").GetProperty("deployment.environment.name").GetString());
        Assert.Equal("dotnet", root.GetProperty("resource").GetProperty("telemetry.sdk.language").GetString());
        Assert.Equal("Workhorse.Worker", root.GetProperty("scope").GetProperty("name").GetString());
        Assert.EndsWith("Z", root.GetProperty("timestamp").GetString(), StringComparison.Ordinal);
    }

    [Fact]
    public void ItRotatesBeforeTheLimit()
    {
        var path = Path.Combine(_directory, "w.ndjson");
        var file = new DemoLogFile(path, 400, 2, new Dictionary<string, object>(StringComparer.Ordinal));
        for (var index = 0; index < 12; index++)
        {
            file.Write(LogLevel.Information, null, $"record {index}", [], "test", DateTimeOffset.UtcNow);
        }

        Assert.Equal(
            ["w.ndjson", "w.ndjson.1", "w.ndjson.2"],
            Directory.GetFiles(_directory).Select(Path.GetFileName).Order(StringComparer.Ordinal));
        Assert.All(Directory.GetFiles(_directory), entry => Assert.True(new FileInfo(entry).Length <= 400));
        Assert.Contains("\"body\":\"record 11\"", File.ReadAllLines(path)[^1], StringComparison.Ordinal);
    }

    [Fact]
    public void ItWritesANestedDictionaryAsAnObject()
    {
        var path = Path.Combine(_directory, "w.ndjson");
        var file = new DemoLogFile(path, 10_000, 1, new Dictionary<string, object>(StringComparer.Ordinal));
        var nested = new Dictionary<string, object?>(StringComparer.Ordinal) { ["a"] = 1, ["b"] = double.NaN };
        file.Write(LogLevel.Information, null, "nested", [new("map", nested)], "test", DateTimeOffset.UtcNow);

        using var record = JsonDocument.Parse(File.ReadAllText(path));
        Assert.Equal("""{"map":{"a":1,"b":null}}""", record.RootElement.GetProperty("attributes").GetRawText());
    }
}
