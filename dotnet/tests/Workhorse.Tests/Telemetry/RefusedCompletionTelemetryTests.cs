using Workhorse.Internal.Telemetry;
using Workhorse.Tests.Testing;
using static Workhorse.Tests.Testing.WorkerHarness;

namespace Workhorse.Tests.Telemetry;

/// <summary>The telemetry of a completion write that PostgreSQL refuses (SM-1649).</summary>
/// <remarks>
/// The handler of the test moves a deadline or an attempt timeout into the past. The maintenance
/// tick of any running worker settles every overdue attempt in its database. If a tick wins, the
/// worker's own expiration answers <c>stale</c>, and the attempt reports a lost lease. This class has
/// a database of its own, so no worker of a parallel class ticks on it (SM-1721, SM-1732). The tests
/// of the class run one at a time. The worker of this test runs its own tick before its claim, so
/// that tick sees no overdue attempt. A stopped worker can abandon a slow tick that then ends later, but a tick is not slow
/// on a test database.
/// <para>
/// <see cref="Worker.RunOnceAsync"/> also runs a due tick before the claim that finds no task. At
/// the 1 s default interval, an attempt that took more than 1 s let that second tick settle the
/// moved deadline (SM-1792). The test sets an interval of one hour, so only the first tick runs.
/// </para>
/// </remarks>
public sealed class RefusedCompletionTelemetryTests(ScratchDatabase database) : TelemetryDatabaseCase(database)
{
    /// <summary>
    /// SM-1649: the handler changes the task in PostgreSQL and returns at once. The worker's own
    /// timers still wait for the claimed boundaries and the heartbeat does not run in between, so
    /// PostgreSQL refuses the completion write. A due deadline or attempt timeout settles under the
    /// attempt's own fence before the run returns. A cancellation and a lost lease keep their own
    /// outcomes.
    /// </summary>
    [Theory]
    [InlineData("UPDATE workhorse.task_runtime SET deadline_at = clock_timestamp() - interval '1 second' WHERE task_id = $1", "failed", "deadline_exceeded", "deadline_exceeded")]
    [InlineData("UPDATE workhorse.task_runtime SET attempt_timeout_at = clock_timestamp() - interval '1 second' WHERE task_id = $1", "failed", "timeout_exceeded", "timeout")]
    [InlineData("SELECT status FROM workhorse.cancel_v1($1, 'test', 'no longer needed')", "canceled", "canceled", "canceled")]
    [InlineData("UPDATE workhorse.task_runtime SET fence_token = fence_token + 1, deadline_at = clock_timestamp() - interval '1 second' WHERE task_id = $1", "active", "stale", "lease_lost")]
    public async Task ARefusedCompletionWriteSettlesItsCause(string change, string state, string spanOutcome, string metricOutcome)
    {
        var taskId = await EnqueueAsync("email.send", new EnqueueOptions
        {
            MaxAttempts = 1,
            Deadline = DateTimeOffset.UtcNow.AddHours(1),
            ExecutionTimeout = TimeSpan.FromHours(1),
        });
        await using var worker = new Worker(DataSource, Options(QueueName, options =>
        {
            options.PollingOnly = true;
            options.PollInterval = TimeSpan.FromMilliseconds(10);
            options.DisableRegistry = true;
            options.Lease = TimeSpan.FromSeconds(60);
            options.Heartbeat = TimeSpan.FromSeconds(30);
            options.MaintenanceInterval = TimeSpan.FromHours(1);
        }));
        worker.Handle<object?, object?>("email.send", async (_, _) =>
        {
            await ScalarAsync(DataSource, change, taskId);
            return new { late = true };
        });
        Assert.True(await worker.RunOnceAsync(Token));

        // The attempt settled its cause before the run returned, without a maintenance pass.
        var row = await TaskAsync(DataSource, taskId);
        Assert.Equal(state, row.Text("state"));
        Assert.Null(row.Json("result"));
        var complete = Single(Names.SpanComplete, span => Equals(span.GetTagItem(Names.TaskId), taskId.ToString()));
        Assert.Equal(false, complete.GetTagItem(Names.CompleteAccepted));
        Assert.Equal(spanOutcome, Handler(taskId).GetTagItem(Names.HandlerOutcome));
        AssertPoints("workhorse.handler.executions", [Tags((Names.QueueName, QueueName), (Names.TaskType, "email.send"), (Names.HandlerOutcome, metricOutcome))]);
        Recorder.AssertGoverned(Surface);
    }
}
