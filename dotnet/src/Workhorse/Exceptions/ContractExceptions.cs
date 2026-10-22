namespace Workhorse;

/// <summary>A payload or a result does not satisfy the contract version of its task type.</summary>
public sealed class ContractValidationException : WorkhorseException
{
    /// <summary>An exception for a payload.</summary>
    public ContractValidationException(string taskType, string version)
        : this(taskType, version, "payload")
    {
    }

    /// <summary>An exception for the value that <paramref name="part"/> names.</summary>
    public ContractValidationException(string taskType, string version, string part)
        : base($"{taskType} {part} does not satisfy contract version {version}")
    {
        TaskType = taskType;
        Version = version;
        Part = part;
    }

    /// <summary>The task type.</summary>
    public string TaskType { get; }

    /// <summary>The contract version.</summary>
    public string Version { get; }

    /// <summary>The value, <c>payload</c> or <c>result</c>.</summary>
    public string Part { get; }
}

/// <summary>
/// A task value exceeds its byte limit, measured as the UTF-8 length of the <c>jsonb</c> text of
/// PostgreSQL.
/// </summary>
public sealed class ValueSizeLimitException : WorkhorseException
{
    /// <summary>An exception for the value, its size, and its limit.</summary>
    public ValueSizeLimitException(string taskType, string part, long actualBytes, long maxBytes)
        : base($"{taskType} {part} exceeds its configured size limit")
    {
        TaskType = taskType;
        Part = part;
        ActualBytes = actualBytes;
        MaxBytes = maxBytes;
    }

    /// <summary>The task type.</summary>
    public string TaskType { get; }

    /// <summary>The value, such as <c>result</c>.</summary>
    public string Part { get; }

    /// <summary>The size of the value, in bytes.</summary>
    public long ActualBytes { get; }

    /// <summary>The limit, in bytes.</summary>
    public long MaxBytes { get; }
}

/// <summary>A contract version that the request names is not installed.</summary>
public sealed class ContractUnavailableException : WorkhorseException
{
    /// <summary>An exception for the task type and the version.</summary>
    public ContractUnavailableException(string taskType, string version)
        : base($"{taskType} contract version {version} is unavailable")
    {
        TaskType = taskType;
        Version = version;
    }

    /// <summary>The task type.</summary>
    public string TaskType { get; }

    /// <summary>The contract version.</summary>
    public string Version { get; }
}

/// <summary>Contracts changed again while the client retried an enqueue with reloaded contracts.</summary>
public sealed class ContractPolicyChangedException : WorkhorseException
{
    /// <summary>The exception.</summary>
    public ContractPolicyChangedException()
        : base("contract policy changed again while retrying enqueue")
    {
    }
}
