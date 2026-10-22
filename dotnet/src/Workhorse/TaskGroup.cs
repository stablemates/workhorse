namespace Workhorse;

/// <summary>The state of a task group (ADR 0095).</summary>
public enum TaskGroupState
{
    /// <summary>The group accepts tasks.</summary>
    Open,

    /// <summary>The group accepts tasks only from a running member task.</summary>
    Sealed,

    /// <summary>Every member task is finished.</summary>
    Finished,
}

/// <summary>The result of a finished task group.</summary>
public enum TaskGroupResult
{
    /// <summary>Every member task succeeded.</summary>
    Succeeded,

    /// <summary>A member task failed or was canceled.</summary>
    Failed,
}

/// <summary>A callback of a task group, in the order a group enqueues them.</summary>
public enum TaskGroupCallbackKind
{
    /// <summary>Enqueued when the group finishes.</summary>
    OnFinish,

    /// <summary>Enqueued when the group succeeds.</summary>
    OnSuccess,

    /// <summary>Enqueued when the group fails.</summary>
    OnFailure,
}

/// <summary>The outcome that a task group counted for one member task.</summary>
public enum TaskGroupMemberOutcome
{
    /// <summary>The member task succeeded.</summary>
    Succeeded,

    /// <summary>The member task failed.</summary>
    Failed,

    /// <summary>The member task was canceled.</summary>
    Canceled,
}

/// <summary>A requested callback of a task group.</summary>
public sealed record TaskGroupCallback
{
    /// <summary>The callback kind.</summary>
    public required TaskGroupCallbackKind Kind { get; init; }

    /// <summary>
    /// The callback task. It is <c>null</c> until the group finishes, and <c>null</c> for a
    /// callback that the result does not select.
    /// </summary>
    public Guid? TaskId { get; init; }
}

/// <summary>The counts of a task group.</summary>
public sealed record TaskGroupCounts
{
    /// <summary>The member tasks.</summary>
    public required long Total { get; init; }

    /// <summary>The member tasks that succeeded.</summary>
    public required long Succeeded { get; init; }

    /// <summary>The member tasks that failed.</summary>
    public required long Failed { get; init; }

    /// <summary>The member tasks that were canceled.</summary>
    public required long Canceled { get; init; }

    /// <summary>The member tasks that are not finished, or <c>null</c> for the recorded counters of a drift report.</summary>
    public long? Pending { get; init; }
}

/// <summary>A set of full-tier tasks that Workhorse tracks as one unit (ADR 0095).</summary>
public sealed record TaskGroup
{
    /// <summary>The group.</summary>
    public required Guid Id { get; init; }

    /// <summary>The state.</summary>
    public required TaskGroupState State { get; init; }

    /// <summary>The result when the group is finished, and <c>null</c> before.</summary>
    public TaskGroupResult? Result { get; init; }

    /// <summary>The counts.</summary>
    public required TaskGroupCounts Counts { get; init; }

    /// <summary>When the group was created.</summary>
    public required DateTimeOffset CreatedAt { get; init; }

    /// <summary>When the group was sealed, or <c>null</c>.</summary>
    public DateTimeOffset? SealedAt { get; init; }

    /// <summary>When the group finished, or <c>null</c>.</summary>
    public DateTimeOffset? FinishedAt { get; init; }

    /// <summary>When the group was canceled, or <c>null</c>.</summary>
    public DateTimeOffset? CanceledAt { get; init; }

    /// <summary>Who canceled the group, or <c>null</c>.</summary>
    public string? CanceledBy { get; init; }

    /// <summary>Why the group was canceled, or <c>null</c>.</summary>
    public string? CancelReason { get; init; }

    /// <summary>The requested callbacks, in the order on finish, on success, on failure.</summary>
    public required IReadOnlyList<TaskGroupCallback> Callbacks { get; init; }
}

/// <summary>One member task of a task group.</summary>
public sealed record TaskGroupMember
{
    /// <summary>The 1-based order in which the task joined its group.</summary>
    public required long Position { get; init; }

    /// <summary>The task.</summary>
    public required Guid TaskId { get; init; }

    /// <summary>The queue, or <c>null</c> after a purge or retention deletes the task.</summary>
    public string? Queue { get; init; }

    /// <summary>The task type, or <c>null</c> after a purge or retention deletes the task.</summary>
    public string? Type { get; init; }

    /// <summary>The task state, or <c>null</c> after a purge or retention deletes the task.</summary>
    public TaskState? State { get; init; }

    /// <summary>The outcome that the group counted, or <c>null</c> while the member is pending.</summary>
    public TaskGroupMemberOutcome? Outcome { get; init; }

    /// <summary>When the task joined.</summary>
    public required DateTimeOffset AddedAt { get; init; }

    /// <summary>When the group counted the outcome, or <c>null</c>.</summary>
    public DateTimeOffset? CountedAt { get; init; }
}

/// <summary>One page of member tasks.</summary>
public sealed record TaskGroupMemberPage
{
    /// <summary>The member tasks of the page.</summary>
    public required IReadOnlyList<TaskGroupMember> Members { get; init; }

    /// <summary>The position to pass as <c>after</c> for the next page, or <c>null</c> on the last page.</summary>
    public long? NextAfter { get; init; }
}
