using System.Collections.Concurrent;
using Workhorse.Examples.Durable;
using Workhorse.Examples.Tests.Testing;
using Workhorse.Tests.Testing;

namespace Workhorse.Examples.Tests.Durable;

/// <summary>Runs the C# handlers of the site page about the durable agentic flow.</summary>
public sealed class AgenticFlowExamplesTests(ScratchDatabase scratch)
{
    private readonly ExampleDatabase _db = ExampleDatabase.Shared(scratch);

    [Fact(Timeout = 120_000)]
    public async Task TheLoopPlansOneTimeRunsItsToolsAndWaitsForApproval()
    {
        var modelCalls = 0;
        var driver = new DurableFlowDriver(_db);
        var examples = new AgenticFlowExamples(
            (prompt, cancellationToken) =>
            {
                Interlocked.Increment(ref modelCalls);
                return Task.FromResult($"plan for {prompt}");
            },
            driver.QueueName,
            TimeSpan.FromMilliseconds(200));
        await using var worker = driver.CreateWorker();
        examples.Register(worker);
        var taskId = await driver.EnqueueAsync("agent.loop", new { conversationId = "conv-12", prompt = "Plan the trip" }, TestContext.Current.CancellationToken);
        await driver.DeliverSignalAsync(worker, taskId, "approval", new { approved = true });
        var task = await driver.FinishAsync(worker, taskId);
        Assert.Equal(TaskState.Succeeded, task.State);
        JsonAssert.Equal(
            """
            {
              "plan": "plan for Plan the trip",
              "tools": { "research": { "sources": 3 }, "calculate": { "total": 42 } },
              "approval": { "approved": true }
            }
            """,
            task.Result);
        Assert.Equal(1, modelCalls);
        JsonAssert.Equal("""{"stage":"planned"}""", (await _db.Admin.GetProgressAsync(taskId, TestContext.Current.CancellationToken))!.Value);
    }
}

/// <summary>Runs the C# snippet of the site page about progress under a worker.</summary>
public sealed class ProgressExamplesTests(ScratchDatabase scratch) : IProgressImporter
{
    private readonly ExampleDatabase _db = ExampleDatabase.Shared(scratch);
    private readonly ConcurrentQueue<string> _sources = new();
    private readonly ConcurrentQueue<IReadOnlyList<string>> _imported = new();

    [Fact(Timeout = 120_000)]
    public async Task TheHandlerReportsTheLastBatch()
    {
        var queueName = $"progress-{Guid.NewGuid()}";
        var enqueued = await _db.Queue.EnqueueAsync(
            "import.rows", new { source = "rows.csv" }, new EnqueueOptions { Queue = queueName }, TestContext.Current.CancellationToken);
        var examples = new ProgressExamples(this);
        await using (var worker = new Worker(_db.DataSource, new WorkerOptions { Queues = [queueName], DisableRegistry = true }))
        {
            worker.Handle<ImportRowsPayload, object>("import.rows", examples.ImportRowsAsync);
            Assert.True(await worker.RunOnceAsync(TestContext.Current.CancellationToken));
        }

        var task = await _db.TerminalAsync(enqueued.TaskId);
        Assert.Equal(TaskState.Succeeded, task.State);
        JsonAssert.Equal("""{"processed":6}""", task.Result);
        Assert.Equal(["rows.csv"], _sources);
        Assert.Equal(3, _imported.Count);
        JsonAssert.Equal("""{"phase":"importing","processed":6}""", task.Progress!.Value);
    }

    Task<IReadOnlyList<IReadOnlyList<string>>> IProgressImporter.ReadBatchesAsync(string source)
    {
        _sources.Enqueue(source);
        return Task.FromResult<IReadOnlyList<IReadOnlyList<string>>>([["a", "b"], ["c", "d"], ["e", "f"]]);
    }

    async Task IProgressImporter.ImportBatchAsync(IReadOnlyList<string> batch)
    {
        // Each import takes longer than the progress rate limit.
        await Task.Delay(150);
        _imported.Enqueue(batch);
    }
}
