using Npgsql;

namespace Workhorse.Examples.Durable;

/// <summary>The person who cancels a task in the cancellation snippets.</summary>
public sealed record CancellationActor(string Email);

/// <summary>The payload of the <c>order.upload</c> task.</summary>
public sealed record UploadPayload(IReadOnlyList<string> Parts);

/// <summary>The file store of the cancellation snippets.</summary>
public interface IPartUploader
{
    /// <summary>Uploads one part of an order. A slow upload stops when <paramref name="cancellationToken"/> is cancelled.</summary>
    Task UploadAsync(string part, CancellationToken cancellationToken);
}

/// <summary>The C# tabs of the site page about cancellation.</summary>
public sealed class CancellationExamples(Queue queue, NpgsqlDataSource dataSource, IPartUploader uploader)
{
    public async Task<CancelResult> CancelBeforeStartAsync(Guid taskId, CancellationActor actor)
    {
        ArgumentNullException.ThrowIfNull(actor);
        // docs:start csharp-cancellation-cancel
        var result = await queue.CancelAsync(
            taskId,
            new CancelOptions { RequestedBy = actor.Email, Reason = "customer withdrew the order" });
        // docs:end
        return result;
    }

    /// <summary>A worker on <paramref name="queueName"/> whose <c>order.upload</c> handler obeys the cancellation.</summary>
    public Worker UploadWorker(string queueName)
    {
        var worker = new Worker(dataSource, new WorkerOptions { Queues = [queueName], Lease = TimeSpan.FromSeconds(3) });
        worker.Handle<UploadPayload>(
            "order.upload",
            async (context, payload) =>
            {
                // docs:start csharp-cancellation-obey-signal
                foreach (var part in payload.Parts)
                {
                    context.CancellationToken.ThrowIfCancellationRequested();
                    await UploadPartAsync(part, context.CancellationToken);
                }
                // docs:end
            });
        return worker;
    }

    private Task UploadPartAsync(string part, CancellationToken cancellationToken) =>
        uploader.UploadAsync(part, cancellationToken);
}
