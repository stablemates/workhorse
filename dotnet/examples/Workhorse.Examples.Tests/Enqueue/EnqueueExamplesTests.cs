using Workhorse.Examples.Enqueue;
using Workhorse.Examples.Tests.Testing;
using Workhorse.Tests.Testing;

namespace Workhorse.Examples.Tests.Enqueue;

/// <summary>Runs the C# snippets of the site page about enqueue, apart from the transactions.</summary>
public sealed class EnqueueExamplesTests(ScratchDatabase scratch)
{
    private readonly ExampleDatabase _db = ExampleDatabase.Shared(scratch);

    [Fact]
    public async Task AnEnqueueWithARunTimeIsScheduledOnItsQueue()
    {
        var invoiceId = $"csharp-{Guid.NewGuid()}";
        var reminderDate = DateTimeOffset.UtcNow.AddDays(3);
        await Examples().EnqueueNowOrLaterAsync(invoiceId, reminderDate);

        var reminder = await _db.TaskAsync("invoice.remind", "invoiceId", invoiceId);
        Assert.Equal("billing", reminder.Queue);
        Assert.Equal(TaskState.Scheduled, reminder.State);
        Assert.True((reminder.RunAt - reminderDate).Duration() < TimeSpan.FromMilliseconds(1));
        Assert.NotEmpty(await _db.TasksAsync("email.send", "to", "person@example.com"));
    }

    [Fact]
    public async Task TheEnqueueOptionsReachTheTask()
    {
        // A deadline with a random millisecond finds the one task of this test.
        var endOfMonth = DateTimeOffset.UtcNow.AddDays(30).AddMilliseconds(Random.Shared.Next(1_000_000));
        endOfMonth = DateTimeOffset.FromUnixTimeMilliseconds(endOfMonth.ToUnixTimeMilliseconds());
        await Examples().EnqueueWithOptionsAsync(endOfMonth);

        var taskId = await _db.ScalarAsync<Guid>(
            "SELECT id FROM workhorse.task WHERE task_type = 'report.generate' AND deadline_at = $1", endOfMonth);
        var task = await _db.DetailAsync(taskId);
        Assert.Equal("reports", task.Queue);
        Assert.Equal(["tenant:acme"], task.Tags);
        Assert.Equal("acme", task.ConcurrencyKey);
        Assert.Equal(10, task.Priority);
        Assert.Equal(5, task.MaxAttempts);
        Assert.Equal(TimeSpan.FromMinutes(2), task.ExecutionTimeout);
        Assert.Equal("2026-08", task.Payload!.Value.GetProperty("month").GetString());
    }

    [Fact]
    public async Task EnqueueManyReturnsOneResultForEachRecipientInOrder()
    {
        var first = $"csharp-{Guid.NewGuid()}@example.com";
        var second = $"csharp-{Guid.NewGuid()}@example.com";
        var results = await Examples().EnqueueManyAsync([new Recipient(first), new Recipient(second)]);

        Assert.Equal(2, results.Count);
        Assert.Equal(results[0].TaskId, (await _db.TaskAsync("email.digest", "to", first)).Id);
        Assert.Equal(results[1].TaskId, (await _db.TaskAsync("email.digest", "to", second)).Id);
        Assert.Equal("mail", (await _db.DetailAsync(results[0].TaskId)).Queue);
    }

    [Fact]
    public async Task PauseAndResumeLeaveTheQueueRunning()
    {
        var requestId = $"csharp-{Guid.NewGuid()}";
        await Examples().PauseAndResumeAsync("dana", "maintenance", requestId, $"{requestId}-resume");

        Assert.False(await _db.ScalarAsync<bool>("SELECT paused FROM workhorse.queue_control WHERE queue_name = 'billing'"));
    }

    private EnqueueExamples Examples() => new(_db.Queue, _db.Admin);
}
