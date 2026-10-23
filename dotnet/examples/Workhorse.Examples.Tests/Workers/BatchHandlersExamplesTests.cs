using System.Collections.Concurrent;
using Workhorse.Examples.Tests.Testing;
using Workhorse.Examples.Workers;
using Workhorse.Tests.Testing;

namespace Workhorse.Examples.Tests.Workers;

/// <summary>Runs the C# snippets of the site page about batch handlers under a real worker.</summary>
public sealed class BatchHandlersExamplesTests(ScratchDatabase scratch)
{
    /// <summary>Records the size of each request. It refuses each address that starts with <c>bounce</c>.</summary>
    private sealed class RecordingProvider : IBatchEmailProvider
    {
        public ConcurrentQueue<int> Requests { get; } = new();

        public Task<IReadOnlyList<BatchDelivery>> SendManyAsync(IReadOnlyList<Email> emails, CancellationToken cancellationToken)
        {
            Requests.Enqueue(emails.Count);
            IReadOnlyList<BatchDelivery> deliveries = [.. emails.Select(email => email.To.StartsWith("bounce", StringComparison.Ordinal)
                ? new BatchDelivery(email.To, new InvalidOperationException("the mailbox is full"))
                : new BatchDelivery($"msg-{email.To}", null))];
            return Task.FromResult(deliveries);
        }
    }

    [Fact(Timeout = 240_000)]
    public async Task TheBatchHandlerSendsTwentySevenTasksInBatchesOfAtMostTwenty()
    {
        // The worker reads `email`, so the test has its own database, and the batch sizes count
        // only the tasks of this test.
        await using var db = await ExampleDatabase.CreateIsolatedAsync(scratch);
        var provider = new RecordingProvider();
        var run = Guid.NewGuid();
        var tasks = new List<Guid>();
        var options = new EnqueueOptions { Queue = "email", MaxAttempts = 1 };
        for (var index = 0; index < 27; index++)
        {
            var to = $"{(index == 0 ? "bounce-" : "user-")}{index}-{run}@example.com";
            tasks.Add((await db.Queue.EnqueueAsync("email.send", new Email(to), options, TestContext.Current.CancellationToken)).TaskId);
        }

        await using var worker = new BatchHandlersExamples(db.DataSource, db.Queue, provider).BatchWorker();
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
        var running = worker.RunAsync(stop.Token);
        try
        {
            for (var index = 0; index < tasks.Count; index++)
            {
                var detail = await db.TerminalAsync(tasks[index]);
                if (index == 0)
                {
                    Assert.Equal(TaskState.Failed, detail.State);
                }
                else
                {
                    Assert.Equal(TaskState.Succeeded, detail.State);
                    Assert.Equal($"msg-user-{index}-{run}@example.com", detail.Result!.Value.GetProperty("providerId").GetString());
                }
            }
        }
        finally
        {
            await stop.CancelAsync();
            await running;
        }

        // A slow claim can split the tasks into more batches, so the test checks the bounds.
        var requests = provider.Requests.ToArray();
        Assert.Equal(27, requests.Sum());
        Assert.True(requests.Length >= 2, $"requests: {string.Join(", ", requests)}");
        Assert.All(requests, size => Assert.True(size <= 20, $"requests: {string.Join(", ", requests)}"));
    }

    [Fact]
    public async Task TheProducerEnqueuesAnOrdinaryTask()
    {
        // The enqueue snippet of the enqueue page writes the same task, so this test has its own database.
        await using var db = await ExampleDatabase.CreateIsolatedAsync(scratch);
        await new BatchHandlersExamples(db.DataSource, db.Queue, new RecordingProvider()).EnqueueEmailAsync();
        var tasks = await db.TasksAsync("email.send", "to", "person@example.com");
        Assert.Single(tasks);
        Assert.Equal(TaskState.Ready, (await db.DetailAsync(tasks[0])).State);
    }
}
