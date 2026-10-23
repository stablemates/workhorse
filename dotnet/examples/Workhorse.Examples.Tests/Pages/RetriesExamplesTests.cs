using Workhorse.Examples.Pages;
using Workhorse.Examples.Tests.Testing;
using Workhorse.Tests.Testing;

namespace Workhorse.Examples.Tests.Pages;

/// <summary>Runs the C# snippets of the site page about retries.</summary>
public sealed class RetriesExamplesTests(ScratchDatabase scratch)
{
    private readonly ExampleDatabase _db = ExampleDatabase.Shared(scratch);

    [Fact]
    public async Task TheAttemptBudgetReachesTheTask()
    {
        var accountId = $"csharp-{Guid.NewGuid()}";
        await new RetriesExamples(_db.Queue).AttemptBudgetAsync(accountId);
        Assert.Equal(5, (await _db.TaskAsync("provider.sync", "accountId", accountId)).MaxAttempts);
    }

    [Fact]
    public async Task TheRetryPolicyReachesTheTask()
    {
        var accountId = $"csharp-{Guid.NewGuid()}";
        await new RetriesExamples(_db.Queue).RetryPolicyAsync(accountId);
        var task = await _db.TaskAsync("provider.sync", "accountId", accountId);
        Assert.Equal(5, task.MaxAttempts);
        var policy = task.RetryPolicy!.Value;
        Assert.Equal("decorrelated-jitter", policy.GetProperty("type").GetString());
        Assert.Equal(1_000, policy.GetProperty("baseDelayMs").GetInt64());
        Assert.Equal(60_000, policy.GetProperty("maxDelayMs").GetInt64());
    }
}
