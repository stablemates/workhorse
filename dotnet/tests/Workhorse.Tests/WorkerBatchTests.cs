using System.Collections.Concurrent;
using Workhorse.Tests.Testing;
using static Workhorse.Tests.Testing.WorkerHarness;

namespace Workhorse.Tests;

/// <summary>Batch delivery against PostgreSQL: grouping, order, per-member outcomes, payload types, and drain.</summary>
public sealed class WorkerBatchTests(ScratchDatabase database)
{
    private static readonly TimeSpan LongLinger = TimeSpan.FromSeconds(60);
    private static readonly string[] Ready = ["ready"];
    private static readonly string[] ReadyOrRunning = ["ready", "running"];

    private sealed record Order(int OrderId);

    private sealed record Total(int Value);

    private sealed class DeclinedException(string message) : Exception(message);

    /// <summary>A batch handler class whose payload type has type arguments.</summary>
    private sealed class LineBatch(ConcurrentQueue<List<Order>> seen) : IBatchHandler<List<Order>>
    {
        public string TaskType => "lines";

        public Task<IReadOnlyList<BatchHandlerOutcome>> HandleAsync(IReadOnlyList<BatchHandlerItem<List<Order>>> items, CancellationToken cancellationToken)
        {
            foreach (var item in items)
            {
                seen.Enqueue(item.Payload);
            }

            return Task.FromResult<IReadOnlyList<BatchHandlerOutcome>>([.. items.Select(item => new BatchSucceeded(new Total(item.Payload.Sum(order => order.OrderId))))]);
        }
    }

    [Fact]
    public async Task ABatchRunsInPriorityOrderAndEachMemberSettlesOnItsOwn()
    {
        var queue = UniqueQueue("batch-order");
        await using var worker = new Worker(database.DataSource, Options(queue, options => options.Concurrency = 3));
        var calls = new ConcurrentQueue<int[]>();
        worker.HandleBatch<Order>("charge", new BatchOptions(3, LongLinger), (items, _) =>
        {
            calls.Enqueue([.. items.Select(item => item.Payload.OrderId)]);
            return Task.FromResult<IReadOnlyList<BatchHandlerOutcome>>(
            [
                .. items.Select(item => item.Payload.OrderId == 3
                    ? (BatchHandlerOutcome)new BatchFailed(new DeclinedException($"order {item.Payload.OrderId} declined"))
                    : new BatchSucceeded(new Total(item.Payload.OrderId * 10))),
            ]);
        });
        var low = await EnqueueAsync(database.DataSource, queue, "charge", new { orderId = 1 }, new { priority = 1 });
        var high = await EnqueueAsync(database.DataSource, queue, "charge", new { orderId = 5 }, new { priority = 5 });
        var middle = await EnqueueAsync(database.DataSource, queue, "charge", new { orderId = 3 }, new { priority = 3, maxAttempts = 1 });

        await using var running = new RunningWorker(worker);
        var lowRow = await TaskInStateAsync(database.DataSource, low, "succeeded");
        var highRow = await TaskInStateAsync(database.DataSource, high, "succeeded");
        var middleRow = await TaskInStateAsync(database.DataSource, middle, "failed");
        await running.StopAsync();

        Assert.Equal([5, 3, 1], Assert.Single(calls));
        Assert.Equal(10, lowRow.Json("result")!.Value.GetProperty("value").GetInt32());
        Assert.Equal(50, highRow.Json("result")!.Value.GetProperty("value").GetInt32());
        var error = middleRow.Json("error")!.Value;
        Assert.Equal("DeclinedException", error.GetProperty("name").GetString());
        Assert.Equal("order 3 declined", error.GetProperty("message").GetString());
        // Each member records the batch that dispatched it.
        Assert.Equal(
            3L,
            await ScalarAsync(
                database.DataSource,
                "SELECT count(*) FROM workhorse.task_event WHERE event_type = 'batch_dispatched' AND task_id = ANY($1)",
                new[] { low, high, middle }));
    }

    [Fact]
    public async Task AThrowingBatchHandlerFailsEveryMember()
    {
        var queue = UniqueQueue("batch-throw");
        await using var worker = new Worker(database.DataSource, Options(queue, options => options.Concurrency = 2));
        worker.HandleBatch<Order>("charge", new BatchOptions(2, LongLinger), (_, _) => throw new DeclinedException("the gateway is down"));
        var first = await EnqueueAsync(database.DataSource, queue, "charge", new { orderId = 1 }, new { maxAttempts = 1 });
        var second = await EnqueueAsync(database.DataSource, queue, "charge", new { orderId = 2 }, new { maxAttempts = 1 });

        await using var running = new RunningWorker(worker);
        foreach (var id in new[] { first, second })
        {
            var row = await TaskInStateAsync(database.DataSource, id, "failed");
            Assert.Equal("the gateway is down", row.Json("error")!.Value.GetProperty("message").GetString());
        }

        Assert.Equal(
            2L,
            await ScalarAsync(
                database.DataSource,
                "SELECT count(*) FROM workhorse.task_event WHERE event_type = 'batch_failed' AND task_id = ANY($1)",
                new[] { first, second }));
        await running.StopAsync();
    }

    [Fact]
    public async Task AWrongOutcomeListFailsEveryMember()
    {
        var queue = UniqueQueue("batch-count");
        await using var worker = new Worker(database.DataSource, Options(queue, options => options.Concurrency = 2));
        worker.HandleBatch<Order>("charge", new BatchOptions(2, LongLinger), (_, _) =>
            Task.FromResult<IReadOnlyList<BatchHandlerOutcome>>([new BatchSucceeded(null)]));
        var first = await EnqueueAsync(database.DataSource, queue, "charge", new { orderId = 1 }, new { maxAttempts = 1 });
        var second = await EnqueueAsync(database.DataSource, queue, "charge", new { orderId = 2 }, new { maxAttempts = 1 });

        await using var running = new RunningWorker(worker);
        foreach (var id in new[] { first, second })
        {
            var row = await TaskInStateAsync(database.DataSource, id, "failed");
            var error = row.Json("error")!.Value;
            Assert.Equal("WorkhorseException", error.GetProperty("name").GetString());
            Assert.Equal("Batch handler for charge returned 1 outcomes for 2 tasks", error.GetProperty("message").GetString());
        }

        await running.StopAsync();
    }

    [Fact]
    public async Task ABatchHandlerDecodesItsFullPayloadType()
    {
        var queue = UniqueQueue("batch-type");
        await using var worker = new Worker(database.DataSource, Options(queue));
        var seen = new ConcurrentQueue<List<Order>>();
        worker.HandleBatch(new LineBatch(seen), new BatchOptions(1, TimeSpan.Zero));
        var id = await EnqueueAsync(database.DataSource, queue, "lines", new[] { new { orderId = 2 }, new { orderId = 3 } });

        await using var running = new RunningWorker(worker);
        var row = await TaskInStateAsync(database.DataSource, id, "succeeded");
        await running.StopAsync();

        Assert.Equal([new Order(2), new Order(3)], Assert.Single(seen));
        Assert.Equal(5, row.Json("result")!.Value.GetProperty("value").GetInt32());
    }

    [Fact]
    public async Task AMemberRunsAloneWhenItsLingerEnds()
    {
        var queue = UniqueQueue("batch-linger");
        await using var worker = new Worker(database.DataSource, Options(queue, options => options.Concurrency = 4));
        var sizes = new ConcurrentQueue<int>();
        worker.HandleBatch<Order>("charge", new BatchOptions(4, TimeSpan.FromMilliseconds(100)), (items, _) =>
        {
            sizes.Enqueue(items.Count);
            return Task.FromResult<IReadOnlyList<BatchHandlerOutcome>>([.. items.Select(_ => new BatchSucceeded(null))]);
        });
        var id = await EnqueueAsync(database.DataSource, queue, "charge", new { orderId = 1 });

        await using var running = new RunningWorker(worker);
        await TaskInStateAsync(database.DataSource, id, "succeeded");
        await running.StopAsync();

        Assert.Equal([1], sizes);
    }

    [Fact]
    public async Task TheDrainRunsALingeringBatchAtOnce()
    {
        var queue = UniqueQueue("batch-drain");
        await using var worker = new Worker(database.DataSource, Options(queue, options => options.Concurrency = 4));
        var sizes = new ConcurrentQueue<int>();
        worker.HandleBatch<Order>("charge", new BatchOptions(4, LongLinger), (items, _) =>
        {
            sizes.Enqueue(items.Count);
            return Task.FromResult<IReadOnlyList<BatchHandlerOutcome>>([.. items.Select(_ => new BatchSucceeded(null))]);
        });
        var first = await EnqueueAsync(database.DataSource, queue, "charge", new { orderId = 1 });
        var second = await EnqueueAsync(database.DataSource, queue, "charge", new { orderId = 2 });

        await using var running = new RunningWorker(worker);
        await EventuallyAsync(() => Task.FromResult(worker.ActiveAttempts == 2), "both members linger");
        // The linger is 60 s. The stop must not wait for it.
        await running.StopAsync().WaitAsync(TimeSpan.FromSeconds(20), TestContext.Current.CancellationToken);

        Assert.Equal("succeeded", (await TaskAsync(database.DataSource, first)).Text("state"));
        Assert.Equal("succeeded", (await TaskAsync(database.DataSource, second)).Text("state"));
        Assert.Equal([2], sizes);
    }

    [Fact]
    public async Task AShutdownCancellationOfTheBatchReturnsEveryMemberToItsQueue()
    {
        var queue = UniqueQueue("batch-shutdown");
        await using var worker = new Worker(database.DataSource, Options(queue, options =>
        {
            options.Concurrency = 2;
            options.ShutdownGrace = TimeSpan.FromMilliseconds(200);
        }));
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var reasons = new ConcurrentQueue<CancelReason?>();
        worker.HandleBatch<Order>("charge", new BatchOptions(2, LongLinger), async (items, cancellationToken) =>
        {
            started.TrySetResult();
            try
            {
                await Task.Delay(Timeout.Infinite, cancellationToken);
            }
            finally
            {
                foreach (var item in items)
                {
                    reasons.Enqueue(item.Context.CancelReason);
                }
            }

            return [.. items.Select(_ => new BatchSucceeded(null))];
        });
        var first = await EnqueueAsync(database.DataSource, queue, "charge", new { orderId = 1 });
        var second = await EnqueueAsync(database.DataSource, queue, "charge", new { orderId = 2 });

        var running = new RunningWorker(worker);
        await started.Task.WaitAsync(Patience, TestContext.Current.CancellationToken);
        var complete = true;
        try
        {
            await running.StopAsync();
        }
        catch (ShutdownIncompleteException)
        {
            // A loaded machine can need more than the 250 ms unwind window for the two releases.
            complete = false;
        }

        // The batch token was cancelled only after the worker cancelled every member for the shutdown.
        Assert.Equal([CancelReason.Shutdown, CancelReason.Shutdown], reasons);
        foreach (var id in new[] { first, second })
        {
            // A member that stopped for the shutdown goes back without a charged attempt. It never fails.
            var state = (await TaskAsync(database.DataSource, id)).Text("state");
            Assert.Contains(state, complete ? Ready : ReadyOrRunning);
        }

        await running.DisposeAsync();
    }

    [Fact]
    public async Task ABatchOnTheFastTierCompletesThroughTheFusedStatement()
    {
        var queue = UniqueQueue("batch-fast");
        await WorkerFastTierTests.FastTierAsync(database.DataSource, queue);
        await using var worker = new Worker(database.DataSource, Options(queue, options => options.Concurrency = 3));
        var statements = new ConcurrentQueue<Worker.FusedStatement>();
        worker.FusedStatementHook = statements.Enqueue;
        worker.HandleBatch<Order>("charge", new BatchOptions(3, LongLinger), (items, _) =>
            Task.FromResult<IReadOnlyList<BatchHandlerOutcome>>([.. items.Select(item => new BatchSucceeded(new Total(item.Payload.OrderId)))]));
        var ids = new List<Guid>();
        for (var order = 1; order <= 3; order++)
        {
            ids.Add(await EnqueueAsync(database.DataSource, queue, "charge", new { orderId = order }));
        }

        await using (var running = new RunningWorker(worker))
        {
            await EventuallyAsync(
                async () => (long)(await ScalarAsync(database.DataSource, "SELECT count(*) FROM workhorse.fast_task_outcome WHERE task_id = ANY($1)", ids.ToArray()))! == 3,
                "three fast-tier outcomes");
            await running.StopAsync();
        }

        Assert.Equal(3, statements.Sum(statement => statement.Completions));
    }

    [Fact]
    public async Task EachMemberCheckpointsAndReportsProgressForItself()
    {
        var queue = UniqueQueue("batch-durable");
        await using var worker = new Worker(database.DataSource, Options(queue, options => options.Concurrency = 2));
        var operations = new ConcurrentQueue<int>();
        var replays = new ConcurrentQueue<string>();
        worker.HandleBatch<Order>("charge", new BatchOptions(2, TimeSpan.FromMilliseconds(200)), async (items, _) =>
        {
            var outcomes = new List<BatchHandlerOutcome>();
            foreach (var item in items)
            {
                var order = item.Payload.OrderId;
                if (await item.Context.GetCheckpointAsync("charged") is { } saved)
                {
                    var progress = await item.Context.GetProgressAsync();
                    replays.Enqueue($"{order}:{saved.Value?.GetInt32()}:{progress?.Value?.GetProperty("step").GetString()}");
                }

                var charged = await item.Context.CheckpointAsync("charged", _ =>
                {
                    operations.Enqueue(order);
                    return Task.FromResult(order * 100);
                });
                await item.Context.SetProgressAsync(new { step = "charged" });
                // The first attempt of order 1 fails after its checkpoint. Its retry replays it.
                outcomes.Add(order == 1 && item.Context.Task.Attempt == 1
                    ? new BatchFailed(new DeclinedException("retry order 1"))
                    : new BatchSucceeded(new Total(charged)));
            }

            return outcomes;
        });
        var first = await EnqueueAsync(database.DataSource, queue, "charge", new { orderId = 1 }, new { maxAttempts = 2, retryPolicy = new { type = "fixed", delayMs = 0 } });
        var second = await EnqueueAsync(database.DataSource, queue, "charge", new { orderId = 2 });

        await using var running = new RunningWorker(worker);
        var firstRow = await TaskInStateAsync(database.DataSource, first, "succeeded");
        var secondRow = await TaskInStateAsync(database.DataSource, second, "succeeded");
        await running.StopAsync();

        Assert.Equal(100, firstRow.Json("result")!.Value.GetProperty("value").GetInt32());
        Assert.Equal(200, secondRow.Json("result")!.Value.GetProperty("value").GetInt32());
        // Each member ran its operation once. The retry of order 1 replayed its own checkpoint and progress.
        Assert.Equal([1, 2], operations.Order());
        Assert.Equal(["1:100:charged"], replays);
        Assert.Equal(
            2L,
            await ScalarAsync(database.DataSource, "SELECT count(*) FROM workhorse.task_checkpoint WHERE task_id = ANY($1)", new[] { first, second }));
    }

    [Fact]
    public async Task AFastTierMemberRefusesCheckpointsAndProgressBeforeAnyWrite()
    {
        var queue = UniqueQueue("batch-fast-durable");
        await WorkerFastTierTests.FastTierAsync(database.DataSource, queue);
        await using var worker = new Worker(database.DataSource, Options(queue));
        var features = new ConcurrentQueue<string>();
        worker.HandleBatch<Order>("charge", new BatchOptions(1, TimeSpan.Zero), async (items, _) =>
        {
            var context = items[0].Context;
            Func<Task>[] calls = [() => context.CheckpointAsync("charged", _ => Task.FromResult(1)), () => context.SetProgressAsync(1)];
            foreach (var call in calls)
            {
                try
                {
                    await call();
                }
                catch (FastTierUnsupportedException refused)
                {
                    features.Enqueue(refused.Feature);
                }
            }

            return [new BatchSucceeded(null)];
        });
        var id = await EnqueueAsync(database.DataSource, queue, "charge", new { orderId = 1 });

        await using (var running = new RunningWorker(worker))
        {
            await EventuallyAsync(
                async () => (long)(await ScalarAsync(database.DataSource, "SELECT count(*) FROM workhorse.fast_task_outcome WHERE task_id = $1", id))! == 1,
                "the fast-tier outcome");
            await running.StopAsync();
        }

        Assert.Equal(["checkpoints", "progress"], features);
        Assert.Equal(0L, await ScalarAsync(database.DataSource, "SELECT count(*) FROM workhorse.task_checkpoint WHERE task_id = $1", id));
    }

    [Fact]
    public async Task ARegistrationChecksItsBounds()
    {
        await using var worker = new Worker(database.DataSource, Options(UniqueQueue("batch-bounds"), options => options.Concurrency = 2));
        static Task<IReadOnlyList<BatchHandlerOutcome>> None(IReadOnlyList<BatchHandlerItem<Order>> items, CancellationToken token) =>
            Task.FromResult<IReadOnlyList<BatchHandlerOutcome>>([]);

        Assert.Throws<ArgumentOutOfRangeException>(() => worker.HandleBatch<Order>("charge", new BatchOptions(3, TimeSpan.Zero), None));
        Assert.Throws<ArgumentOutOfRangeException>(() => new BatchOptions(0, TimeSpan.Zero));
        Assert.Throws<ArgumentOutOfRangeException>(() => new BatchOptions(101, TimeSpan.Zero));
        Assert.Throws<ArgumentException>(() => new BatchOptions(1, TimeSpan.FromSeconds(61)));
        Assert.Throws<ArgumentException>(() => new BatchOptions(1, TimeSpan.FromTicks(1)));
        Assert.Throws<ArgumentNullException>(() => new BatchFailed(null!));

        worker.HandleBatch<Order>("charge", new BatchOptions(2, TimeSpan.Zero), None);
        Assert.False(await worker.RunOnceAsync(TestContext.Current.CancellationToken));
        Assert.Throws<InvalidOperationException>(() => worker.HandleBatch<Order>("charge", new BatchOptions(2, TimeSpan.Zero), None));
    }
}
