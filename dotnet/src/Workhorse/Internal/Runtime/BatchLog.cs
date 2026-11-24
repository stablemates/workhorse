using Microsoft.Extensions.Logging;
using Workhorse.Internal.Telemetry;

namespace Workhorse.Internal.Runtime;

/// <summary>The log events of batch delivery and of the fast tier.</summary>
internal static partial class WorkerLog
{
    private static readonly SdkLog BatchDispatchedEvent = new("workhorse.handler.batch_dispatched", LogLevel.Information);
    private static readonly SdkLog BatchEvidenceFailedEvent = new("workhorse.handler.batch_evidence_failed", LogLevel.Warning);

    internal static void BatchDispatched(ILogger logger, int size, string taskType, string queue, string workerId, bool full, long lingerMs)
    {
        if (BatchDispatchedEvent.Enabled(logger))
        {
            BatchDispatchedEvent.Write(logger, "Task batch of {workhorse.handler.batch.size} {workhorse.task.type} tasks dispatched from queue {workhorse.queue.name} on worker {workhorse.worker.id} (full: {workhorse.handler.batch.full}, linger: {workhorse.handler.batch.linger_ms} ms)",
                size, taskType, queue, workerId, full, lingerMs);
        }
    }

    internal static void BatchEvidenceFailed(ILogger logger, int size, string taskType, string queue, string workerId, string phase, bool full, string errorType)
    {
        if (BatchEvidenceFailedEvent.Enabled(logger))
        {
            BatchEvidenceFailedEvent.Write(logger, "Batch execution evidence of {workhorse.handler.batch.size} {workhorse.task.type} tasks from queue {workhorse.queue.name} on worker {workhorse.worker.id} could not be persisted in phase {workhorse.handler.batch.evidence_phase} (full: {workhorse.handler.batch.full}): {error.type}",
                size, taskType, queue, workerId, phase, full, errorType);
        }
    }
}

/// <summary>
/// The registration record of a batch handler. It has the event name of
/// <see cref="WorkerLog.HandlerRegistered"/> and adds the batch bounds, so it is in a class of its own.
/// </summary>
internal static class BatchRegistrationLog
{
    private static readonly SdkLog RegisteredEvent = new("workhorse.handler.registered", LogLevel.Debug);

    internal static void Registered(ILogger logger, string taskType, int maxSize, long lingerMs, string workerId)
    {
        if (RegisteredEvent.Enabled(logger))
        {
            RegisteredEvent.Write(logger, "Batch task handler registered for task type {workhorse.task.type} with max size {workhorse.handler.batch.max_size} and linger {workhorse.handler.batch.linger_ms} ms on worker {workhorse.worker.id}",
                taskType, maxSize, lingerMs, workerId);
        }
    }
}
