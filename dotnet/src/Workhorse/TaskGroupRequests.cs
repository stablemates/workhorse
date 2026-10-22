namespace Workhorse;

/// <summary>
/// The optional callbacks of a task group. A callback cannot use enqueue idempotency, debounce, or
/// throttle. When the group is sealed and every member task is finished, Workhorse enqueues
/// <see cref="OnFinish"/>, and <see cref="OnSuccess"/> or <see cref="OnFailure"/> as the result selects.
/// </summary>
public sealed record TaskGroupCallbacks
{
    /// <summary>The callback for every result, or <c>null</c>.</summary>
    public EnqueueRequest? OnFinish { get; init; }

    /// <summary>The callback for a successful group, or <c>null</c>.</summary>
    public EnqueueRequest? OnSuccess { get; init; }

    /// <summary>The callback for a failed group, or <c>null</c>.</summary>
    public EnqueueRequest? OnFailure { get; init; }
}

/// <summary>Collects the member tasks of the block form of <see cref="Queue.TaskGroupAsync"/>.</summary>
public sealed class TaskGroupBuilder
{
    private readonly List<EnqueueRequest> _requests = [];

    internal TaskGroupBuilder()
    {
    }

    internal IReadOnlyList<EnqueueRequest> Requests => _requests;

    /// <summary>Adds one member task with the default options.</summary>
    public TaskGroupBuilder Add(string taskType, object? payload) =>
        Add(new EnqueueRequest { TaskType = taskType, Payload = payload });

    /// <summary>Adds one member task.</summary>
    public TaskGroupBuilder Add(string taskType, object? payload, EnqueueOptions options) =>
        Add(new EnqueueRequest { TaskType = taskType, Payload = payload, Options = options });

    /// <summary>Adds one member task.</summary>
    public TaskGroupBuilder Add(EnqueueRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        _requests.Add(request);
        return this;
    }
}

/// <summary>What the block form of <see cref="Queue.TaskGroupAsync"/> returns.</summary>
public sealed record TaskGroupBlockResult
{
    /// <summary>The sealed group.</summary>
    public required TaskGroup Group { get; init; }

    /// <summary>One result for each added request, in order.</summary>
    public required IReadOnlyList<EnqueueResult> Tasks { get; init; }
}

/// <summary>How a task belongs to a task group.</summary>
public enum TaskGroupRole
{
    /// <summary>The task is a member task.</summary>
    Member,

    /// <summary>The task is a callback of the group.</summary>
    Callback,
}

/// <summary>The group of a task.</summary>
public sealed record TaskGroupLink
{
    /// <summary>Whether the task is a member task or a callback.</summary>
    public required TaskGroupRole Role { get; init; }

    /// <summary>The callback kind of a callback task, and <c>null</c> for a member task.</summary>
    public TaskGroupCallbackKind? Callback { get; init; }

    /// <summary>The group.</summary>
    public required TaskGroup Group { get; init; }
}
