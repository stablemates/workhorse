using System.Collections.Concurrent;
using Workhorse.Examples.Durable;
using Workhorse.Examples.Tests.Testing;
using Workhorse.Tests.Testing;

namespace Workhorse.Examples.Tests.Durable;

/// <summary>Runs the C# snippets of the site page about child tasks under a real worker.</summary>
/// <remarks>The worker reads <c>orders</c> and <c>payments</c>, so each test has its own database.</remarks>
public sealed class ChildTasksExamplesTests(ScratchDatabase scratch)
{
    [Fact(Timeout = 240_000)]
    public async Task RunChildGivesTheParentTheReceiptOfTheChild()
    {
        await using var db = await ExampleDatabase.CreateIsolatedAsync(scratch);
        var parentId = await EnqueueAsync(db, "orders.charge-csharp", new { id = "ord-7" });
        await using var worker = Worker(db);
        worker.Handle<ChildTasksOrder, Receipt>("orders.charge-csharp", (context, order) => ChildTasksExamples.ChargeAsync(context, order));
        worker.Handle<ChargeRequest, Receipt>(
            "payments.charge", (context, payment) => Task.FromResult(new Receipt($"rcpt-{payment.OrderId}")));
        var parent = await RunUntilTerminalAsync(db, worker, parentId, TestContext.Current.CancellationToken);
        Assert.Equal(TaskState.Succeeded, parent.State);
        JsonAssert.Equal("""{"receiptId":"rcpt-ord-7"}""", parent.Result);
        var child = Assert.Single(parent.ChildTaskIds);
        Assert.Equal("payments", (await db.DetailAsync(child)).Queue);
    }

    [Fact(Timeout = 240_000)]
    public async Task RunChildrenGivesTheParentTheFailedFraudCheck()
    {
        await using var db = await ExampleDatabase.CreateIsolatedAsync(scratch);
        var parentId = await EnqueueAsync(db, "orders.checkout-csharp", new { orderId = "ord-9" });
        await using var worker = Worker(db);
        worker.Handle<ChargeRequest, object>("orders.checkout-csharp", (context, order) => ChildTasksExamples.CheckoutAsync(context, order.OrderId));
        worker.Handle<ChargeRequest>(
            "orders.check-fraud", (context, payload) => throw new InvalidOperationException("the card is on a block list"));
        worker.Handle<ChargeRequest, object>("orders.reserve", (context, payload) => Task.FromResult<object>(new { reserved = true }));
        var parent = await RunUntilTerminalAsync(db, worker, parentId, TestContext.Current.CancellationToken);
        Assert.Equal(TaskState.Succeeded, parent.State);
        Assert.False(parent.Result!.Value.GetProperty("accepted").GetBoolean());
        Assert.Equal("InvalidOperationException", parent.Result.Value.GetProperty("reason").GetProperty("name").GetString());
        Assert.Equal(2, parent.ChildTaskIds.Count);
        foreach (var childId in parent.ChildTaskIds)
        {
            Assert.Equal("orders", (await db.DetailAsync(childId)).Queue);
        }
    }

    private static async Task<Guid> EnqueueAsync(ExampleDatabase db, string taskType, object payload) =>
        (await db.Queue.EnqueueAsync(taskType, payload, new EnqueueOptions { Queue = "orders" }, TestContext.Current.CancellationToken)).TaskId;

    /// <summary>A worker that retries a failed child at once, so the fraud child fails fast.</summary>
    private static Worker Worker(ExampleDatabase db) =>
        new(db.DataSource, new WorkerOptions
        {
            Queues = ["orders", "payments"],
            PollInterval = TimeSpan.FromMilliseconds(50),
            RetryDelay = (attempt, task) => TimeSpan.Zero,
        });

    private static async Task<TaskDetail> RunUntilTerminalAsync(ExampleDatabase db, Worker worker, Guid taskId, CancellationToken cancellationToken)
    {
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var run = worker.RunAsync(stop.Token);
        try
        {
            return await db.TerminalAsync(taskId);
        }
        finally
        {
            await stop.CancelAsync();
            await run;
        }
    }
}

/// <summary>The payload of a child of the child-task snippets.</summary>
public sealed record ChargeRequest(string OrderId);

/// <summary>Runs the C# snippets of the site page about task groups under real workers.</summary>
/// <remarks>The workers read <c>imports</c> and <c>import-rows</c>, so each test has its own database.</remarks>
public sealed class TaskGroupsExamplesTests(ScratchDatabase scratch) : IImportReporter
{
    private readonly ConcurrentQueue<(string ImportId, long Succeeded, long Failed)> _reports = new();

    [Fact(Timeout = 240_000)]
    public async Task TheGroupHoldsEveryRowAndEnqueuesTheReportWhenItFinishes()
    {
        await using var db = await ExampleDatabase.CreateIsolatedAsync(scratch);
        // 1,001 rows take two adds in PostgreSQL.
        var rows = Enumerable.Range(0, 1_001).Select(index => $"row-{index}").ToList();
        var group = await new TaskGroupsExamples(db.DataSource, db.Queue, this).ImportRowsAsync(new ImportFile(rows));
        Assert.Equal(TaskGroupState.Sealed, group.State);
        Assert.Equal(1_001, group.Counts.Total);
        Assert.Equal(TaskGroupCallbackKind.OnFinish, group.Callbacks[0].Kind);

        await using var worker = new Worker(
            db.DataSource, new WorkerOptions { Queues = ["imports"], Concurrency = 32, PollInterval = TimeSpan.FromMilliseconds(50) });
        worker.Handle<object>("imports.row", (context, row) => Task.CompletedTask);
        worker.Handle<ImportReport, object>("imports.report", (context, report) => Task.FromResult<object>(new { sent = true }));
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
        var run = worker.RunAsync(stop.Token);
        try
        {
            var finished = await FinishedAsync(db, group.Id);
            Assert.Equal(TaskGroupResult.Succeeded, finished.Result);
            Assert.Equal(1_001, finished.Counts.Succeeded);
            var report = await db.TerminalAsync(finished.Callbacks[0].TaskId!.Value);
            Assert.Equal("imports.report", report.Type);
            Assert.Equal("imports", report.Queue);
            Assert.Equal(TaskState.Succeeded, report.State);
        }
        finally
        {
            await stop.CancelAsync();
            await run;
        }
    }

    [Fact(Timeout = 240_000)]
    public async Task TheReportHandlerReadsTheCountsOfItsGroup()
    {
        await using var db = await ExampleDatabase.CreateIsolatedAsync(scratch);
        var rows = new EnqueueOptions { Queue = "import-rows", MaxAttempts = 1 };
        var created = await db.Queue.TaskGroupAsync(
            new TaskGroupCallbacks
            {
                OnFinish = new EnqueueRequest
                {
                    TaskType = "imports.report",
                    Payload = new { importId = "imp-7" },
                    Options = new EnqueueOptions { Queue = "imports" },
                },
            },
            builder => builder.Add("imports.row", new { row = "good" }, rows).Add("imports.row", new { row = "bad" }, rows),
            TestContext.Current.CancellationToken);

        await using var rowWorker = new Worker(
            db.DataSource, new WorkerOptions { Queues = ["import-rows"], PollInterval = TimeSpan.FromMilliseconds(50) });
        rowWorker.Handle<RowPayload>(
            "imports.row",
            (context, row) => row.Row == "bad" ? throw new ArgumentException("the row has no email") : Task.CompletedTask);
        await using var reportWorker = new TaskGroupsExamples(db.DataSource, db.Queue, this).ReportWorker();
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
        var runs = new[] { rowWorker.RunAsync(stop.Token), reportWorker.RunAsync(stop.Token) };
        try
        {
            var finished = await FinishedAsync(db, created.Group.Id);
            var done = await db.TerminalAsync(finished.Callbacks[0].TaskId!.Value);
            Assert.Equal(TaskState.Succeeded, done.State);
            JsonAssert.Equal("""{"sent":true}""", done.Result);
            Assert.Equal([("imp-7", 1L, 1L)], _reports);
        }
        finally
        {
            await stop.CancelAsync();
            await Task.WhenAll(runs);
        }
    }

    Task IImportReporter.SendAsync(string importId, long succeeded, long failed)
    {
        _reports.Enqueue((importId, succeeded, failed));
        return Task.CompletedTask;
    }

    private static async Task<TaskGroup> FinishedAsync(ExampleDatabase db, Guid groupId)
    {
        TaskGroup? group = null;
        await ExampleDatabase.EventuallyAsync(
            async () => (group = await db.Queue.GetTaskGroupAsync(groupId, TestContext.Current.CancellationToken))!.State == TaskGroupState.Finished,
            $"group {groupId} finishes");
        return group!;
    }
}

/// <summary>The payload of a row task of the task-group test.</summary>
public sealed record RowPayload(string Row);
