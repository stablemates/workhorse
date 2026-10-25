using Microsoft.Extensions.Logging;

namespace Workhorse.Internal.Runtime;

/// <summary>The worker's log events. Each event name matches the event of the other SDKs.</summary>
internal static partial class WorkerLog
{
    [LoggerMessage(EventName = "workhorse.worker.started", Level = LogLevel.Information,
        Message = "Worker started with concurrency {Concurrency} on queues {Queues}")]
    internal static partial void Started(ILogger logger, int concurrency, string queues);

    [LoggerMessage(EventName = "workhorse.worker.stop_requested", Level = LogLevel.Information,
        Message = "Worker stop requested on queues {Queues}")]
    internal static partial void StopRequested(ILogger logger, string queues);

    [LoggerMessage(EventName = "workhorse.worker.stopped", Level = LogLevel.Information,
        Message = "Worker stopped on queues {Queues} with {ActiveSlots} handlers still running")]
    internal static partial void Stopped(ILogger logger, string queues, int activeSlots);

    [LoggerMessage(EventName = "workhorse.worker.paused", Level = LogLevel.Information,
        Message = "Worker paused {Where} on queues {Queues}")]
    internal static partial void Paused(ILogger logger, string where, string queues);

    [LoggerMessage(EventName = "workhorse.worker.resumed", Level = LogLevel.Information,
        Message = "Worker resumed {Where} on queues {Queues}")]
    internal static partial void Resumed(ILogger logger, string where, string queues);

    [LoggerMessage(EventName = "workhorse.worker.polling_only", Level = LogLevel.Warning,
        Message = "Worker {WorkerId} has no notification listener and dispatches by polling")]
    internal static partial void PollingOnly(ILogger logger, string workerId);

    [LoggerMessage(EventName = "workhorse.worker.claim_isolation", Level = LogLevel.Warning,
        Message = "Claims need read committed isolation, not {IsolationLevel}; configure the data source at read committed")]
    internal static partial void ClaimIsolation(ILogger logger, string isolationLevel);

    [LoggerMessage(EventName = "workhorse.worker.claims_abandoned", Level = LogLevel.Warning,
        Message = "{Claims} claims still in flight at the shutdown deadline were abandoned")]
    internal static partial void ClaimsAbandoned(ILogger logger, int claims);

    [LoggerMessage(EventName = "workhorse.worker.stop_step_abandoned", Level = LogLevel.Warning,
        Message = "The stop step {Step} did not finish before the shutdown deadline")]
    internal static partial void StopStepAbandoned(ILogger logger, string step);

    [LoggerMessage(EventName = "workhorse.worker.statement_slow", Level = LogLevel.Warning,
        Message = "Worker statement is still waiting after the stop budget: worker {WorkerId}, statement {Statement}, {ElapsedMs} ms")]
    internal static partial void StatementSlow(ILogger logger, string workerId, string statement, long elapsedMs);

    [LoggerMessage(EventName = "workhorse.worker.registration_failed", Level = LogLevel.Information,
        Message = "Worker registration failed")]
    internal static partial void RegistrationFailed(ILogger logger, Exception error);

    [LoggerMessage(EventName = "workhorse.worker.reporter_failed", Level = LogLevel.Error,
        Message = "Worker {WorkerId} reporter {Reporter} failed with {ErrorType} after {Unreported} unreported failures")]
    internal static partial void ReporterFailed(ILogger logger, string workerId, string reporter, string errorType, long unreported);

    [LoggerMessage(EventName = "workhorse.worker.notification_failed", Level = LogLevel.Warning,
        Message = "The notification listener failed; the worker polls until it listens again")]
    internal static partial void NotificationFailed(ILogger logger, Exception error);

    [LoggerMessage(EventName = "workhorse.handler.missing", Level = LogLevel.Warning,
        Message = "No handler registered for task type {TaskType}; task {TaskId} goes back to its queue")]
    internal static partial void HandlerMissing(ILogger logger, string taskType, Guid taskId);

    [LoggerMessage(EventName = "workhorse.task.completed", Level = LogLevel.Information,
        Message = "Task {TaskId} completed")]
    internal static partial void Completed(ILogger logger, Guid taskId);

    [LoggerMessage(EventName = "workhorse.task.completion_rejected", Level = LogLevel.Information,
        Message = "Stale completion of task {TaskId} rejected")]
    internal static partial void CompletionRejected(ILogger logger, Guid taskId);

    [LoggerMessage(EventName = "workhorse.task.release_processed", Level = LogLevel.Information,
        Message = "Owned task {TaskId} release processed with status {Status}")]
    internal static partial void ReleaseProcessed(ILogger logger, Guid taskId, string? status);

    [LoggerMessage(EventName = "workhorse.task.release_failed", Level = LogLevel.Warning,
        Message = "Unstarted task {TaskId} release failed")]
    internal static partial void ReleaseFailed(ILogger logger, Guid taskId, Exception error);

    [LoggerMessage(EventName = "workhorse.task.failure_processed", Level = LogLevel.Information,
        Message = "Task {TaskId} attempt failure processed with outcome {State} after {ErrorType}")]
    internal static partial void FailureProcessed(ILogger logger, Guid taskId, string? state, string errorType);

    [LoggerMessage(EventName = "workhorse.task.heartbeat_rejected", Level = LogLevel.Information,
        Message = "Task {TaskId} heartbeat rejected with status {Status}")]
    internal static partial void HeartbeatRejected(ILogger logger, Guid taskId, string status);

    [LoggerMessage(EventName = "workhorse.task.ownership_expired", Level = LogLevel.Information,
        Message = "Owned task {TaskId} expired with status {Status}")]
    internal static partial void OwnershipExpired(ILogger logger, Guid taskId, string? status);

    [LoggerMessage(EventName = "workhorse.task.cancellation_acknowledged", Level = LogLevel.Information,
        Message = "Task {TaskId} cancellation acknowledged: {Accepted}")]
    internal static partial void CancellationAcknowledged(ILogger logger, Guid taskId, bool accepted);

    [LoggerMessage(EventName = "workhorse.schedule.fired", Level = LogLevel.Information,
        Message = "Recurring schedule {Namespace}/{Schedule} fired task {TaskId}")]
    internal static partial void ScheduleFired(ILogger logger, string? @namespace, string? schedule, string taskId);
}
