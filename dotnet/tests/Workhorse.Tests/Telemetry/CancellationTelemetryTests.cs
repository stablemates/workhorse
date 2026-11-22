using System.Diagnostics;
using System.Diagnostics.Metrics;
using Workhorse.Internal.Telemetry;
using Workhorse.Tests.Testing;

namespace Workhorse.Tests.Telemetry;

/// <summary>
/// The count of each <c>cancel_v1</c> result in <c>workhorse.tasks.cancellation</c>, as the
/// TypeScript queue records it. The .NET dashboard calls the queue, so it counts the same result.
/// </summary>
/// <remarks>
/// The counter has no queue attribute, and the tests of other classes cancel tasks at the same
/// time. So each test runs its cancels under a caller span and reads only the measurements of
/// that trace.
/// </remarks>
public sealed class CancellationTelemetryTests(ScratchDatabase database) : TelemetryDatabaseCase(database)
{
    [Fact]
    public async Task CountsEachCancelResultByItsDurableStatus()
    {
        var taskId = await EnqueueAsync("email.send");
        var queue = new Queue(DataSource);
        ActivityTraceId trace;
        using (var caller = TelemetryRecorder.Caller.StartActivity("caller"))
        {
            trace = caller!.TraceId;
            Assert.Equal(CancelStatus.Canceled, (await queue.CancelAsync(taskId, new CancelOptions(), Token)).Status);
            Assert.Equal(CancelStatus.NotFound, (await queue.CancelAsync(Guid.NewGuid(), new CancelOptions(), Token)).Status);
        }

        var points = Recorder.Of("workhorse.tasks.cancellation", measurement => measurement.Trace == trace);
        Assert.Equal(
            [Tags(("workhorse.cancellation.status", "canceled")), Tags(("workhorse.cancellation.status", "not_found"))],
            points.Select(point => point.Tags.OrderBy(tag => tag.Key).ToDictionary(StringComparer.Ordinal)));
        Assert.All(points, point => Assert.Equal(1, point.Value));
        var instrument = Recorder.Instruments["workhorse.tasks.cancellation"];
        Assert.Equal(("{request}", "Task cancellation requests by durable result"), (instrument.Unit, instrument.Description));
        Recorder.AssertGoverned(Surface);
    }

    /// <summary>
    /// <c>cancel_v1</c> answers a status of a newer protocol. As TypeScript does, the queue counts
    /// the raw status before it rejects the result. Before, the .NET queue counted nothing. The
    /// tests of this class run one at a time, so the replaced function is restored before the next.
    /// </summary>
    [Fact]
    public async Task CountsAStatusOfANewerProtocolBeforeItRejectsTheResult()
    {
        var original = (string)(await WorkerHarness.ScalarAsync(DataSource, "SELECT pg_get_functiondef('workhorse.cancel_v1(uuid,text,text)'::regprocedure)"))!;
        await WorkerHarness.ScalarAsync(DataSource, """
            CREATE OR REPLACE FUNCTION workhorse.cancel_v1(
              p_task_id uuid, p_requested_by text DEFAULT NULL, p_reason text DEFAULT NULL
            ) RETURNS TABLE (
              status text, state text, current_attempt integer, requested_at timestamptz,
              requested_by text, reason text, finished_at timestamptz
            ) LANGUAGE sql AS $body$
              SELECT 'future_status'::text, NULL::text, NULL::integer, NULL::timestamptz, NULL::text,
                     NULL::text, NULL::timestamptz
            $body$
            """);
        ActivityTraceId trace;
        try
        {
            using var caller = TelemetryRecorder.Caller.StartActivity("caller");
            trace = caller!.TraceId;
            await Assert.ThrowsAnyAsync<Exception>(() => new Queue(DataSource).CancelAsync(Guid.NewGuid(), new CancelOptions(), Token));
        }
        finally
        {
            await WorkerHarness.ScalarAsync(DataSource, original);
        }

        var points = Recorder.Of("workhorse.tasks.cancellation", measurement => measurement.Trace == trace);
        Assert.Equal(
            [Tags(("workhorse.cancellation.status", "future_status"))],
            points.Select(point => point.Tags.OrderBy(tag => tag.Key).ToDictionary(StringComparer.Ordinal)));
    }

    [Fact]
    public async Task KeepsTheCancelResultWhenAListenerThrows()
    {
        var taskId = await EnqueueAsync("email.send");
        using var caller = TelemetryRecorder.Caller.StartActivity("caller");
        var trace = caller!.TraceId;
        using var throwing = new MeterListener
        {
            InstrumentPublished = (instrument, listener) =>
            {
                if (instrument.Meter.Name == Instrumentation.Name && instrument.Name == "workhorse.tasks.cancellation")
                {
                    listener.EnableMeasurementEvents(instrument);
                }
            },
        };
        throwing.SetMeasurementEventCallback<long>((_, _, _, _) =>
        {
            if (Activity.Current?.TraceId == trace)
            {
                throw new InvalidOperationException("listener failed");
            }
        });
        throwing.Start();

        var result = await new Queue(DataSource).CancelAsync(taskId, new CancelOptions(), Token);

        Assert.Equal(CancelStatus.Canceled, result.Status);
    }
}
