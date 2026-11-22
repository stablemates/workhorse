using System.Diagnostics;
using System.Diagnostics.Metrics;
using Workhorse.Internal.Telemetry;
using Workhorse.Tests.Testing;

namespace Workhorse.Tests.Telemetry;

/// <summary>
/// The count of each <c>redrive_v1</c> and <c>redrive_many_v1</c> result in
/// <c>workhorse.tasks.redrive</c>, as the TypeScript admin records it. The .NET dashboard calls the
/// admin, so it counts the same result.
/// </summary>
/// <remarks>
/// The counter has no queue attribute, and the tests of other classes redrive tasks at the same
/// time. So each test runs its redrives under a caller span and reads only the measurements of
/// that trace.
/// </remarks>
public sealed class RedriveTelemetryTests(ScratchDatabase database) : TelemetryDatabaseCase(database)
{
    /// <summary>
    /// <c>redrive_many_v1</c> answers two rows of a known status and one of a status of a newer
    /// protocol, and <c>redrive_v1</c> answers a status of a newer protocol. Only a failed task gives
    /// real rows. The tests of this class run one at a time, so a test restores the functions
    /// before the next.
    /// </summary>
    private const string ScriptedRedriveFunctions = """
        CREATE OR REPLACE FUNCTION workhorse.redrive_many_v1(
          p_filter jsonb, p_limit integer, p_dry_run boolean, p_requested_by text, p_reason text,
          p_request_id text, p_cursor_finished_at timestamptz DEFAULT NULL,
          p_cursor_task_id uuid DEFAULT NULL
        ) RETURNS TABLE (
          ordinal integer, status text, source_task_id uuid, target_task_id uuid, source_state text,
          target_state text, requested_at timestamptz, source_finished_at_cursor text, has_more boolean
        ) LANGUAGE sql AS $body$
          SELECT row.ordinal, row.status, gen_random_uuid(), NULL::uuid, NULL::text, NULL::text,
                 NULL::timestamptz, NULL::text, false
          FROM (VALUES (1, 'redriven'), (2, 'future_status'), (3, 'redriven')) AS row(ordinal, status)
        $body$;
        CREATE OR REPLACE FUNCTION workhorse.redrive_v1(
          p_source_task_id uuid, p_requested_by text, p_reason text, p_request_id text
        ) RETURNS TABLE (
          status text, source_task_id uuid, target_task_id uuid, source_state text, target_state text,
          requested_at timestamptz
        ) LANGUAGE sql AS $body$
          SELECT 'future_status'::text, p_source_task_id, NULL::uuid, NULL::text, NULL::text,
                 NULL::timestamptz
        $body$;
        """;

    private const string ScriptedFunctionNames =
        "'workhorse.redrive_v1(uuid,text,text,text)'::regprocedure, 'workhorse.redrive_many_v1(jsonb,integer,boolean,text,text,text,timestamptz,uuid)'::regprocedure";

    private static AdminAudit Audit() => new() { Actor = "operator", Reason = "redrive metric", RequestId = Guid.NewGuid().ToString() };

    [Fact]
    public async Task CountsEachRedriveResultByItsDurableStatus()
    {
        var taskId = await EnqueueAsync("email.send");
        var admin = new Admin(DataSource);
        ActivityTraceId trace;
        using (var caller = TelemetryRecorder.Caller.StartActivity("caller"))
        {
            trace = caller!.TraceId;
            Assert.Equal(RedriveStatus.NotFound, (await admin.RedriveAsync(Guid.NewGuid(), Audit(), Token)).Status);
            Assert.Equal(RedriveStatus.NotFailed, (await admin.RedriveAsync(taskId, Audit(), Token)).Status);
            // A page without a failed task counts nothing.
            Assert.Empty((await admin.RedriveManyAsync(new RedriveFilter { Queue = QueueName }, Audit(), Token)).Results);
        }

        var points = Recorder.Of("workhorse.tasks.redrive", measurement => measurement.Trace == trace);
        Assert.Equal(
            [Tags(("workhorse.redrive.status", "not_found")), Tags(("workhorse.redrive.status", "not_failed"))],
            points.Select(point => point.Tags.OrderBy(tag => tag.Key).ToDictionary(StringComparer.Ordinal)));
        Assert.All(points, point => Assert.Equal(1, point.Value));
        var instrument = Recorder.Instruments["workhorse.tasks.redrive"];
        Assert.Equal(("{request}", "Task redrive requests by durable result"), (instrument.Unit, instrument.Description));
        Recorder.AssertGoverned(Surface);
    }

    /// <summary>
    /// As TypeScript does, the bulk redrive counts each status once with the number of its rows, and
    /// a dry run counts its rows too. The count takes the raw status before the admin rejects the
    /// result, so a status of a newer protocol is also counted. Before, the .NET admin counted
    /// nothing.
    /// </summary>
    [Fact]
    public async Task CountsEachStatusOfAPageAndAStatusOfANewerProtocol()
    {
        var originals = await OriginalFunctionsAsync();
        await WorkerHarness.ScalarAsync(DataSource, ScriptedRedriveFunctions);
        ActivityTraceId trace;
        try
        {
            using var caller = TelemetryRecorder.Caller.StartActivity("caller");
            trace = caller!.TraceId;
            var admin = new Admin(DataSource);
            await Assert.ThrowsAnyAsync<Exception>(() => admin.RedriveManyAsync(new RedriveFilter { Queue = QueueName, DryRun = true }, Audit(), Token));
            await Assert.ThrowsAnyAsync<Exception>(() => admin.RedriveAsync(Guid.NewGuid(), Audit(), Token));
        }
        finally
        {
            await WorkerHarness.ScalarAsync(DataSource, originals);
        }

        var points = Recorder.Of("workhorse.tasks.redrive", measurement => measurement.Trace == trace);
        Assert.Equal(
            [
                (Tags(("workhorse.redrive.status", "redriven")), 2.0),
                (Tags(("workhorse.redrive.status", "future_status")), 1.0),
                (Tags(("workhorse.redrive.status", "future_status")), 1.0),
            ],
            points.Select(point => (point.Tags.OrderBy(tag => tag.Key).ToDictionary(StringComparer.Ordinal), point.Value)));
    }

    [Fact]
    public async Task KeepsTheRedriveResultWhenAListenerThrows()
    {
        using var caller = TelemetryRecorder.Caller.StartActivity("caller");
        var trace = caller!.TraceId;
        using var throwing = new MeterListener
        {
            InstrumentPublished = (instrument, listener) =>
            {
                if (instrument.Meter.Name == Instrumentation.Name && instrument.Name == "workhorse.tasks.redrive")
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

        var result = await new Admin(DataSource).RedriveAsync(Guid.NewGuid(), Audit(), Token);

        Assert.Equal(RedriveStatus.NotFound, result.Status);
    }

    /// <summary>The definitions of the two functions that the scripted test replaces, as one statement.</summary>
    private async Task<string> OriginalFunctionsAsync()
    {
        var definitions = (string)(await WorkerHarness.ScalarAsync(
            DataSource,
            $"SELECT string_agg(pg_get_functiondef(function), E';\n') FROM unnest(ARRAY[{ScriptedFunctionNames}]) AS function"))!;
        return definitions;
    }
}
