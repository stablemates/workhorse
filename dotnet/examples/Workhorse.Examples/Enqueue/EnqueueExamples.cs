namespace Workhorse.Examples.Enqueue;

/// <summary>One recipient of the digest mail.</summary>
public sealed record Recipient(string Email);

/// <summary>The C# tabs of the site page about enqueue.</summary>
public sealed class EnqueueExamples(Queue queue, Admin admin)
{
    public async Task EnqueueNowOrLaterAsync(string invoiceId, DateTimeOffset reminderDate)
    {
        // docs:start csharp-enqueue-now-or-later
        await queue.EnqueueAsync("email.send", new { to = "person@example.com" });
        await queue.EnqueueAsync(
            "invoice.remind",
            new { invoiceId },
            new EnqueueOptions { Queue = "billing", RunAt = reminderDate });
        // docs:end
    }

    public async Task EnqueueWithOptionsAsync(DateTimeOffset endOfMonth)
    {
        // docs:start csharp-enqueue-options
        await queue.EnqueueAsync(
            "report.generate",
            new { month = "2026-08" },
            new EnqueueOptions
            {
                Queue = "reports",
                Tags = ["tenant:acme"],
                ConcurrencyKey = "acme",
                Priority = 10,
                MaxAttempts = 5,
                Deadline = endOfMonth,
                ExecutionTimeout = TimeSpan.FromMinutes(2),
            });
        // docs:end
    }

    public async Task<IReadOnlyList<EnqueueResult>> EnqueueManyAsync(IEnumerable<Recipient> recipients)
    {
        // docs:start csharp-enqueue-many
        var results = await queue.EnqueueManyAsync(
            recipients.Select(recipient => new EnqueueRequest
            {
                TaskType = "email.digest",
                Payload = new { to = recipient.Email },
                Options = new EnqueueOptions { Queue = "mail" },
            }));
        // docs:end
        return results;
    }

    public async Task PauseAndResumeAsync(string actor, string reason, string requestId, string resumeRequestId)
    {
        // docs:start csharp-enqueue-pause-resume
        await admin.PauseQueueAsync(
            "billing",
            new AdminAudit { Actor = actor, Reason = reason, RequestId = requestId });
        await admin.ResumeQueueAsync(
            "billing",
            new AdminAudit { Actor = actor, Reason = reason, RequestId = resumeRequestId });
        // docs:end
    }
}
