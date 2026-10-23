namespace Workhorse.Examples.Enqueue;

/// <summary>The C# tab of the site page about rate limits.</summary>
public sealed class RateLimitsExamples(Queue queue)
{
    public async Task<IReadOnlyList<RateLimitPolicy>> SyncPoliciesAsync()
    {
        // docs:start csharp-rate-limits-sync
        var policies = await queue.SyncRateLimitPoliciesAsync(
            "workers",
            [
                new RateLimitPolicyDefinition
                {
                    Queue = "provider-api",
                    Rate = new RateLimit { Limit = 60, Interval = TimeSpan.FromMinutes(1), Burst = 10 },
                    PerKey = new RateLimit { Limit = 5, Interval = TimeSpan.FromMinutes(1), Burst = 2 },
                },
            ]);
        // docs:end
        return policies;
    }
}
