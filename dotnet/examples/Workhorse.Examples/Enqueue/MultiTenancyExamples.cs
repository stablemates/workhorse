namespace Workhorse.Examples.Enqueue;

/// <summary>The C# tab of the site page about multi-tenancy.</summary>
public sealed class MultiTenancyExamples(Queue queue)
{
    public async Task<EnqueueResult> TenantOptionsAsync()
    {
        // docs:start csharp-multi-tenancy-options
        var tenant = "acme";

        await queue.SyncConcurrencyPoliciesAsync(
            "workers",
            [new ConcurrencyPolicyDefinition { Queue = "reports", MaxActive = 40, MaxActivePerKey = 4 }]);
        await queue.SyncBudgetsAsync(
            "workers",
            [new BudgetDefinition { Name = tenant, MaxActive = 8 }]);

        var result = await queue.EnqueueAsync(
            "report.generate",
            new { month = "2026-08" },
            new EnqueueOptions
            {
                Queue = "reports",
                ConcurrencyKey = tenant,
                Budget = tenant,
                Tags = [$"tenant:{tenant}"],
            });
        // docs:end
        return result;
    }
}
