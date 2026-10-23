namespace Workhorse.Examples.Enqueue;

/// <summary>The C# tab of the site page about priority.</summary>
public sealed class PriorityExamples(Queue queue)
{
    public async Task EnqueueUrgentAsync(string invoiceId)
    {
        // docs:start csharp-priority-enqueue
        await queue.EnqueueAsync(
            "invoice.remind",
            new { invoiceId },
            new EnqueueOptions { Queue = "billing", Priority = 10 });
        // docs:end
    }
}
