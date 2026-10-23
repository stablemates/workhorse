namespace Workhorse.Examples.Enqueue;

/// <summary>The C# tabs of the site page about throttle.</summary>
public sealed class ThrottleExamples(Queue queue)
{
    public async Task<EnqueueResult> ThrottleAsync(string accountId, TimeSpan digestWindow)
    {
        // docs:start csharp-throttle-enqueue
        var result = await queue.EnqueueAsync(
            "email.digest",
            new { accountId },
            new EnqueueOptions
            {
                Throttle = new Throttle { Key = accountId, Window = digestWindow, Scope = "digest" },
            });
        // docs:end
        return result;
    }
}
