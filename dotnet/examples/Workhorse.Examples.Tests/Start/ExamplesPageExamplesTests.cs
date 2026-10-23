using System.Text.Json;
using Workhorse.Examples.Start;
using Workhorse.Examples.Tests.Testing;
using Workhorse.Tests.Testing;

namespace Workhorse.Examples.Tests.Start;

/// <summary>Runs the C# snippets of the site page of examples.</summary>
public sealed class ExamplesPageExamplesTests(ScratchDatabase scratch)
{
    private readonly ExampleDatabase _db = ExampleDatabase.Shared(scratch);

    private static readonly string[] Parts = ["a", "b"];

    private static ExamplesPageExamples Examples(ExampleDatabase database) =>
        new(database.DataSource, database.Queue, database.Admin);

    // Another snippet test can make a table `orders` of another shape, so the test has its own database.
    [Fact]
    public async Task TheOrderAndItsTaskCommitTogether()
    {
        await using var database = await ExampleDatabase.CreateIsolatedAsync(scratch);
        await database.ExecuteAsync("CREATE TABLE orders (id text PRIMARY KEY, items text[])");
        var orderId = $"csharp-{Guid.NewGuid()}";
        await Examples(database).CreateOrderAsync(orderId, ["book", "lamp"]);
        Assert.Equal(
            ["book", "lamp"],
            await database.ScalarAsync<string[]>("SELECT items FROM orders WHERE id = $1", orderId));
        Assert.Equal("orders", (await database.TaskAsync("order.fulfill", "orderId", orderId)).Queue);
    }

    [Fact(Timeout = 120_000)]
    public async Task TheTrialSendsEachEmailOnceAroundTheSleep()
    {
        var token = TestContext.Current.CancellationToken;
        const string queueName = "examples-page-csharp-trial";
        var to = $"{Guid.NewGuid()}@example.com";
        var enqueued = await _db.Queue.EnqueueAsync(
            "trial.lifecycle",
            new { to, followUpAt = DateTimeOffset.UtcNow.AddSeconds(1) },
            new EnqueueOptions { Queue = queueName },
            token);
        await using var worker = StartDatabase.Worker(_db, queueName);
        ExamplesPageExamples.RegisterTrialHandler(worker);
        TaskDetail? task = null;
        await StartDatabase.RunAsync(worker, async () => task = await _db.TerminalAsync(enqueued.TaskId));
        Assert.Equal(TaskState.Succeeded, task!.State);
        Assert.Equal(to, task.Result!.Value.GetProperty("deliveredTo").GetString());

        foreach (var (name, kind) in new[] { ("welcome", "welcome"), ("follow-up", "follow-up") })
        {
            var value = (await _db.Admin.GetCheckpointAsync(enqueued.TaskId, name, token))!.Value!.Value;
            Assert.Equal(to, value.GetProperty("deliveredTo").GetString());
            Assert.Equal(kind, value.GetProperty("kind").GetString());
            Assert.Equal($"{name}:{enqueued.TaskId}", value.GetProperty("idempotencyKey").GetString());
        }
    }

    // The worker claims every task of `billing`, so the test has its own database.
    [Fact(Timeout = 120_000)]
    public async Task TheScheduleIsSyncedAndTheWorkerRunsTheTask()
    {
        var token = TestContext.Current.CancellationToken;
        await using var database = await ExampleDatabase.CreateIsolatedAsync(scratch);
        var scope = $"csharp-{Guid.NewGuid()}";
        var enqueued = await database.Queue.EnqueueAsync(
            "invoice.generate",
            new { scope },
            new EnqueueOptions { Queue = "billing" },
            token);

        using var stop = CancellationTokenSource.CreateLinkedTokenSource(token);
        var run = Examples(database).RunBillingWorkerAsync(stop.Token);
        try
        {
            var task = await database.TerminalAsync(enqueued.TaskId);
            Assert.Equal(TaskState.Succeeded, task.State);
            var result = task.Result!.Value;
            Assert.True(result.GetProperty("generated").GetBoolean());
            Assert.Equal(scope, result.GetProperty("payload").GetProperty("scope").GetString());
            Assert.Equal(
                "0 3 * * *|billing|invoice.generate",
                await database.ScalarAsync<string>(
                    "SELECT cron_expression || '|' || queue_name || '|' || task_type FROM workhorse.schedule_definition"
                    + " WHERE namespace = 'billing-production' AND schedule_name = 'nightly-invoice-run'"));
        }
        finally
        {
            await stop.CancelAsync();
            await run;
        }
    }

    [Fact]
    public async Task ARepeatedWebhookReturnsTheFirstTask()
    {
        var eventId = $"evt_{Guid.NewGuid()}";
        var stripeEvent = new ExamplesPageExamples.StripeEvent(eventId, "invoice.paid", null);
        var first = await Examples(_db).HandleStripeWebhookAsync(stripeEvent);
        var second = await Examples(_db).HandleStripeWebhookAsync(stripeEvent);
        Assert.Equal(first, second);
        var task = await _db.TaskAsync("stripe.event", "eventId", eventId);
        Assert.Equal(first, task.Id);
        Assert.Equal("webhooks", task.Queue);
        Assert.Equal("invoice.paid", task.Payload!.Value.GetProperty("eventType").GetString());
    }

    // The test's worker reads `billing`, and the script redrives every dead letter of `billing`, so
    // the test has its own database.
    [Fact(Timeout = 120_000)]
    public async Task TheIncidentScriptRedrivesEachDeadLetterOnce()
    {
        var token = TestContext.Current.CancellationToken;
        await using var database = await ExampleDatabase.CreateIsolatedAsync(scratch);
        var run = $"csharp-{Guid.NewGuid()}";
        var options = new EnqueueOptions { Queue = "billing", MaxAttempts = 1 };
        Guid[] sources =
        [
            (await database.Queue.EnqueueAsync("invoice.charge", new { run = $"{run}-0" }, options, token)).TaskId,
            (await database.Queue.EnqueueAsync("invoice.charge", new { run = $"{run}-1" }, options, token)).TaskId,
        ];
        await using (var worker = StartDatabase.Worker(database, "billing"))
        {
            worker.Handle<JsonElement>("invoice.charge", (_, _) => throw new ProviderTimeout());
            await StartDatabase.RunAsync(worker, async () =>
            {
                foreach (var source in sources)
                {
                    Assert.Equal(TaskState.Failed, (await database.TerminalAsync(source)).State);
                }
            });
        }

        await Examples(database).RedriveIncidentAsync();
        // A second run of the script with the same request ID makes no new task.
        await Examples(database).RedriveIncidentAsync();
        for (var index = 0; index < sources.Length; index++)
        {
            var tasks = await database.TasksAsync("invoice.charge", "run", $"{run}-{index}");
            Assert.Equal(2, tasks.Count);
            Assert.Equal(sources[index], tasks[0]);
            Assert.Equal(TaskState.Failed, (await database.DetailAsync(sources[index])).State);
            Assert.Equal("billing", (await database.DetailAsync(tasks[1])).Queue);
        }
    }

    [Fact(Timeout = 120_000)]
    public async Task TheCancelEndsAWaitingTaskAndTheHandlerRunsTheNext()
    {
        var token = TestContext.Current.CancellationToken;
        const string queueName = "examples-page-csharp-export";
        var options = new EnqueueOptions { Queue = queueName };
        var canceled = await _db.Queue.EnqueueAsync("export.build", new { parts = Parts }, options, token);
        await using var worker = StartDatabase.Worker(_db, queueName);
        await Examples(_db).ConfigureExportAsync(worker, canceled.TaskId);
        Assert.Equal(TaskState.Canceled, (await _db.DetailAsync(canceled.TaskId)).State);

        var exported = await _db.Queue.EnqueueAsync("export.build", new { parts = Parts }, options, token);
        TaskDetail? task = null;
        await StartDatabase.RunAsync(worker, async () => task = await _db.TerminalAsync(exported.TaskId));
        Assert.Equal(TaskState.Succeeded, task!.State);
        Assert.True(task.Result!.Value.GetProperty("exported").GetBoolean());
    }

    // The worker reads `tools`, which another snippet test can also use, so the test has its own database.
    [Fact(Timeout = 120_000)]
    public async Task TheAgentLoopPlansOnceRunsTheToolsAndWaitsForTheApproval()
    {
        var token = TestContext.Current.CancellationToken;
        await using var database = await ExampleDatabase.CreateIsolatedAsync(scratch);
        const string queueName = "examples-page-csharp-agent";
        var model = new CountingModel();
        var enqueued = await database.Queue.EnqueueAsync(
            "agent.run",
            new { prompt = "find the invoice", conversationId = "conversation-csharp" },
            new EnqueueOptions { Queue = queueName },
            token);
        await using var worker = StartDatabase.Worker(database, queueName, "tools");
        worker.Handle<ExamplesPageExamples.Tool, object>(
            "agent.tool",
            (_, tool) => Task.FromResult<object>(new { ran = tool.Id }));
        ExamplesPageExamples.RegisterAgent(worker, model, TimeSpan.FromMilliseconds(10));

        TaskDetail? task = null;
        await StartDatabase.RunAsync(worker, async () =>
        {
            await ExampleDatabase.EventuallyAsync(
                async () => (await database.Queue.SendSignalAsync(
                    enqueued.TaskId,
                    "approval",
                    new { approved = true },
                    $"approval:{enqueued.TaskId}",
                    "reviewer@example.com",
                    token)).Status == SignalStatus.Delivered,
                "the task waits for the approval");
            task = await database.TerminalAsync(enqueued.TaskId);
        });

        Assert.Equal(TaskState.Succeeded, task!.State);
        var result = task.Result!.Value;
        Assert.True(result.GetProperty("approved").GetBoolean());
        Assert.Equal("search", result.GetProperty("tools").GetProperty("search").GetProperty("ran").GetString());
        Assert.Equal("summarize", result.GetProperty("tools").GetProperty("summarize").GetProperty("ran").GetString());
        Assert.Equal(2, result.GetProperty("plan").GetProperty("tools").GetArrayLength());
        Assert.Equal(1, model.Plans);
        var children = (await database.DetailAsync(enqueued.TaskId)).ChildTaskIds;
        Assert.Equal(2, children.Count);
        foreach (var child in children)
        {
            var detail = await database.DetailAsync(child);
            Assert.Equal("tools", detail.Queue);
            Assert.Equal("conversation-csharp", detail.ConcurrencyKey);
        }
    }

    /// <summary>A model that returns one fixed plan and counts its calls.</summary>
    private sealed class CountingModel : ExamplesPageExamples.IModel
    {
        private int _plans;

        public int Plans => _plans;

        public Task<ExamplesPageExamples.Plan> PlanAsync(string prompt, string idempotencyKey, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _plans);
            return Task.FromResult(new ExamplesPageExamples.Plan(
            [
                new ExamplesPageExamples.Tool("search", "invoice INV-7"),
                new ExamplesPageExamples.Tool("summarize", null),
            ]));
        }
    }

    /// <summary>The failure of the provider in the incident.</summary>
    private sealed class ProviderTimeout() : Exception("the provider timed out");
}
