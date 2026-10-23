using System.Diagnostics;
using System.Text.Json;
using Workhorse.Examples.Tests.Testing;

namespace Workhorse.Examples.Tests.Durable;

/// <summary>
/// Drives the durable handlers of the snippet tests on one private queue of the shared database.
/// Each pass runs the maintenance tick and then one <see cref="Worker.RunOnceAsync"/>, so a test does
/// not wait for a background worker.
/// </summary>
public sealed class DurableFlowDriver(ExampleDatabase db)
{
    /// <summary>The private queue of this driver.</summary>
    public string QueueName { get; } = $"durable-{Guid.NewGuid()}";

    /// <summary>A worker for the private queue, with no background loop and a short retry delay.</summary>
    public Worker CreateWorker(JsonSerializerOptions? json = null) =>
        new(db.DataSource, new WorkerOptions
        {
            Json = json,
            Queues = [QueueName],
            PollingOnly = true,
            PollInterval = TimeSpan.FromMilliseconds(10),
            DisableRegistry = true,
            RetryDelay = (attempt, task) => TimeSpan.FromMilliseconds(10),
        });

    /// <summary>Enqueues one task on the private queue, with at most two attempts.</summary>
    public async Task<Guid> EnqueueAsync(string taskType, object? payload, CancellationToken cancellationToken) =>
        (await db.Queue.EnqueueAsync(taskType, payload, new EnqueueOptions { Queue = QueueName, MaxAttempts = 2 }, cancellationToken)).TaskId;

    /// <summary>Runs passes until the signal <paramref name="name"/> reaches the task.</summary>
    public async Task DeliverSignalAsync(Worker worker, Guid taskId, string name, object? payload)
    {
        var clock = Stopwatch.StartNew();
        for (var pass = 0; ; pass++)
        {
            await PassAsync(worker);
            var result = await db.Queue.SendSignalAsync(taskId, name, payload, $"{name}-{pass}", "snippet-test");
            if (result.Status == SignalStatus.Delivered)
            {
                return;
            }

            Assert.True(clock.Elapsed < ExampleDatabase.Patience, $"the task does not wait for {name}");
            await Task.Delay(20);
        }
    }

    /// <summary>Runs passes until the decision for the human wait <paramref name="name"/> reaches the task.</summary>
    public async Task CompleteHumanWaitAsync(Worker worker, Guid taskId, string name, object? decision)
    {
        var clock = Stopwatch.StartNew();
        for (var pass = 0; ; pass++)
        {
            await PassAsync(worker);
            var result = await db.Queue.CompleteHumanWaitAsync(taskId, name, decision, $"{name}-{pass}", "snippet-operator");
            if (result.Status == HumanWaitStatus.Completed)
            {
                return;
            }

            Assert.True(clock.Elapsed < ExampleDatabase.Patience, $"the task does not wait for {name}");
            await Task.Delay(20);
        }
    }

    /// <summary>Runs passes until the task ends, and returns its detail.</summary>
    public async Task<TaskDetail> FinishAsync(Worker worker, Guid taskId)
    {
        var clock = Stopwatch.StartNew();
        while (true)
        {
            var detail = await db.DetailAsync(taskId);
            if (detail.State is TaskState.Succeeded or TaskState.Failed or TaskState.Canceled)
            {
                return detail;
            }

            Assert.True(clock.Elapsed < ExampleDatabase.Patience, $"task {taskId} is still {detail.State}");
            if (!await PassAsync(worker))
            {
                await Task.Delay(20);
            }
        }
    }

    private async Task<bool> PassAsync(Worker worker)
    {
        await db.ExecuteAsync("SELECT count(*) FROM workhorse.tick_v1(100, 100)");
        return await worker.RunOnceAsync();
    }
}
