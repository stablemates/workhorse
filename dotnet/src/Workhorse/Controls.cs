using System.Text.Json;

namespace Workhorse;

/// <summary>Who requests a cancellation, and why. Both are optional.</summary>
public sealed record CancelOptions
{
    /// <summary>Who requests cancellation, or <c>null</c>.</summary>
    public string? RequestedBy { get; init; }

    /// <summary>Why, or <c>null</c>.</summary>
    public string? Reason { get; init; }
}

/// <summary>The disposition of PostgreSQL for a cancellation request.</summary>
public enum CancelStatus
{
    /// <summary>The task was canceled.</summary>
    Canceled,

    /// <summary>The active task stops at its next checkpoint that PostgreSQL owns.</summary>
    CancelRequested,

    /// <summary>The task had already finished.</summary>
    AlreadyTerminal,

    /// <summary>No such task exists.</summary>
    NotFound,
}

/// <summary>The answer of PostgreSQL to a cancellation request.</summary>
public sealed record CancelResult
{
    /// <summary>The disposition.</summary>
    public required CancelStatus Status { get; init; }

    /// <summary>The task.</summary>
    public required Guid TaskId { get; init; }

    /// <summary>The state of the task, or <c>null</c> when it was not found.</summary>
    public TaskState? State { get; init; }

    /// <summary>The current attempt, or <c>null</c>.</summary>
    public int? CurrentAttempt { get; init; }

    /// <summary>When cancellation was first requested, or <c>null</c>.</summary>
    public DateTimeOffset? RequestedAt { get; init; }

    /// <summary>Who requested cancellation, or <c>null</c>.</summary>
    public string? RequestedBy { get; init; }

    /// <summary>The recorded reason, or <c>null</c>.</summary>
    public string? Reason { get; init; }

    /// <summary>When the task finished, or <c>null</c>.</summary>
    public DateTimeOffset? FinishedAt { get; init; }
}

/// <summary>The disposition of PostgreSQL for a signal.</summary>
public enum SignalStatus
{
    /// <summary>The signal reached the waiting task.</summary>
    Delivered,

    /// <summary>The idempotency key replayed a delivered signal.</summary>
    Duplicate,

    /// <summary>The task does not wait for the signal.</summary>
    NotWaiting,

    /// <summary>Another signal already completed the wait.</summary>
    AlreadyDelivered,

    /// <summary>The wait belongs to an earlier attempt.</summary>
    Stale,

    /// <summary>No such task exists.</summary>
    NotFound,
}

/// <summary>The disposition of PostgreSQL for a signal.</summary>
public sealed record SignalDeliveryResult
{
    /// <summary>The disposition.</summary>
    public required SignalStatus Status { get; init; }

    /// <summary>The task.</summary>
    public required Guid TaskId { get; init; }

    /// <summary>The signal name.</summary>
    public required string Name { get; init; }

    /// <summary>The delivered payload, or <c>null</c>.</summary>
    public JsonElement? Payload { get; init; }

    /// <summary>When the signal was delivered, or <c>null</c>.</summary>
    public DateTimeOffset? DeliveredAt { get; init; }

    /// <summary>Who delivered it, or <c>null</c>.</summary>
    public string? DeliveredBy { get; init; }
}

/// <summary>The disposition of PostgreSQL for a human wait completion.</summary>
public enum HumanWaitStatus
{
    /// <summary>The decision reached the waiting task.</summary>
    Completed,

    /// <summary>The idempotency key replayed a recorded decision.</summary>
    Duplicate,

    /// <summary>The task does not wait for the decision.</summary>
    NotWaiting,

    /// <summary>Another decision already completed the wait.</summary>
    AlreadyCompleted,

    /// <summary>The wait belongs to an earlier attempt.</summary>
    Stale,

    /// <summary>No such task exists.</summary>
    NotFound,
}

/// <summary>The disposition of PostgreSQL for a human wait completion.</summary>
public sealed record HumanWaitCompletionResult
{
    /// <summary>The disposition.</summary>
    public required HumanWaitStatus Status { get; init; }

    /// <summary>The task.</summary>
    public required Guid TaskId { get; init; }

    /// <summary>The wait name.</summary>
    public required string Name { get; init; }

    /// <summary>The recorded decision, or <c>null</c>.</summary>
    public JsonElement? Payload { get; init; }

    /// <summary>When the wait was completed, or <c>null</c>.</summary>
    public DateTimeOffset? CompletedAt { get; init; }

    /// <summary>Who completed it, or <c>null</c>.</summary>
    public string? CompletedBy { get; init; }
}

/// <summary>
/// The queue health snapshot of PostgreSQL over the last day. The snapshot keeps the keys that
/// <c>queue_health_v1</c> returns. A schema migration can add a key, so the record holds one map
/// (ADR 0107, "Public types grow only additively").
/// </summary>
public sealed record QueueHealth
{
    /// <summary>The snapshot.</summary>
    public required IReadOnlyDictionary<string, JsonElement> Snapshot { get; init; }
}
