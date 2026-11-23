using System.Diagnostics;
using Workhorse.Tests.Testing;
using static Workhorse.Tests.Testing.WorkerHarness;

namespace Workhorse.Tests.Telemetry;

/// <summary>
/// The errors of a handler span when a handler fails and a statement of the settlement then fails.
/// As in TypeScript, the span records the handler error first and the error of the statement
/// second.
/// </summary>
/// <remarks>
/// Each test replaces one function of the database of this class with a function that raises an
/// error, so no other class uses that database.
/// </remarks>
public sealed class SettlementErrorTelemetryTests(ScratchDatabase database) : TelemetryDatabaseCase(database)
{
    private const string Past = "clock_timestamp() - interval '1 second'";

    /// <summary>
    /// The statement can be <c>fail_v2</c>, the reconciliation of a <c>stale</c> answer, or the
    /// acknowledgement of a <c>cancel_requested</c> answer. The worker records the handler error
    /// before it reads the retry delay, so a retry delay that throws comes second too.
    /// </summary>
    [Theory]
    [InlineData("fail")]
    [InlineData("reconciliation")]
    [InlineData("acknowledgement")]
    [InlineData("retry-delay")]
    public async Task TheSpanRecordsTheHandlerErrorAndThenTheErrorOfTheSettlement(string failure)
    {
        var taskId = await EnqueueAsync("email.send", Boundaries());
        var function = failure switch
        {
            "fail" => "fail_v2",
            "reconciliation" => "expire_owned_telemetry_v1",
            "acknowledgement" => "acknowledge_cancel_v1",
            _ => null,
        };
        Exception settlement;
        await using (await FailingFunctionAsync(function))
        {
            await using var worker = new Worker(DataSource, WorkerOptions(options =>
            {
                if (failure == "retry-delay")
                {
                    options.RetryDelay = (_, _) => TimeSpan.FromMilliseconds(-1);
                }
            }));
            worker.Handle<object?, object?>("email.send", async (_, _) =>
            {
                if (failure == "reconciliation")
                {
                    await ScalarAsync(DataSource, $"UPDATE workhorse.task_runtime SET expires_at = {Past} WHERE task_id = $1", taskId);
                }
                else if (failure == "acknowledgement")
                {
                    await ScalarAsync(DataSource, "SELECT status FROM workhorse.cancel_v1($1, 'test', 'no longer needed')", taskId);
                }

                throw new InvalidOperationException("the handler failed");
            });
            settlement = await Assert.ThrowsAnyAsync<Exception>(() => worker.RunOnceAsync(Token));
        }

        AssertErrors(Handler(taskId), typeof(InvalidOperationException).FullName!, settlement.GetType().FullName!);
    }

    /// <summary>
    /// A handler fails after the shutdown cancellation, and then <c>release_owned_v1</c> fails. As in
    /// TypeScript, the stop is not a failure of the task, so the span records only the error of the
    /// statement.
    /// </summary>
    [Fact]
    public async Task AFailedReleaseAfterTheShutdownRecordsOnlyTheStatementError()
    {
        var taskId = await EnqueueAsync("email.send", Boundaries());
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        Exception? settlement = null;
        await using (await FailingFunctionAsync("release_owned_v1"))
        {
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
                    throw new InvalidOperationException("the handler failed after the shutdown");
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
            catch (Exception error) when (error is not ShutdownIncompleteException)
            {
                settlement = error;
            }

            await EventuallyAsync(() => Task.FromResult(Handlers(taskId).Count == 1), "the handler span of the attempt");
        }

        Assert.NotNull(settlement);
        AssertErrors(Handler(taskId), typeof(DatabaseException).FullName!);
    }

    private static void AssertErrors(Activity span, params string[] errorTypes)
    {
        Assert.Equal(errorTypes.Length == 0 ? ActivityStatusCode.Unset : ActivityStatusCode.Error, span.Status);
        Assert.Equal(errorTypes, ExceptionTypes(span));
    }

    private static List<object?> ExceptionTypes(Activity span) =>
        [.. span.Events.Where(item => item.Name == "exception").Select(item => item.Tags.Single(tag => tag.Key == "exception.type").Value)];

    private static EnqueueOptions Boundaries() => new()
    {
        MaxAttempts = 1,
        Deadline = DateTimeOffset.UtcNow.AddHours(1),
        ExecutionTimeout = TimeSpan.FromHours(1),
    };

    // Only the tick before the claim runs, and no heartbeat round runs while the handler runs.
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

    /// <summary>
    /// Replaces <c>workhorse.<paramref name="name"/></c> with a function of the same signature that
    /// raises an error, until the result is disposed. A <c>null</c> name replaces no function.
    /// </summary>
    private async Task<IAsyncDisposable> FailingFunctionAsync(string? name)
    {
        if (name is null)
        {
            return new Restore(() => Task.CompletedTask);
        }

        var identity = (string)(await ScalarAsync(DataSource, "SELECT pg_get_function_identity_arguments(oid) FROM pg_proc WHERE proname = $1 AND pronamespace = 'workhorse'::regnamespace", name))!;
        var arguments = (string)(await ScalarAsync(DataSource, "SELECT pg_get_function_arguments(oid) FROM pg_proc WHERE proname = $1 AND pronamespace = 'workhorse'::regnamespace", name))!;
        var result = (string)(await ScalarAsync(DataSource, "SELECT pg_get_function_result(oid) FROM pg_proc WHERE proname = $1 AND pronamespace = 'workhorse'::regnamespace", name))!;
        await ScalarAsync(DataSource, $"""
            ALTER FUNCTION workhorse.{name}({identity}) RENAME TO test_original_{name};
            CREATE FUNCTION workhorse.{name}({arguments}) RETURNS {result} LANGUAGE plpgsql AS $body$
              BEGIN RAISE EXCEPTION 'injected {name} failure'; END $body$;
            """);
        return new Restore(() => ScalarAsync(DataSource, $"""
            DROP FUNCTION workhorse.{name}({identity});
            ALTER FUNCTION workhorse.test_original_{name}({identity}) RENAME TO {name};
            """));
    }

    private sealed class Restore(Func<Task> restore) : IAsyncDisposable
    {
        public async ValueTask DisposeAsync() => await restore().ConfigureAwait(false);
    }
}
