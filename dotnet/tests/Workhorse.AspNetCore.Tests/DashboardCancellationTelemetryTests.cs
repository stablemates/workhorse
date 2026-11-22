using System.Collections.Concurrent;
using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Text.Json;
using System.Text.Json.Nodes;
using Workhorse.AspNetCore.Internal;
using Workhorse.Tests.Testing;

namespace Workhorse.AspNetCore.Tests;

/// <summary>
/// The TypeScript dashboard calls the queue, which counts each <c>cancel_v1</c> result in
/// <c>workhorse.tasks.cancellation</c>. The .NET dashboard also calls its queue, so it counts the
/// same result.
/// </summary>
public sealed class DashboardCancellationTelemetryTests(ScratchDatabase database) : IClassFixture<ScratchDatabase>
{
    private const string CallerName = "Workhorse.AspNetCore.Tests.Caller";

    private static readonly ActivitySource Caller = new(CallerName);

    [Fact]
    public async Task CountsEachCancelResultAsTheQueueDoes()
    {
        var token = TestContext.Current.CancellationToken;
        var statuses = new ConcurrentQueue<(ActivityTraceId? Trace, string? Status)>();
        using var activities = new ActivityListener
        {
            // The listener compares names: the field's own source asks the listeners whether they
            // listen before the field is set.
            ShouldListenTo = source => source.Name == CallerName,
            Sample = (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.AllDataAndRecorded,
        };
        ActivitySource.AddActivityListener(activities);
        using var meters = new MeterListener
        {
            InstrumentPublished = (instrument, listener) =>
            {
                if (instrument.Meter.Name == "workhorse" && instrument.Name == "workhorse.tasks.cancellation")
                {
                    listener.EnableMeasurementEvents(instrument);
                }
            },
        };
        meters.SetMeasurementEventCallback<long>((_, _, tags, _) =>
        {
            foreach (var tag in tags)
            {
                if (tag.Key == "workhorse.cancellation.status")
                {
                    statuses.Enqueue((Activity.Current?.TraceId, tag.Value as string));
                }
            }
        });
        meters.Start();

        var taskId = (await new Queue(database.DataSource).EnqueueAsync<object?>("email.send", null, new EnqueueOptions(), token)).TaskId;
        var backend = new Backend(database.DataSource, "test", [], new Dictionary<string, JsonElement>(), false, TimeSpan.FromSeconds(15), false);
        var cancel = backend.Procedures()["cancelTask"];
        ActivityTraceId trace;
        using (var caller = Caller.StartActivity("caller"))
        {
            trace = caller!.TraceId;
            await cancel(new JsonObject { ["id"] = taskId.ToString(), ["audit"] = new JsonObject() }, "operator", token);
            await Assert.ThrowsAsync<DashboardRpcException>(() =>
                cancel(new JsonObject { ["id"] = Guid.NewGuid().ToString(), ["audit"] = new JsonObject() }, "operator", token));
        }

        Assert.Equal(["canceled", "not_found"], statuses.Where(point => point.Trace == trace).Select(point => point.Status));
    }
}
