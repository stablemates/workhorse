using Microsoft.Extensions.Logging;

namespace Workhorse.Internal.Runtime;

/// <summary>The log events of batch delivery and of the fast tier.</summary>
internal static partial class WorkerLog
{
    [LoggerMessage(EventName = "workhorse.handler.batch_dispatched", Level = LogLevel.Information,
        Message = "Task batch of {Size} {TaskType} tasks dispatched from queue {Queue} (full: {Full}, linger: {LingerMs} ms)")]
    internal static partial void BatchDispatched(ILogger logger, int size, string taskType, string queue, bool full, long lingerMs);

    [LoggerMessage(EventName = "workhorse.handler.batch_evidence_failed", Level = LogLevel.Warning,
        Message = "Batch execution evidence of {Size} {TaskType} tasks could not be persisted in phase {Phase}")]
    internal static partial void BatchEvidenceFailed(ILogger logger, int size, string taskType, string phase, Exception error);
}
