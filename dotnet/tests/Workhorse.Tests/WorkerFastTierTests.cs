using System.Collections.Concurrent;
using Npgsql;
using Workhorse.Internal;
using Workhorse.Internal.Database;
using Workhorse.Tests.Testing;
using static Workhorse.Tests.Testing.WorkerHarness;

namespace Workhorse.Tests;

/// <summary>
/// The fast task tier (ADR 0077) and the fused completion in slot cohorts (ADR 0076, rules 10 to 16)
/// against PostgreSQL.
/// </summary>
public sealed class WorkerFastTierTests(ScratchDatabase database)
{
    private sealed record Order(int OrderId);

    private sealed record Total(int Value);

    /// <summary>Moves <paramref name="queue"/> to the fast tier. It holds no live task yet.</summary>
    internal static async Task FastTierAsync(NpgsqlDataSource dataSource, string queue)
    {
        await using var connection = await dataSource.OpenConnectionAsync();
        var rows = await Sql.RowsAsync(
            connection,
            SqlCatalogue.SetQueueTier,
            [Parameters.Text(queue), Parameters.Text("fast"), Parameters.Text("dotnet-test"), Parameters.Text("fast tier test")],
            CancellationToken.None);
        Assert.Equal("fast", rows.Single().Text("tier"));
    }

    /// <summary>The number of rows of <paramref name="table"/> that belong to <paramref name="ids"/>.</summary>
    private async Task<long> CountAsync(string table, IEnumerable<Guid> ids) =>
        (long)(await ScalarAsync(database.DataSource, $"SELECT count(*) FROM workhorse.{table} WHERE task_id = ANY($1)", ids.ToArray()))!;

    [Fact]
    public async Task AFastTierTaskLeavesOneOutcomeRowAndNoHistory()
    {
        var queue = UniqueQueue("fast");
        await FastTierAsync(database.DataSource, queue);
        await using var worker = new Worker(database.DataSource, Options(queue));
        worker.Handle<Order, Total>("total", (_, order) => Task.FromResult(new Total(order.OrderId * 2)));
        var ids = new List<Guid>();
        for (var order = 1; order <= 3; order++)
        {
            ids.Add(await EnqueueAsync(database.DataSource, queue, "total", new { orderId = order }));
        }

        await using var running = new RunningWorker(worker);
        await EventuallyAsync(async () => await CountAsync("fast_task_outcome", ids) == 3, "three fast-tier outcomes");
        await running.StopAsync();

        var results = await ScalarAsync(
            database.DataSource,
            "SELECT string_agg(state || ':' || (result->>'value'), ',' ORDER BY result->>'value') FROM workhorse.fast_task_outcome WHERE task_id = ANY($1)",
            ids.ToArray());
        Assert.Equal("succeeded:2,succeeded:4,succeeded:6", results);
        Assert.Equal(0, await CountAsync("fast_task_runtime", ids));
        Assert.Equal(0, await CountAsync("task_runtime", ids));
        Assert.Equal(0, await CountAsync("attempt_history", ids));
        Assert.Equal(0, await CountAsync("task_event", ids));
    }

    [Fact]
    public async Task AFailedFastTierAttemptRetriesAndRecordsItsError()
    {
        var queue = UniqueQueue("fast-retry");
        await FastTierAsync(database.DataSource, queue);
        await using var worker = new Worker(database.DataSource, Options(queue));
        var attempts = 0;
        worker.Handle<Order, Total>("flaky", (context, order) =>
        {
            Interlocked.Increment(ref attempts);
            return context.Task.Attempt == 1 ? throw new InvalidOperationException("first attempt fails") : Task.FromResult(new Total(order.OrderId));
        });
        var id = await EnqueueAsync(database.DataSource, queue, "flaky", new { orderId = 5 }, new { maxAttempts = 2, retryPolicy = new { type = "fixed", delayMs = 0 } });

        await using var running = new RunningWorker(worker);
        await EventuallyAsync(async () => await CountAsync("fast_task_outcome", [id]) == 1, "the fast-tier outcome");
        await running.StopAsync();

        var outcome = await ScalarAsync(
            database.DataSource,
            "SELECT state || ':' || attempt || ':' || jsonb_array_length(errors) || ':' || (errors->0->'error'->>'message') FROM workhorse.fast_task_outcome WHERE task_id = $1",
            id);
        Assert.Equal("succeeded:2:1:first attempt fails", outcome);
        Assert.Equal(2, attempts);
    }

    [Fact]
    public async Task FusedCompletionsRefillTheirCohortWithinTheConcurrency()
    {
        const int tasks = 60;
        var queue = UniqueQueue("fused");
        await FastTierAsync(database.DataSource, queue);
        await using var worker = new Worker(database.DataSource, Options(queue, options => options.Concurrency = 8));
        Assert.Equal(2, worker.Cohorts);
        var statements = new ConcurrentQueue<Worker.FusedStatement>();
        worker.FusedStatementHook = statements.Enqueue;
        var running = 0;
        var most = 0;
        var done = 0;
        worker.Handle<Order, Total>("work", async (_, order) =>
        {
            var now = Interlocked.Increment(ref running);
            InterlockedMax(ref most, now);
            await Task.Delay(Random.Shared.Next(1, 10));
            Interlocked.Decrement(ref running);
            Interlocked.Increment(ref done);
            return new Total(order.OrderId);
        });
        var ids = new List<Guid>();
        for (var order = 0; order < tasks; order++)
        {
            ids.Add(await EnqueueAsync(database.DataSource, queue, "work", new { orderId = order }));
        }

        await using (var run = new RunningWorker(worker))
        {
            await EventuallyAsync(async () => await CountAsync("fast_task_outcome", ids) == tasks, "every fast-tier outcome");
            await run.StopAsync();
        }

        Assert.Equal(tasks, done);
        Assert.InRange(most, 1, 8);
        // A fused statement completed tasks and claimed the next ones in the same round trip.
        Assert.Contains(statements, statement => statement.Completions > 0 && statement.Claimed > 0);
        // Each claim, plain or fused, asks for at most one cohort's share of 4 slots.
        Assert.All(statements, statement => Assert.InRange(statement.ClaimLimit, 0, 4));
        Assert.All(statements, statement => Assert.InRange(statement.Claimed, 0, statement.ClaimLimit));
        Assert.Equal(0, worker.ActiveAttempts);
        Assert.Equal(0, await CountAsync("fast_task_runtime", ids));
    }

    [Fact]
    public async Task AFullTierQueueIgnoresCohortsAndCompletesThroughCompleteV1()
    {
        const int tasks = 12;
        var queue = UniqueQueue("full");
        await using var worker = new Worker(database.DataSource, Options(queue, options => options.Concurrency = 8));
        var statements = new ConcurrentQueue<Worker.FusedStatement>();
        worker.FusedStatementHook = statements.Enqueue;
        worker.Handle<Order, Total>("work", (_, order) => Task.FromResult(new Total(order.OrderId)));
        var ids = new List<Guid>();
        for (var order = 0; order < tasks; order++)
        {
            ids.Add(await EnqueueAsync(database.DataSource, queue, "work", new { orderId = order }));
        }

        await using (var run = new RunningWorker(worker))
        {
            await EventuallyAsync(
                async () => (long)(await ScalarAsync(database.DataSource, "SELECT count(*) FROM workhorse.task_outcome WHERE task_id = ANY($1)", ids.ToArray()))! == tasks,
                "every full-tier outcome");
            await run.StopAsync();
        }

        // The queue rejected the fast-tier probe, so no fused statement ran.
        Assert.Empty(statements);
        Assert.Equal(tasks, await CountAsync("attempt_history", ids));
        Assert.Equal(0, await CountAsync("fast_task_outcome", ids));
    }

    [Fact]
    public async Task AWorkerOnAFastAndAFullQueueRunsBoth()
    {
        var fast = UniqueQueue("mixed-fast");
        var full = UniqueQueue("mixed-full");
        await FastTierAsync(database.DataSource, fast);
        await using var worker = new Worker(database.DataSource, Options(fast, options =>
        {
            options.Queues = [fast, full];
            options.Concurrency = 8;
        }));
        worker.Handle<Order, Total>("work", (_, order) => Task.FromResult(new Total(order.OrderId)));
        var fastIds = new List<Guid>();
        var fullIds = new List<Guid>();
        for (var order = 0; order < 6; order++)
        {
            fastIds.Add(await EnqueueAsync(database.DataSource, fast, "work", new { orderId = order }));
            fullIds.Add(await EnqueueAsync(database.DataSource, full, "work", new { orderId = order }));
        }

        await using (var run = new RunningWorker(worker))
        {
            await EventuallyAsync(async () => await CountAsync("fast_task_outcome", fastIds) == 6, "every fast-tier outcome");
            await EventuallyAsync(
                async () => (long)(await ScalarAsync(database.DataSource, "SELECT count(*) FROM workhorse.task_outcome WHERE task_id = ANY($1)", fullIds.ToArray()))! == 6,
                "every full-tier outcome");
            await run.StopAsync();
        }

        Assert.Equal(0, worker.ActiveAttempts);
    }

    [Fact]
    public async Task AFastClaimStartsItsLeaseWindowAfterTheWaitForThePool()
    {
        var queue = UniqueQueue("fast-pool");
        await FastTierAsync(database.DataSource, queue);
        // The heartbeat reserves one connection, so the test can hold the other two.
        await using var dataSource = database.CreateDataSource(builder => builder.MaxPoolSize = 3);
        await using var worker = new Worker(dataSource, Options(queue, options =>
        {
            options.PollingOnly = true;
            options.DisableRegistry = true;
            options.Lease = TimeSpan.FromSeconds(1);
        }));
        worker.Handle<Order, Total>("total", (_, order) => Task.FromResult(new Total(order.OrderId)));

        await using var running = new RunningWorker(worker);
        // An empty fast claim answered, so the worker knows the tier and claims again on its poll.
        await EventuallyAsync(() => Task.FromResult(Volatile.Read(ref worker.ClaimsAnswered) > 0), "the first claim answers");
        var id = Guid.Empty;
        await using (await dataSource.OpenConnectionAsync(TestContext.Current.CancellationToken))
        await using (await dataSource.OpenConnectionAsync(TestContext.Current.CancellationToken))
        {
            id = await EnqueueAsync(database.DataSource, queue, "total", new { orderId = 4 });
            // The next claim waits for the pool longer than the lease. Its lease window must not
            // start before PostgreSQL grants the lease.
            await Task.Delay(TimeSpan.FromMilliseconds(1_500), TestContext.Current.CancellationToken);
        }

        await EventuallyAsync(async () => await CountAsync("fast_task_outcome", [id]) == 1, "the fast-tier outcome");
        await running.StopAsync();
        Assert.Equal(
            "succeeded:1:0",
            await ScalarAsync(database.DataSource, "SELECT state || ':' || attempt || ':' || jsonb_array_length(errors) FROM workhorse.fast_task_outcome WHERE task_id = $1", id));
    }

    [Fact]
    public async Task AStopRunsTheTaskThatAFusedClaimInFlightReturns()
    {
        var queue = UniqueQueue("fast-stop");
        await FastTierAsync(database.DataSource, queue);
        await using var worker = new Worker(database.DataSource, Options(queue, options => options.DisableRegistry = true));
        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var ran = new ConcurrentQueue<int>();
        worker.Handle<Order, Total>("work", async (_, order) =>
        {
            ran.Enqueue(order.OrderId);
            if (order.OrderId == 1)
            {
                await gate.Task;
            }

            return new Total(order.OrderId);
        });
        var first = await EnqueueAsync(database.DataSource, queue, "work", new { orderId = 1 });
        var running = new RunningWorker(worker);
        await EventuallyAsync(() => Task.FromResult(ran.Contains(1)), "the first handler runs");
        var second = await EnqueueAsync(database.DataSource, queue, "work", new { orderId = 2 });

        // The test holds the first task's runtime row, so the fused statement that completes it and
        // claims the second task waits in PostgreSQL.
        await using (var connection = await database.DataSource.OpenConnectionAsync(TestContext.Current.CancellationToken))
        await using (var transaction = await connection.BeginTransactionAsync(TestContext.Current.CancellationToken))
        {
            await using (var command = new NpgsqlCommand("SELECT 1 FROM workhorse.fast_task_runtime WHERE task_id = $1 FOR UPDATE", connection, transaction))
            {
                command.Parameters.Add(new NpgsqlParameter { Value = first });
                await command.ExecuteScalarAsync(TestContext.Current.CancellationToken);
            }

            gate.SetResult();
            await EventuallyAsync(
                async () => (long)(await ScalarAsync(
                    database.DataSource,
                    "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%complete_many_and_claim_v1%'"))! > 0,
                "the fused statement waits for the row");
            var stop = running.StopAsync();
            // The dispatch loop stops claiming now. The fused claim still holds a lease for the second task.
            await Task.Delay(300, TestContext.Current.CancellationToken);
            await transaction.CommitAsync(TestContext.Current.CancellationToken);
            await stop;
        }

        Assert.Equal([1, 2], ran);
        Assert.Equal(
            "succeeded,succeeded",
            await ScalarAsync(database.DataSource, "SELECT string_agg(state, ',') FROM workhorse.fast_task_outcome WHERE task_id = ANY($1)", new[] { first, second }));
        await running.DisposeAsync();
    }

    [Fact]
    public void TheDefaultCohortsFollowTheConcurrency()
    {
        Assert.Equal(1, Worker.DefaultCohorts(7, null));
        Assert.Equal(2, Worker.DefaultCohorts(8, null));
        Assert.Equal(2, Worker.DefaultCohorts(16, null));
        Assert.Equal(3, Worker.DefaultCohorts(17, null));
        Assert.Equal(8, Worker.DefaultCohorts(100, null));
    }

    private static void InterlockedMax(ref int target, int value)
    {
        var current = Volatile.Read(ref target);
        while (value > current)
        {
            var seen = Interlocked.CompareExchange(ref target, value, current);
            if (seen == current)
            {
                return;
            }

            current = seen;
        }
    }
}
