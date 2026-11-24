using Microsoft.Extensions.Logging;
using Workhorse.Internal.Telemetry;

namespace Workhorse.Internal;

/// <summary>
/// The log events of <see cref="Queue"/> and <see cref="Admin"/>. Each event name matches the event
/// of the other SDKs, and each record carries the values of the TypeScript record under its keys
/// (<see cref="SdkLog"/>). A record never holds a payload, a result, a reason, or an idempotency key.
/// </summary>
internal static class ClientLog
{
    private static readonly SdkLog EnqueuedEvent = new("workhorse.task.enqueued", LogLevel.Debug);
    private static readonly SdkLog EnqueueReplayedEvent = new("workhorse.task.enqueue_replayed", LogLevel.Debug);
    private static readonly SdkLog DebouncedEvent = new("workhorse.task.debounced", LogLevel.Debug);
    private static readonly SdkLog DebounceRejectedEvent = new("workhorse.task.debounce_rejected", LogLevel.Debug);
    private static readonly SdkLog ThrottledEvent = new("workhorse.task.throttled", LogLevel.Debug);
    private static readonly SdkLog CancellationProcessedEvent = new("workhorse.task.cancellation_processed", LogLevel.Information);
    private static readonly SdkLog SignalProcessedEvent = new("workhorse.task.signal_processed", LogLevel.Information);
    private static readonly SdkLog HumanWaitProcessedEvent = new("workhorse.task.human_wait_processed", LogLevel.Information);
    private static readonly SdkLog SchedulesSynchronizedEvent = new("workhorse.schedules.synchronized", LogLevel.Information);
    private static readonly SdkLog RedriveProcessedEvent = new("workhorse.task.redrive_processed", LogLevel.Information);
    private static readonly SdkLog RedriveBatchProcessedEvent = new("workhorse.tasks.redrive_processed", LogLevel.Information);
    private static readonly SdkLog QueuePausedEvent = new("workhorse.queue.paused", LogLevel.Information);
    private static readonly SdkLog QueueResumedEvent = new("workhorse.queue.resumed", LogLevel.Information);
    private static readonly SdkLog QueuePurgedEvent = new("workhorse.queue.purged", LogLevel.Information);
    private static readonly SdkLog QueueTierSetEvent = new("workhorse.queue.tier_set", LogLevel.Information);
    private static readonly SdkLog WorkerPausedEvent = new("workhorse.worker.paused", LogLevel.Information);
    private static readonly SdkLog WorkerResumedEvent = new("workhorse.worker.resumed", LogLevel.Information);

    internal static void Enqueued(ILogger logger, Guid taskId, string taskType, string queue)
    {
        if (EnqueuedEvent.Enabled(logger))
        {
            EnqueuedEvent.Write(logger, "Task enqueued: task {workhorse.task.id} of type {workhorse.task.type} on queue {workhorse.queue.name}",
                taskId, taskType, queue);
        }
    }

    internal static void EnqueueReplayed(ILogger logger, Guid taskId, string taskType, string queue)
    {
        if (EnqueueReplayedEvent.Enabled(logger))
        {
            EnqueueReplayedEvent.Write(logger, "Idempotent enqueue replayed: task {workhorse.task.id} of type {workhorse.task.type} on queue {workhorse.queue.name}",
                taskId, taskType, queue);
        }
    }

    internal static void Debounced(ILogger logger, Guid taskId, string taskType, string queue)
    {
        if (DebouncedEvent.Enabled(logger))
        {
            DebouncedEvent.Write(logger, "Pending task replaced: task {workhorse.task.id} of type {workhorse.task.type} on queue {workhorse.queue.name}",
                taskId, taskType, queue);
        }
    }

    internal static void DebounceRejected(ILogger logger, Guid taskId, string taskType, string queue)
    {
        if (DebounceRejectedEvent.Enabled(logger))
        {
            DebounceRejectedEvent.Write(logger, "Debounced task not replaceable: task {workhorse.task.id} of type {workhorse.task.type} on queue {workhorse.queue.name}",
                taskId, taskType, queue);
        }
    }

    internal static void Throttled(ILogger logger, Guid taskId, string taskType, string queue)
    {
        if (ThrottledEvent.Enabled(logger))
        {
            ThrottledEvent.Write(logger, "Throttled enqueue coalesced: task {workhorse.task.id} of type {workhorse.task.type} on queue {workhorse.queue.name}",
                taskId, taskType, queue);
        }
    }

    internal static void CancellationProcessed(ILogger logger, Guid taskId, string state, string status)
    {
        if (CancellationProcessedEvent.Enabled(logger))
        {
            CancellationProcessedEvent.Write(logger, "Task cancellation processed: task {workhorse.task.id} in state {workhorse.task.state}, status {workhorse.operation.status}",
                taskId, state, status);
        }
    }

    internal static void SignalProcessed(ILogger logger, Guid taskId, string signalName, string status)
    {
        if (SignalProcessedEvent.Enabled(logger))
        {
            SignalProcessedEvent.Write(logger, "Task signal processed: task {workhorse.task.id}, signal {workhorse.signal.name}, status {workhorse.signal.status}",
                taskId, signalName, status);
        }
    }

    internal static void HumanWaitProcessed(ILogger logger, Guid taskId, string waitName, string status)
    {
        if (HumanWaitProcessedEvent.Enabled(logger))
        {
            HumanWaitProcessedEvent.Write(logger, "Human wait completion processed: task {workhorse.task.id}, wait {workhorse.human_wait.name}, status {workhorse.human_wait.status}",
                taskId, waitName, status);
        }
    }

    internal static void SchedulesSynchronized(ILogger logger, string @namespace, int count)
    {
        if (SchedulesSynchronizedEvent.Enabled(logger))
        {
            SchedulesSynchronizedEvent.Write(logger, "Recurring schedules synchronized in namespace {workhorse.schedule.namespace}: {workhorse.schedule.count} schedules",
                @namespace, count);
        }
    }

    internal static void RedriveProcessed(ILogger logger, Guid taskId, string targetTaskId, string status)
    {
        if (RedriveProcessedEvent.Enabled(logger))
        {
            RedriveProcessedEvent.Write(logger, "Dead-letter task redrive processed: task {workhorse.task.id}, target {workhorse.redrive.target_task_id}, status {workhorse.operation.status}",
                taskId, targetTaskId, status);
        }
    }

    internal static void RedriveBatchProcessed(ILogger logger, int count, bool dryRun)
    {
        if (RedriveBatchProcessedEvent.Enabled(logger))
        {
            RedriveBatchProcessedEvent.Write(logger, "Dead-letter task redrive batch processed: {workhorse.task.count} tasks (dry run: {workhorse.redrive.dry_run})",
                count, dryRun);
        }
    }

    internal static void QueuePaused(ILogger logger, string queue)
    {
        if (QueuePausedEvent.Enabled(logger))
        {
            QueuePausedEvent.Write(logger, "Queue paused: {workhorse.queue.name}",
                queue);
        }
    }

    internal static void QueueResumed(ILogger logger, string queue)
    {
        if (QueueResumedEvent.Enabled(logger))
        {
            QueueResumedEvent.Write(logger, "Queue resumed: {workhorse.queue.name}",
                queue);
        }
    }

    internal static void QueuePurged(ILogger logger, string queue, long count)
    {
        if (QueuePurgedEvent.Enabled(logger))
        {
            QueuePurgedEvent.Write(logger, "Queue purged: {workhorse.queue.name}, {workhorse.task.count} tasks",
                queue, count);
        }
    }

    internal static void QueueTierSet(ILogger logger, string queue, string tier)
    {
        if (QueueTierSetEvent.Enabled(logger))
        {
            QueueTierSetEvent.Write(logger, "Queue tier set: {workhorse.queue.name} is {workhorse.queue.tier}",
                queue, tier);
        }
    }

    internal static void WorkerPaused(ILogger logger, string workerId)
    {
        if (WorkerPausedEvent.Enabled(logger))
        {
            WorkerPausedEvent.Write(logger, "Worker paused: {workhorse.worker.id}",
                workerId);
        }
    }

    internal static void WorkerResumed(ILogger logger, string workerId)
    {
        if (WorkerResumedEvent.Enabled(logger))
        {
            WorkerResumedEvent.Write(logger, "Worker resumed: {workhorse.worker.id}",
                workerId);
        }
    }
}
