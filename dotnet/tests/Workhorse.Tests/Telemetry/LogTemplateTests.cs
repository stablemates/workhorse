using System.Globalization;
using Microsoft.Extensions.Logging;
using Workhorse.Internal;
using Workhorse.Internal.Durable;
using Workhorse.Internal.Runtime;
using Workhorse.Internal.Telemetry;
using Workhorse.Tests.Testing;

namespace Workhorse.Tests.Telemetry;

/// <summary>
/// Each .NET log record carries the values of the TypeScript record of its event under the
/// TypeScript keys, such as <c>workhorse.task.id</c> and <c>error.type</c> (SM-2064). Its message
/// states the values, its <c>{OriginalFormat}</c> names the keys, and it carries no exception, because a record never holds an error message
/// (docs/architecture/telemetry.md, "Log content limits"). Many records come from failures and
/// races that a test against PostgreSQL cannot cause on demand, so the test writes each record
/// directly through an <see cref="ILogger"/>.
/// </summary>
public sealed class LogTemplateTests
{
    private static readonly Guid TaskId = Guid.NewGuid();

    private static readonly string[] Queues = ["mail", "billing"];

    /// <summary>The task identity of a worker record whose TypeScript record has the queue.</summary>
    private static readonly Dictionary<string, object?> Task = new(StringComparer.Ordinal)
    {
        ["workhorse.task.id"] = TaskId,
        ["workhorse.task.type"] = "send-mail",
        ["workhorse.task.attempt"] = 2,
        ["workhorse.queue.name"] = "mail",
        ["workhorse.worker.id"] = "worker-1",
    };

    private static Dictionary<string, object?> With(IReadOnlyDictionary<string, object?> values, params (string Key, object? Value)[] more)
    {
        var all = new Dictionary<string, object?>(values, StringComparer.Ordinal);
        foreach (var (key, value) in more)
        {
            all[key] = value;
        }

        return all;
    }

    private static Dictionary<string, object?> Values(params (string Key, object? Value)[] values) =>
        With(new Dictionary<string, object?>(StringComparer.Ordinal), values);

    private static Dictionary<string, object?> Without(IReadOnlyDictionary<string, object?> values, string key)
    {
        var all = new Dictionary<string, object?>(values, StringComparer.Ordinal);
        all.Remove(key);
        return all;
    }

    /// <summary>
    /// Asserts the one record of <paramref name="eventName"/> in <paramref name="log"/>: its level,
    /// its event ID, its keys and values, no exception, and a message that states each value.
    /// </summary>
    private static void AssertRecord(LogRecorder log, string eventName, LogLevel level, IReadOnlyDictionary<string, object?> expected)
    {
        var record = log.Single(eventName);
        AssertRecord(record, eventName, level, expected);
    }

    private static void AssertRecord(LogRecord record, string eventName, LogLevel level, IReadOnlyDictionary<string, object?> expected)
    {
        Assert.Equal(level, record.Level);
        Assert.Equal(SdkLog.StableId(eventName), record.EventId.Id);
        Assert.Equal(expected.Keys.Order(StringComparer.Ordinal), record.Values.Keys.Order(StringComparer.Ordinal));
        foreach (var (key, value) in expected)
        {
            // As in a LoggerMessage state, {OriginalFormat} holds the template, with a hole for each key.
            Assert.Contains($"{{{key}}}", record.Template, StringComparison.Ordinal);
            if (value is IEnumerable<string> list)
            {
                Assert.Equal(list, Assert.IsAssignableFrom<IEnumerable<string>>(record[key]));
                Assert.Contains(string.Join(", ", list), record.Message, StringComparison.Ordinal);
            }
            else
            {
                Assert.Equal(value, record[key]);
                Assert.Contains(Convert.ToString(value, CultureInfo.InvariantCulture)!, record.Message, StringComparison.Ordinal);
            }
        }

        Assert.Null(record.Exception);
    }

    [Fact]
    public void AnEventKeepsTheIdThatTheSourceGeneratorGaveIt()
    {
        // The LoggerMessage source generator gave these IDs before SM-2064.
        Assert.Equal(318252084, SdkLog.StableId("workhorse.worker.started"));
        Assert.Equal(2147390176, SdkLog.StableId("workhorse.task.enqueued"));
        Assert.Equal(30106083, SdkLog.StableId("workhorse.handler.batch_evidence_failed"));
    }

    [Fact]
    public void TheWorkerLifecycleRecordsCarryTheTypeScriptKeys()
    {
        using var log = new LogRecorder();
        WorkerLog.Started(log, "worker-1", 4, Queues);
        WorkerLog.StopRequested(log, "worker-1", Queues, 3);
        WorkerLog.Stopped(log, "worker-1", Queues, 1);
        WorkerLog.Paused(log, "worker-1", "locally", Queues);
        WorkerLog.Resumed(log, "worker-1", "remotely", Queues);
        WorkerLog.PollingOnly(log, "worker-1", Queues, "unknown");
        WorkerLog.StatementSlow(log, "worker-1", "claim", 1234L);
        WorkerLog.RegistrationFailed(log, "worker-1", Queues, "Npgsql.NpgsqlException");
        WorkerLog.ReporterFailed(log, "worker-1", "maintenance", "System.InvalidOperationException", 5L);
        WorkerLog.Registered(log, Queues, "worker-1", 4, 2, true, false);
        WorkerLog.Deregistered(log, "worker-1", true);
        WorkerLog.HandlerRegistered(log, "send-mail", "worker-1");
        BatchRegistrationLog.Registered(log, "send-mail", 10, 25L, "worker-1");

        var worker = Values(("workhorse.worker.id", "worker-1"), ("workhorse.worker.queues", Queues));
        AssertRecord(log, "workhorse.worker.started", LogLevel.Information, With(worker, ("workhorse.worker.concurrency", 4)));
        AssertRecord(log, "workhorse.worker.stop_requested", LogLevel.Information, With(worker, ("workhorse.worker.active_slots", 3)));
        AssertRecord(log, "workhorse.worker.stopped", LogLevel.Information, With(worker, ("workhorse.worker.active_slots", 1)));
        AssertRecord(log, "workhorse.worker.paused", LogLevel.Information, worker);
        Assert.Contains(" locally ", log.Single("workhorse.worker.paused").Message, StringComparison.Ordinal);
        AssertRecord(log, "workhorse.worker.resumed", LogLevel.Information, worker);
        Assert.Contains(" remotely ", log.Single("workhorse.worker.resumed").Message, StringComparison.Ordinal);
        AssertRecord(log, "workhorse.worker.polling_only", LogLevel.Warning, With(worker, ("workhorse.worker.pool_max_size", "unknown")));
        AssertRecord(log, "workhorse.worker.statement_slow", LogLevel.Warning, Values(
            ("workhorse.worker.id", "worker-1"), ("workhorse.worker.statement", "claim"), ("workhorse.worker.elapsed_ms", 1234L)));
        AssertRecord(log, "workhorse.worker.registration_failed", LogLevel.Information, With(worker, ("error.type", "Npgsql.NpgsqlException")));
        AssertRecord(log, "workhorse.worker.reporter_failed", LogLevel.Error, Values(
            ("workhorse.worker.id", "worker-1"), ("workhorse.worker.reporter", "maintenance"), ("error.type", "System.InvalidOperationException")));
        // As in the TypeScript body, the count of unreported failures is in the message only.
        Assert.Contains("after 5 unreported failures", log.Single("workhorse.worker.reporter_failed").Message, StringComparison.Ordinal);
        AssertRecord(log, "workhorse.worker.registered", LogLevel.Debug, With(worker,
            ("workhorse.worker.concurrency", 4), ("workhorse.worker.active_slots", 2), ("workhorse.worker.draining", true), ("workhorse.worker.paused", false)));
        AssertRecord(log, "workhorse.worker.deregistered", LogLevel.Debug, Values(("workhorse.worker.id", "worker-1"), ("workhorse.worker.deregistered", true)));
        var registrations = log.Of("workhorse.handler.registered");
        Assert.Equal(2, registrations.Count);
        AssertRecord(registrations[0], "workhorse.handler.registered", LogLevel.Debug, Values(("workhorse.task.type", "send-mail"), ("workhorse.worker.id", "worker-1")));
        AssertRecord(registrations[1], "workhorse.handler.registered", LogLevel.Debug, Values(
            ("workhorse.task.type", "send-mail"), ("workhorse.handler.batch.max_size", 10), ("workhorse.handler.batch.linger_ms", 25L), ("workhorse.worker.id", "worker-1")));
    }

    [Fact]
    public void TheWorkerAttemptRecordsCarryTheTypeScriptKeys()
    {
        using var log = new LogRecorder();
        WorkerLog.Claimed(log, TaskId, "send-mail", 2, "mail", "worker-1");
        WorkerLog.HandlerStarted(log, TaskId, "send-mail", 2, "mail", "worker-1");
        WorkerLog.HandlerFinished(log, TaskId, "send-mail", 2, "mail", "worker-1", 12.5);
        WorkerLog.ExecutionFinished(log, TaskId, "send-mail", 2, "mail", "worker-1", "succeeded");
        WorkerLog.HandlerMissing(log, "send-mail", TaskId, 2, "mail", "worker-1");
        WorkerLog.Completed(log, TaskId, "send-mail", 2, "mail", "worker-1", true);
        WorkerLog.CompletionRejected(log, TaskId, "send-mail", 2, "mail", "worker-1", false);
        WorkerLog.ReleaseProcessed(log, TaskId, "send-mail", 2, "mail", "worker-1", "released");
        WorkerLog.FailureProcessed(log, TaskId, "send-mail", 2, "mail", "worker-1", "scheduled");
        WorkerLog.OwnershipExpired(log, TaskId, "send-mail", 2, "mail", "worker-1", "deadline_exceeded");
        WorkerLog.CancellationAcknowledged(log, TaskId, "send-mail", 2, "mail", "worker-1", true);
        WorkerLog.ExpirationRequestFailed(log, TaskId, "send-mail", 2, "mail", "worker-1", "Workhorse.DatabaseException");
        WorkerLog.ShutdownSettlementFailed(log, TaskId, "send-mail", 2, "mail", "worker-1", "Workhorse.DatabaseException");
        WorkerLog.HeartbeatAccepted(log, TaskId, "send-mail", 2, "worker-1");
        WorkerLog.HeartbeatRejected(log, TaskId, "send-mail", 2, "worker-1", "stale");
        WorkerLog.ReleaseFailed(log, TaskId, "Workhorse.DatabaseException");
        DurableLog.SignalSwallowed(log, TaskId, "send-mail", 2, "mail", "worker-1", "suspended");

        AssertRecord(log, "workhorse.task.claimed", LogLevel.Debug, Task);
        AssertRecord(log, "workhorse.handler.started", LogLevel.Debug, Task);
        AssertRecord(log, "workhorse.handler.finished", LogLevel.Debug, With(Task, ("workhorse.handler.duration_ms", 12.5)));
        AssertRecord(log, "workhorse.task.execution_finished", LogLevel.Information, With(Task, ("workhorse.handler.outcome", "succeeded")));
        AssertRecord(log, "workhorse.handler.missing", LogLevel.Warning, Task);
        AssertRecord(log, "workhorse.task.completed", LogLevel.Information, With(Task, ("workhorse.complete.accepted", true)));
        AssertRecord(log, "workhorse.task.completion_rejected", LogLevel.Information, With(Task, ("workhorse.complete.accepted", false)));
        AssertRecord(log, "workhorse.task.release_processed", LogLevel.Information, With(Task, ("workhorse.release.status", "released")));
        AssertRecord(log, "workhorse.task.failure_processed", LogLevel.Information, With(Task, ("workhorse.attempt.outcome", "scheduled")));
        AssertRecord(log, "workhorse.task.ownership_expired", LogLevel.Information, With(Task, ("workhorse.expiration.status", "deadline_exceeded")));
        AssertRecord(log, "workhorse.task.cancellation_acknowledged", LogLevel.Information, With(Task, ("workhorse.cancel.accepted", true)));
        AssertRecord(log, "workhorse.worker.expiration_request_failed", LogLevel.Warning, With(Task, ("error.type", "Workhorse.DatabaseException")));
        AssertRecord(log, "workhorse.worker.shutdown_settlement_failed", LogLevel.Warning, With(Task, ("error.type", "Workhorse.DatabaseException")));
        var heartbeat = Without(Task, "workhorse.queue.name");
        AssertRecord(log, "workhorse.task.heartbeat_accepted", LogLevel.Debug, heartbeat);
        AssertRecord(log, "workhorse.task.heartbeat_rejected", LogLevel.Information, With(heartbeat, ("workhorse.heartbeat.status", "stale")));
        AssertRecord(log, "workhorse.task.release_failed", LogLevel.Warning, Values(("workhorse.task.id", TaskId), ("error.type", "Workhorse.DatabaseException")));
        AssertRecord(log, "workhorse.handler.signal_swallowed", LogLevel.Warning, With(Task, ("workhorse.handler.outcome", "suspended")));
    }

    [Fact]
    public void TheWorkerRoutineAndBatchRecordsCarryTheirKeys()
    {
        using var log = new LogRecorder();
        WorkerLog.LeasesRecovered(log, 3L, 2L, 1L);
        WorkerLog.MaintenanceCompleted(log, "tick", "recover", 3L, false);
        WorkerLog.ScheduleFired(log, "billing", "every-minute", TaskId.ToString());
        WorkerLog.ScheduleFireReplayed(log, "billing", "every-minute");
        WorkerLog.BatchDispatched(log, 3, "send-mail", "mail", "worker-1", true, 25L);
        WorkerLog.BatchEvidenceFailed(log, 3, "send-mail", "mail", "worker-1", "dispatch", false, "Workhorse.DatabaseException");
        WorkerLog.NotificationFailed(log, "Npgsql.NpgsqlException");
        WorkerLog.ClaimIsolation(log, "Serializable");
        WorkerLog.ClaimsAbandoned(log, 2);
        WorkerLog.StopStepAbandoned(log, "dispatch");

        AssertRecord(log, "workhorse.leases.recovered", LogLevel.Information, Values(
            ("workhorse.recovery.rows_affected", 3L), ("workhorse.recovery.expired_leases", 2L), ("workhorse.recovery.retried", 1L)));
        AssertRecord(log, "workhorse.maintenance.completed", LogLevel.Information, Values(
            ("workhorse.maintenance.operation", "tick"), ("workhorse.maintenance.phase", "recover"),
            ("workhorse.maintenance.rows_affected", 3L), ("workhorse.maintenance.skipped_lock", false)));
        var schedule = Values(("workhorse.schedule.namespace", "billing"), ("workhorse.schedule.name", "every-minute"));
        AssertRecord(log, "workhorse.schedule.fired", LogLevel.Information, With(schedule, ("workhorse.task.id", TaskId.ToString())));
        AssertRecord(log, "workhorse.schedule.fire_replayed", LogLevel.Debug, schedule);
        var batch = Values(
            ("workhorse.handler.batch.size", 3), ("workhorse.task.type", "send-mail"), ("workhorse.queue.name", "mail"), ("workhorse.worker.id", "worker-1"));
        AssertRecord(log, "workhorse.handler.batch_dispatched", LogLevel.Information, With(batch,
            ("workhorse.handler.batch.full", true), ("workhorse.handler.batch.linger_ms", 25L)));
        AssertRecord(log, "workhorse.handler.batch_evidence_failed", LogLevel.Warning, With(batch,
            ("workhorse.handler.batch.evidence_phase", "dispatch"), ("workhorse.handler.batch.full", false), ("error.type", "Workhorse.DatabaseException")));
        // The JVM and .NET workers write the last four events. Their keys are the keys of the JVM record.
        AssertRecord(log, "workhorse.worker.notification_failed", LogLevel.Warning, Values(("error.type", "Npgsql.NpgsqlException")));
        AssertRecord(log, "workhorse.worker.claim_isolation", LogLevel.Warning, Values(("workhorse.isolation_level", "Serializable")));
        AssertRecord(log, "workhorse.worker.claims_abandoned", LogLevel.Warning, Values(("workhorse.worker.claims", 2)));
        AssertRecord(log, "workhorse.worker.stop_step_abandoned", LogLevel.Warning, Values(("workhorse.worker.stop_step", "dispatch")));
    }

    [Fact]
    public void TheDurableRecordsCarryTheTypeScriptKeys()
    {
        using var log = new LogRecorder();
        DurableLog.CheckpointSaved(log, TaskId, "send-mail", 2, "worker-1", "step", "saved");
        DurableLog.ProgressUpdated(log, TaskId, "send-mail", 2, "worker-1", "updated");
        DurableLog.WaitProcessed(log, TaskId, "send-mail", 2, "worker-1", "nap", "scheduled");
        DurableLog.ChildProcessed(log, TaskId, "worker-1", "kid", "created");
        DurableLog.ChildSetProcessed(log, TaskId, "worker-1", 3, "created");

        var identity = Without(Task, "workhorse.queue.name");
        AssertRecord(log, "workhorse.task.checkpoint_saved", LogLevel.Debug, With(identity,
            ("workhorse.checkpoint.name", "step"), ("workhorse.checkpoint.status", "saved")));
        AssertRecord(log, "workhorse.task.progress_updated", LogLevel.Debug, With(identity, ("workhorse.progress.status", "updated")));
        AssertRecord(log, "workhorse.task.wait_processed", LogLevel.Information, With(identity,
            ("workhorse.wait.name", "nap"), ("workhorse.wait.status", "scheduled")));
        var children = log.Of("workhorse.task.child_processed");
        Assert.Equal(2, children.Count);
        var parent = Values(("workhorse.task.id", TaskId), ("workhorse.worker.id", "worker-1"), ("workhorse.child.status", "created"));
        AssertRecord(children[0], "workhorse.task.child_processed", LogLevel.Information, With(parent, ("workhorse.child.name", "kid")));
        AssertRecord(children[1], "workhorse.task.child_processed", LogLevel.Information, With(parent, ("workhorse.child.count", 3)));
    }

    [Fact]
    public void TheQueueAndAdminRecordsCarryTheTypeScriptKeys()
    {
        using var log = new LogRecorder();
        ClientLog.Enqueued(log, TaskId, "send-mail", "mail");
        ClientLog.EnqueueReplayed(log, TaskId, "send-mail", "mail");
        ClientLog.Debounced(log, TaskId, "send-mail", "mail");
        ClientLog.DebounceRejected(log, TaskId, "send-mail", "mail");
        ClientLog.Throttled(log, TaskId, "send-mail", "mail");
        ClientLog.CancellationProcessed(log, TaskId, "cancelled", "applied");
        ClientLog.SignalProcessed(log, TaskId, "approved", "delivered");
        ClientLog.HumanWaitProcessed(log, TaskId, "review", "completed");
        ClientLog.SchedulesSynchronized(log, "billing", 2);
        ClientLog.RedriveProcessed(log, TaskId, "target-task", "redriven");
        ClientLog.RedriveBatchProcessed(log, 4, true);
        ClientLog.QueuePaused(log, "mail");
        ClientLog.QueueResumed(log, "mail");
        ClientLog.QueuePurged(log, "mail", 7L);
        ClientLog.QueueTierSet(log, "mail", "fast");
        ClientLog.WorkerPaused(log, "worker-1");
        ClientLog.WorkerResumed(log, "worker-1");

        var enqueue = Values(("workhorse.task.id", TaskId), ("workhorse.task.type", "send-mail"), ("workhorse.queue.name", "mail"));
        foreach (var name in new[] { "workhorse.task.enqueued", "workhorse.task.enqueue_replayed", "workhorse.task.debounced", "workhorse.task.debounce_rejected", "workhorse.task.throttled" })
        {
            AssertRecord(log, name, LogLevel.Debug, enqueue);
        }

        var task = Values(("workhorse.task.id", TaskId));
        AssertRecord(log, "workhorse.task.cancellation_processed", LogLevel.Information, With(task,
            ("workhorse.task.state", "cancelled"), ("workhorse.operation.status", "applied")));
        AssertRecord(log, "workhorse.task.signal_processed", LogLevel.Information, With(task,
            ("workhorse.signal.name", "approved"), ("workhorse.signal.status", "delivered")));
        AssertRecord(log, "workhorse.task.human_wait_processed", LogLevel.Information, With(task,
            ("workhorse.human_wait.name", "review"), ("workhorse.human_wait.status", "completed")));
        AssertRecord(log, "workhorse.schedules.synchronized", LogLevel.Information, Values(
            ("workhorse.schedule.namespace", "billing"), ("workhorse.schedule.count", 2)));
        AssertRecord(log, "workhorse.task.redrive_processed", LogLevel.Information, With(task,
            ("workhorse.redrive.target_task_id", "target-task"), ("workhorse.operation.status", "redriven")));
        AssertRecord(log, "workhorse.tasks.redrive_processed", LogLevel.Information, Values(
            ("workhorse.task.count", 4), ("workhorse.redrive.dry_run", true)));
        var queue = Values(("workhorse.queue.name", "mail"));
        AssertRecord(log, "workhorse.queue.paused", LogLevel.Information, queue);
        AssertRecord(log, "workhorse.queue.resumed", LogLevel.Information, queue);
        AssertRecord(log, "workhorse.queue.purged", LogLevel.Information, With(queue, ("workhorse.task.count", 7L)));
        AssertRecord(log, "workhorse.queue.tier_set", LogLevel.Information, With(queue, ("workhorse.queue.tier", "fast")));
        AssertRecord(log, "workhorse.worker.paused", LogLevel.Information, Values(("workhorse.worker.id", "worker-1")));
        AssertRecord(log, "workhorse.worker.resumed", LogLevel.Information, Values(("workhorse.worker.id", "worker-1")));
    }

    /// <summary>A disabled logger gets no record, so a record costs no work then.</summary>
    [Fact]
    public void ADisabledLoggerGetsNoRecord()
    {
        var logger = new DisabledLogger();
        WorkerLog.Completed(logger, TaskId, "send-mail", 2, "mail", "worker-1", true);
        ClientLog.Enqueued(logger, TaskId, "send-mail", "mail");
        DurableLog.WaitProcessed(logger, TaskId, "send-mail", 2, "worker-1", "nap", "scheduled");
        Assert.Equal(0, logger.Records);
    }

    private sealed class DisabledLogger : ILogger
    {
        internal int Records { get; private set; }

        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => false;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter) => Records++;
    }
}
