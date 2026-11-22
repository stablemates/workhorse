using Microsoft.Extensions.Logging;

namespace Workhorse.Internal.Runtime;

/// <summary>
/// The worker's log events. Each event name matches the event of the other SDKs, and each template
/// carries the values of the TypeScript record. A task record carries <c>TaskId</c>,
/// <c>TaskType</c>, <c>Attempt</c>, <c>Queue</c>, and <c>WorkerId</c>. <c>Queues</c> is a list
/// value. No template carries an exception, because a record never holds an error message.
/// </summary>
internal static partial class WorkerLog
{
    [LoggerMessage(EventName = "workhorse.worker.started", Level = LogLevel.Information,
        Message = "Worker {WorkerId} started with concurrency {Concurrency} on queues {Queues}")]
    internal static partial void Started(ILogger logger, string workerId, int concurrency, IReadOnlyList<string> queues);

    [LoggerMessage(EventName = "workhorse.worker.stop_requested", Level = LogLevel.Information,
        Message = "Worker {WorkerId} stop requested on queues {Queues} with {ActiveSlots} handlers running")]
    internal static partial void StopRequested(ILogger logger, string workerId, IReadOnlyList<string> queues, int activeSlots);

    [LoggerMessage(EventName = "workhorse.worker.stopped", Level = LogLevel.Information,
        Message = "Worker {WorkerId} stopped on queues {Queues} with {ActiveSlots} handlers still running")]
    internal static partial void Stopped(ILogger logger, string workerId, IReadOnlyList<string> queues, int activeSlots);

    [LoggerMessage(EventName = "workhorse.worker.paused", Level = LogLevel.Information,
        Message = "Worker {WorkerId} paused {Where} on queues {Queues}")]
    internal static partial void Paused(ILogger logger, string workerId, string where, IReadOnlyList<string> queues);

    [LoggerMessage(EventName = "workhorse.worker.resumed", Level = LogLevel.Information,
        Message = "Worker {WorkerId} resumed {Where} on queues {Queues}")]
    internal static partial void Resumed(ILogger logger, string workerId, string where, IReadOnlyList<string> queues);

    [LoggerMessage(EventName = "workhorse.worker.polling_only", Level = LogLevel.Warning,
        Message = "Worker {WorkerId} on queues {Queues} has no notification listener and dispatches by polling (pool maximum size {PoolMaxSize})")]
    internal static partial void PollingOnly(ILogger logger, string workerId, IReadOnlyList<string> queues, object poolMaxSize);

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
        Message = "Worker {WorkerId} registration failed on queues {Queues} with {ErrorType}")]
    internal static partial void RegistrationFailed(ILogger logger, string workerId, IReadOnlyList<string> queues, string errorType);

    [LoggerMessage(EventName = "workhorse.worker.reporter_failed", Level = LogLevel.Error,
        Message = "Worker {WorkerId} reporter {Reporter} failed with {ErrorType} after {Unreported} unreported failures")]
    internal static partial void ReporterFailed(ILogger logger, string workerId, string reporter, string errorType, long unreported);

    [LoggerMessage(EventName = "workhorse.worker.notification_failed", Level = LogLevel.Warning,
        Message = "The notification listener failed with {ErrorType}; the worker polls until it listens again")]
    internal static partial void NotificationFailed(ILogger logger, string errorType);

    [LoggerMessage(EventName = "workhorse.handler.missing", Level = LogLevel.Warning,
        Message = "No handler registered for task type {TaskType}; task {TaskId}, attempt {Attempt}, goes back to queue {Queue} from worker {WorkerId}")]
    internal static partial void HandlerMissing(ILogger logger, string taskType, Guid taskId, int attempt, string queue, string workerId);

    [LoggerMessage(EventName = "workhorse.task.completed", Level = LogLevel.Information,
        Message = "Task {TaskId} of type {TaskType}, attempt {Attempt}, from queue {Queue} completed on worker {WorkerId}: {Accepted}")]
    internal static partial void Completed(ILogger logger, Guid taskId, string taskType, int attempt, string queue, string workerId, bool accepted);

    [LoggerMessage(EventName = "workhorse.task.completion_rejected", Level = LogLevel.Information,
        Message = "Stale completion of task {TaskId} of type {TaskType}, attempt {Attempt}, from queue {Queue} rejected on worker {WorkerId}: {Accepted}")]
    internal static partial void CompletionRejected(ILogger logger, Guid taskId, string taskType, int attempt, string queue, string workerId, bool accepted);

    [LoggerMessage(EventName = "workhorse.task.release_processed", Level = LogLevel.Information,
        Message = "Owned task {TaskId} of type {TaskType}, attempt {Attempt}, from queue {Queue} release processed on worker {WorkerId} with status {Status}")]
    internal static partial void ReleaseProcessed(ILogger logger, Guid taskId, string taskType, int attempt, string queue, string workerId, string? status);

    [LoggerMessage(EventName = "workhorse.task.release_failed", Level = LogLevel.Warning,
        Message = "Unstarted task {TaskId} release failed with {ErrorType}")]
    internal static partial void ReleaseFailed(ILogger logger, Guid taskId, string errorType);

    [LoggerMessage(EventName = "workhorse.task.failure_processed", Level = LogLevel.Information,
        Message = "Task {TaskId} of type {TaskType}, attempt {Attempt}, from queue {Queue} failure processed on worker {WorkerId} with outcome {State}")]
    internal static partial void FailureProcessed(ILogger logger, Guid taskId, string taskType, int attempt, string queue, string workerId, string? state);

    [LoggerMessage(EventName = "workhorse.task.heartbeat_rejected", Level = LogLevel.Information,
        Message = "Task heartbeat rejected: task {TaskId} of type {TaskType}, attempt {Attempt}, on worker {WorkerId} with status {Status}")]
    internal static partial void HeartbeatRejected(ILogger logger, Guid taskId, string taskType, int attempt, string workerId, string status);

    [LoggerMessage(EventName = "workhorse.task.ownership_expired", Level = LogLevel.Information,
        Message = "Owned task {TaskId} of type {TaskType}, attempt {Attempt}, from queue {Queue} expired on worker {WorkerId} with status {Status}")]
    internal static partial void OwnershipExpired(ILogger logger, Guid taskId, string taskType, int attempt, string queue, string workerId, string? status);

    [LoggerMessage(EventName = "workhorse.worker.expiration_request_failed", Level = LogLevel.Warning,
        Message = "Ownership expiration request failed for task {TaskId} of type {TaskType}, attempt {Attempt}, from queue {Queue} on worker {WorkerId} with {ErrorType}; the worker asks again")]
    internal static partial void ExpirationRequestFailed(ILogger logger, Guid taskId, string taskType, int attempt, string queue, string workerId, string errorType);

    [LoggerMessage(EventName = "workhorse.task.cancellation_acknowledged", Level = LogLevel.Information,
        Message = "Task {TaskId} of type {TaskType}, attempt {Attempt}, from queue {Queue} cancellation acknowledged on worker {WorkerId}: {Accepted}")]
    internal static partial void CancellationAcknowledged(ILogger logger, Guid taskId, string taskType, int attempt, string queue, string workerId, bool accepted);

    [LoggerMessage(EventName = "workhorse.schedule.fired", Level = LogLevel.Information,
        Message = "Recurring schedule {Namespace}/{Schedule} fired task {TaskId}")]
    internal static partial void ScheduleFired(ILogger logger, string? @namespace, string? schedule, string taskId);

    [LoggerMessage(EventName = "workhorse.handler.registered", Level = LogLevel.Debug,
        Message = "Task handler registered for task type {TaskType} on worker {WorkerId}")]
    internal static partial void HandlerRegistered(ILogger logger, string taskType, string workerId);

    [LoggerMessage(EventName = "workhorse.task.claimed", Level = LogLevel.Debug,
        Message = "Task claimed: task {TaskId} of type {TaskType}, attempt {Attempt}, from queue {Queue} by worker {WorkerId}")]
    internal static partial void Claimed(ILogger logger, Guid taskId, string taskType, int attempt, string queue, string workerId);

    [LoggerMessage(EventName = "workhorse.handler.started", Level = LogLevel.Debug,
        Message = "Task handler started: task {TaskId} of type {TaskType}, attempt {Attempt}, from queue {Queue} on worker {WorkerId}")]
    internal static partial void HandlerStarted(ILogger logger, Guid taskId, string taskType, int attempt, string queue, string workerId);

    [LoggerMessage(EventName = "workhorse.handler.finished", Level = LogLevel.Debug,
        Message = "Task handler finished: task {TaskId} of type {TaskType}, attempt {Attempt}, from queue {Queue} on worker {WorkerId} after {DurationMs} ms")]
    internal static partial void HandlerFinished(ILogger logger, Guid taskId, string taskType, int attempt, string queue, string workerId, double durationMs);

    [LoggerMessage(EventName = "workhorse.task.execution_finished", Level = LogLevel.Information,
        Message = "Task execution finished: task {TaskId} of type {TaskType}, attempt {Attempt}, from queue {Queue} on worker {WorkerId} with outcome {Outcome}")]
    internal static partial void ExecutionFinished(ILogger logger, Guid taskId, string taskType, int attempt, string queue, string workerId, string outcome);

    [LoggerMessage(EventName = "workhorse.task.heartbeat_accepted", Level = LogLevel.Debug,
        Message = "Task heartbeat accepted: task {TaskId} of type {TaskType}, attempt {Attempt}, on worker {WorkerId}")]
    internal static partial void HeartbeatAccepted(ILogger logger, Guid taskId, string taskType, int attempt, string workerId);

    [LoggerMessage(EventName = "workhorse.worker.shutdown_settlement_failed", Level = LogLevel.Warning,
        Message = "Worker {WorkerId} could not settle task {TaskId} of type {TaskType}, attempt {Attempt}, from queue {Queue} after the shutdown abort: {ErrorType}")]
    internal static partial void ShutdownSettlementFailed(ILogger logger, Guid taskId, string taskType, int attempt, string queue, string workerId, string errorType);

    [LoggerMessage(EventName = "workhorse.worker.registered", Level = LogLevel.Debug,
        Message = "Worker registration changed: worker {WorkerId} on queues {Queues} with concurrency {Concurrency}, {ActiveSlots} active slots, draining {Draining}, paused {Paused}")]
    internal static partial void Registered(ILogger logger, IReadOnlyList<string> queues, string workerId, int concurrency, int activeSlots, bool draining, bool paused);

    [LoggerMessage(EventName = "workhorse.worker.deregistered", Level = LogLevel.Debug,
        Message = "Worker {WorkerId} deregistered: {Deregistered}")]
    internal static partial void Deregistered(ILogger logger, string workerId, bool deregistered);

    [LoggerMessage(EventName = "workhorse.leases.recovered", Level = LogLevel.Information,
        Message = "Expired leases recovered: {RowsAffected} rows, {ExpiredLeases} expired leases, {Retried} retried")]
    internal static partial void LeasesRecovered(ILogger logger, long rowsAffected, long expiredLeases, long retried);

    [LoggerMessage(EventName = "workhorse.maintenance.completed", Level = LogLevel.Information,
        Message = "Maintenance phase completed: {Operation} {Phase} changed {RowsAffected} rows (skipped lock: {SkippedLock})")]
    internal static partial void MaintenanceCompleted(ILogger logger, string operation, string phase, long rowsAffected, bool skippedLock);

    [LoggerMessage(EventName = "workhorse.schedule.fire_replayed", Level = LogLevel.Debug,
        Message = "Recurring schedule occurrence replayed: {Namespace}/{Schedule}")]
    internal static partial void ScheduleFireReplayed(ILogger logger, string? @namespace, string? schedule);
}
