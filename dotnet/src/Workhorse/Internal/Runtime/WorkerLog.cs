using System.Globalization;
using Microsoft.Extensions.Logging;
using Workhorse.Internal.Telemetry;

namespace Workhorse.Internal.Runtime;

/// <summary>
/// The worker's log events. Each event name matches the event of the other SDKs, and each record
/// carries the values of the TypeScript record under its keys (<see cref="SdkLog"/>). A task record
/// carries <c>workhorse.task.id</c>, <c>workhorse.task.type</c>, <c>workhorse.task.attempt</c>,
/// <c>workhorse.queue.name</c>, and <c>workhorse.worker.id</c>. <c>workhorse.worker.queues</c> is
/// a list value. No record carries an exception, because a record never holds an error message.
/// </summary>
internal static partial class WorkerLog
{
    private static readonly SdkLog StartedEvent = new("workhorse.worker.started", LogLevel.Information);
    private static readonly SdkLog StopRequestedEvent = new("workhorse.worker.stop_requested", LogLevel.Information);
    private static readonly SdkLog StoppedEvent = new("workhorse.worker.stopped", LogLevel.Information);
    private static readonly SdkLog PausedEvent = new("workhorse.worker.paused", LogLevel.Information);
    private static readonly SdkLog ResumedEvent = new("workhorse.worker.resumed", LogLevel.Information);
    private static readonly SdkLog PollingOnlyEvent = new("workhorse.worker.polling_only", LogLevel.Warning);
    private static readonly SdkLog ClaimIsolationEvent = new("workhorse.worker.claim_isolation", LogLevel.Warning);
    private static readonly SdkLog ClaimsAbandonedEvent = new("workhorse.worker.claims_abandoned", LogLevel.Warning);
    private static readonly SdkLog StopStepAbandonedEvent = new("workhorse.worker.stop_step_abandoned", LogLevel.Warning);
    private static readonly SdkLog StatementSlowEvent = new("workhorse.worker.statement_slow", LogLevel.Warning);
    private static readonly SdkLog RegistrationFailedEvent = new("workhorse.worker.registration_failed", LogLevel.Information);
    private static readonly SdkLog ReporterFailedEvent = new("workhorse.worker.reporter_failed", LogLevel.Error);
    private static readonly SdkLog NotificationFailedEvent = new("workhorse.worker.notification_failed", LogLevel.Warning);
    private static readonly SdkLog HandlerMissingEvent = new("workhorse.handler.missing", LogLevel.Warning);
    private static readonly SdkLog CompletedEvent = new("workhorse.task.completed", LogLevel.Information);
    private static readonly SdkLog CompletionRejectedEvent = new("workhorse.task.completion_rejected", LogLevel.Information);
    private static readonly SdkLog ReleaseProcessedEvent = new("workhorse.task.release_processed", LogLevel.Information);
    private static readonly SdkLog ReleaseFailedEvent = new("workhorse.task.release_failed", LogLevel.Warning);
    private static readonly SdkLog FailureProcessedEvent = new("workhorse.task.failure_processed", LogLevel.Information);
    private static readonly SdkLog HeartbeatRejectedEvent = new("workhorse.task.heartbeat_rejected", LogLevel.Information);
    private static readonly SdkLog OwnershipExpiredEvent = new("workhorse.task.ownership_expired", LogLevel.Information);
    private static readonly SdkLog ExpirationRequestFailedEvent = new("workhorse.worker.expiration_request_failed", LogLevel.Warning);
    private static readonly SdkLog CancellationAcknowledgedEvent = new("workhorse.task.cancellation_acknowledged", LogLevel.Information);
    private static readonly SdkLog ScheduleFiredEvent = new("workhorse.schedule.fired", LogLevel.Information);
    private static readonly SdkLog HandlerRegisteredEvent = new("workhorse.handler.registered", LogLevel.Debug);
    private static readonly SdkLog ClaimedEvent = new("workhorse.task.claimed", LogLevel.Debug);
    private static readonly SdkLog HandlerStartedEvent = new("workhorse.handler.started", LogLevel.Debug);
    private static readonly SdkLog HandlerFinishedEvent = new("workhorse.handler.finished", LogLevel.Debug);
    private static readonly SdkLog ExecutionFinishedEvent = new("workhorse.task.execution_finished", LogLevel.Information);
    private static readonly SdkLog HeartbeatAcceptedEvent = new("workhorse.task.heartbeat_accepted", LogLevel.Debug);
    private static readonly SdkLog ShutdownSettlementFailedEvent = new("workhorse.worker.shutdown_settlement_failed", LogLevel.Warning);
    private static readonly SdkLog RegisteredEvent = new("workhorse.worker.registered", LogLevel.Debug);
    private static readonly SdkLog DeregisteredEvent = new("workhorse.worker.deregistered", LogLevel.Debug);
    private static readonly SdkLog LeasesRecoveredEvent = new("workhorse.leases.recovered", LogLevel.Information);
    private static readonly SdkLog MaintenanceCompletedEvent = new("workhorse.maintenance.completed", LogLevel.Information);
    private static readonly SdkLog ScheduleFireReplayedEvent = new("workhorse.schedule.fire_replayed", LogLevel.Debug);

    internal static void Started(ILogger logger, string workerId, int concurrency, IReadOnlyList<string> queues)
    {
        if (StartedEvent.Enabled(logger))
        {
            StartedEvent.Write(logger, "Worker {workhorse.worker.id} started with concurrency {workhorse.worker.concurrency} on queues {workhorse.worker.queues}",
                workerId, concurrency, queues);
        }
    }

    internal static void StopRequested(ILogger logger, string workerId, IReadOnlyList<string> queues, int activeSlots)
    {
        if (StopRequestedEvent.Enabled(logger))
        {
            StopRequestedEvent.Write(logger, "Worker {workhorse.worker.id} stop requested on queues {workhorse.worker.queues} with {workhorse.worker.active_slots} handlers running",
                workerId, queues, activeSlots);
        }
    }

    internal static void Stopped(ILogger logger, string workerId, IReadOnlyList<string> queues, int activeSlots)
    {
        if (StoppedEvent.Enabled(logger))
        {
            StoppedEvent.Write(logger, "Worker {workhorse.worker.id} stopped on queues {workhorse.worker.queues} with {workhorse.worker.active_slots} handlers still running",
                workerId, queues, activeSlots);
        }
    }

    /// <summary>A pause of the worker. <paramref name="where"/> is a word of the template, as of the TypeScript body.</summary>
    internal static void Paused(ILogger logger, string workerId, string where, IReadOnlyList<string> queues)
    {
        if (PausedEvent.Enabled(logger))
        {
            PausedEvent.Write(logger, $"Worker {{workhorse.worker.id}} paused {where} on queues {{workhorse.worker.queues}}",
                workerId, queues);
        }
    }

    /// <summary>A resume of the worker. <paramref name="where"/> is a word of the template, as of the TypeScript body.</summary>
    internal static void Resumed(ILogger logger, string workerId, string where, IReadOnlyList<string> queues)
    {
        if (ResumedEvent.Enabled(logger))
        {
            ResumedEvent.Write(logger, $"Worker {{workhorse.worker.id}} resumed {where} on queues {{workhorse.worker.queues}}",
                workerId, queues);
        }
    }

    internal static void PollingOnly(ILogger logger, string workerId, IReadOnlyList<string> queues, object poolMaxSize)
    {
        if (PollingOnlyEvent.Enabled(logger))
        {
            PollingOnlyEvent.Write(logger, "Worker {workhorse.worker.id} on queues {workhorse.worker.queues} has no notification listener and dispatches by polling (pool maximum size {workhorse.worker.pool_max_size})",
                workerId, queues, poolMaxSize);
        }
    }

    internal static void ClaimIsolation(ILogger logger, string isolationLevel)
    {
        if (ClaimIsolationEvent.Enabled(logger))
        {
            ClaimIsolationEvent.Write(logger, "Claims need read committed isolation, not {workhorse.isolation_level}; configure the data source at read committed",
                isolationLevel);
        }
    }

    internal static void ClaimsAbandoned(ILogger logger, int claims)
    {
        if (ClaimsAbandonedEvent.Enabled(logger))
        {
            ClaimsAbandonedEvent.Write(logger, "{workhorse.worker.claims} claims still in flight at the shutdown deadline were abandoned",
                claims);
        }
    }

    internal static void StopStepAbandoned(ILogger logger, string step)
    {
        if (StopStepAbandonedEvent.Enabled(logger))
        {
            StopStepAbandonedEvent.Write(logger, "The stop step {workhorse.worker.stop_step} did not finish before the shutdown deadline",
                step);
        }
    }

    internal static void StatementSlow(ILogger logger, string workerId, string statement, long elapsedMs)
    {
        if (StatementSlowEvent.Enabled(logger))
        {
            StatementSlowEvent.Write(logger, "Worker statement is still waiting after the stop budget: worker {workhorse.worker.id}, statement {workhorse.worker.statement}, {workhorse.worker.elapsed_ms} ms",
                workerId, statement, elapsedMs);
        }
    }

    internal static void RegistrationFailed(ILogger logger, string workerId, IReadOnlyList<string> queues, string errorType)
    {
        if (RegistrationFailedEvent.Enabled(logger))
        {
            RegistrationFailedEvent.Write(logger, "Worker {workhorse.worker.id} registration failed on queues {workhorse.worker.queues} with {error.type}",
                workerId, queues, errorType);
        }
    }

    /// <summary>A failed reporter callback. <paramref name="unreported"/> is in the message only, as in the TypeScript body.</summary>
    internal static void ReporterFailed(ILogger logger, string workerId, string reporter, string errorType, long unreported)
    {
        if (ReporterFailedEvent.Enabled(logger))
        {
            // The count is part of the template, as it is part of the TypeScript body.
            ReporterFailedEvent.Write(logger, string.Create(CultureInfo.InvariantCulture, $"Worker {{workhorse.worker.id}} reporter {{workhorse.worker.reporter}} failed with {{error.type}} after {unreported} unreported failures"),
                workerId, reporter, errorType);
        }
    }

    internal static void NotificationFailed(ILogger logger, string errorType)
    {
        if (NotificationFailedEvent.Enabled(logger))
        {
            NotificationFailedEvent.Write(logger, "The notification listener failed with {error.type}; the worker polls until it listens again",
                errorType);
        }
    }

    internal static void HandlerMissing(ILogger logger, string taskType, Guid taskId, int attempt, string queue, string workerId)
    {
        if (HandlerMissingEvent.Enabled(logger))
        {
            HandlerMissingEvent.Write(logger, "No handler registered for task type {workhorse.task.type}; task {workhorse.task.id}, attempt {workhorse.task.attempt}, goes back to queue {workhorse.queue.name} from worker {workhorse.worker.id}",
                taskType, taskId, attempt, queue, workerId);
        }
    }

    internal static void Completed(ILogger logger, Guid taskId, string taskType, int attempt, string queue, string workerId, bool accepted)
    {
        if (CompletedEvent.Enabled(logger))
        {
            CompletedEvent.Write(logger, "Task {workhorse.task.id} of type {workhorse.task.type}, attempt {workhorse.task.attempt}, from queue {workhorse.queue.name} completed on worker {workhorse.worker.id}: {workhorse.complete.accepted}",
                taskId, taskType, attempt, queue, workerId, accepted);
        }
    }

    internal static void CompletionRejected(ILogger logger, Guid taskId, string taskType, int attempt, string queue, string workerId, bool accepted)
    {
        if (CompletionRejectedEvent.Enabled(logger))
        {
            CompletionRejectedEvent.Write(logger, "Stale completion of task {workhorse.task.id} of type {workhorse.task.type}, attempt {workhorse.task.attempt}, from queue {workhorse.queue.name} rejected on worker {workhorse.worker.id}: {workhorse.complete.accepted}",
                taskId, taskType, attempt, queue, workerId, accepted);
        }
    }

    internal static void ReleaseProcessed(ILogger logger, Guid taskId, string taskType, int attempt, string queue, string workerId, string? status)
    {
        if (ReleaseProcessedEvent.Enabled(logger))
        {
            ReleaseProcessedEvent.Write(logger, "Owned task {workhorse.task.id} of type {workhorse.task.type}, attempt {workhorse.task.attempt}, from queue {workhorse.queue.name} release processed on worker {workhorse.worker.id} with status {workhorse.release.status}",
                taskId, taskType, attempt, queue, workerId, status);
        }
    }

    internal static void ReleaseFailed(ILogger logger, Guid taskId, string errorType)
    {
        if (ReleaseFailedEvent.Enabled(logger))
        {
            ReleaseFailedEvent.Write(logger, "Unstarted task {workhorse.task.id} release failed with {error.type}",
                taskId, errorType);
        }
    }

    internal static void FailureProcessed(ILogger logger, Guid taskId, string taskType, int attempt, string queue, string workerId, string? state)
    {
        if (FailureProcessedEvent.Enabled(logger))
        {
            FailureProcessedEvent.Write(logger, "Task {workhorse.task.id} of type {workhorse.task.type}, attempt {workhorse.task.attempt}, from queue {workhorse.queue.name} failure processed on worker {workhorse.worker.id} with outcome {workhorse.attempt.outcome}",
                taskId, taskType, attempt, queue, workerId, state);
        }
    }

    internal static void HeartbeatRejected(ILogger logger, Guid taskId, string taskType, int attempt, string workerId, string status)
    {
        if (HeartbeatRejectedEvent.Enabled(logger))
        {
            HeartbeatRejectedEvent.Write(logger, "Task heartbeat rejected: task {workhorse.task.id} of type {workhorse.task.type}, attempt {workhorse.task.attempt}, on worker {workhorse.worker.id} with status {workhorse.heartbeat.status}",
                taskId, taskType, attempt, workerId, status);
        }
    }

    internal static void OwnershipExpired(ILogger logger, Guid taskId, string taskType, int attempt, string queue, string workerId, string? status)
    {
        if (OwnershipExpiredEvent.Enabled(logger))
        {
            OwnershipExpiredEvent.Write(logger, "Owned task {workhorse.task.id} of type {workhorse.task.type}, attempt {workhorse.task.attempt}, from queue {workhorse.queue.name} expired on worker {workhorse.worker.id} with status {workhorse.expiration.status}",
                taskId, taskType, attempt, queue, workerId, status);
        }
    }

    internal static void ExpirationRequestFailed(ILogger logger, Guid taskId, string taskType, int attempt, string queue, string workerId, string errorType)
    {
        if (ExpirationRequestFailedEvent.Enabled(logger))
        {
            ExpirationRequestFailedEvent.Write(logger, "Ownership expiration request failed for task {workhorse.task.id} of type {workhorse.task.type}, attempt {workhorse.task.attempt}, from queue {workhorse.queue.name} on worker {workhorse.worker.id} with {error.type}; the worker asks again",
                taskId, taskType, attempt, queue, workerId, errorType);
        }
    }

    internal static void CancellationAcknowledged(ILogger logger, Guid taskId, string taskType, int attempt, string queue, string workerId, bool accepted)
    {
        if (CancellationAcknowledgedEvent.Enabled(logger))
        {
            CancellationAcknowledgedEvent.Write(logger, "Task {workhorse.task.id} of type {workhorse.task.type}, attempt {workhorse.task.attempt}, from queue {workhorse.queue.name} cancellation acknowledged on worker {workhorse.worker.id}: {workhorse.cancel.accepted}",
                taskId, taskType, attempt, queue, workerId, accepted);
        }
    }

    internal static void ScheduleFired(ILogger logger, string? @namespace, string? schedule, string taskId)
    {
        if (ScheduleFiredEvent.Enabled(logger))
        {
            ScheduleFiredEvent.Write(logger, "Recurring schedule {workhorse.schedule.namespace}/{workhorse.schedule.name} fired task {workhorse.task.id}",
                @namespace, schedule, taskId);
        }
    }

    internal static void HandlerRegistered(ILogger logger, string taskType, string workerId)
    {
        if (HandlerRegisteredEvent.Enabled(logger))
        {
            HandlerRegisteredEvent.Write(logger, "Task handler registered for task type {workhorse.task.type} on worker {workhorse.worker.id}",
                taskType, workerId);
        }
    }

    internal static void Claimed(ILogger logger, Guid taskId, string taskType, int attempt, string queue, string workerId)
    {
        if (ClaimedEvent.Enabled(logger))
        {
            ClaimedEvent.Write(logger, "Task claimed: task {workhorse.task.id} of type {workhorse.task.type}, attempt {workhorse.task.attempt}, from queue {workhorse.queue.name} by worker {workhorse.worker.id}",
                taskId, taskType, attempt, queue, workerId);
        }
    }

    internal static void HandlerStarted(ILogger logger, Guid taskId, string taskType, int attempt, string queue, string workerId)
    {
        if (HandlerStartedEvent.Enabled(logger))
        {
            HandlerStartedEvent.Write(logger, "Task handler started: task {workhorse.task.id} of type {workhorse.task.type}, attempt {workhorse.task.attempt}, from queue {workhorse.queue.name} on worker {workhorse.worker.id}",
                taskId, taskType, attempt, queue, workerId);
        }
    }

    internal static void HandlerFinished(ILogger logger, Guid taskId, string taskType, int attempt, string queue, string workerId, double durationMs)
    {
        if (HandlerFinishedEvent.Enabled(logger))
        {
            HandlerFinishedEvent.Write(logger, "Task handler finished: task {workhorse.task.id} of type {workhorse.task.type}, attempt {workhorse.task.attempt}, from queue {workhorse.queue.name} on worker {workhorse.worker.id} after {workhorse.handler.duration_ms} ms",
                taskId, taskType, attempt, queue, workerId, durationMs);
        }
    }

    internal static void ExecutionFinished(ILogger logger, Guid taskId, string taskType, int attempt, string queue, string workerId, string outcome)
    {
        if (ExecutionFinishedEvent.Enabled(logger))
        {
            ExecutionFinishedEvent.Write(logger, "Task execution finished: task {workhorse.task.id} of type {workhorse.task.type}, attempt {workhorse.task.attempt}, from queue {workhorse.queue.name} on worker {workhorse.worker.id} with outcome {workhorse.handler.outcome}",
                taskId, taskType, attempt, queue, workerId, outcome);
        }
    }

    internal static void HeartbeatAccepted(ILogger logger, Guid taskId, string taskType, int attempt, string workerId)
    {
        if (HeartbeatAcceptedEvent.Enabled(logger))
        {
            HeartbeatAcceptedEvent.Write(logger, "Task heartbeat accepted: task {workhorse.task.id} of type {workhorse.task.type}, attempt {workhorse.task.attempt}, on worker {workhorse.worker.id}",
                taskId, taskType, attempt, workerId);
        }
    }

    internal static void ShutdownSettlementFailed(ILogger logger, Guid taskId, string taskType, int attempt, string queue, string workerId, string errorType)
    {
        if (ShutdownSettlementFailedEvent.Enabled(logger))
        {
            ShutdownSettlementFailedEvent.Write(logger, "Worker {workhorse.worker.id} could not settle task {workhorse.task.id} of type {workhorse.task.type}, attempt {workhorse.task.attempt}, from queue {workhorse.queue.name} after the shutdown abort: {error.type}",
                workerId, taskId, taskType, attempt, queue, errorType);
        }
    }

    internal static void Registered(ILogger logger, IReadOnlyList<string> queues, string workerId, int concurrency, int activeSlots, bool draining, bool paused)
    {
        if (RegisteredEvent.Enabled(logger))
        {
            RegisteredEvent.Write(logger, "Worker registration changed: worker {workhorse.worker.id} on queues {workhorse.worker.queues} with concurrency {workhorse.worker.concurrency}, {workhorse.worker.active_slots} active slots, draining {workhorse.worker.draining}, paused {workhorse.worker.paused}",
                workerId, queues, concurrency, activeSlots, draining, paused);
        }
    }

    internal static void Deregistered(ILogger logger, string workerId, bool deregistered)
    {
        if (DeregisteredEvent.Enabled(logger))
        {
            DeregisteredEvent.Write(logger, "Worker {workhorse.worker.id} deregistered: {workhorse.worker.deregistered}",
                workerId, deregistered);
        }
    }

    internal static void LeasesRecovered(ILogger logger, long rowsAffected, long expiredLeases, long retried)
    {
        if (LeasesRecoveredEvent.Enabled(logger))
        {
            LeasesRecoveredEvent.Write(logger, "Expired leases recovered: {workhorse.recovery.rows_affected} rows, {workhorse.recovery.expired_leases} expired leases, {workhorse.recovery.retried} retried",
                rowsAffected, expiredLeases, retried);
        }
    }

    internal static void MaintenanceCompleted(ILogger logger, string operation, string phase, long rowsAffected, bool skippedLock)
    {
        if (MaintenanceCompletedEvent.Enabled(logger))
        {
            MaintenanceCompletedEvent.Write(logger, "Maintenance phase completed: {workhorse.maintenance.operation} {workhorse.maintenance.phase} changed {workhorse.maintenance.rows_affected} rows (skipped lock: {workhorse.maintenance.skipped_lock})",
                operation, phase, rowsAffected, skippedLock);
        }
    }

    internal static void ScheduleFireReplayed(ILogger logger, string? @namespace, string? schedule)
    {
        if (ScheduleFireReplayedEvent.Enabled(logger))
        {
            ScheduleFireReplayedEvent.Write(logger, "Recurring schedule occurrence replayed: {workhorse.schedule.namespace}/{workhorse.schedule.name}",
                @namespace, schedule);
        }
    }
}
