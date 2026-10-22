using System.Text.Json;

namespace Workhorse;

/// <summary>
/// One task that a worker claimed, as <c>claim_many_v1</c> returns it. The counterpart of Ruby's
/// <c>ClaimedTask</c>.
/// </summary>
/// <remarks>
/// The fence token identifies this attempt. Every write of the attempt carries it, so an attempt
/// that lost its lease cannot change the task.
/// </remarks>
public sealed record ClaimedTask
{
    /// <summary>The task.</summary>
    public required Guid Id { get; init; }

    /// <summary>The queue that the worker claimed the task from.</summary>
    public required string Queue { get; init; }

    /// <summary>The task type.</summary>
    public required string Type { get; init; }

    /// <summary>The priority.</summary>
    public required int Priority { get; init; }

    /// <summary>The payload as JSON. The handler receives it decoded to its payload type.</summary>
    public required JsonElement Payload { get; init; }

    /// <summary>The payload contract version that the task has, or <c>null</c>.</summary>
    public string? ContractVersion { get; init; }

    /// <summary>The largest result that PostgreSQL accepts, in bytes, or <c>null</c>.</summary>
    public long? ResultMaxBytes { get; init; }

    /// <summary>Whether a failure records only the redacted envelope.</summary>
    public required bool RedactErrorDetails { get; init; }

    /// <summary>The W3C trace context of the enqueue, or <c>null</c>.</summary>
    public JsonElement? TraceContext { get; init; }

    /// <summary>The attempt number, from 1.</summary>
    public required int Attempt { get; init; }

    /// <summary>The attempt limit.</summary>
    public required int MaxAttempts { get; init; }

    /// <summary>The persisted retry policy, or <c>null</c>.</summary>
    public JsonElement? RetryPolicy { get; init; }

    /// <summary>The absolute deadline, or <c>null</c>.</summary>
    public DateTimeOffset? DeadlineAt { get; init; }

    /// <summary>The timeout of each attempt, or <c>null</c>.</summary>
    public TimeSpan? ExecutionTimeout { get; init; }

    /// <summary>When this attempt times out, or <c>null</c>.</summary>
    public DateTimeOffset? AttemptTimeoutAt { get; init; }

    /// <summary>The fence token of this attempt.</summary>
    public required long FenceToken { get; init; }

    /// <summary>When the lease expires unless the worker renews it.</summary>
    public DateTimeOffset? LeaseExpiresAt { get; init; }
}
