using System.Text.Json;

namespace Workhorse;

/// <summary>
/// The filter, the page, and the payload projection of <see cref="Admin.ListTasksAsync"/>. Each
/// property is a keyword of Ruby's <c>Admin#list_tasks</c>, with the same default.
/// </summary>
public sealed record TaskQuery
{
    /// <summary>The queue, or <c>null</c> for every queue.</summary>
    public string? Queue { get; init; }

    /// <summary>The task type, or <c>null</c> for every type.</summary>
    public string? Type { get; init; }

    /// <summary>The unique states to keep. An empty collection keeps every state.</summary>
    public IReadOnlyCollection<TaskState> States { get; init; } = [];

    /// <summary>The earliest creation time, or <c>null</c>.</summary>
    public DateTimeOffset? CreatedAfter { get; init; }

    /// <summary>The latest creation time, or <c>null</c>. It must be later than <see cref="CreatedAfter"/>.</summary>
    public DateTimeOffset? CreatedBefore { get; init; }

    /// <summary>The page size, 1 to 1,000. The default is 100.</summary>
    public int Limit { get; init; } = 100;

    /// <summary>The cursor of the previous page, or <c>null</c> for the first page.</summary>
    public TaskListCursor? Cursor { get; init; }

    /// <summary>The payload projection. The default omits every payload.</summary>
    public TaskPayloadProjection Payload { get; init; } = new();
}

/// <summary>How a task page projects each payload.</summary>
public sealed record TaskPayloadProjection
{
    /// <summary><c>true</c> to return each payload that fits in <see cref="MaxBytes"/>.</summary>
    public bool Include { get; init; }

    /// <summary>The largest payload that the page includes, 1 to 1,048,576 bytes. The default is 16,384.</summary>
    public int MaxBytes { get; init; } = 16_384;

    /// <summary>At most 50 unique top-level keys of 1 to 200 characters that the page removes from each payload.</summary>
    public IReadOnlyCollection<string> RedactKeys { get; init; } = [];
}

/// <summary>
/// Resumes a task page after its last task. The text properties hold PostgreSQL's text, and the
/// SDK passes them back unchanged.
/// </summary>
public sealed record TaskListCursor
{
    /// <summary>The creation time of the last task, as PostgreSQL's text.</summary>
    public required string CreatedAt { get; init; }

    /// <summary>The last task.</summary>
    public required Guid TaskId { get; init; }

    /// <summary>PostgreSQL's signature of the filter that made the page.</summary>
    public required string Signature { get; init; }
}

/// <summary>One page of tasks, newest first.</summary>
public sealed record TaskPage
{
    /// <summary>The tasks of the page.</summary>
    public required IReadOnlyList<TaskListItem> Items { get; init; }

    /// <summary>The cursor of the next page, or <c>null</c> on the last page.</summary>
    public TaskListCursor? NextCursor { get; init; }
}

/// <summary>Why a task is in the blocked state.</summary>
public enum TaskBlockedReason
{
    /// <summary>A prerequisite task is not finished.</summary>
    PrerequisitePending,
}

/// <summary>What a task page did with the payload of a task.</summary>
public enum TaskPayloadStatus
{
    /// <summary>The projection omits payloads.</summary>
    Omitted,

    /// <summary>The page includes the payload.</summary>
    Included,

    /// <summary>The payload is larger than the maximum of the projection, so the page omits it.</summary>
    TooLarge,
}

/// <summary>The prerequisite policy that the dependency edges of a task share.</summary>
public sealed record TaskDependencyPolicy
{
    /// <summary>The policy when a prerequisite task succeeds.</summary>
    public required DependencyPolicy OnSuccess { get; init; }

    /// <summary>The policy when a prerequisite task fails.</summary>
    public required DependencyPolicy OnFailure { get; init; }

    /// <summary>The policy when a prerequisite task is canceled.</summary>
    public required DependencyPolicy OnCancellation { get; init; }
}

/// <summary>One task of a <see cref="TaskPage"/>.</summary>
public sealed record TaskListItem
{
    /// <summary>The task.</summary>
    public required Guid Id { get; init; }

    /// <summary>The queue.</summary>
    public required string Queue { get; init; }

    /// <summary>The task type.</summary>
    public required string Type { get; init; }

    /// <summary>The concurrency key, or <c>null</c>.</summary>
    public string? ConcurrencyKey { get; init; }

    /// <summary>The priority.</summary>
    public required int Priority { get; init; }

    /// <summary>The tags.</summary>
    public required IReadOnlyList<string> Tags { get; init; }

    /// <summary>The state.</summary>
    public required TaskState State { get; init; }

    /// <summary>The prerequisite task when the task has exactly one, or <c>null</c>.</summary>
    public Guid? PrerequisiteTaskId { get; init; }

    /// <summary>Every prerequisite task.</summary>
    public required IReadOnlyList<Guid> PrerequisiteTaskIds { get; init; }

    /// <summary>The prerequisite policy, or <c>null</c> when the task has no prerequisite.</summary>
    public TaskDependencyPolicy? DependencyPolicy { get; init; }

    /// <summary>Why the task is blocked, or <c>null</c>.</summary>
    public TaskBlockedReason? BlockedReason { get; init; }

    /// <summary>The parent task, or <c>null</c>.</summary>
    public Guid? ParentTaskId { get; init; }

    /// <summary>The child tasks.</summary>
    public required IReadOnlyList<Guid> ChildTaskIds { get; init; }

    /// <summary>The current attempt.</summary>
    public required int CurrentAttempt { get; init; }

    /// <summary>The attempt limit.</summary>
    public required int MaxAttempts { get; init; }

    /// <summary>The persisted retry policy, or <c>null</c>.</summary>
    public JsonElement? RetryPolicy { get; init; }

    /// <summary>The absolute deadline, or <c>null</c>.</summary>
    public DateTimeOffset? DeadlineAt { get; init; }

    /// <summary>The timeout of each attempt, or <c>null</c>.</summary>
    public TimeSpan? ExecutionTimeout { get; init; }

    /// <summary>The earliest run time.</summary>
    public required DateTimeOffset RunAt { get; init; }

    /// <summary>When cancellation was requested, or <c>null</c>.</summary>
    public DateTimeOffset? CancelRequestedAt { get; init; }

    /// <summary>Who requested cancellation, or <c>null</c>.</summary>
    public string? CancelRequestedBy { get; init; }

    /// <summary>Why cancellation was requested, or <c>null</c>.</summary>
    public string? CancelReason { get; init; }

    /// <summary>The creation time.</summary>
    public required DateTimeOffset CreatedAt { get; init; }

    /// <summary>The time of the last change.</summary>
    public required DateTimeOffset UpdatedAt { get; init; }

    /// <summary>The payload, or <c>null</c> when the page omits it.</summary>
    public JsonElement? Payload { get; init; }

    /// <summary>What the page did with the payload.</summary>
    public required TaskPayloadStatus PayloadStatus { get; init; }

    /// <summary>The size of the payload when the projection includes payloads, or <c>null</c>.</summary>
    public long? PayloadBytes { get; init; }
}

/// <summary>
/// The snapshot of one task. The counterpart of Ruby's <c>TaskSnapshot</c>. The payload and the
/// result have their redacted keys removed.
/// </summary>
public sealed record TaskDetail
{
    /// <summary>The task.</summary>
    public required Guid Id { get; init; }

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

    /// <summary>The payload contract version that the task was stamped with, or <c>null</c>.</summary>
    public string? ContractVersion { get; init; }

    /// <summary>The tags.</summary>
    public required IReadOnlyList<string> Tags { get; init; }

    /// <summary>The state.</summary>
    public required TaskState State { get; init; }

    /// <summary>The prerequisite task when the task has exactly one, or <c>null</c>.</summary>
    public Guid? PrerequisiteTaskId { get; init; }

    /// <summary>Every prerequisite task.</summary>
    public required IReadOnlyList<Guid> PrerequisiteTaskIds { get; init; }

    /// <summary>The prerequisite policy, or <c>null</c> when the task has no prerequisite.</summary>
    public TaskDependencyPolicy? DependencyPolicy { get; init; }

    /// <summary>Why the task is blocked, or <c>null</c>.</summary>
    public TaskBlockedReason? BlockedReason { get; init; }

    /// <summary>The parent task, or <c>null</c>.</summary>
    public Guid? ParentTaskId { get; init; }

    /// <summary>The child tasks.</summary>
    public required IReadOnlyList<Guid> ChildTaskIds { get; init; }

    /// <summary>The current attempt.</summary>
    public required int CurrentAttempt { get; init; }

    /// <summary>The attempt limit.</summary>
    public required int MaxAttempts { get; init; }

    /// <summary>The persisted retry policy, or <c>null</c>.</summary>
    public JsonElement? RetryPolicy { get; init; }

    /// <summary>The absolute deadline, or <c>null</c>.</summary>
    public DateTimeOffset? DeadlineAt { get; init; }

    /// <summary>The timeout of each attempt, or <c>null</c>.</summary>
    public TimeSpan? ExecutionTimeout { get; init; }

    /// <summary>
    /// The fence token of the current attempt, or <c>null</c> for a fast-tier task that finished
    /// before a worker claimed it.
    /// </summary>
    public long? FenceToken { get; init; }

    /// <summary>The earliest run time.</summary>
    public required DateTimeOffset RunAt { get; init; }

    /// <summary>The result, or <c>null</c>.</summary>
    public JsonElement? Result { get; init; }

    /// <summary>The latest error, or <c>null</c>.</summary>
    public JsonElement? Error { get; init; }

    /// <summary>When cancellation was requested, or <c>null</c>.</summary>
    public DateTimeOffset? CancelRequestedAt { get; init; }

    /// <summary>Who requested cancellation, or <c>null</c>.</summary>
    public string? CancelRequestedBy { get; init; }

    /// <summary>Why cancellation was requested, or <c>null</c>.</summary>
    public string? CancelReason { get; init; }

    /// <summary>The latest progress, or <c>null</c>.</summary>
    public TaskProgress? Progress { get; init; }

    /// <summary>The creation time.</summary>
    public required DateTimeOffset CreatedAt { get; init; }

    /// <summary>The time of the last change.</summary>
    public required DateTimeOffset UpdatedAt { get; init; }
}

/// <summary>The page of <see cref="Admin.GetTaskTimelineAsync"/>.</summary>
public sealed record TimelineQuery
{
    /// <summary>The page size, 1 to 1,000. The default is 100.</summary>
    public int Limit { get; init; } = 100;

    /// <summary>The cursor of the previous page of the same task, or <c>null</c> for the first page.</summary>
    public TaskTimelineCursor? Cursor { get; init; }
}

/// <summary>The kind of a timeline entry.</summary>
public enum TaskTimelineKind
{
    /// <summary>A <see cref="TaskTimelineEvent"/>.</summary>
    Event,

    /// <summary>A <see cref="TaskTimelineAttempt"/>.</summary>
    Attempt,
}

/// <summary>Resumes a timeline page after its last entry.</summary>
public sealed record TaskTimelineCursor
{
    /// <summary>The task of the timeline.</summary>
    public required Guid TaskId { get; init; }

    /// <summary>The time of the last entry, as PostgreSQL's text.</summary>
    public required string OccurredAt { get; init; }

    /// <summary>The kind of the last entry.</summary>
    public required TaskTimelineKind Kind { get; init; }

    /// <summary>The record of the last entry.</summary>
    public required Guid RecordId { get; init; }
}

/// <summary>One page of the events and attempts of a task, newest first.</summary>
public sealed record TimelinePage
{
    /// <summary>The entries of the page.</summary>
    public required IReadOnlyList<TaskTimelineEntry> Items { get; init; }

    /// <summary>The cursor of the next page, or <c>null</c> on the last page.</summary>
    public TaskTimelineCursor? NextCursor { get; init; }
}

/// <summary>
/// One entry of a task timeline: a <see cref="TaskTimelineEvent"/> or a
/// <see cref="TaskTimelineAttempt"/>. The family is closed: only the SDK derives from this class. A
/// later minor can add a kind, so a <c>switch</c> over the entries must handle an unknown type.
/// </summary>
public abstract class TaskTimelineEntry
{
    private protected TaskTimelineEntry()
    {
    }

    /// <summary>The kind of the entry.</summary>
    public abstract TaskTimelineKind Kind { get; }

    /// <summary>The record of the entry.</summary>
    public required Guid RecordId { get; init; }

    /// <summary>The priority of the task when the entry occurred.</summary>
    public required int Priority { get; init; }

    /// <summary>The attempt of the entry, or <c>null</c> for an event outside an attempt.</summary>
    public int? Attempt { get; init; }

    /// <summary>When the entry occurred.</summary>
    public required DateTimeOffset OccurredAt { get; init; }
}

/// <summary>A task event of a timeline.</summary>
public sealed class TaskTimelineEvent : TaskTimelineEntry
{
    /// <inheritdoc />
    public override TaskTimelineKind Kind => TaskTimelineKind.Event;

    /// <summary>The event type.</summary>
    public required string EventType { get; init; }

    /// <summary>The event details, or <c>null</c>.</summary>
    public JsonElement? Details { get; init; }
}

/// <summary>A finished attempt of a timeline.</summary>
public sealed class TaskTimelineAttempt : TaskTimelineEntry
{
    /// <inheritdoc />
    public override TaskTimelineKind Kind => TaskTimelineKind.Attempt;

    /// <summary>The fence token of the attempt.</summary>
    public required long FenceToken { get; init; }

    /// <summary>The worker that ran the attempt.</summary>
    public required string WorkerId { get; init; }

    /// <summary>PostgreSQL's outcome of the attempt, such as <c>"succeeded"</c> or <c>"retry"</c>.</summary>
    public required string Outcome { get; init; }

    /// <summary>When the attempt started.</summary>
    public required DateTimeOffset StartedAt { get; init; }

    /// <summary>When the worker claimed the task.</summary>
    public required DateTimeOffset ClaimedAt { get; init; }

    /// <summary>When the attempt finished.</summary>
    public required DateTimeOffset FinishedAt { get; init; }

    /// <summary>The error of the attempt, or <c>null</c>.</summary>
    public JsonElement? Error { get; init; }
}
