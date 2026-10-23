using Workhorse.Examples.Tests.Testing;
using Workhorse.Examples.Workers;
using Workhorse.Tests.Testing;

namespace Workhorse.Examples.Tests.Workers;

/// <summary>Runs the C# snippets of the site page about dead letters and redrive.</summary>
public sealed class DeadLettersExamplesTests(ScratchDatabase scratch)
{
    [Fact(Timeout = 120_000)]
    public async Task TheListHoldsTheFailedCharge()
    {
        // The worker reads `payments`, and each redrive leaves a ready copy there, so each test has
        // its own database.
        await using var db = await ExampleDatabase.CreateIsolatedAsync(scratch);
        var taskId = await FailedChargeAsync(db, TestContext.Current.CancellationToken);
        var page = await new DeadLettersExamples(db.Admin).ListFailuresAsync();
        var letter = Assert.Single(page.Items, item => item.TaskId == taskId);
        Assert.Equal("payments", letter.Queue);
        Assert.Equal("ProviderTimeout", letter.Error!.Value.GetProperty("name").GetString());
    }

    [Fact(Timeout = 120_000)]
    public async Task TheRedriveCreatesANewReadyTaskAndReplaysTheSameRequest()
    {
        await using var db = await ExampleDatabase.CreateIsolatedAsync(scratch);
        var sourceTaskId = await FailedChargeAsync(db, TestContext.Current.CancellationToken);
        var examples = new DeadLettersExamples(db.Admin);
        var result = await examples.RedriveOneAsync(sourceTaskId);
        Assert.Equal(RedriveStatus.Redriven, result.Status);
        Assert.Equal(TaskState.Failed, result.SourceState);
        Assert.Equal(TaskState.Ready, result.TargetState);
        var copy = await db.DetailAsync(result.TargetTaskId!.Value);
        Assert.Equal("payments", copy.Queue);
        Assert.Equal("payment.charge", copy.Type);

        var replay = await examples.RedriveOneAsync(sourceTaskId);
        Assert.Equal(RedriveStatus.Replayed, replay.Status);
        Assert.Equal(result.TargetTaskId, replay.TargetTaskId);
    }

    [Fact(Timeout = 120_000)]
    public async Task TheBacklogRedrivesEveryPageAfterTheDryRun()
    {
        await using var db = await ExampleDatabase.CreateIsolatedAsync(scratch);
        Guid[] sources = [await FailedChargeAsync(db, TestContext.Current.CancellationToken), await FailedChargeAsync(db, TestContext.Current.CancellationToken)];
        var preview = await new DeadLettersExamples(db.Admin).RedriveBacklogAsync();
        foreach (var source in sources)
        {
            Assert.Contains(preview.Results, item => item.SourceTaskId == source && item.Status == RedriveStatus.Eligible);

            // The loop redrove the source with this request, so the same request only replays it.
            var replay = await db.Admin.RedriveAsync(
                source,
                new AdminAudit { Actor = "ops@example.com", Reason = "Provider outage ended", RequestId = "outage-0314" },
                TestContext.Current.CancellationToken);
            Assert.Equal(RedriveStatus.Replayed, replay.Status);
            Assert.NotNull(replay.TargetTaskId);
        }
    }

    /// <summary>Runs one <c>payment.charge</c> task on <c>payments</c> that fails with <c>ProviderTimeout</c>.</summary>
    private static async Task<Guid> FailedChargeAsync(ExampleDatabase db, CancellationToken cancellationToken)
    {
        var task = await db.Queue.EnqueueAsync(
            "payment.charge",
            new { chargeId = $"csharp-{Guid.NewGuid()}" },
            new EnqueueOptions { Queue = "payments", MaxAttempts = 1 },
            cancellationToken);
        await using (var worker = new Worker(db.DataSource, new WorkerOptions { Queues = ["payments"] }))
        {
            worker.Handle("payment.charge", (HandlerContext _, object _) => Task.FromException(new ProviderTimeout()));
            Assert.True(await worker.RunOnceAsync(cancellationToken));
        }

        Assert.Equal(TaskState.Failed, (await db.TerminalAsync(task.TaskId)).State);
        return task.TaskId;
    }

    /// <summary>The error of the payment provider in the outage. The failure envelope names it <c>ProviderTimeout</c>.</summary>
#pragma warning disable CA1710 // The error name of the page has no Exception suffix.
    private sealed class ProviderTimeout() : Exception("the payment provider did not answer");
#pragma warning restore CA1710
}
