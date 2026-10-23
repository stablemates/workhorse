using System.Diagnostics;
using Npgsql;
using Workhorse.Internal.Telemetry;
using Workhorse.Tests.Testing;
using static Workhorse.Tests.Testing.WorkerHarness;

namespace Workhorse.Tests.Telemetry;

/// <summary>
/// The shared setup of a telemetry test against PostgreSQL: a recorder of the runtime listeners, a
/// unique queue, and the reads of the captured spans and measurements of that queue.
/// </summary>
public abstract class TelemetryDatabaseCase(ScratchDatabase database) : IDisposable
{
    private protected static readonly TelemetrySurface Surface = TelemetrySurface.Read();

    private protected TelemetryRecorder Recorder { get; } = new();

    private protected string QueueName { get; } = UniqueQueue("telemetry");

    private protected NpgsqlDataSource DataSource => database.DataSource;

    private protected static CancellationToken Token => TestContext.Current.CancellationToken;

    public void Dispose()
    {
        Dispose(true);
        GC.SuppressFinalize(this);
    }

    protected virtual void Dispose(bool disposing)
    {
        if (disposing)
        {
            Recorder.Dispose();
        }
    }

    private protected async Task<Guid> EnqueueAsync(string taskType, EnqueueOptions? options = null) =>
        (await new Queue(DataSource).EnqueueAsync<object?>(taskType, null, (options ?? new EnqueueOptions()) with { Queue = QueueName }, Token)).TaskId;

    private protected Activity Single(string name, Func<Activity, bool> match) => Assert.Single(Recorder.SpansNamed(name, match));

    private protected List<Activity> Handlers(Guid taskId) =>
        [.. Recorder.SpansNamed(Names.SpanHandler, span => Equals(span.GetTagItem(Names.TaskId), taskId.ToString())).OrderBy(span => span.StartTimeUtc)];

    private protected Activity Handler(Guid taskId) => Assert.Single(Handlers(taskId));

    private protected static Dictionary<string, object?> Tags(params (string Key, object? Value)[] tags) =>
        tags.ToDictionary(tag => tag.Key, tag => tag.Value, StringComparer.Ordinal);

    /// <summary>The tags of each measurement of <paramref name="instrument"/> on this test's queue.</summary>
    private protected void AssertPoints(string instrument, IReadOnlyList<Dictionary<string, object?>> expected)
    {
        var points = Recorder.Of(instrument, measurement => measurement.Tags.TryGetValue(Names.QueueName, out var queue) && Equals(queue, QueueName));
        Assert.Equal(expected.Count, points.Count);
        for (var index = 0; index < expected.Count; index++)
        {
            Assert.Equal(expected[index].OrderBy(tag => tag.Key), points[index].Tags.OrderBy(tag => tag.Key));
        }
    }
}
