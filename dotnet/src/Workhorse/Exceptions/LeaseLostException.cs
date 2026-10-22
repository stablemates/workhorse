namespace Workhorse;

/// <summary>A durable call returned <c>stale</c>: another attempt owns the task now.</summary>
public sealed class LeaseLostException : WorkhorseException
{
    /// <summary>An exception for the task and the operation that lost the lease.</summary>
    public LeaseLostException(Guid taskId, string operation)
        : base($"{operation} lost the lease for task {taskId}")
    {
        TaskId = taskId;
        Operation = operation;
    }

    /// <summary>The task.</summary>
    public Guid TaskId { get; }

    /// <summary>The operation that found the lease lost.</summary>
    public string Operation { get; }
}
