namespace Workhorse;

/// <summary>One registered worker. The counterpart of Ruby's <c>WorkerRegistryEntry</c>.</summary>
public sealed record WorkerInfo
{
    /// <summary>The worker.</summary>
    public required string WorkerId { get; init; }

    /// <summary><c>true</c> when the worker claims no new task.</summary>
    public required bool Paused { get; init; }

    /// <summary>Who paused the worker, or <c>null</c>.</summary>
    public string? PausedBy { get; init; }

    /// <summary>Why the worker was paused, or <c>null</c>.</summary>
    public string? Reason { get; init; }

    /// <summary>When the worker was paused, or <c>null</c>.</summary>
    public DateTimeOffset? PausedAt { get; init; }

    /// <summary>The last heartbeat of the worker.</summary>
    public required DateTimeOffset LastHeartbeatAt { get; init; }

    /// <summary>The process instance of the worker.</summary>
    public required Guid InstanceId { get; init; }

    /// <summary>The host of the worker.</summary>
    public required string Hostname { get; init; }

    /// <summary>The process ID of the worker.</summary>
    public required int Pid { get; init; }

    /// <summary>The queues that the worker claims from.</summary>
    public required IReadOnlyList<string> Queues { get; init; }

    /// <summary>The first queue of the worker.</summary>
    public required string Queue { get; init; }

    /// <summary>The handler limit of the worker.</summary>
    public required int Concurrency { get; init; }

    /// <summary>The handlers that run now.</summary>
    public required int ActiveSlots { get; init; }

    /// <summary><c>true</c> when the worker stops.</summary>
    public required bool Draining { get; init; }

    /// <summary>When the worker started.</summary>
    public required DateTimeOffset StartedAt { get; init; }
}

/// <summary>The durable pause state of one worker after a pause or a resume.</summary>
public sealed record WorkerPauseResult
{
    /// <summary>The worker.</summary>
    public required string WorkerId { get; init; }

    /// <summary><c>true</c> when the worker claims no new task.</summary>
    public required bool Paused { get; init; }

    /// <summary>Who paused the worker, or <c>null</c>.</summary>
    public string? PausedBy { get; init; }

    /// <summary>Why the worker was paused, or <c>null</c>.</summary>
    public string? Reason { get; init; }

    /// <summary>When the worker was paused, or <c>null</c>.</summary>
    public DateTimeOffset? PausedAt { get; init; }

    /// <summary>The last heartbeat of the worker.</summary>
    public required DateTimeOffset LastHeartbeatAt { get; init; }
}

/// <summary>
/// The setting of a queue that decides how much Workhorse records for each task of the queue (ADR
/// 0077). The tier changes only while the queue holds no live task.
/// </summary>
public enum QueueTier
{
    /// <summary>The opt-in tier for queues whose handlers never suspend. It writes history only on opt-in.</summary>
    Fast,

    /// <summary>The default tier. It writes events and attempt history and supports every feature.</summary>
    Full,
}

/// <summary>The history that a fast-tier queue records.</summary>
public sealed record QueueHistory
{
    /// <summary><c>true</c> when the queue records attempt rows.</summary>
    public required bool RecordAttempts { get; init; }

    /// <summary><c>true</c> when the queue records claim events.</summary>
    public required bool RecordClaims { get; init; }
}
