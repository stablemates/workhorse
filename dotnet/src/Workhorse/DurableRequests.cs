using System.Text.Json;

namespace Workhorse;

/// <summary>
/// The options of <see cref="HandlerContext.CheckpointAsync{T}(string, CheckpointOptions, Func{CancellationToken, Task{T}})"/>.
/// </summary>
public sealed record CheckpointOptions
{
    /// <summary>
    /// The checkpoint input, a JSON value whose fingerprint the checkpoint stores (ADR 0098). A
    /// <c>null</c> input is the JSON value <c>null</c>. Only a call without options has no input.
    /// </summary>
    public object? Input { get; init; }
}

/// <summary>
/// One child of <see cref="HandlerContext.RunChildrenAsync"/> or
/// <see cref="HandlerContext.RunChildrenAllAsync"/>. The counterpart of Ruby's <c>ChildTaskRequest</c>.
/// </summary>
public sealed record ChildRequest
{
    /// <summary>The child name, unique in the set, of 1 to 200 characters.</summary>
    public required string Name { get; init; }

    /// <summary>The task type of the child.</summary>
    public required string TaskType { get; init; }

    /// <summary>The payload, which the worker encodes as JSON. It can be <c>null</c>.</summary>
    public object? Payload { get; init; }

    /// <summary>
    /// The enqueue options, without idempotency, debounce, throttle, or dependencies. A child with no
    /// queue runs on the queue of its parent.
    /// </summary>
    public EnqueueOptions Options { get; init; } = new();
}

/// <summary>How one child of <see cref="HandlerContext.RunChildrenAsync"/> ended.</summary>
public enum ChildStatus
{
    /// <summary>The child completed.</summary>
    Succeeded,

    /// <summary>The child failed.</summary>
    Failed,

    /// <summary>The child was canceled.</summary>
    Canceled,
}

/// <summary>
/// How one child of <see cref="HandlerContext.RunChildrenAsync"/> ended. The counterpart of Ruby's
/// <c>ChildOutcome</c>.
/// </summary>
public sealed record ChildOutcome
{
    /// <summary>How the child ended.</summary>
    public required ChildStatus Status { get; init; }

    /// <summary>The result of a child that succeeded, or <c>null</c>.</summary>
    public JsonElement? Result { get; init; }

    /// <summary>The failure envelope of a child that failed, or <c>null</c>.</summary>
    public JsonElement? Error { get; init; }
}

/// <summary>
/// The task group operations of one handler activation (ADR 0095).
/// <see cref="HandlerContext.TaskGroup"/> returns it. The counterpart of Ruby's <c>TaskGroupContext</c>.
/// </summary>
/// <remarks>Only the SDK derives from this class, so it can gain members without a breaking change.</remarks>
public abstract class TaskGroupContext
{
    private protected TaskGroupContext()
    {
    }

    /// <summary>
    /// The group that this task is a member of, or whose callback this task is, with its counts, or
    /// <c>null</c> for a task with no group. The activation reads it one time and keeps it.
    /// </summary>
    public abstract Task<TaskGroupLink?> GetAsync();

    /// <summary>
    /// Adds at most 1,000 requests to the group of this member task, under the current fenced lease,
    /// and returns their results in request order. A request with no queue goes to the queue of this
    /// task. A running member task can add tasks after the seal, until its group is canceled.
    /// </summary>
    /// <exception cref="ArgumentException">This task is not a member task, or a request uses
    /// debounce or throttle.</exception>
    /// <exception cref="LeaseLostException">The attempt lost its lease.</exception>
    public abstract Task<IReadOnlyList<EnqueueResult>> AddAsync(IReadOnlyList<EnqueueRequest> requests);
}
