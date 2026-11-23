using Workhorse.Internal.Telemetry;
using Workhorse.Tests.Testing;
using static Workhorse.Tests.Testing.WorkerHarness;

namespace Workhorse.Tests.Telemetry;

/// <summary>
/// The handler outcome of a failure or a release that PostgreSQL refuses after the lease lapsed
/// (SM-1884). The cases are the lapsed-lease cases of the Go test
/// <c>worker_refused_completion_outcome_test.go</c>.
/// </summary>
/// <remarks>
/// The handler moves <c>expires_at</c> into the past, so <c>fail_v1</c> and <c>release_owned_v1</c>
/// answer <c>stale</c> under an unchanged fence. <c>expire_owned_v1</c> does not read
/// <c>expires_at</c>, so a due deadline or attempt timeout still settles under that fence. The class
/// has a database of its own, and its worker runs one maintenance tick before its claim and no
/// other, as <see cref="RefusedCompletionTelemetryTests"/> explains.
/// </remarks>
public sealed class StaleSettlementTelemetryTests(ScratchDatabase database) : TelemetryDatabaseCase(database)
{
    private const string Past = "clock_timestamp() - interval '1 second'";

    /// <summary>
    /// A handler fails after its lease lapsed. The worker reconciles the <c>stale</c> answer of
    /// <c>fail_v1</c> and reports the cause that it settles. Only a lapsed lease with no due boundary
    /// reports a lost lease.
    /// </summary>
    [Theory]
    [InlineData("deadline_at", "failed", "deadline_exceeded", "deadline_exceeded")]
    [InlineData("attempt_timeout_at", "failed", "timeout_exceeded", "timeout")]
    [InlineData(null, "active", "stale", "lease_lost")]
    public async Task AStaleFailureReportsTheSettledCause(string? boundary, string state, string spanOutcome, string metricOutcome)
    {
        var taskId = await EnqueueAsync("email.send", Boundaries());
        await using var worker = new Worker(DataSource, WorkerOptions());
        worker.Handle<object?, object?>("email.send", async (_, _) =>
        {
            await LapseAsync(taskId, boundary);
            throw new InvalidOperationException("the handler failed");
        });
        Assert.True(await worker.RunOnceAsync(Token));

        Assert.Equal(state, (await TaskAsync(DataSource, taskId)).Text("state"));
        Assert.Equal(spanOutcome, Handler(taskId).GetTagItem(Names.HandlerOutcome));
        // The span records the handler error before fail_v1, so it keeps it after a lost lease.
        AssertErrors(Handler(taskId), typeof(InvalidOperationException).FullName!);
        AssertPoints("workhorse.handler.executions", [Tags((Names.QueueName, QueueName), (Names.TaskType, "email.send"), (Names.HandlerOutcome, metricOutcome))]);
    }

    /// <summary>
    /// A handler stops for the shutdown after its lease lapsed. The worker reconciles the
    /// <c>stale</c> answer of <c>release_owned_v1</c> and reports the cause that it settles.
    /// </summary>
    [Theory]
    [InlineData("deadline_at", "failed", "deadline_exceeded", "deadline_exceeded")]
    [InlineData("attempt_timeout_at", "failed", "timeout_exceeded", "timeout")]
    [InlineData(null, "active", "stale", "lease_lost")]
    public async Task AStaleShutdownReleaseReportsTheSettledCause(string? boundary, string state, string spanOutcome, string metricOutcome)
    {
        var taskId = await EnqueueAsync("email.send", Boundaries());
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var worker = new Worker(DataSource, WorkerOptions(options => options.ShutdownGrace = TimeSpan.FromMilliseconds(100)));
        worker.Handle<object?, object?>("email.send", async (context, _) =>
        {
            started.SetResult();
            try
            {
                await Task.Delay(Timeout.Infinite, context.CancellationToken);
            }
            catch (OperationCanceledException)
            {
                await LapseAsync(taskId, boundary);
                throw;
            }

            return null;
        });
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(Token);
        var run = worker.RunOnceAsync(stop.Token);
        await started.Task.WaitAsync(Patience, Token);
        await stop.CancelAsync();
        try
        {
            await run.WaitAsync(Patience, Token);
        }
        catch (OperationCanceledException)
        {
            // The stop ends the run.
        }
        catch (ShutdownIncompleteException)
        {
            // A loaded host can stall the release past the unwind window. The wait below covers it.
        }

        await EventuallyAsync(() => Task.FromResult(Handlers(taskId).Count == 1), "the handler span of the attempt");

        Assert.Equal(state, (await TaskAsync(DataSource, taskId)).Text("state"));
        Assert.Equal(spanOutcome, Handler(taskId).GetTagItem(Names.HandlerOutcome));
        // The shutdown stop is not a failure, and a lost lease is not an error of the span.
        AssertErrors(Handler(taskId));
        AssertPoints("workhorse.handler.executions", [Tags((Names.QueueName, QueueName), (Names.TaskType, "email.send"), (Names.HandlerOutcome, metricOutcome))]);
    }

    /// <summary>
    /// <c>fail_v1</c> answers <c>cancel_requested</c>, and <c>acknowledge_cancel_v1</c> refuses. The
    /// worker settles nothing, so the handler outcome is a lost lease, not <c>unknown</c>, and the span
    /// records <c>stale</c>. A trigger of this test database keeps the acknowledgement from deleting
    /// the runtime row.
    /// </summary>
    [Fact]
    public async Task ARefusedCancellationAcknowledgementReportsALostLease()
    {
        var taskId = await EnqueueAsync("email.send", Boundaries());
        await ScalarAsync(DataSource, "CREATE FUNCTION public.keep_runtime() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END; $$");
        await ScalarAsync(DataSource, $"""
            CREATE TRIGGER keep_runtime BEFORE DELETE ON workhorse.task_runtime FOR EACH ROW
            WHEN (OLD.task_id = '{taskId}') EXECUTE FUNCTION public.keep_runtime()
            """);
        try
        {
            await using var worker = new Worker(DataSource, WorkerOptions());
            worker.Handle<object?, object?>("email.send", async (_, _) =>
            {
                await ScalarAsync(DataSource, "SELECT status FROM workhorse.cancel_v1($1, 'test', 'no longer needed')", taskId);
                throw new InvalidOperationException("the handler failed");
            });
            Assert.True(await worker.RunOnceAsync(Token));
        }
        finally
        {
            await ScalarAsync(DataSource, "DROP TRIGGER keep_runtime ON workhorse.task_runtime");
            await ScalarAsync(DataSource, "DROP FUNCTION public.keep_runtime()");
        }

        Assert.Equal("stale", Handler(taskId).GetTagItem(Names.HandlerOutcome));
        AssertErrors(Handler(taskId), typeof(InvalidOperationException).FullName!);
        AssertPoints("workhorse.handler.executions", [Tags((Names.QueueName, QueueName), (Names.TaskType, "email.send"), (Names.HandlerOutcome, "lease_lost"))]);
    }

    /// <summary>
    /// A heartbeat round delivers the cancellation, and <c>acknowledge_cancel_v1</c> fails or
    /// PostgreSQL refuses it. The worker settled nothing, so the attempt has no outcome. The span gets
    /// <c>canceled</c> only after PostgreSQL accepts: a failed acknowledgement gives <c>unknown</c>,
    /// and a refused one gives <c>stale</c>, as in TypeScript. A trigger of this test database makes
    /// the acknowledgement fail, or refuses it by deleting no row.
    /// </summary>
    [Theory]
    [InlineData(false, "unknown")]
    [InlineData(true, "stale")]
    public async Task AnUnacknowledgedDeliveredCancellationHasNoCanceledSpan(bool refused, string spanOutcome)
    {
        var taskId = await EnqueueAsync("email.send", new EnqueueOptions());
        var body = refused ? "RETURN NULL;" : "RAISE EXCEPTION 'the acknowledgement failed';";
        await ScalarAsync(DataSource, $"CREATE FUNCTION public.refuse_runtime_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN {body} END; $$");
        await ScalarAsync(DataSource, $"""
            CREATE TRIGGER refuse_runtime_delete BEFORE DELETE ON workhorse.task_runtime FOR EACH ROW
            WHEN (OLD.task_id = '{taskId}') EXECUTE FUNCTION public.refuse_runtime_delete()
            """);
        try
        {
            await using var worker = new Worker(DataSource, WorkerOptions(options =>
            {
                options.Lease = TimeSpan.FromSeconds(3);
                options.Heartbeat = TimeSpan.FromMilliseconds(100);
            }));
            worker.Handle<object?, object?>("email.send", async (context, _) =>
            {
                await ScalarAsync(DataSource, "SELECT status FROM workhorse.cancel_v1($1, 'test', 'no longer needed')", taskId);
                await Task.Delay(Timeout.Infinite, context.CancellationToken);
                return null;
            });
            try
            {
                await worker.RunOnceAsync(Token).WaitAsync(Patience, Token);
            }
            catch (Exception) when (!refused)
            {
                // The failed acknowledgement ends the pass with its error.
            }
        }
        finally
        {
            await ScalarAsync(DataSource, "DROP TRIGGER refuse_runtime_delete ON workhorse.task_runtime");
            await ScalarAsync(DataSource, "DROP FUNCTION public.refuse_runtime_delete()");
        }

        Assert.Equal(spanOutcome, Handler(taskId).GetTagItem(Names.HandlerOutcome));
        AssertPoints("workhorse.handler.executions", []);
    }

    /// <summary>
    /// PostgreSQL refuses a completion, and the worker reconciles. A heartbeat round that read the
    /// membership before the release already submitted a cancellation, and
    /// <c>acknowledge_cancel_v1</c> refuses it. During the reconciliation, the refusal proves that the
    /// lease is lost, so the attempt reports <c>lease_lost</c> and the span records <c>stale</c>, as
    /// in TypeScript. The task has no runtime row, so PostgreSQL refuses the acknowledgement. The
    /// worker writes <c>workhorse.task.execution_finished</c> for each attempt whose
    /// <see cref="Workhorse.Internal.Runtime.Arbiter.Reported"/> outcome is not <c>null</c>.
    /// </summary>
    [Fact]
    public async Task ARefusedAcknowledgementOfALateCancellationDuringAReconciliationReportsALostLease()
    {
        await using var worker = new Worker(DataSource, WorkerOptions());
        var task = new ClaimedTask
        {
            Id = Guid.NewGuid(),
            Queue = QueueName,
            Type = "email.send",
            Priority = 0,
            Payload = System.Text.Json.JsonDocument.Parse("null").RootElement.Clone(),
            RedactErrorDetails = false,
            Attempt = 1,
            MaxAttempts = 1,
            FenceToken = 7,
        };
        var arbiter = new Workhorse.Internal.Runtime.Arbiter();
        var ownership = new Workhorse.Internal.Runtime.Ownership(Workhorse.Internal.Runtime.Monotonic.Now(), Workhorse.Internal.Runtime.Monotonic.Millis(30_000));
        var attempt = WorkerTelemetry.StartAttempt(task);
        Assert.True(arbiter.Submit(Workhorse.Internal.Runtime.Outcome.Cancelled));

        var error = await Assert.ThrowsAsync<LeaseLostException>(
            () => worker.ReconcileRejectedCompletionAsync(task, ownership, arbiter, CancellationToken.None));
        Assert.Equal("cancel", error.Operation);
        Assert.Equal(Workhorse.Internal.Runtime.Outcome.LeaseExpired, arbiter.Reported);
        attempt?.Finish(arbiter.Released ?? arbiter.Reported);

        Assert.Equal("stale", Handler(task.Id).GetTagItem(Names.HandlerOutcome));
        var lost = Tags((Names.QueueName, QueueName), (Names.TaskType, "email.send"), (Names.HandlerOutcome, "lease_lost"));
        AssertPoints("workhorse.handler.duration", [lost]);
        AssertPoints("workhorse.handler.executions", [lost]);
    }

    // The enqueued boundaries are far away, so the worker's own timers cannot reach them.
    /// <summary>
    /// As in TypeScript, only a handler error or a failed statement gives the handler span the error
    /// status, with one <c>exception</c> event for each of <paramref name="errorTypes"/> in order. A
    /// lost lease does not.
    /// </summary>
    private static void AssertErrors(System.Diagnostics.Activity span, params string[] errorTypes)
    {
        Assert.Equal(errorTypes.Length == 0 ? System.Diagnostics.ActivityStatusCode.Unset : System.Diagnostics.ActivityStatusCode.Error, span.Status);
        Assert.Equal(errorTypes, span.Events.Where(item => item.Name == "exception").Select(item => item.Tags.Single(tag => tag.Key == "exception.type").Value as string));
    }

    private static EnqueueOptions Boundaries() => new()
    {
        MaxAttempts = 1,
        Deadline = DateTimeOffset.UtcNow.AddHours(1),
        ExecutionTimeout = TimeSpan.FromHours(1),
    };

    private WorkerOptions WorkerOptions(Action<WorkerOptions>? configure = null) => Options(QueueName, options =>
    {
        options.PollingOnly = true;
        options.PollInterval = TimeSpan.FromMilliseconds(10);
        options.DisableRegistry = true;
        options.Lease = TimeSpan.FromSeconds(60);
        options.Heartbeat = TimeSpan.FromSeconds(30);
        options.MaintenanceInterval = TimeSpan.FromHours(1);
        configure?.Invoke(options);
    });

    // Lets the lease lapse under an unchanged fence, and makes the boundary due if one is named.
    private async Task LapseAsync(Guid taskId, string? boundary)
    {
        var change = boundary is null ? $"expires_at = {Past}" : $"expires_at = {Past}, {boundary} = {Past}";
        await ScalarAsync(DataSource, $"UPDATE workhorse.task_runtime SET {change} WHERE task_id = $1", taskId);
    }
}
