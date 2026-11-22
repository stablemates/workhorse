using Workhorse.Internal.Telemetry;
using Workhorse.Tests.Testing;
using static Workhorse.Tests.Testing.WorkerHarness;

namespace Workhorse.Tests.Telemetry;

/// <summary>The handler metrics of an attempt whose settlement failed.</summary>
/// <remarks>
/// The test replaces <c>complete_v1</c> in the database of this class, so no other class uses that
/// database.
/// </remarks>
public sealed class FailedSettlementTelemetryTests(ScratchDatabase database) : TelemetryDatabaseCase(database)
{
    /// <summary>
    /// The completion write fails, so the attempt settles nothing and has no outcome. As in
    /// TypeScript, its duration records <c>unknown</c>, and <c>workhorse.handler.executions</c> does
    /// not count it.
    /// </summary>
    [Fact]
    public async Task AFailedCompletionHasADurationButNoExecutionCount()
    {
        await ScalarAsync(DataSource, """
            ALTER FUNCTION workhorse.complete_v1(uuid, text, bigint, jsonb) RENAME TO test_original_complete_v1;
            CREATE FUNCTION workhorse.complete_v1(p_task_id uuid, p_worker_id text, p_fence_token bigint, p_result jsonb DEFAULT 'null'::jsonb)
              RETURNS boolean LANGUAGE plpgsql AS $body$
              BEGIN RAISE EXCEPTION 'injected completion failure'; END $body$;
            """);
        try
        {
            await EnqueueAsync("email.send");
            await using var worker = new Worker(DataSource, Options(QueueName, options =>
            {
                options.PollingOnly = true;
                options.PollInterval = TimeSpan.FromMilliseconds(10);
                options.DisableRegistry = true;
                options.MaintenanceInterval = TimeSpan.FromHours(1);
            }));
            worker.Handle<object?, object?>("email.send", (_, _) => Task.FromResult<object?>(new { done = true }));
            await Assert.ThrowsAnyAsync<Exception>(() => worker.RunOnceAsync(Token));
        }
        finally
        {
            await ScalarAsync(DataSource, """
                DROP FUNCTION workhorse.complete_v1(uuid, text, bigint, jsonb);
                ALTER FUNCTION workhorse.test_original_complete_v1(uuid, text, bigint, jsonb) RENAME TO complete_v1;
                """);
        }

        AssertPoints("workhorse.handler.executions", []);
        AssertPoints("workhorse.handler.duration", [Tags((Names.QueueName, QueueName), (Names.TaskType, "email.send"), (Names.HandlerOutcome, "unknown"))]);
    }
}
