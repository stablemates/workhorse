using System.Collections.Concurrent;
using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Text.Json;
using System.Text.Json.Nodes;
using Workhorse.AspNetCore.Internal;
using Workhorse.Tests.Testing;

namespace Workhorse.AspNetCore.Tests;

/// <summary>
/// The TypeScript dashboard calls the admin, which counts each <c>redrive_v1</c> result in
/// <c>workhorse.tasks.redrive</c>. The .NET dashboard also calls its admin, so it counts the same
/// result once.
/// </summary>
public sealed class DashboardRedriveTelemetryTests(ScratchDatabase database) : IClassFixture<ScratchDatabase>
{
    private const string CallerName = "Workhorse.AspNetCore.Tests.RedriveCaller";

    private static readonly ActivitySource Caller = new(CallerName);

    [Fact]
    public async Task CountsEachRedriveResultAsTheAdminDoes()
    {
        var token = TestContext.Current.CancellationToken;
        var statuses = new ConcurrentQueue<(ActivityTraceId? Trace, string? Status, long Value)>();
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
                if (instrument.Meter.Name == "workhorse" && instrument.Name == "workhorse.tasks.redrive")
                {
                    listener.EnableMeasurementEvents(instrument);
                }
            },
        };
        meters.SetMeasurementEventCallback<long>((_, value, tags, _) =>
        {
            foreach (var tag in tags)
            {
                if (tag.Key == "workhorse.redrive.status")
                {
                    statuses.Enqueue((Activity.Current?.TraceId, tag.Value as string, value));
                }
            }
        });
        meters.Start();

        var taskId = (await new Queue(database.DataSource).EnqueueAsync<object?>("email.send", null, new EnqueueOptions(), token)).TaskId;
        var backend = new Backend(database.DataSource, "test", [], new Dictionary<string, JsonElement>(), false, TimeSpan.FromSeconds(15), false);
        var redrive = backend.Procedures()["redriveTask"];
        JsonObject Audit() => new() { ["actor"] = "operator", ["reason"] = "test", ["requestId"] = Guid.NewGuid().ToString() };
        ActivityTraceId trace;
        using (var caller = Caller.StartActivity("caller"))
        {
            trace = caller!.TraceId;
            await redrive(new JsonObject { ["id"] = taskId.ToString(), ["audit"] = Audit() }, "operator", token);
            await Assert.ThrowsAsync<DashboardRpcException>(() =>
                redrive(new JsonObject { ["id"] = Guid.NewGuid().ToString(), ["audit"] = Audit() }, "operator", token));
        }

        Assert.Equal(
            [("not_failed", 1L), ("not_found", 1L)],
            statuses.Where(point => point.Trace == trace).Select(point => (point.Status, point.Value)));
    }
}
