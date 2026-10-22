using Microsoft.Extensions.Logging;

namespace Workhorse.Internal.Durable;

/// <summary>The log events of the durable context. Each event name matches the event of the other SDKs.</summary>
internal static partial class DurableLog
{
    [LoggerMessage(EventName = "workhorse.task.checkpoint_saved", Level = LogLevel.Debug,
        Message = "Task checkpoint persisted for task {TaskId}: {CheckpointName} {Status}")]
    internal static partial void CheckpointSaved(ILogger logger, Guid taskId, string checkpointName, string status);

    [LoggerMessage(EventName = "workhorse.task.wait_processed", Level = LogLevel.Information,
        Message = "Durable task wait processed for task {TaskId}: {WaitName} {Status}")]
    internal static partial void WaitProcessed(ILogger logger, Guid taskId, string waitName, string status);

    [LoggerMessage(EventName = "workhorse.task.child_processed", Level = LogLevel.Information,
        Message = "Child task processed for task {TaskId}: {ChildName} {Status}")]
    internal static partial void ChildProcessed(ILogger logger, Guid taskId, string childName, string status);

    [LoggerMessage(EventName = "workhorse.task.progress_updated", Level = LogLevel.Debug,
        Message = "Task progress persisted for task {TaskId}: {Status}")]
    internal static partial void ProgressUpdated(ILogger logger, Guid taskId, string status);

    [LoggerMessage(EventName = "workhorse.handler.signal_swallowed", Level = LogLevel.Warning,
        Message = "Task handler swallowed its abort signal for task {TaskId}; the attempt still suspends")]
    internal static partial void SignalSwallowed(ILogger logger, Guid taskId);
}
