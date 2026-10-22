namespace Workhorse;

/// <summary>A retained signal idempotency key received a different request.</summary>
public sealed class SignalIdempotencyConflictException : WorkhorseException
{
    /// <summary>An exception for the task and the signal.</summary>
    public SignalIdempotencyConflictException(Guid taskId, string name)
        : base($"signal {name} for task {taskId} received a different request for a retained idempotency key")
    {
        TaskId = taskId;
        Name = name;
    }

    /// <summary>The task.</summary>
    public Guid TaskId { get; }

    /// <summary>The signal name.</summary>
    public string Name { get; }
}

/// <summary>A retained human wait idempotency key received a different completion.</summary>
public sealed class HumanWaitIdempotencyConflictException : WorkhorseException
{
    /// <summary>An exception for the task and the wait.</summary>
    public HumanWaitIdempotencyConflictException(Guid taskId, string name)
        : base($"human wait {name} for task {taskId} received a different completion for a retained idempotency key")
    {
        TaskId = taskId;
        Name = name;
    }

    /// <summary>The task.</summary>
    public Guid TaskId { get; }

    /// <summary>The wait name.</summary>
    public string Name { get; }
}

/// <summary>PostgreSQL returned a status that this SDK does not know. An unknown status is never a success.</summary>
public sealed class UnexpectedStatusException : WorkhorseException
{
    /// <summary>An exception for the operation and the status.</summary>
    public UnexpectedStatusException(string operation, string? status)
        : base($"{operation} returned unexpected status {(status is null ? "null" : $"\"{status}\"")}")
    {
        Operation = operation;
        Status = status;
    }

    /// <summary>The operation.</summary>
    public string Operation { get; }

    /// <summary>The status, or <c>null</c>.</summary>
    public string? Status { get; }
}
