namespace Workhorse.Examples.Workers;

/// <summary>The C# tabs of the site page about dead letters and redrive.</summary>
public sealed class DeadLettersExamples(Admin admin)
{
    public async Task<DeadLetterPage> ListFailuresAsync()
    {
        // docs:start csharp-dead-letters-list
        var page = await admin.ListDeadLettersAsync(new DeadLetterQuery
        {
            Queue = "payments",
            ErrorName = "ProviderTimeout",
            FinishedAfter = new DateTimeOffset(2026, 3, 14, 9, 0, 0, TimeSpan.Zero),
        });
        // docs:end
        return page;
    }

    public async Task<RedriveResult> RedriveOneAsync(Guid sourceTaskId)
    {
        // docs:start csharp-dead-letters-redrive
        var result = await admin.RedriveAsync(
            sourceTaskId,
            new AdminAudit { Actor = "ops@example.com", Reason = "Provider outage ended", RequestId = "r-77" });
        // docs:end
        return result;
    }

    /// <summary>Redrives the backlog in pages, and returns the dry run of the first page.</summary>
    public async Task<BulkRedrivePage> RedriveBacklogAsync()
    {
        // docs:start csharp-dead-letters-redrive-many
        var filter = new RedriveFilter { Queue = "payments", ErrorName = "ProviderTimeout", Limit = 100 };
        var audit = new AdminAudit { Actor = "ops@example.com", Reason = "Provider outage ended", RequestId = "outage-0314" };
        var preview = await admin.RedriveManyAsync(filter with { DryRun = true }, audit);
        var page = await admin.RedriveManyAsync(filter, audit);
        while (page.NextCursor is { } cursor)
        {
            page = await admin.RedriveManyAsync(filter with { Cursor = cursor }, audit);
        }
        // docs:end
        return preview;
    }
}
