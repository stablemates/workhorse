namespace Workhorse.Examples.Pages;

/// <summary>The C# tabs of the site page about retries.</summary>
public sealed class RetriesExamples(Queue queue)
{
    public async Task AttemptBudgetAsync(string accountId)
    {
        // docs:start csharp-retries-attempt-budget
        await queue.EnqueueAsync(
            "provider.sync",
            new { accountId },
            new EnqueueOptions { MaxAttempts = 5 });
        // docs:end
    }

    public async Task RetryPolicyAsync(string accountId)
    {
        // docs:start csharp-retries-retry-policy
        var jitter = RetryPolicy.DecorrelatedJitter(
            baseDelay: TimeSpan.FromSeconds(1),
            maxDelay: TimeSpan.FromSeconds(60));
        await queue.EnqueueAsync(
            "provider.sync",
            new { accountId },
            new EnqueueOptions { RetryPolicy = jitter, MaxAttempts = 5 });
        // docs:end
    }
}
