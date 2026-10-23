using Workhorse.Examples.Tests.Testing;
using Workhorse.Examples.Workers;
using Workhorse.Tests.Testing;

namespace Workhorse.Examples.Tests.Workers;

/// <summary>Runs the C# snippets of the site page about workers, and of guide 310.</summary>
public sealed class WorkersExamplesTests(ScratchDatabase scratch)
{
    /// <summary>A mailer that answers with the address of each email.</summary>
    private sealed class EchoMailer : IMailer
    {
        public Task<Delivery> SendAsync(Email email, CancellationToken cancellationToken) =>
            Task.FromResult(new Delivery(email.To));
    }

    private static WorkersExamples Examples(ExampleDatabase db) =>
        new(db.DataSource, new EchoMailer(), workerConcurrency: 4, workerLease: TimeSpan.FromSeconds(20));

    [Fact(Timeout = 120_000)]
    public async Task TheWorkerRunsTheHandlerAndStoresItsResult()
    {
        // The worker reads `email` and `billing`, so the test has its own database.
        await using var db = await ExampleDatabase.CreateIsolatedAsync(scratch);
        var to = $"csharp-{Guid.NewGuid()}@example.com";
        var task = await db.Queue.EnqueueAsync("email.send", new Email(to), new EnqueueOptions { Queue = "email" }, TestContext.Current.CancellationToken);

        using var stop = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
        var run = Examples(db).RegisterAndRunAsync(stop.Token);
        try
        {
            var detail = await db.TerminalAsync(task.TaskId);
            Assert.Equal(TaskState.Succeeded, detail.State);
            Assert.Equal(to, detail.Result!.Value.GetProperty("deliveredTo").GetString());
        }
        finally
        {
            await stop.CancelAsync();
            await run;
        }
    }

    [Fact]
    public async Task TheOptionsReachTheWorker()
    {
        var db = ExampleDatabase.Shared(scratch);
        await using var worker = Examples(db).WithOptions();
        Assert.Equal("email-worker-1", worker.WorkerId);
        Assert.Equal(4, worker.Concurrency);
        Assert.Equal(["email", "billing"], worker.Queues);
    }

    [Fact(Timeout = 120_000)]
    public async Task TheHostRunsTheWorkerAndDrainsItOnStop()
    {
        await using var db = await ExampleDatabase.CreateIsolatedAsync(scratch);
        var to = $"csharp-{Guid.NewGuid()}@example.com";
        var task = await db.Queue.EnqueueAsync("email.send", new Email(to), new EnqueueOptions { Queue = "billing" }, TestContext.Current.CancellationToken);

        using var stop = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
        var run = Examples(db).RunHostAsync([], stop.Token);
        try
        {
            var detail = await db.TerminalAsync(task.TaskId);
            Assert.Equal(TaskState.Succeeded, detail.State);
            Assert.Equal(to, detail.Result!.Value.GetProperty("deliveredTo").GetString());
        }
        finally
        {
            await stop.CancelAsync();
            await run;
        }

        // The stop drained the worker, so it removed its registry row.
        Assert.Empty(await db.Admin.ListWorkersAsync(TestContext.Current.CancellationToken));
    }

    [Fact(Timeout = 120_000)]
    public async Task TheScopedHandlerRunsInTheHost()
    {
        await using var db = await ExampleDatabase.CreateIsolatedAsync(scratch);
        var to = $"csharp-{Guid.NewGuid()}@example.com";
        var task = await db.Queue.EnqueueAsync("email.send", new Email(to), new EnqueueOptions { Queue = "email" }, TestContext.Current.CancellationToken);

        using var stop = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
        var run = Examples(db).RunScopedHandlerAsync([], stop.Token);
        try
        {
            var detail = await db.TerminalAsync(task.TaskId);
            Assert.Equal(TaskState.Succeeded, detail.State);
            Assert.Equal(to, detail.Result!.Value.GetProperty("deliveredTo").GetString());
        }
        finally
        {
            await stop.CancelAsync();
            await run;
        }
    }
}
