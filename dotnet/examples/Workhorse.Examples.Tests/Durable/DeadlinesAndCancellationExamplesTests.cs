using System.Collections.Concurrent;
using Workhorse.Examples.Durable;
using Workhorse.Examples.Tests.Testing;
using Workhorse.Tests.Testing;

namespace Workhorse.Examples.Tests.Durable;

/// <summary>Runs the C# snippets of the site page about deadlines and execution timeouts.</summary>
public sealed class DeadlinesExamplesTests(ScratchDatabase scratch)
{
    private readonly ExampleDatabase _db = ExampleDatabase.Shared(scratch);

    [Fact]
    public async Task TheDeadlineReachesTheTask()
    {
        var quoteId = $"csharp-{Guid.NewGuid()}";
        var quoteExpiresAt = DateTimeOffset.UtcNow.AddHours(1);
        await new DeadlinesExamples(_db.Queue).DeadlineAsync(quoteId, quoteExpiresAt);
        var expected = quoteExpiresAt.AddTicks(-(quoteExpiresAt.Ticks % TimeSpan.TicksPerMillisecond));
        Assert.Equal(expected, (await _db.TaskAsync("price.quote", "quoteId", quoteId)).DeadlineAt);
    }

    [Fact]
    public async Task TheExecutionTimeoutAndTheBudgetReachTheTask()
    {
        var reportId = $"csharp-{Guid.NewGuid()}";
        await new DeadlinesExamples(_db.Queue).ExecutionTimeoutAsync(reportId, TimeSpan.FromMinutes(2), 3);
        var task = await _db.TaskAsync("report.build", "reportId", reportId);
        Assert.Equal(TimeSpan.FromMinutes(2), task.ExecutionTimeout);
        Assert.Equal(3, task.MaxAttempts);
    }
}

/// <summary>Runs the C# snippets of the site page about cancellation.</summary>
public sealed class CancellationExamplesTests(ScratchDatabase scratch) : IPartUploader
{
    private readonly ExampleDatabase _db = ExampleDatabase.Shared(scratch);
    private readonly ConcurrentQueue<string> _uploaded = new();
    private readonly TaskCompletionSource _started = new(TaskCreationOptions.RunContinuationsAsynchronously);

    private static readonly string[] OnePart = ["part-1"];
    private static readonly string[] ThreeParts = ["part-1", "part-2", "part-3"];

    [Fact]
    public async Task AScheduledTaskIsCanceledAtOnce()
    {
        var enqueued = await _db.Queue.EnqueueAsync(
            "order.upload",
            new { parts = OnePart },
            new EnqueueOptions { Queue = $"uploads-{Guid.NewGuid()}", RunAt = DateTimeOffset.UtcNow.AddMinutes(10) },
            TestContext.Current.CancellationToken);
        var result = await Examples().CancelBeforeStartAsync(enqueued.TaskId, new CancellationActor("dana@example.com"));
        Assert.Equal(CancelStatus.Canceled, result.Status);
        Assert.Equal("dana@example.com", result.RequestedBy);
        Assert.Equal("customer withdrew the order", result.Reason);
        Assert.Equal(TaskState.Canceled, (await _db.DetailAsync(enqueued.TaskId)).State);
    }

    [Fact(Timeout = 120_000)]
    public async Task TheHandlerStopsBeforeTheNextPart()
    {
        var queueName = $"uploads-{Guid.NewGuid()}";
        var enqueued = await _db.Queue.EnqueueAsync(
            "order.upload",
            new { parts = ThreeParts },
            new EnqueueOptions { Queue = queueName },
            TestContext.Current.CancellationToken);
        await using var worker = Examples().UploadWorker(queueName);
        using var stop = new CancellationTokenSource();
        var run = worker.RunAsync(stop.Token);
        try
        {
            await _started.Task.WaitAsync(ExampleDatabase.Patience, TestContext.Current.CancellationToken);
            var request = await _db.Queue.CancelAsync(
                enqueued.TaskId, new CancelOptions { RequestedBy = "dana@example.com", Reason = "customer withdrew the order" }, TestContext.Current.CancellationToken);
            Assert.Equal(CancelStatus.CancelRequested, request.Status);
            Assert.Equal(TaskState.Canceled, (await _db.TerminalAsync(enqueued.TaskId)).State);
        }
        finally
        {
            await stop.CancelAsync();
            await run;
        }

        Assert.Equal(["part-1"], _uploaded);
    }

    async Task IPartUploader.UploadAsync(string part, CancellationToken cancellationToken)
    {
        _uploaded.Enqueue(part);
        _started.TrySetResult();

        // The first part is slow: it ends only when the cancellation reaches the handler.
        await Task.Delay(ExampleDatabase.Patience, cancellationToken);
    }

    private CancellationExamples Examples() => new(_db.Queue, _db.DataSource, this);
}
