namespace Workhorse.Examples.Durable;

/// <summary>The C# tabs of the site page about deadlines and execution timeouts.</summary>
public sealed class DeadlinesExamples(Queue queue)
{
    public async Task DeadlineAsync(string quoteId, DateTimeOffset quoteExpiresAt)
    {
        // docs:start csharp-deadlines-deadline
        await queue.EnqueueAsync(
            "price.quote",
            new { quoteId },
            new EnqueueOptions { Deadline = quoteExpiresAt });
        // docs:end
    }

    public async Task ExecutionTimeoutAsync(string reportId, TimeSpan attemptTimeout, int attemptBudget)
    {
        // docs:start csharp-deadlines-execution-timeout
        await queue.EnqueueAsync(
            "report.build",
            new { reportId },
            new EnqueueOptions { ExecutionTimeout = attemptTimeout, MaxAttempts = attemptBudget });
        // docs:end
    }
}
