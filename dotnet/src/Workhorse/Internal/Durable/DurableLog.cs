using Microsoft.Extensions.Logging;

namespace Workhorse.Internal.Durable;

/// <summary>The log events of the durable context. Each event name matches the event of the other SDKs.</summary>
internal static partial class DurableLog
{
    [LoggerMessage(EventName = "workhorse.task.checkpoint_saved", Level = LogLevel.Debug,
        Message = "Task checkpoint persisted for task {TaskId} of type {TaskType}, attempt {Attempt}, on worker {WorkerId}: {CheckpointName} {Status}")]
    internal static partial void CheckpointSaved(ILogger logger, Guid taskId, string taskType, int attempt, string workerId, string checkpointName, string status);

    [LoggerMessage(EventName = "workhorse.task.wait_processed", Level = LogLevel.Information,
        Message = "Durable task wait processed for task {TaskId} of type {TaskType}, attempt {Attempt}, on worker {WorkerId}: {WaitName} {Status}")]
    internal static partial void WaitProcessed(ILogger logger, Guid taskId, string taskType, int attempt, string workerId, string waitName, string status);

    [LoggerMessage(EventName = "workhorse.task.child_processed", Level = LogLevel.Information,
        Message = "Child task processed for task {TaskId} on worker {WorkerId}: {ChildName} {Status}")]
    internal static partial void ChildProcessed(ILogger logger, Guid taskId, string workerId, string childName, string status);

    [LoggerMessage(EventName = "workhorse.task.progress_updated", Level = LogLevel.Debug,
        Message = "Task progress persisted for task {TaskId} of type {TaskType}, attempt {Attempt}, on worker {WorkerId}: {Status}")]
    internal static partial void ProgressUpdated(ILogger logger, Guid taskId, string taskType, int attempt, string workerId, string status);

    [LoggerMessage(EventName = "workhorse.handler.signal_swallowed", Level = LogLevel.Warning,
        Message = "Task handler swallowed its abort signal for task {TaskId} of type {TaskType}, attempt {Attempt}, from queue {Queue} on worker {WorkerId}; the attempt still suspends with outcome {HandlerOutcome}")]
    internal static partial void SignalSwallowed(ILogger logger, Guid taskId, string taskType, int attempt, string queue, string workerId, string handlerOutcome);
}

/// <summary>
/// The record of a child set. It has the event name of <see cref="DurableLog.ChildProcessed"/> and
/// carries the count of the set, as TypeScript does, so it is in a class of its own.
/// </summary>
internal static partial class ChildSetLog
{
    [LoggerMessage(EventName = "workhorse.task.child_processed", Level = LogLevel.Information,
        Message = "Child set processed for task {TaskId} on worker {WorkerId}: {ChildCount} children {Status}")]
    internal static partial void Processed(ILogger logger, Guid taskId, string workerId, int childCount, string status);
}
