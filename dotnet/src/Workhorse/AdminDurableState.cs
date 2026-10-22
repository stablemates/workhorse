using System.Text.Json;

namespace Workhorse;

/// <summary>One saved checkpoint of a task.</summary>
public sealed record TaskCheckpoint
{
    /// <summary>The task.</summary>
    public required Guid TaskId { get; init; }

    /// <summary>The checkpoint name.</summary>
    public required string Name { get; init; }

    /// <summary>The saved value.</summary>
    public JsonElement? Value { get; init; }

    /// <summary>The attempt that saved the value.</summary>
    public required int Attempt { get; init; }

    /// <summary>The fence token of that attempt.</summary>
    public required long FenceToken { get; init; }

    /// <summary>The worker that saved the value.</summary>
    public required string WorkerId { get; init; }

    /// <summary>When the value was saved.</summary>
    public required DateTimeOffset CreatedAt { get; init; }

    /// <summary>
    /// The fingerprint of the input that produced the value, or <c>null</c> when the write gave no
    /// input (ADR 0098).
    /// </summary>
    public string? InputFingerprint { get; init; }
}

/// <summary>The latest progress value of a task, and the attempt that wrote it.</summary>
public sealed record TaskProgress
{
    /// <summary>The task.</summary>
    public required Guid TaskId { get; init; }

    /// <summary>The progress value.</summary>
    public JsonElement? Value { get; init; }

    /// <summary>The revision, which each accepted update increases.</summary>
    public required long Revision { get; init; }

    /// <summary>The attempt that wrote the value.</summary>
    public required int Attempt { get; init; }

    /// <summary>The fence token of that attempt.</summary>
    public required long FenceToken { get; init; }

    /// <summary>The worker that wrote the value.</summary>
    public required string WorkerId { get; init; }

    /// <summary>The time of the first update.</summary>
    public required DateTimeOffset CreatedAt { get; init; }

    /// <summary>The time of the last update.</summary>
    public required DateTimeOffset UpdatedAt { get; init; }
}

/// <summary>How a durable wait sets its wake time.</summary>
public enum TaskWaitMode
{
    /// <summary>The wait sleeps for a duration.</summary>
    Relative,

    /// <summary>The wait sleeps until a time.</summary>
    Absolute,
}

/// <summary>One durable wait of a task.</summary>
public sealed record TaskWait
{
    /// <summary>The task.</summary>
    public required Guid TaskId { get; init; }

    /// <summary>The wait name.</summary>
    public required string Name { get; init; }

    /// <summary>How the wait sets its wake time.</summary>
    public required TaskWaitMode Mode { get; init; }

    /// <summary>The requested duration of a relative wait, or <c>null</c>.</summary>
    public TimeSpan? Duration { get; init; }

    /// <summary>The requested wake time of an absolute wait, or <c>null</c>.</summary>
    public DateTimeOffset? RequestedWakeAt { get; init; }

    /// <summary>The wake time that PostgreSQL set.</summary>
    public required DateTimeOffset WakeAt { get; init; }

    /// <summary>The attempt that scheduled the wait.</summary>
    public required int Attempt { get; init; }

    /// <summary>The fence token of that attempt.</summary>
    public required long FenceToken { get; init; }

    /// <summary>The worker that scheduled the wait.</summary>
    public required string WorkerId { get; init; }

    /// <summary>When the wait was scheduled.</summary>
    public required DateTimeOffset CreatedAt { get; init; }
}

/// <summary>The page of <see cref="Admin.ListSignalWaitsAsync"/>.</summary>
public sealed record SignalWaitQuery
{
    /// <summary>The page size, 1 to 1,000. The default is 100.</summary>
    public int Limit { get; init; } = 100;

    /// <summary>The cursor of the previous page, or <c>null</c> for the first page.</summary>
    public ExternalWaitCursor? Cursor { get; init; }
}

/// <summary>The page of <see cref="Admin.ListHumanWaitsAsync"/>.</summary>
public sealed record HumanWaitQuery
{
    /// <summary>The page size, 1 to 1,000. The default is 100.</summary>
    public int Limit { get; init; } = 100;

    /// <summary>The cursor of the previous page, or <c>null</c> for the first page.</summary>
    public ExternalWaitCursor? Cursor { get; init; }
}

/// <summary>Resumes a signal wait page or a human wait page after its last wait.</summary>
public sealed record ExternalWaitCursor
{
    /// <summary>The creation time of the last wait, as PostgreSQL's text.</summary>
    public required string CreatedAt { get; init; }

    /// <summary>The task of the last wait.</summary>
    public required Guid TaskId { get; init; }

    /// <summary>The name of the last wait.</summary>
    public required string Name { get; init; }
}

/// <summary>A task that waits for a signal. The counterpart of Ruby's <c>ExternalWait</c>.</summary>
public sealed record SignalWait
{
    /// <summary>The task.</summary>
    public required Guid TaskId { get; init; }

    /// <summary>The queue.</summary>
    public required string Queue { get; init; }

    /// <summary>The task type.</summary>
    public required string TaskType { get; init; }

    /// <summary>The signal name.</summary>
    public required string Name { get; init; }

    /// <summary>The attempt that waits.</summary>
    public required int Attempt { get; init; }

    /// <summary>When the wait started.</summary>
    public required DateTimeOffset CreatedAt { get; init; }

    /// <summary>When the wait times out.</summary>
    public required DateTimeOffset DeadlineAt { get; init; }
}

/// <summary>One page of the tasks that wait for a signal, oldest first.</summary>
public sealed record SignalWaitPage
{
    /// <summary>The waits of the page.</summary>
    public required IReadOnlyList<SignalWait> Items { get; init; }

    /// <summary>The cursor of the next page, or <c>null</c> on the last page.</summary>
    public ExternalWaitCursor? NextCursor { get; init; }
}

/// <summary>A task that waits for a human decision.</summary>
public sealed record HumanWait
{
    /// <summary>The task.</summary>
    public required Guid TaskId { get; init; }

    /// <summary>The queue.</summary>
    public required string Queue { get; init; }

    /// <summary>The task type.</summary>
    public required string TaskType { get; init; }

    /// <summary>The decision name.</summary>
    public required string Name { get; init; }

    /// <summary>The attempt that waits.</summary>
    public required int Attempt { get; init; }

    /// <summary>When the wait started.</summary>
    public required DateTimeOffset CreatedAt { get; init; }

    /// <summary>When the wait times out.</summary>
    public required DateTimeOffset DeadlineAt { get; init; }

    /// <summary>The context for the human.</summary>
    public JsonElement? Context { get; init; }
}

/// <summary>One page of the tasks that wait for a human decision, oldest first.</summary>
public sealed record HumanWaitPage
{
    /// <summary>The waits of the page.</summary>
    public required IReadOnlyList<HumanWait> Items { get; init; }

    /// <summary>The cursor of the next page, or <c>null</c> on the last page.</summary>
    public ExternalWaitCursor? NextCursor { get; init; }
}
