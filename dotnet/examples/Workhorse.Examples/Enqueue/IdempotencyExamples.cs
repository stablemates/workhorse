namespace Workhorse.Examples.Enqueue;

/// <summary>The C# tabs of the site page about enqueue idempotency.</summary>
public sealed class IdempotencyExamples(Queue queue)
{
    public async Task<Guid> EnqueueOnceAsync(string invoiceId)
    {
        // docs:start csharp-idempotency-enqueue
        var result = await queue.EnqueueAsync(
            "invoice.capture",
            new { invoiceId },
            new EnqueueOptions
            {
                Queue = "billing",
                Idempotency = new Idempotency
                {
                    Key = $"capture:{invoiceId}",
                    Scope = "invoice-capture",
                    Ttl = TimeSpan.FromDays(1),
                },
            });
        var taskId = result.TaskId;
        // docs:end
        return taskId;
    }

    public async Task<EnqueueResult> EnqueueWithResultAsync(string invoiceId, string key)
    {
        // docs:start csharp-idempotency-outcome
        var result = await queue.EnqueueAsync(
            "invoice.capture",
            new { invoiceId },
            new EnqueueOptions
            {
                Idempotency = new Idempotency
                {
                    Key = key,
                    Scope = "invoice-capture",
                    Ttl = TimeSpan.FromDays(1),
                },
            });
        // docs:end
        return result;
    }
}
