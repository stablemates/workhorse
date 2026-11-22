using Microsoft.Extensions.Logging;

namespace Workhorse.Internal;

/// <summary>
/// The log events of <see cref="Queue"/> and <see cref="Admin"/>. Each event name matches the event
/// of the other SDKs. A record never holds a payload, a result, a reason, or an idempotency key.
/// </summary>
internal static partial class ClientLog
{
    [LoggerMessage(EventName = "workhorse.task.enqueued", Level = LogLevel.Debug,
        Message = "Task enqueued: task {TaskId} of type {TaskType} on queue {Queue}")]
    internal static partial void Enqueued(ILogger logger, Guid taskId, string taskType, string queue);

    [LoggerMessage(EventName = "workhorse.task.enqueue_replayed", Level = LogLevel.Debug,
        Message = "Idempotent enqueue replayed: task {TaskId} of type {TaskType} on queue {Queue}")]
    internal static partial void EnqueueReplayed(ILogger logger, Guid taskId, string taskType, string queue);

    [LoggerMessage(EventName = "workhorse.task.debounced", Level = LogLevel.Debug,
        Message = "Pending task replaced: task {TaskId} of type {TaskType} on queue {Queue}")]
    internal static partial void Debounced(ILogger logger, Guid taskId, string taskType, string queue);

    [LoggerMessage(EventName = "workhorse.task.debounce_rejected", Level = LogLevel.Debug,
        Message = "Debounced task not replaceable: task {TaskId} of type {TaskType} on queue {Queue}")]
    internal static partial void DebounceRejected(ILogger logger, Guid taskId, string taskType, string queue);

    [LoggerMessage(EventName = "workhorse.task.throttled", Level = LogLevel.Debug,
        Message = "Throttled enqueue coalesced: task {TaskId} of type {TaskType} on queue {Queue}")]
    internal static partial void Throttled(ILogger logger, Guid taskId, string taskType, string queue);

    [LoggerMessage(EventName = "workhorse.task.cancellation_processed", Level = LogLevel.Information,
        Message = "Task cancellation processed: task {TaskId} in state {State}, status {Status}")]
    internal static partial void CancellationProcessed(ILogger logger, Guid taskId, string state, string status);

    [LoggerMessage(EventName = "workhorse.task.signal_processed", Level = LogLevel.Information,
        Message = "Task signal processed: task {TaskId}, signal {SignalName}, status {Status}")]
    internal static partial void SignalProcessed(ILogger logger, Guid taskId, string signalName, string status);

    [LoggerMessage(EventName = "workhorse.task.human_wait_processed", Level = LogLevel.Information,
        Message = "Human wait completion processed: task {TaskId}, wait {WaitName}, status {Status}")]
    internal static partial void HumanWaitProcessed(ILogger logger, Guid taskId, string waitName, string status);

    [LoggerMessage(EventName = "workhorse.schedules.synchronized", Level = LogLevel.Information,
        Message = "Recurring schedules synchronized in namespace {Namespace}: {Count} schedules")]
    internal static partial void SchedulesSynchronized(ILogger logger, string @namespace, int count);

    [LoggerMessage(EventName = "workhorse.task.redrive_processed", Level = LogLevel.Information,
        Message = "Dead-letter task redrive processed: task {TaskId}, target {TargetTaskId}, status {Status}")]
    internal static partial void RedriveProcessed(ILogger logger, Guid taskId, string targetTaskId, string status);

    [LoggerMessage(EventName = "workhorse.tasks.redrive_processed", Level = LogLevel.Information,
        Message = "Dead-letter task redrive batch processed: {Count} tasks (dry run: {DryRun})")]
    internal static partial void RedriveBatchProcessed(ILogger logger, int count, bool dryRun);

    [LoggerMessage(EventName = "workhorse.queue.paused", Level = LogLevel.Information,
        Message = "Queue paused: {Queue}")]
    internal static partial void QueuePaused(ILogger logger, string queue);

    [LoggerMessage(EventName = "workhorse.queue.resumed", Level = LogLevel.Information,
        Message = "Queue resumed: {Queue}")]
    internal static partial void QueueResumed(ILogger logger, string queue);

    [LoggerMessage(EventName = "workhorse.queue.purged", Level = LogLevel.Information,
        Message = "Queue purged: {Queue}, {Count} tasks")]
    internal static partial void QueuePurged(ILogger logger, string queue, long count);

    [LoggerMessage(EventName = "workhorse.queue.tier_set", Level = LogLevel.Information,
        Message = "Queue tier set: {Queue} is {Tier}")]
    internal static partial void QueueTierSet(ILogger logger, string queue, string tier);

    [LoggerMessage(EventName = "workhorse.worker.paused", Level = LogLevel.Information,
        Message = "Worker paused: {WorkerId}")]
    internal static partial void WorkerPaused(ILogger logger, string workerId);

    [LoggerMessage(EventName = "workhorse.worker.resumed", Level = LogLevel.Information,
        Message = "Worker resumed: {WorkerId}")]
    internal static partial void WorkerResumed(ILogger logger, string workerId);
}
