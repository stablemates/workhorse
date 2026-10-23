namespace Workhorse.Examples.Enqueue;

/// <summary>The C# tabs of the site page about concurrency policies.</summary>
public sealed class ConcurrencyPoliciesExamples(Queue queue)
{
    public async Task<IReadOnlyList<ConcurrencyPolicy>> SyncPoliciesAsync()
    {
        // docs:start csharp-concurrency-policies-sync
        var policies = await queue.SyncConcurrencyPoliciesAsync(
            "workers",
            [new ConcurrencyPolicyDefinition { Queue = "mail", MaxActive = 20, MaxActivePerKey = 3 }]);
        // docs:end
        return policies;
    }

    public async Task EnqueueWithKeyAsync(string messageId, string tenantId)
    {
        // docs:start csharp-concurrency-policies-key
        await queue.EnqueueAsync(
            "mail.send",
            new { messageId },
            new EnqueueOptions { Queue = "mail", ConcurrencyKey = tenantId });
        // docs:end
    }

    public async Task<IReadOnlyList<Budget>> BudgetsAsync()
    {
        // docs:start csharp-concurrency-policies-budget
        var budgets = await queue.SyncBudgetsAsync(
            "workers",
            [new BudgetDefinition { Name = "vendor-api", MaxActive = 4 }]);

        await queue.EnqueueAsync(
            "invoice.sync",
            new { id = 1 },
            new EnqueueOptions { Queue = "billing", Budget = "vendor-api" });
        await queue.EnqueueAsync(
            "contact.sync",
            new { id = 2 },
            new EnqueueOptions { Queue = "crm", Budget = "vendor-api" });
        // docs:end
        return budgets;
    }
}
