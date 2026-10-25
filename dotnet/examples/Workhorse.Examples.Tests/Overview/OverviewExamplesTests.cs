using System.Collections.Concurrent;
using Workhorse.Examples.Overview;
using Workhorse.Examples.Tests.Durable;
using Workhorse.Examples.Tests.Testing;
using Workhorse.Tests.Testing;

namespace Workhorse.Examples.Tests.Overview;

/// <summary>Runs the C# onboarding of the site page "What is Workhorse?".</summary>
public sealed class OverviewExamplesTests(ScratchDatabase scratch) : IWorkspaces, IMailer
{
    private readonly ExampleDatabase _db = ExampleDatabase.Shared(scratch);
    private readonly ConcurrentQueue<string> _calls = new();
    private int _welcomes;

    [Fact(Timeout = 120_000)]
    public async Task TheOnboardingWaitsForTheEmailAndCreatesOneWorkspace()
    {
        var token = TestContext.Current.CancellationToken;
        var driver = new DurableFlowDriver(_db);
        await using var worker = driver.CreateWorker();
        var enqueued = $"csharp-{Guid.NewGuid()}";
        await new OverviewExamples(this, this).OnboardAsync(_db.Queue, worker, enqueued, "ada@example.com", "tenant-42");

        var policy = Assert.Single(
            await _db.Queue.ListConcurrencyPoliciesAsync(token), stored => stored.Queue == "onboarding");
        Assert.Equal("accounts", policy.Namespace);
        Assert.Equal(3, policy.MaxActivePerKey);
        var stored = await _db.TaskAsync("account.onboard", "accountId", enqueued);
        Assert.Equal("onboarding", stored.Queue);
        Assert.Equal("tenant-42", stored.ConcurrencyKey);

        var taskId = await driver.EnqueueAsync(
            "account.onboard", new { accountId = "acct-9", email = "ada@example.com" }, token);
        await driver.DeliverSignalAsync(worker, taskId, "email-verified", new { verified = true });
        var task = await driver.FinishAsync(worker, taskId);
        Assert.Equal(TaskState.Succeeded, task.State);
        Assert.Equal(2, task.CurrentAttempt);
        Assert.Equal(["workspace acct-9 workspace:acct-9", "welcome ada@example.com", "welcome ada@example.com"], _calls);
        JsonAssert.Equal("""{"id":"ws-acct-9","url":"https://example.com/ws-acct-9"}""", task.Result);
    }

    Task<Workspace> IWorkspaces.CreateAsync(string accountId, string idempotencyKey, CancellationToken cancellationToken)
    {
        _calls.Enqueue($"workspace {accountId} {idempotencyKey}");
        return Task.FromResult(new Workspace($"ws-{accountId}", $"https://example.com/ws-{accountId}"));
    }

    Task<WelcomeResult> IMailer.WelcomeAsync(string email, Workspace workspace, CancellationToken cancellationToken)
    {
        _calls.Enqueue($"welcome {email}");
        if (Interlocked.Increment(ref _welcomes) == 1)
        {
            throw new InvalidOperationException("the mail service is not available");
        }
        return Task.FromResult(new WelcomeResult(true));
    }
}
