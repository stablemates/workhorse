using Npgsql;

namespace Workhorse.Examples.Workers;

/// <summary>The C# tabs of the site page about batch handlers.</summary>
public sealed class BatchHandlersExamples(NpgsqlDataSource dataSource, Queue queue, IBatchEmailProvider emailProvider)
{
    /// <summary>Builds a worker with a batch handler for <c>email.send</c>, and does not run it.</summary>
    public Worker BatchWorker()
    {
        // docs:start csharp-batch-handlers-handle-batch
        var worker = new Worker(dataSource, new WorkerOptions { Queues = ["email"], Concurrency = 32 });
        worker.HandleBatch<Email>(
            "email.send",
            new BatchOptions { MaxSize = 20, Linger = TimeSpan.FromMilliseconds(50) },
            async (items, cancellationToken) =>
            {
                var deliveries = await emailProvider.SendManyAsync(
                    [.. items.Select(item => item.Payload)], cancellationToken);
                return [.. deliveries.Select(delivery => delivery.Error is { } error
                    ? (BatchHandlerOutcome)new BatchFailed(error)
                    : new BatchSucceeded(new { providerId = delivery.Id }))];
            });
        // docs:end
        return worker;
    }

    /// <summary>Enqueues one ordinary task for the batch handler.</summary>
    public async Task EnqueueEmailAsync()
    {
        // docs:start csharp-batch-handlers-enqueue
        await queue.EnqueueAsync("email.send", new { to = "person@example.com" });
        // docs:end
    }
}
