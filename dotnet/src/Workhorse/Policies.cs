namespace Workhorse;

/// <summary>
/// A token bucket: <see cref="Limit"/> admissions for each <see cref="Interval"/>, with at most
/// <see cref="Burst"/> in reserve. PostgreSQL stores the interval in whole milliseconds.
/// </summary>
public sealed record RateLimit
{
    /// <summary>Admissions for each interval, 1 to 1,000,000.</summary>
    public required int Limit { get; init; }

    /// <summary>The interval, 1 ms to 1 day.</summary>
    public required TimeSpan Interval { get; init; }

    /// <summary>The reserve, 1 to 1,000,000.</summary>
    public required int Burst { get; init; }
}

/// <summary>The concurrency limit that a sync gives one queue.</summary>
public sealed record ConcurrencyPolicyDefinition
{
    /// <summary>The queue.</summary>
    public required string Queue { get; init; }

    /// <summary>The active task limit, 1 to 1,000,000.</summary>
    public required int MaxActive { get; init; }

    /// <summary>The active task limit for each concurrency key, or <c>null</c>.</summary>
    public int? MaxActivePerKey { get; init; }
}

/// <summary>A stored concurrency policy for one queue.</summary>
public sealed record ConcurrencyPolicy
{
    /// <summary>The namespace that synced the policy.</summary>
    public required string Namespace { get; init; }

    /// <summary>The queue.</summary>
    public required string Queue { get; init; }

    /// <summary>The active task limit.</summary>
    public required int MaxActive { get; init; }

    /// <summary>The active task limit for each concurrency key, or <c>null</c>.</summary>
    public int? MaxActivePerKey { get; init; }

    /// <summary>When the policy last changed.</summary>
    public required DateTimeOffset UpdatedAt { get; init; }
}

/// <summary>The rate limit that a sync gives one queue.</summary>
public sealed record RateLimitPolicyDefinition
{
    /// <summary>The queue.</summary>
    public required string Queue { get; init; }

    /// <summary>The rate limit of the queue.</summary>
    public required RateLimit Rate { get; init; }

    /// <summary>The rate limit for each concurrency key, or <c>null</c>.</summary>
    public RateLimit? PerKey { get; init; }
}

/// <summary>A stored rate limit policy for one queue.</summary>
public sealed record RateLimitPolicy
{
    /// <summary>The namespace that synced the policy.</summary>
    public required string Namespace { get; init; }

    /// <summary>The queue.</summary>
    public required string Queue { get; init; }

    /// <summary>The rate limit of the queue.</summary>
    public required RateLimit Rate { get; init; }

    /// <summary>The rate limit for each concurrency key, or <c>null</c>.</summary>
    public RateLimit? PerKey { get; init; }

    /// <summary>When the policy last changed.</summary>
    public required DateTimeOffset UpdatedAt { get; init; }
}

/// <summary>One named budget that tasks in any queue can name. Set <see cref="MaxActive"/>, <see cref="Rate"/>, or both.</summary>
public sealed record BudgetDefinition
{
    /// <summary>The budget name.</summary>
    public required string Name { get; init; }

    /// <summary>The active task limit, or <c>null</c>.</summary>
    public int? MaxActive { get; init; }

    /// <summary>The rate limit, or <c>null</c>.</summary>
    public RateLimit? Rate { get; init; }
}

/// <summary>A stored budget.</summary>
public sealed record Budget
{
    /// <summary>The namespace that synced the budget.</summary>
    public required string Namespace { get; init; }

    /// <summary>The budget name.</summary>
    public required string Name { get; init; }

    /// <summary>The active task limit, or <c>null</c>.</summary>
    public int? MaxActive { get; init; }

    /// <summary>The rate limit, or <c>null</c>.</summary>
    public RateLimit? Rate { get; init; }

    /// <summary>When the budget last changed.</summary>
    public required DateTimeOffset UpdatedAt { get; init; }
}
