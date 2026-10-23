namespace Workhorse;

/// <summary>The settings of one enqueue request. Every property is optional.</summary>
public sealed record EnqueueOptions
{
    /// <summary>The queue, or <c>null</c> for the default queue of the <see cref="Queue"/>.</summary>
    public string? Queue { get; init; }

    /// <summary>The priority, 0 to 100, or <c>null</c> for 0.</summary>
    public int? Priority { get; init; }

    /// <summary>The concurrency key, or <c>null</c>.</summary>
    public string? ConcurrencyKey { get; init; }

    /// <summary>The named budget, or <c>null</c>.</summary>
    public string? Budget { get; init; }

    /// <summary>The earliest run time, or <c>null</c> for now.</summary>
    /// <remarks>
    /// C# converts a <see cref="DateTime"/> to a <see cref="DateTimeOffset"/> implicitly. If the
    /// <see cref="DateTime.Kind"/> is <see cref="DateTimeKind.Local"/> or
    /// <see cref="DateTimeKind.Unspecified"/>, the conversion uses the offset of the host. Pass a
    /// <see cref="DateTimeOffset"/>, or a <see cref="DateTime"/> of kind
    /// <see cref="DateTimeKind.Utc"/>.
    /// </remarks>
    public DateTimeOffset? RunAt { get; init; }

    /// <summary>The absolute deadline, or <c>null</c>.</summary>
    /// <remarks>
    /// C# converts a <see cref="DateTime"/> to a <see cref="DateTimeOffset"/> implicitly. If the
    /// <see cref="DateTime.Kind"/> is <see cref="DateTimeKind.Local"/> or
    /// <see cref="DateTimeKind.Unspecified"/>, the conversion uses the offset of the host. Pass a
    /// <see cref="DateTimeOffset"/>, or a <see cref="DateTime"/> of kind
    /// <see cref="DateTimeKind.Utc"/>.
    /// </remarks>
    public DateTimeOffset? Deadline { get; init; }

    /// <summary>The timeout of each attempt, or <c>null</c> or zero for none.</summary>
    public TimeSpan? ExecutionTimeout { get; init; }

    /// <summary>The attempt limit, 1 to 100, or <c>null</c> or 0 for 25.</summary>
    public int? MaxAttempts { get; init; }

    /// <summary>The persisted retry policy, or <c>null</c>.</summary>
    public RetryPolicy? RetryPolicy { get; init; }

    /// <summary>At most 20 tags of 1 to 100 characters.</summary>
    public IReadOnlyList<string> Tags { get; init; } = [];

    /// <summary>The enqueue idempotency, or <c>null</c>.</summary>
    public Idempotency? Idempotency { get; init; }

    /// <summary>The keyed debounce, or <c>null</c>.</summary>
    public Debounce? Debounce { get; init; }

    /// <summary>The keyed throttle, or <c>null</c>.</summary>
    public Throttle? Throttle { get; init; }

    /// <summary>The prerequisite tasks, or <c>null</c>.</summary>
    public Dependencies? Dependencies { get; init; }
}

/// <summary>One task to enqueue.</summary>
public sealed record EnqueueRequest
{
    /// <summary>The task type.</summary>
    public required string TaskType { get; init; }

    /// <summary>The payload, which the JSON options of the <see cref="Queue"/> serialize. It can be <c>null</c>.</summary>
    public object? Payload { get; init; }

    /// <summary>The settings of the request.</summary>
    public EnqueueOptions Options { get; init; } = new();
}

/// <summary>What PostgreSQL did with one enqueue request.</summary>
public enum EnqueueOutcome
{
    /// <summary>PostgreSQL created a task.</summary>
    Accepted,

    /// <summary>An idempotency key returned its retained task.</summary>
    Replayed,

    /// <summary>A debounce replaced the pending task.</summary>
    Replaced,

    /// <summary>A debounce could not replace the keyed task; the result names the reason.</summary>
    NonReplaceable,

    /// <summary>A throttle or a debounce joined the request to an equivalent task.</summary>
    Coalesced,
}

/// <summary>Why a debounced request was <see cref="EnqueueOutcome.NonReplaceable"/>.</summary>
public enum EnqueueNonReplaceableReason
{
    /// <summary>The key belongs to another coalescing mode.</summary>
    IncompatibleKeyMode,

    /// <summary>The keyed task is no longer pending.</summary>
    NotPending,

    /// <summary>The window elapsed while the keyed task was still pending.</summary>
    WindowElapsedPending,
}

/// <summary>What PostgreSQL did with one enqueue request.</summary>
public sealed record EnqueueResult
{
    /// <summary>The task that the request created or joined.</summary>
    public required Guid TaskId { get; init; }

    /// <summary>What PostgreSQL did.</summary>
    public required EnqueueOutcome Outcome { get; init; }

    /// <summary>The reason of a <see cref="EnqueueOutcome.NonReplaceable"/> outcome, and <c>null</c> otherwise.</summary>
    public EnqueueNonReplaceableReason? Reason { get; init; }
}

/// <summary>Retains one canonical request under a scoped key for <see cref="Ttl"/>.</summary>
public sealed record Idempotency
{
    /// <summary>The idempotency key, 1 to 512 UTF-8 bytes.</summary>
    public required string Key { get; init; }

    /// <summary>The scope of the key. The default is <c>default</c>.</summary>
    public string Scope { get; init; } = "default";

    /// <summary>How long PostgreSQL retains the request. The default is one day; zero takes the default.</summary>
    public TimeSpan Ttl { get; init; } = TimeSpan.FromDays(1);
}

/// <summary>How a debounce replacement moves the run time of the keyed task.</summary>
public enum DebounceSchedule
{
    /// <summary>The window starts again at each replacement.</summary>
    Reset,

    /// <summary>The first run time stays.</summary>
    Preserve,
}

/// <summary>Replaces a pending keyed task during a window that PostgreSQL owns.</summary>
public sealed record Debounce
{
    /// <summary>The debounce key, 1 to 512 UTF-8 bytes.</summary>
    public required string Key { get; init; }

    /// <summary>The window, 1 ms to 365 days.</summary>
    public required TimeSpan Window { get; init; }

    /// <summary>How a replacement moves the run time. The default is <see cref="DebounceSchedule.Reset"/>.</summary>
    public DebounceSchedule Schedule { get; init; } = DebounceSchedule.Reset;

    /// <summary>The scope of the key. The default is <c>default</c>.</summary>
    public string Scope { get; init; } = "default";
}

/// <summary>Accepts at most one equivalent keyed task during a window that PostgreSQL owns.</summary>
public sealed record Throttle
{
    /// <summary>The throttle key, 1 to 512 UTF-8 bytes.</summary>
    public required string Key { get; init; }

    /// <summary>The window, 1 ms to 365 days.</summary>
    public required TimeSpan Window { get; init; }

    /// <summary>The scope of the key. The default is <c>default</c>.</summary>
    public string Scope { get; init; } = "default";
}

/// <summary>Prerequisite tasks, and what a dependent task does when one of them ends.</summary>
public sealed record Dependencies
{
    /// <summary>1 to 100 unique prerequisite tasks.</summary>
    public required IReadOnlyList<Guid> PrerequisiteTaskIds { get; init; }

    /// <summary>The policy when a prerequisite task succeeds.</summary>
    public required DependencyPolicy OnSuccess { get; init; }

    /// <summary>The policy when a prerequisite task fails.</summary>
    public required DependencyPolicy OnFailure { get; init; }

    /// <summary>The policy when a prerequisite task is canceled.</summary>
    public required DependencyPolicy OnCancellation { get; init; }
}

/// <summary>The kind of a persisted retry policy.</summary>
public enum RetryPolicyKind
{
    /// <summary>The same delay before each retry.</summary>
    Fixed,

    /// <summary>A delay that grows by a multiplier up to a maximum.</summary>
    Exponential,

    /// <summary>A random delay between a base and three times the previous delay, up to a maximum.</summary>
    DecorrelatedJitter,
}

/// <summary>
/// A retry policy that PostgreSQL stores with the task. Create one with <see cref="Fixed"/>,
/// <see cref="Exponential"/>, or <see cref="DecorrelatedJitter"/>. PostgreSQL stores each delay in
/// whole milliseconds, from 0 to 365 days.
/// </summary>
public sealed record RetryPolicy
{
    private RetryPolicy()
    {
    }

    /// <summary>The kind.</summary>
    public RetryPolicyKind Kind { get; init; }

    /// <summary>The delay of a <see cref="RetryPolicyKind.Fixed"/> policy.</summary>
    public TimeSpan? Delay { get; init; }

    /// <summary>The first delay of an <see cref="RetryPolicyKind.Exponential"/> policy.</summary>
    public TimeSpan? InitialDelay { get; init; }

    /// <summary>The multiplier of an <see cref="RetryPolicyKind.Exponential"/> policy, 1 to 100.</summary>
    public int? Multiplier { get; init; }

    /// <summary>The base delay of a <see cref="RetryPolicyKind.DecorrelatedJitter"/> policy.</summary>
    public TimeSpan? BaseDelay { get; init; }

    /// <summary>The largest delay of an exponential or a decorrelated-jitter policy.</summary>
    public TimeSpan? MaxDelay { get; init; }

    /// <summary>The same delay before each retry.</summary>
    public static RetryPolicy Fixed(TimeSpan delay) => new() { Kind = RetryPolicyKind.Fixed, Delay = delay };

    /// <summary>A delay that starts at <paramref name="initialDelay"/> and grows by <paramref name="multiplier"/> up to <paramref name="maxDelay"/>.</summary>
    public static RetryPolicy Exponential(TimeSpan initialDelay, int multiplier, TimeSpan maxDelay) =>
        new() { Kind = RetryPolicyKind.Exponential, InitialDelay = initialDelay, Multiplier = multiplier, MaxDelay = maxDelay };

    /// <summary>A random delay from <paramref name="baseDelay"/> up to <paramref name="maxDelay"/>.</summary>
    public static RetryPolicy DecorrelatedJitter(TimeSpan baseDelay, TimeSpan maxDelay) =>
        new() { Kind = RetryPolicyKind.DecorrelatedJitter, BaseDelay = baseDelay, MaxDelay = maxDelay };
}
