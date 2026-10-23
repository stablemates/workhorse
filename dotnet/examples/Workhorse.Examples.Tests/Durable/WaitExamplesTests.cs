using System.Collections.Concurrent;
using Workhorse.Examples.Durable;
using Workhorse.Examples.Tests.Testing;
using Workhorse.Tests.Testing;

namespace Workhorse.Examples.Tests.Durable;

/// <summary>Runs the C# handler of the site page about signals.</summary>
public sealed class SignalsExamplesTests(ScratchDatabase scratch)
{
    private readonly ExampleDatabase _db = ExampleDatabase.Shared(scratch);

    [Fact(Timeout = 120_000)]
    public async Task AnApprovalSignalPublishesTheOrderOneTime()
    {
        var published = 0;
        var driver = new DurableFlowDriver(_db);
        await using var worker = driver.CreateWorker();
        new SignalsExamples(() =>
        {
            Interlocked.Increment(ref published);
            return Task.CompletedTask;
        }).Register(worker);
        var taskId = await driver.EnqueueAsync("order.publish", new { orderId = "ord-381" }, TestContext.Current.CancellationToken);
        await driver.DeliverSignalAsync(worker, taskId, "approval", new { approved = true });
        var task = await driver.FinishAsync(worker, taskId);
        Assert.Equal(TaskState.Succeeded, task.State);
        Assert.Equal(1, task.CurrentAttempt);
        JsonAssert.Equal("""{"approved":true}""", task.Result);
        Assert.Equal(1, published);
    }
}

/// <summary>Runs the C# handler of the site page about human waits.</summary>
public sealed class HumanWaitsExamplesTests(ScratchDatabase scratch)
{
    private readonly ExampleDatabase _db = ExampleDatabase.Shared(scratch);
    private readonly ConcurrentQueue<string> _activated = new();

    [Fact(Timeout = 120_000)]
    public async Task AnApprovalActivatesTheAccountInTheSameAttempt()
    {
        var driver = new DurableFlowDriver(_db);
        await using var worker = driver.CreateWorker();
        Examples().Register(worker);
        var taskId = await driver.EnqueueAsync("account.activate", new { accountId = "acct-19" }, TestContext.Current.CancellationToken);
        await driver.CompleteHumanWaitAsync(worker, taskId, "account-review", new { approved = true });
        var task = await driver.FinishAsync(worker, taskId);
        Assert.Equal(TaskState.Succeeded, task.State);
        Assert.Equal(1, task.CurrentAttempt);
        Assert.Equal(["acct-19"], _activated);
    }

    [Fact(Timeout = 120_000)]
    public async Task TheWaitShowsTheContextToThePerson()
    {
        var driver = new DurableFlowDriver(_db);
        await using var worker = driver.CreateWorker();
        Examples().Register(worker);
        var taskId = await driver.EnqueueAsync("account.activate", new { accountId = "acct-20" }, TestContext.Current.CancellationToken);
        await ExampleDatabase.EventuallyAsync(
            async () =>
            {
                await _db.ExecuteAsync("SELECT count(*) FROM workhorse.tick_v1(100, 100)");
                await worker.RunOnceAsync();
                return await _db.ScalarAsync<long>(
                    "SELECT count(*) FROM workhorse.task_human_wait WHERE task_id = $1", taskId) == 1;
            },
            "the task waits for a person");
        var context = await _db.ScalarAsync<string>(
            "SELECT context::text FROM workhorse.task_human_wait WHERE task_id = $1 AND token_name = 'account-review'", taskId);
        JsonAssert.Equal("""{"accountId":"acct-20","prompt":"Approve this account?"}""", System.Text.Json.JsonDocument.Parse(context).RootElement);
    }

    [Fact(Timeout = 120_000)]
    public async Task ARejectionDoesNotActivateTheAccount()
    {
        var driver = new DurableFlowDriver(_db);
        await using var worker = driver.CreateWorker();
        Examples().Register(worker);
        var taskId = await driver.EnqueueAsync("account.activate", new { accountId = "acct-19" }, TestContext.Current.CancellationToken);
        await driver.CompleteHumanWaitAsync(worker, taskId, "account-review", new { approved = false });
        Assert.Equal(TaskState.Succeeded, (await driver.FinishAsync(worker, taskId)).State);
        Assert.Empty(_activated);
    }

    private HumanWaitsExamples Examples() =>
        new(accountId =>
        {
            _activated.Enqueue(accountId);
            return Task.CompletedTask;
        });
}
