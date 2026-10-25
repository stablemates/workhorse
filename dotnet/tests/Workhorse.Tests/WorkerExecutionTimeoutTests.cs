using Workhorse.Tests.Testing;
using static Workhorse.Tests.Testing.WorkerHarness;

namespace Workhorse.Tests;

/// <summary>The C# worker's local execution-timeout timer against PostgreSQL.</summary>
/// <remarks>
/// The maintenance tick of any running worker times out every overdue attempt in its database. If a
/// tick wins, the worker's own expiration answers <c>stale</c>, and the handler sees
/// <see cref="CancelReason.LeaseLost"/>. This class has a database of its own, so no worker of a
/// parallel class ticks on it, and only this worker's local timer can settle the attempt (SM-1684,
/// SM-1732).
/// </remarks>
public sealed class WorkerExecutionTimeoutTests(ScratchDatabase database) : IClassFixture<ScratchDatabase>
{
    private sealed record Order(int OrderId);

    [Fact]
    public async Task AnExecutionTimeoutCancelsTheHandlerAndSettlesTheAttempt()
    {
        var queue = UniqueQueue("timeout");
        // After its startup pass, the worker sends no tick until the test ends.
        await using var worker = new Worker(database.DataSource, Options(queue, options => options.MaintenanceInterval = TimeSpan.FromMinutes(10)));
        var witness = new CancellationWitness();
        worker.Handle<Order>("slow", (context, _) => witness.WaitForCancellationAsync(context));
        var startedAt = await ScalarAsync(database.DataSource, "SELECT clock_timestamp()");

        await using var running = new RunningWorker(worker);
        await EventuallyAsync(
            async () => await ScalarAsync(
                database.DataSource,
                "SELECT last_completed_at > $1 FROM workhorse.maintenance_state WHERE routine_name = 'tick'",
                startedAt!) is true,
            "the startup maintenance pass completes");
        var taskId = await EnqueueAsync(database.DataSource, queue, "slow", new { orderId = 1 }, new { maxAttempts = 1, executionTimeoutMs = 300 });

        await TaskInStateAsync(database.DataSource, taskId, "failed");
        await witness.AssertReasonAsync(CancelReason.ExecutionTimeout);
        await running.StopAsync();
    }

    /// <summary>
    /// SM-1701: the handler moves PostgreSQL's copy of the timeout 2.5 s later, so the worker clock
    /// runs ahead of PostgreSQL by more than the 2 s lease. PostgreSQL answers <c>not_due</c> for
    /// those 2.5 s. The attempt reaches its database timeout only if renewals continue. The timeout
    /// of 1.5 s gives the handler time to move the database copy before the local timer fires. The
    /// retry backs off from 5 ms to 1 s, so the worker asks about 11 times. A fixed 5 ms retry asks
    /// hundreds of times, and each request locks the task row that the heartbeat renews.
    /// </summary>
    [Fact]
    public async Task RenewalsContinueWhileTheWorkerAsksAgainAfterNotDue()
    {
        await ExecuteAsync(
            """
            CREATE SEQUENCE workhorse_test_expiry_asks;
            ALTER FUNCTION workhorse.expire_owned_v1(uuid, text, bigint) RENAME TO expire_owned_v1__counted;
            CREATE FUNCTION workhorse.expire_owned_v1(p_task_id uuid, p_worker_id text, p_fence_token bigint)
            RETURNS text LANGUAGE plpgsql AS $$
            BEGIN
              PERFORM nextval('workhorse_test_expiry_asks');
              RETURN workhorse.expire_owned_v1__counted(p_task_id, p_worker_id, p_fence_token);
            END;
            $$;
            """);
        try
        {
            var queue = UniqueQueue("not-due");
            await using var worker = new Worker(database.DataSource, Options(queue, options =>
            {
                options.Lease = TimeSpan.FromSeconds(2);
                options.Heartbeat = TimeSpan.FromMilliseconds(200);
                options.MaintenanceInterval = TimeSpan.FromHours(1);
            }));
            var observed = new TaskCompletionSource<(CancelReason? Reason, bool AfterExpiry)>(TaskCreationOptions.RunContinuationsAsynchronously);
            worker.Handle<Order>("slow", async (context, _) =>
            {
                var expiry = await ScalarAsync(
                    database.DataSource,
                    "UPDATE workhorse.task_runtime SET attempt_timeout_at = attempt_timeout_at + interval '2500 milliseconds' WHERE task_id = $1 AND attempt_timeout_at > clock_timestamp() RETURNING attempt_timeout_at",
                    context.Task.Id);
                Assert.NotNull(expiry);
                try
                {
                    await Task.Delay(Timeout.Infinite, context.CancellationToken);
                }
                catch (OperationCanceledException)
                {
                    var after = await ScalarAsync(database.DataSource, "SELECT clock_timestamp() >= $1", expiry!);
                    observed.TrySetResult((context.CancelReason, after is true));
                    throw;
                }
            });
            var startedAt = await ScalarAsync(database.DataSource, "SELECT clock_timestamp()");

            await using var running = new RunningWorker(worker);
            await EventuallyAsync(
                async () => await ScalarAsync(
                    database.DataSource,
                    "SELECT last_completed_at > $1 FROM workhorse.maintenance_state WHERE routine_name = 'tick'",
                    startedAt!) is true,
                "the startup maintenance pass completes");
            var taskId = await EnqueueAsync(database.DataSource, queue, "slow", new { orderId = 1 }, new { maxAttempts = 1, executionTimeoutMs = 1500 });

            await TaskInStateAsync(database.DataSource, taskId, "failed");
            Assert.Equal((CancelReason.ExecutionTimeout, true), await observed.Task.WaitAsync(Patience, TestContext.Current.CancellationToken));
            await running.StopAsync();
            var asks = (long)(await ScalarAsync(database.DataSource, "SELECT last_value FROM workhorse_test_expiry_asks"))!;
            Assert.True(asks <= 20, $"the worker asked PostgreSQL to expire the attempt {asks} times");
        }
        finally
        {
            await ExecuteAsync(
                """
                DROP FUNCTION workhorse.expire_owned_v1(uuid, text, bigint);
                ALTER FUNCTION workhorse.expire_owned_v1__counted(uuid, text, bigint) RENAME TO expire_owned_v1;
                DROP SEQUENCE workhorse_test_expiry_asks;
                """);
        }
    }

    private async Task ExecuteAsync(string sql)
    {
        await using var command = database.DataSource.CreateCommand(sql);
        await command.ExecuteNonQueryAsync(TestContext.Current.CancellationToken);
    }
}
