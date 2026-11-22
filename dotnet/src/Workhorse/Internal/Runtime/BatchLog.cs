using Microsoft.Extensions.Logging;

namespace Workhorse.Internal.Runtime;

/// <summary>The log events of batch delivery and of the fast tier.</summary>
internal static partial class WorkerLog
{
    [LoggerMessage(EventName = "workhorse.handler.batch_dispatched", Level = LogLevel.Information,
        Message = "Task batch of {Size} {TaskType} tasks dispatched from queue {Queue} on worker {WorkerId} (full: {Full}, linger: {LingerMs} ms)")]
    internal static partial void BatchDispatched(ILogger logger, int size, string taskType, string queue, string workerId, bool full, long lingerMs);

    [LoggerMessage(EventName = "workhorse.handler.batch_evidence_failed", Level = LogLevel.Warning,
        Message = "Batch execution evidence of {Size} {TaskType} tasks from queue {Queue} on worker {WorkerId} could not be persisted in phase {Phase} (full: {Full}): {ErrorType}")]
    internal static partial void BatchEvidenceFailed(ILogger logger, int size, string taskType, string queue, string workerId, string phase, bool full, string errorType);
}

/// <summary>
/// The registration record of a batch handler. It has the event name of
/// <see cref="WorkerLog.HandlerRegistered"/> and adds the batch bounds, so it is in a class of its own.
/// </summary>
internal static partial class BatchRegistrationLog
{
    [LoggerMessage(EventName = "workhorse.handler.registered", Level = LogLevel.Debug,
        Message = "Batch task handler registered for task type {TaskType} with max size {MaxSize} and linger {LingerMs} ms on worker {WorkerId}")]
    internal static partial void Registered(ILogger logger, string taskType, int maxSize, long lingerMs, string workerId);
}
