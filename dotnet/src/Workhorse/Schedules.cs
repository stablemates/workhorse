namespace Workhorse;

/// <summary>What a schedule does with occurrences that it missed.</summary>
public enum CatchupPolicy
{
    /// <summary>It skips them.</summary>
    Skip,

    /// <summary>It enqueues the latest one.</summary>
    Latest,

    /// <summary>It enqueues each of them.</summary>
    All,
}

/// <summary>The task that a schedule enqueues at each occurrence.</summary>
public sealed record ScheduledTask
{
    /// <summary>The task type.</summary>
    public required string TaskType { get; init; }

    /// <summary>The JSON payload, which can be <c>null</c>.</summary>
    public object? Payload { get; init; }

    /// <summary>The queue, or <c>null</c> for the default queue of the <see cref="Queue"/>.</summary>
    public string? Queue { get; init; }

    /// <summary>The priority, 0 to 100.</summary>
    public int Priority { get; init; }

    /// <summary>The concurrency key, or <c>null</c>.</summary>
    public string? ConcurrencyKey { get; init; }

    /// <summary>The attempt limit, or <c>null</c> for the default of 25.</summary>
    public int? MaxAttempts { get; init; }

    /// <summary>The persisted retry policy, or <c>null</c>.</summary>
    public RetryPolicy? RetryPolicy { get; init; }
}

/// <summary>One named schedule.</summary>
public sealed record ScheduleDefinition
{
    /// <summary>The schedule name.</summary>
    public required string Name { get; init; }

    /// <summary>A cron expression or an interval that PostgreSQL accepts.</summary>
    public required string Schedule { get; init; }

    /// <summary>The task that each occurrence enqueues.</summary>
    public required ScheduledTask Task { get; init; }

    /// <summary>The time zone of the cron expression. The default is <c>UTC</c>.</summary>
    public string Timezone { get; init; } = "UTC";

    /// <summary>What the schedule does with missed occurrences. The default is <see cref="CatchupPolicy.Skip"/>.</summary>
    public CatchupPolicy CatchupPolicy { get; init; } = CatchupPolicy.Skip;

    /// <summary>Whether the schedule fires. The default is <c>true</c>.</summary>
    public bool Enabled { get; init; } = true;
}
