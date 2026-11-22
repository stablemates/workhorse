using Microsoft.Extensions.Logging;
using Workhorse.Internal.Durable;
using Workhorse.Internal.Runtime;
using Workhorse.Tests.Testing;

namespace Workhorse.Tests.Telemetry;

/// <summary>
/// Each .NET log template carries the values of the TypeScript record of its event, and no
/// exception, because a record never holds an error message (docs/architecture/telemetry.md, "Log
/// content limits"). A .NET record names each value by its template (".NET logs"). These records
/// come from failures and races that a test against PostgreSQL cannot cause on demand, so the test
/// writes each template directly.
/// </summary>
public sealed class LogTemplateTests
{
    private static readonly Guid TaskId = Guid.NewGuid();

    private static readonly string[] Task = ["Attempt", "Queue", "TaskId", "TaskType", "WorkerId"];

    private static void AssertTemplate(LogRecorder log, string eventName, LogLevel level, params string[] values)
    {
        var record = log.Single(eventName);
        Assert.Equal(level, record.Level);
        Assert.Equal(values.Order(StringComparer.Ordinal), record.Values.Keys.Order(StringComparer.Ordinal));
        Assert.Null(record.Exception);
    }

    [Fact]
    public void TheWorkerTemplatesCarryTheTypeScriptValues()
    {
        using var log = new LogRecorder();
        string[] queues = ["mail", "billing"];
        WorkerLog.PollingOnly(log, "worker-1", queues, "unknown");
        WorkerLog.RegistrationFailed(log, "worker-1", queues, "Npgsql.NpgsqlException");
        WorkerLog.HeartbeatRejected(log, TaskId, "mail", 1, "worker-1", "stale");
        WorkerLog.OwnershipExpired(log, TaskId, "mail", 1, "mail", "worker-1", "deadline_exceeded");
        WorkerLog.CancellationAcknowledged(log, TaskId, "mail", 1, "mail", "worker-1", true);
        WorkerLog.CompletionRejected(log, TaskId, "mail", 1, "mail", "worker-1", false);
        WorkerLog.ExpirationRequestFailed(log, TaskId, "mail", 1, "mail", "worker-1", "Workhorse.DatabaseException");
        WorkerLog.BatchEvidenceFailed(log, 2, "mail", "mail", "worker-1", "dispatch", true, "Workhorse.DatabaseException");
        WorkerLog.NotificationFailed(log, "Npgsql.NpgsqlException");
        WorkerLog.ReleaseFailed(log, TaskId, "Workhorse.DatabaseException");

        AssertTemplate(log, "workhorse.worker.polling_only", LogLevel.Warning, "PoolMaxSize", "Queues", "WorkerId");
        Assert.Equal<IEnumerable<string>>(queues, Assert.IsAssignableFrom<IReadOnlyList<string>>(log.Single("workhorse.worker.polling_only")["Queues"]));
        AssertTemplate(log, "workhorse.worker.registration_failed", LogLevel.Information, "ErrorType", "Queues", "WorkerId");
        AssertTemplate(log, "workhorse.task.heartbeat_rejected", LogLevel.Information, "Attempt", "Status", "TaskId", "TaskType", "WorkerId");
        AssertTemplate(log, "workhorse.task.ownership_expired", LogLevel.Information, [.. Task, "Status"]);
        AssertTemplate(log, "workhorse.task.cancellation_acknowledged", LogLevel.Information, [.. Task, "Accepted"]);
        AssertTemplate(log, "workhorse.task.completion_rejected", LogLevel.Information, [.. Task, "Accepted"]);
        AssertTemplate(log, "workhorse.worker.expiration_request_failed", LogLevel.Warning, [.. Task, "ErrorType"]);
        AssertTemplate(log, "workhorse.handler.batch_evidence_failed", LogLevel.Warning, "ErrorType", "Full", "Phase", "Queue", "Size", "TaskType", "WorkerId");
        // These two diagnostic records passed the exception, which holds the error message.
        AssertTemplate(log, "workhorse.worker.notification_failed", LogLevel.Warning, "ErrorType");
        AssertTemplate(log, "workhorse.task.release_failed", LogLevel.Warning, "ErrorType", "TaskId");
    }

    [Fact]
    public void TheDurableTemplatesCarryTheTypeScriptValues()
    {
        using var log = new LogRecorder();
        DurableLog.CheckpointSaved(log, TaskId, "mail", 1, "worker-1", "step", "saved");
        DurableLog.ProgressUpdated(log, TaskId, "mail", 1, "worker-1", "updated");
        DurableLog.WaitProcessed(log, TaskId, "mail", 1, "worker-1", "nap", "scheduled");
        DurableLog.ChildProcessed(log, TaskId, "worker-1", "kid", "created");
        ChildSetLog.Processed(log, TaskId, "worker-1", 3, "created");
        DurableLog.SignalSwallowed(log, TaskId, "mail", 1, "mail", "worker-1", "suspended");

        string[] identity = ["Attempt", "TaskId", "TaskType", "WorkerId"];
        AssertTemplate(log, "workhorse.task.checkpoint_saved", LogLevel.Debug, [.. identity, "CheckpointName", "Status"]);
        AssertTemplate(log, "workhorse.task.progress_updated", LogLevel.Debug, [.. identity, "Status"]);
        AssertTemplate(log, "workhorse.task.wait_processed", LogLevel.Information, [.. identity, "Status", "WaitName"]);
        var children = log.Of("workhorse.task.child_processed");
        Assert.Equal(2, children.Count);
        Assert.Equal(["ChildName", "Status", "TaskId", "WorkerId"], children[0].Values.Keys.Order(StringComparer.Ordinal));
        Assert.Equal(["ChildCount", "Status", "TaskId", "WorkerId"], children[1].Values.Keys.Order(StringComparer.Ordinal));
        Assert.Equal(3, children[1]["ChildCount"]);
        AssertTemplate(log, "workhorse.handler.signal_swallowed", LogLevel.Warning, [.. Task, "HandlerOutcome"]);
    }
}
