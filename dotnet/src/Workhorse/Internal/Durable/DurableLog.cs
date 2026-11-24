using Microsoft.Extensions.Logging;
using Workhorse.Internal.Telemetry;

namespace Workhorse.Internal.Durable;

/// <summary>
/// The log events of the durable context. Each event name matches the event of the other SDKs, and
/// each record carries the values of the TypeScript record under its keys (<see cref="SdkLog"/>).
/// </summary>
internal static class DurableLog
{
    private static readonly SdkLog CheckpointSavedEvent = new("workhorse.task.checkpoint_saved", LogLevel.Debug);
    private static readonly SdkLog WaitProcessedEvent = new("workhorse.task.wait_processed", LogLevel.Information);
    private static readonly SdkLog ChildProcessedEvent = new("workhorse.task.child_processed", LogLevel.Information);
    private static readonly SdkLog ProgressUpdatedEvent = new("workhorse.task.progress_updated", LogLevel.Debug);
    private static readonly SdkLog SignalSwallowedEvent = new("workhorse.handler.signal_swallowed", LogLevel.Warning);

    internal static void CheckpointSaved(ILogger logger, Guid taskId, string taskType, int attempt, string workerId, string checkpointName, string status)
    {
        if (CheckpointSavedEvent.Enabled(logger))
        {
            CheckpointSavedEvent.Write(logger, "Task checkpoint persisted for task {workhorse.task.id} of type {workhorse.task.type}, attempt {workhorse.task.attempt}, on worker {workhorse.worker.id}: {workhorse.checkpoint.name} {workhorse.checkpoint.status}",
                taskId, taskType, attempt, workerId, checkpointName, status);
        }
    }

    internal static void WaitProcessed(ILogger logger, Guid taskId, string taskType, int attempt, string workerId, string waitName, string status)
    {
        if (WaitProcessedEvent.Enabled(logger))
        {
            WaitProcessedEvent.Write(logger, "Durable task wait processed for task {workhorse.task.id} of type {workhorse.task.type}, attempt {workhorse.task.attempt}, on worker {workhorse.worker.id}: {workhorse.wait.name} {workhorse.wait.status}",
                taskId, taskType, attempt, workerId, waitName, status);
        }
    }

    internal static void ChildProcessed(ILogger logger, Guid taskId, string workerId, string childName, string status)
    {
        if (ChildProcessedEvent.Enabled(logger))
        {
            ChildProcessedEvent.Write(logger, "Child task processed for task {workhorse.task.id} on worker {workhorse.worker.id}: {workhorse.child.name} {workhorse.child.status}",
                taskId, workerId, childName, status);
        }
    }

    /// <summary>
    /// The record of a child set. It has the event name of <see cref="ChildProcessed"/> and carries
    /// the count of the set, as TypeScript does.
    /// </summary>
    internal static void ChildSetProcessed(ILogger logger, Guid taskId, string workerId, int childCount, string status)
    {
        if (ChildProcessedEvent.Enabled(logger))
        {
            ChildProcessedEvent.Write(logger, "Child set processed for task {workhorse.task.id} on worker {workhorse.worker.id}: {workhorse.child.count} children {workhorse.child.status}",
                taskId, workerId, childCount, status);
        }
    }

    internal static void ProgressUpdated(ILogger logger, Guid taskId, string taskType, int attempt, string workerId, string status)
    {
        if (ProgressUpdatedEvent.Enabled(logger))
        {
            ProgressUpdatedEvent.Write(logger, "Task progress persisted for task {workhorse.task.id} of type {workhorse.task.type}, attempt {workhorse.task.attempt}, on worker {workhorse.worker.id}: {workhorse.progress.status}",
                taskId, taskType, attempt, workerId, status);
        }
    }

    internal static void SignalSwallowed(ILogger logger, Guid taskId, string taskType, int attempt, string queue, string workerId, string handlerOutcome)
    {
        if (SignalSwallowedEvent.Enabled(logger))
        {
            SignalSwallowedEvent.Write(logger, "Task handler swallowed its abort signal for task {workhorse.task.id} of type {workhorse.task.type}, attempt {workhorse.task.attempt}, from queue {workhorse.queue.name} on worker {workhorse.worker.id}; the attempt still suspends with outcome {workhorse.handler.outcome}",
                taskId, taskType, attempt, queue, workerId, handlerOutcome);
        }
    }
}
