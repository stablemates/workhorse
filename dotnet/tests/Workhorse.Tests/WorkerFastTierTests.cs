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
public sealed class WorkerFastTierTests(ScratchDatabase database) : IClassFixture<ScratchDatabase>
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

    /// <summary>
    /// A fused claim asks only the completing task's queue. While that queue has a backlog, each
    /// completion refills the slot, so no plain claim asks the other queues (SM-1676).
    /// </summary>
    [Fact]
    public async Task AnotherQueueGetsAClaimWhileAFastQueueKeepsABacklog()
    {
        const int backlog = 100;
        await WarmUpFusedCompletionsAsync();
        var hot = UniqueQueue("fair-hot");
        var cold = UniqueQueue("fair-cold");
        await FastTierAsync(database.DataSource, hot);
        await FastTierAsync(database.DataSource, cold);
        // The first plain claim asks the second queue, so it asks the hot queue first.
        await using var worker = new Worker(database.DataSource, Options(hot, options =>
        {
            options.Queues = [cold, hot];
            options.Concurrency = 1;
            options.DisableRegistry = true;
        }));
        // Each handler start and the claim limit of each fused completion, in order.
        var events = new ConcurrentQueue<string>();
        worker.FusedStatementHook = statement =>
        {
            if (statement.Completions > 0)
            {
                events.Enqueue($"fused:{statement.ClaimLimit}");
            }
        };
        worker.Handle<Order, Total>("work", async (context, order) =>
        {
            var isCold = context.Task.Queue == cold;
            events.Enqueue(isCold ? "cold" : "hot");
            if (!isCold)
            {
                await Task.Delay(2);
            }

            return new Total(order.OrderId);
        });
        for (var order = 0; order < backlog; order++)
        {
            await EnqueueAsync(database.DataSource, hot, "work", new { orderId = order });
        }

        await EnqueueAsync(database.DataSource, cold, "work", new { orderId = backlog });

        await using (var run = new RunningWorker(worker))
        {
            await EventuallyAsync(() => events.Contains("cold"), "the cold task starts");
            await run.StopAsync();
        }

        // Once the cold queue has waited a poll interval, one hot completion claims nothing. Its slot
        // goes to a plain claim, which asks the cold queue next. Each earlier completion refilled.
        // A slow start can make the first completion the one that skips.
        var seen = events.ToList();
        var coldAt = seen.IndexOf("cold");
        Assert.InRange(seen.Take(coldAt).Count(entry => entry == "hot"), 1, (backlog / 2) - 1);
        var fused = seen.Take(coldAt).Where(entry => entry.StartsWith("fused:", StringComparison.Ordinal)).ToList();
        Assert.Equal("fused:0", seen[coldAt - 1]);
        Assert.All(fused[..^1], entry => Assert.Equal("fused:1", entry));
    }

    /// <summary>
    /// After a completion skips its refill for fairness, a plain claim in flight for another cohort
    /// keeps a new plain claim from starting. The next completion of the first cohort must not take
    /// the slot that the skip gave back, or every slot fills again and the other queue starves.
    /// </summary>
    [Fact]
    public async Task KeepsTheSlotOfAFairnessSkipFreeForAPlainClaim()
    {
        var hot = UniqueQueue("skip-hot");
        var cold = UniqueQueue("skip-cold");
        await FastTierAsync(database.DataSource, hot);
        await FastTierAsync(database.DataSource, cold);
        await using var worker = new Worker(database.DataSource, Options(hot, options =>
        {
            options.Queues = [hot, cold];
            options.Concurrency = 4;
            options.Cohorts = 2;
            options.PollInterval = TimeSpan.FromMilliseconds(40);
            options.DisableRegistry = true;
        }));
        var limits = new ConcurrentQueue<int>();
        worker.FusedStatementHook = statement =>
        {
            if (statement.Completions > 0)
            {
                limits.Enqueue(statement.ClaimLimit);
            }
        };
        var holding = false;
        var heldClaim = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var claimHeld = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        worker.PlainClaimHook = () =>
        {
            if (!Volatile.Read(ref holding))
            {
                return Task.CompletedTask;
            }

            claimHeld.TrySetResult();
            return heldClaim.Task;
        };
        // Each handler waits until the test finishes its task, or until the test opens every handler.
        var started = new ConcurrentQueue<int>();
        var finishes = new ConcurrentDictionary<int, TaskCompletionSource>();
        var open = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        TaskCompletionSource Finish(int order) => finishes.GetOrAdd(order, _ => new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously));
        worker.Handle<Order, Total>("work", async (_, order) =>
        {
            started.Enqueue(order.OrderId);
            await Task.WhenAny(Finish(order.OrderId).Task, open.Task);
            return new Total(order.OrderId);
        });
        for (var order = 0; order < 20; order++)
        {
            await EnqueueAsync(database.DataSource, hot, "work", new { orderId = order });
        }

        await using (var run = new RunningWorker(worker))
        {
            try
            {
                // The first plain claim fills cohort 0 with tasks 0 and 1, the second fills cohort 1
                // with tasks 2 and 3.
                await EventuallyAsync(() => started.Count == 4, "four tasks start");
                Assert.Equal([0, 1, 2, 3], started.Order());
                Volatile.Write(ref holding, true);
                // The cold queue waits a fairness interval. A cohort 1 completion then skips its
                // refill, and the plain claim that takes its slot stays in flight.
                await Task.Delay(100, TestContext.Current.CancellationToken);
                Finish(2).SetResult();
                await claimHeld.Task.WaitAsync(Patience, TestContext.Current.CancellationToken);
                // That claim has not asked the cold queue, so a cohort 0 completion skips too.
                Finish(0).SetResult();
                await EventuallyAsync(() => limits.Count == 2, "the second fused completion");
                Finish(1).SetResult();
                await EventuallyAsync(() => limits.Count == 3, "the third fused completion");
                // The skip is pending, so the third completion asks only for its own slot, not 2.
                Assert.Equal([0, 0, 1], limits);
            }
            finally
            {
                open.TrySetResult();
                heldClaim.TrySetResult();
                await run.StopAsync();
            }
        }
    }

    /// <summary>
    /// Runs one fused completion in this process first, so the first run of the code does not use up
    /// the poll interval of a test that measures it.
    /// </summary>
    private async Task WarmUpFusedCompletionsAsync()
    {
        var queue = UniqueQueue("fair-warm");
        await FastTierAsync(database.DataSource, queue);
        await using var worker = new Worker(database.DataSource, Options(queue, options => options.DisableRegistry = true));
        worker.Handle<Order, Total>("work", (_, order) => Task.FromResult(new Total(order.OrderId)));
        var ids = new List<Guid>();
        for (var order = 0; order < 2; order++)
        {
            ids.Add(await EnqueueAsync(database.DataSource, queue, "work", new { orderId = order }));
        }

        await using var running = new RunningWorker(worker);
        await EventuallyAsync(async () => await CountAsync("fast_task_outcome", ids) == 2, "the warm-up outcomes");
        await running.StopAsync();
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
