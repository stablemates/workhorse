using Microsoft.EntityFrameworkCore;
using Workhorse.Examples.Enqueue;
using Workhorse.Examples.Readme;
using Workhorse.Examples.Tests.Testing;
using Workhorse.Tests.Testing;

namespace Workhorse.Examples.Tests.Readme;

/// <summary>Runs the C# fences of dotnet/README.md.</summary>
public sealed class ReadmeExamplesTests(ScratchDatabase scratch)
{
    [Fact(Timeout = 120_000)]
    public async Task TheWorkerRunsTheOneTask()
    {
        await using var db = await ExampleDatabase.CreateIsolatedAsync(scratch);
        await db.Queue.AssertCompatibleAsync(TestContext.Current.CancellationToken);
        var taskId = await ReadmeExamples.RunOneTaskAsync(db.DataSource);

        var task = await db.TerminalAsync(taskId);
        Assert.Equal(TaskState.Succeeded, task.State);
        Assert.Equal("readme", task.Queue);
        Assert.True(task.Result!.Value.GetProperty("echo").GetProperty("packaged").GetBoolean());
    }

    [Fact(Timeout = 120_000)]
    public async Task TheExecutionStrategyCommitsTheAccountAndTheTask()
    {
        await using var db = await ExampleDatabase.CreateIsolatedAsync(scratch);
        await db.ExecuteAsync("CREATE TABLE account (id text PRIMARY KEY, email text NOT NULL)");
        var id = $"readme-{Guid.NewGuid()}";
        await using (var context = new AccountsDbContext(new DbContextOptionsBuilder<AccountsDbContext>()
            .UseNpgsql(db.DataSource, npgsql => npgsql.EnableRetryOnFailure())
            .Options))
        {
            await ReadmeExamples.CreateAccountWithRetriesAsync(
                db.Queue, context, id, $"{id}@example.com", TestContext.Current.CancellationToken);
        }

        Assert.Equal(1L, await db.ScalarAsync<long>("SELECT count(*) FROM account WHERE id = $1", id));
        Assert.Single(await db.TasksAsync("account.created", "accountId", id));
    }

    [Fact(Timeout = 120_000)]
    public async Task TheHostedWorkerRunsATaskAndDrains()
    {
        await using var db = await ExampleDatabase.CreateIsolatedAsync(scratch);
        var enqueued = await db.Queue.EnqueueAsync("readme.echo", new { packaged = true }, TestContext.Current.CancellationToken);
        using var stop = new CancellationTokenSource();
        var host = ReadmeExamples.RunWorkerHostAsync(["--Workhorse:Worker:DisableRegistry=true"], db.DataSource, stop.Token);
        try
        {
            var task = await db.TerminalAsync(enqueued.TaskId);
            Assert.Equal(TaskState.Succeeded, task.State);
            Assert.True(task.Result!.Value.GetProperty("echo").GetProperty("packaged").GetBoolean());
        }
        finally
        {
            await stop.CancelAsync();
            await host;
        }
    }
}
