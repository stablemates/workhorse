using System.Text.Json;

namespace Workhorse;

/// <summary>
/// The filter and the page of <see cref="Admin.ListDeadLettersAsync"/>. Each property is a keyword
/// of Ruby's <c>Admin#list_dead_letters</c>, with the same default.
/// </summary>
public sealed record DeadLetterQuery
{
    /// <summary>The page size, 1 to 1,000. The default is 100.</summary>
    public int Limit { get; init; } = 100;

    /// <summary>The cursor of the previous page, or <c>null</c> for the first page.</summary>
    public DeadLetterCursor? Cursor { get; init; }

    /// <summary>The queue, or <c>null</c> for every queue.</summary>
    public string? Queue { get; init; }

    /// <summary>The task type, or <c>null</c> for every type.</summary>
    public string? Type { get; init; }

    /// <summary>The tags that each failed task must have. An empty collection keeps every task.</summary>
    public IReadOnlyCollection<string> Tags { get; init; } = [];

    /// <summary>The error name of the last attempt, or <c>null</c> or empty for every name.</summary>
    public string? ErrorName { get; init; }

    /// <summary>The earliest finish time, or <c>null</c>.</summary>
    public DateTimeOffset? FinishedAfter { get; init; }

    /// <summary>The latest finish time, or <c>null</c>.</summary>
    public DateTimeOffset? FinishedBefore { get; init; }
}

/// <summary>
/// The filter and the page of <see cref="Admin.RedriveManyAsync"/>. Each property is a keyword of
/// Ruby's <c>Admin#redrive_many</c>, with the same default.
/// </summary>
public sealed record RedriveFilter
{
    /// <summary>The page size, 1 to 1,000. The default is 100.</summary>
    public int Limit { get; init; } = 100;

    /// <summary><c>true</c> to report the result for each failed task without a change.</summary>
    public bool DryRun { get; init; }

    /// <summary>The cursor of the previous page, or <c>null</c> for the first page.</summary>
    public DeadLetterCursor? Cursor { get; init; }

    /// <summary>The queue, or <c>null</c> for every queue.</summary>
    public string? Queue { get; init; }

    /// <summary>The task type, or <c>null</c> for every type.</summary>
    public string? Type { get; init; }

    /// <summary>The tags that each failed task must have. An empty collection keeps every task.</summary>
    public IReadOnlyCollection<string> Tags { get; init; } = [];

    /// <summary>The error name of the last attempt, or <c>null</c> or empty for every name.</summary>
    public string? ErrorName { get; init; }

    /// <summary>The earliest finish time, or <c>null</c>.</summary>
    public DateTimeOffset? FinishedAfter { get; init; }

    /// <summary>The latest finish time, or <c>null</c>.</summary>
    public DateTimeOffset? FinishedBefore { get; init; }
}

/// <summary>Resumes a dead-letter page or a bulk redrive after its last source task.</summary>
public sealed record DeadLetterCursor
{
    /// <summary>The finish time of the last source task, as PostgreSQL's text.</summary>
    public required string FinishedAt { get; init; }

    /// <summary>The last source task.</summary>
    public required Guid TaskId { get; init; }
}

/// <summary>One page of failed tasks, most recently finished first.</summary>
public sealed record DeadLetterPage
{
    /// <summary>The failed tasks of the page.</summary>
    public required IReadOnlyList<DeadLetter> Items { get; init; }

    /// <summary>The cursor of the next page, or <c>null</c> on the last page.</summary>
    public DeadLetterCursor? NextCursor { get; init; }
}

/// <summary>One failed task of a <see cref="DeadLetterPage"/>.</summary>
public sealed record DeadLetter
{
    /// <summary>The failed task.</summary>
    public required Guid TaskId { get; init; }

    /// <summary>The queue.</summary>
    public required string Queue { get; init; }

    /// <summary>The task type.</summary>
    public required string Type { get; init; }

    /// <summary>The concurrency key, or <c>null</c>.</summary>
    public string? ConcurrencyKey { get; init; }

    /// <summary>The priority.</summary>
    public required int Priority { get; init; }

    /// <summary>The payload.</summary>
    public JsonElement? Payload { get; init; }

    /// <summary>The tags.</summary>
    public required IReadOnlyList<string> Tags { get; init; }

    /// <summary>The last attempt.</summary>
    public required int CurrentAttempt { get; init; }

    /// <summary>The attempt limit.</summary>
    public required int MaxAttempts { get; init; }

    /// <summary>The persisted retry policy, or <c>null</c>.</summary>
    public JsonElement? RetryPolicy { get; init; }

    /// <summary>The absolute deadline, or <c>null</c>.</summary>
    public DateTimeOffset? DeadlineAt { get; init; }

    /// <summary>The timeout of each attempt, or <c>null</c>.</summary>
    public TimeSpan? ExecutionTimeout { get; init; }

    /// <summary>The error of the last attempt.</summary>
    public JsonElement? Error { get; init; }

    /// <summary>When the task failed.</summary>
    public required DateTimeOffset FinishedAt { get; init; }

    /// <summary>How many times an operator redrove the task.</summary>
    public required long RedriveCount { get; init; }
}

/// <summary>What a redrive did with one source task.</summary>
public enum RedriveStatus
{
    /// <summary>The redrive enqueued a fresh copy of the failed task.</summary>
    Redriven,

    /// <summary>An earlier redrive with the same request ID enqueued the copy, and this call replays it.</summary>
    Replayed,

    /// <summary>A dry run found that the task can be redriven.</summary>
    Eligible,

    /// <summary>No such task exists.</summary>
    NotFound,

    /// <summary>The task is not failed.</summary>
    NotFailed,
}

/// <summary>The result of a redrive for one source task.</summary>
public sealed record RedriveResult
{
    /// <summary>What the redrive did.</summary>
    public required RedriveStatus Status { get; init; }

    /// <summary>The failed task.</summary>
    public required Guid SourceTaskId { get; init; }

    /// <summary>The fresh copy, or <c>null</c> when the redrive enqueued none.</summary>
    public Guid? TargetTaskId { get; init; }

    /// <summary>The state of the source task, or <c>null</c> when it does not exist.</summary>
    public TaskState? SourceState { get; init; }

    /// <summary>The state of the copy, or <c>null</c>.</summary>
    public TaskState? TargetState { get; init; }

    /// <summary>When the redrive was first requested, or <c>null</c>.</summary>
    public DateTimeOffset? RequestedAt { get; init; }
}

/// <summary>The results of one page of a bulk redrive.</summary>
public sealed record BulkRedrivePage
{
    /// <summary>One result for each source task of the page.</summary>
    public required IReadOnlyList<RedriveResult> Results { get; init; }

    /// <summary>The cursor of the next page, or <c>null</c> on the last page.</summary>
    public DeadLetterCursor? NextCursor { get; init; }
}
