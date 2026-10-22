namespace Workhorse.Internal.Telemetry;

/// <summary>
/// The span and attribute names that the .NET SDK emits. Each one is in <c>api/telemetry.txt</c>,
/// and <c>TelemetrySurfaceTests</c> fails when one is not (ADR 0107, "Telemetry").
/// </summary>
/// <remarks>
/// The set is the span and metric set of the JVM SDK: the Ruby reference set and the
/// <c>workhorse.enqueue</c> span of the TypeScript queue. The .NET worker and queue log through
/// <c>ILogger</c>, so the attributes of the JVM log records are not in this set.
/// </remarks>
internal static class Names
{
    /// <summary>The span around one enqueue or one batch enqueue.</summary>
    internal const string SpanEnqueue = "workhorse.enqueue";

    /// <summary>The span around one claim from one queue.</summary>
    internal const string SpanClaim = "workhorse.claim";

    /// <summary>The consumer span around one attempt. Its parent is the stored trace context.</summary>
    internal const string SpanHandler = "workhorse.handler";

    /// <summary>The span around one fenced completion.</summary>
    internal const string SpanComplete = "workhorse.complete";

    /// <summary>The span around one failure or one lease expiration that PostgreSQL settles.</summary>
    internal const string SpanRetry = "workhorse.retry";

    /// <summary>The span around one maintenance pass.</summary>
    internal const string SpanMaintenance = "workhorse.maintenance";

    /// <summary>The span around the recovery phases of one maintenance pass.</summary>
    internal const string SpanRecovery = "workhorse.recovery";

    internal const string AttemptOutcome = "workhorse.attempt.outcome";
    internal const string ClaimResult = "workhorse.claim.result";
    internal const string CompleteAccepted = "workhorse.complete.accepted";
    internal const string EnqueueCount = "workhorse.enqueue.count";
    internal const string EnqueueOutcome = "workhorse.enqueue.outcome";
    internal const string HandlerBatchFull = "workhorse.handler.batch.full";
    internal const string HandlerOutcome = "workhorse.handler.outcome";
    internal const string HeartbeatStatus = "workhorse.heartbeat.status";
    internal const string MaintenanceLoop = "workhorse.maintenance.loop";
    internal const string MaintenanceOperation = "workhorse.maintenance.operation";
    internal const string MaintenancePhase = "workhorse.maintenance.phase";
    internal const string MaintenanceRowsAffected = "workhorse.maintenance.rows_affected";
    internal const string MaintenanceSkippedLock = "workhorse.maintenance.skipped_lock";
    internal const string QueueName = "workhorse.queue.name";
    internal const string QueueTier = "workhorse.queue.tier";
    internal const string RecoveryExpiredLeases = "workhorse.recovery.expired_leases";
    internal const string RecoveryRetried = "workhorse.recovery.retried";
    internal const string RecoveryRowsAffected = "workhorse.recovery.rows_affected";
    internal const string RecoverySkipped = "workhorse.recovery.skipped";
    internal const string RetryOutcome = "workhorse.retry.outcome";
    internal const string ScheduleName = "workhorse.schedule.name";
    internal const string ScheduleNamespace = "workhorse.schedule.namespace";
    internal const string TaskAttempt = "workhorse.task.attempt";
    internal const string TaskId = "workhorse.task.id";
    internal const string TaskType = "workhorse.task.type";
}
