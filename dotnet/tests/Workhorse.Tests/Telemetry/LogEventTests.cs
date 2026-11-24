using Microsoft.Extensions.Logging;
using Npgsql;
using Workhorse.Internal;
using Workhorse.Internal.Database;
using Workhorse.Tests.Testing;
using static Workhorse.Tests.Testing.WorkerHarness;

namespace Workhorse.Tests.Telemetry;

/// <summary>
/// The log records of the worker, the queue, and the admin client against PostgreSQL. Each record
/// has the event name, the severity, and the attributes of the TypeScript <c>WorkhorseLogEvent</c>
/// (docs/architecture/telemetry.md, "Structured logs"). A .NET record carries each attribute under
/// the TypeScript key, such as <c>workhorse.task.id</c> (SM-2064), so each test checks the keys of
/// the record.
/// </summary>
public sealed class LogEventTests(ScratchDatabase database) : IClassFixture<ScratchDatabase>, IDisposable
{
    private static readonly string[] TaskAttributes = ["workhorse.task.attempt", "workhorse.queue.name", "workhorse.task.id", "workhorse.task.type", "workhorse.worker.id"];

    private readonly LogRecorder _log = new();

    private readonly string _queue = UniqueQueue("logs");

    private static CancellationToken Token => TestContext.Current.CancellationToken;

    private NpgsqlDataSource DataSource => database.DataSource;

    private static AdminAudit Audit() => new() { Actor = "dotnet-test", Reason = "log event test", RequestId = Guid.NewGuid().ToString("N") };

    private Queue Queue() => new(DataSource, new QueueOptions { DefaultQueue = _queue, LoggerFactory = _log });

    private Admin Admin() => new(DataSource, new AdminOptions { LoggerFactory = _log });

    private Worker Worker(Action<WorkerOptions>? configure = null) =>
        new(DataSource, Options(_queue, options =>
        {
            options.LoggerFactory = _log;
            options.PollingOnly = true;
            options.DisableRegistry = true;
            configure?.Invoke(options);
        }));

    public void Dispose() => _log.Dispose();

    private static void AssertRecord(LogRecord record, LogLevel level, params string[] attributes)
    {
        Assert.Equal(level, record.Level);
        Assert.Equal(attributes.Order(StringComparer.Ordinal), record.Values.Keys.Order(StringComparer.Ordinal));
    }

    // ---------------------------------------------------------------------------------------------
    // Queue

    [Fact]
    public async Task EachEnqueueOutcomeWritesItsDebugRecord()
    {
        var queue = Queue();
        var idempotent = new EnqueueOptions { Idempotency = new Idempotency { Key = "same" } };
        var accepted = await queue.EnqueueAsync("mail", 1, idempotent, Token);
        var replayed = await queue.EnqueueAsync("mail", 1, idempotent, Token);
        var debounce = new EnqueueOptions { Debounce = new Debounce { Key = "shared", Window = TimeSpan.FromMinutes(5) } };
        await queue.EnqueueAsync("mail", 1, debounce, Token);
        var debounced = await queue.EnqueueAsync("mail", 2, debounce, Token);
        var throttle = new EnqueueOptions { Throttle = new Throttle { Key = "throttled", Window = TimeSpan.FromMinutes(5) } };
        await queue.EnqueueAsync("mail", 1, throttle, Token);
        var throttled = await queue.EnqueueAsync("mail", 1, throttle, Token);
        // The key of a throttled task belongs to another coalescing mode, so a debounce cannot replace it.
        var rejected = await queue.EnqueueAsync("mail", 1, new EnqueueOptions { Debounce = new Debounce { Key = "throttled", Window = TimeSpan.FromMinutes(5) } }, Token);
        Assert.Equal(EnqueueOutcome.Replaced, debounced.Outcome);
        Assert.Equal(EnqueueOutcome.Coalesced, throttled.Outcome);
        Assert.Equal(EnqueueOutcome.NonReplaceable, rejected.Outcome);

        foreach (var (name, result) in new[]
                 {
                     ("workhorse.task.enqueued", accepted),
                     ("workhorse.task.enqueue_replayed", replayed),
                     ("workhorse.task.debounced", debounced),
                     ("workhorse.task.throttled", throttled),
                     ("workhorse.task.debounce_rejected", rejected),
                 })
        {
            var record = _log.Single(name, record => Equals(record["workhorse.task.id"], result.TaskId));
            AssertRecord(record, LogLevel.Debug, "workhorse.queue.name", "workhorse.task.id", "workhorse.task.type");
            Assert.Equal("mail", record["workhorse.task.type"]);
            Assert.Equal(_queue, record["workhorse.queue.name"]);
        }

        Assert.Equal(3, _log.Of("workhorse.task.enqueued").Count);
    }

    [Fact]
    public async Task ATaskGroupMemberWritesTheEnqueueRecord()
    {
        var queue = Queue();
        var group = await queue.CreateTaskGroupAsync(new TaskGroupCallbacks(), Token);
        var member = Assert.Single(await queue.AddToTaskGroupAsync(group.Id, [new EnqueueRequest { TaskType = "member", Options = new EnqueueOptions { Queue = "members" } }], Token));

        var record = _log.Single("workhorse.task.enqueued");
        AssertRecord(record, LogLevel.Debug, "workhorse.queue.name", "workhorse.task.id", "workhorse.task.type");
        Assert.Equal(member.TaskId, record["workhorse.task.id"]);
        Assert.Equal("member", record["workhorse.task.type"]);
        Assert.Equal("members", record["workhorse.queue.name"]);
    }

    [Fact]
    public async Task ACancellationWritesItsInfoRecord()
    {
        var queue = Queue();
        var taskId = (await queue.EnqueueAsync("mail", 1, Token)).TaskId;
        var canceled = await queue.CancelAsync(taskId, new CancelOptions { Reason = "a reason that the log never holds" }, Token);
        var missing = Guid.NewGuid();
        var unknown = await queue.CancelAsync(missing, new CancelOptions(), Token);

        var record = _log.Single("workhorse.task.cancellation_processed", record => Equals(record["workhorse.task.id"], taskId));
        AssertRecord(record, LogLevel.Information, "workhorse.task.state", "workhorse.operation.status", "workhorse.task.id");
        Assert.Equal(Wire.Text(canceled.State!.Value), record["workhorse.task.state"]);
        Assert.Equal(Wire.Text(canceled.Status), record["workhorse.operation.status"]);
        var notFound = _log.Single("workhorse.task.cancellation_processed", record => Equals(record["workhorse.task.id"], missing));
        Assert.Equal("not_found", notFound["workhorse.task.state"]);
        Assert.Equal(Wire.Text(unknown.Status), notFound["workhorse.operation.status"]);
    }

    [Fact]
    public async Task ASignalAndAHumanDecisionWriteTheirInfoRecords()
    {
        var queue = Queue();
        var taskId = (await queue.EnqueueAsync("mail", 1, Token)).TaskId;
        var signal = await queue.SendSignalAsync(taskId, "approved", new { secret = "payload" }, "signal-key", "tester", Token);
        var decision = await queue.CompleteHumanWaitAsync(taskId, "review", new { secret = "result" }, "decision-key", "tester", Token);

        var signalRecord = _log.Single("workhorse.task.signal_processed");
        AssertRecord(signalRecord, LogLevel.Information, "workhorse.signal.name", "workhorse.signal.status", "workhorse.task.id");
        Assert.Equal(taskId, signalRecord["workhorse.task.id"]);
        Assert.Equal("approved", signalRecord["workhorse.signal.name"]);
        Assert.Equal(Wire.Text(signal.Status), signalRecord["workhorse.signal.status"]);

        var decisionRecord = _log.Single("workhorse.task.human_wait_processed");
        AssertRecord(decisionRecord, LogLevel.Information, "workhorse.human_wait.status", "workhorse.task.id", "workhorse.human_wait.name");
        Assert.Equal(taskId, decisionRecord["workhorse.task.id"]);
        Assert.Equal("review", decisionRecord["workhorse.human_wait.name"]);
        Assert.Equal(Wire.Text(decision.Status), decisionRecord["workhorse.human_wait.status"]);
    }

    [Fact]
    public async Task AScheduleSyncWritesItsInfoRecord()
    {
        var @namespace = $"dotnet-{Guid.NewGuid():N}";
        await Queue().SyncSchedulesAsync(
            @namespace,
            [
                new ScheduleDefinition { Name = "first", Schedule = "* * * * *", Task = new ScheduledTask { TaskType = "cron" } },
                new ScheduleDefinition { Name = "second", Schedule = "0 * * * *", Task = new ScheduledTask { TaskType = "cron" } },
            ],
            Token);

        var record = _log.Single("workhorse.schedules.synchronized");
        AssertRecord(record, LogLevel.Information, "workhorse.schedule.count", "workhorse.schedule.namespace");
        Assert.Equal(@namespace, record["workhorse.schedule.namespace"]);
        Assert.Equal(2, record["workhorse.schedule.count"]);
    }

    // ---------------------------------------------------------------------------------------------
    // Admin

    [Fact]
    public async Task TheQueueControlsWriteTheirInfoRecords()
    {
        var queue = Queue();
        await queue.EnqueueAsync("mail", 1, Token);
        await queue.EnqueueAsync("mail", 2, Token);
        var admin = Admin();
        await admin.PauseQueueAsync(_queue, Audit(), Token);
        await admin.ResumeQueueAsync(_queue, Audit(), Token);
        var purged = await admin.PurgeQueueAsync(_queue, Audit(), Token);
        var tier = await admin.SetQueueTierAsync(_queue, QueueTier.Fast, Audit(), Token);

        AssertRecord(_log.Single("workhorse.queue.paused"), LogLevel.Information, "workhorse.queue.name");
        Assert.Equal(_queue, _log.Single("workhorse.queue.paused")["workhorse.queue.name"]);
        AssertRecord(_log.Single("workhorse.queue.resumed"), LogLevel.Information, "workhorse.queue.name");
        Assert.Equal(_queue, _log.Single("workhorse.queue.resumed")["workhorse.queue.name"]);
        var purge = _log.Single("workhorse.queue.purged");
        AssertRecord(purge, LogLevel.Information, "workhorse.task.count", "workhorse.queue.name");
        Assert.Equal(_queue, purge["workhorse.queue.name"]);
        Assert.Equal(2L, purged);
        Assert.Equal(purged, purge["workhorse.task.count"]);
        var tierRecord = _log.Single("workhorse.queue.tier_set");
        AssertRecord(tierRecord, LogLevel.Information, "workhorse.queue.name", "workhorse.queue.tier");
        Assert.Equal(_queue, tierRecord["workhorse.queue.name"]);
        Assert.Equal(Wire.Text(tier), tierRecord["workhorse.queue.tier"]);
    }

    [Fact]
    public async Task ARedriveWritesItsInfoRecords()
    {
        var taskId = (await Queue().EnqueueAsync("failing", 1, new EnqueueOptions { MaxAttempts = 1 }, Token)).TaskId;
        await using (var worker = Worker())
        {
            worker.Handle<int>("failing", (_, _) => throw new InvalidOperationException("declined"));
            Assert.True(await worker.RunOnceAsync(Token));
        }

        await TaskInStateAsync(DataSource, taskId, "failed");
        var admin = Admin();
        var redriven = await admin.RedriveAsync(taskId, Audit(), Token);
        var page = await admin.RedriveManyAsync(new RedriveFilter { Queue = _queue, DryRun = true }, Audit(), Token);

        var record = _log.Single("workhorse.task.redrive_processed");
        AssertRecord(record, LogLevel.Information, "workhorse.operation.status", "workhorse.redrive.target_task_id", "workhorse.task.id");
        Assert.Equal(taskId, record["workhorse.task.id"]);
        Assert.Equal(redriven.TargetTaskId!.Value.ToString(), record["workhorse.redrive.target_task_id"]);
        Assert.Equal(Wire.Text(redriven.Status), record["workhorse.operation.status"]);
        var batch = _log.Single("workhorse.tasks.redrive_processed");
        AssertRecord(batch, LogLevel.Information, "workhorse.task.count", "workhorse.redrive.dry_run");
        Assert.Equal(page.Results.Count, batch["workhorse.task.count"]);
        Assert.Equal(true, batch["workhorse.redrive.dry_run"]);
    }

    // ---------------------------------------------------------------------------------------------
    // Worker

    [Fact]
    public async Task AnAttemptWritesItsClaimHandlerAndExecutionRecords()
    {
        var taskId = (await Queue().EnqueueAsync("mail", 1, Token)).TaskId;
        await using var worker = Worker();
        worker.Handle<int>("mail", (_, _) => Task.CompletedTask);
        Assert.True(await worker.RunOnceAsync(Token));

        var registered = _log.Single("workhorse.handler.registered");
        AssertRecord(registered, LogLevel.Debug, "workhorse.task.type", "workhorse.worker.id");
        Assert.Equal("mail", registered["workhorse.task.type"]);
        Assert.Equal(worker.WorkerId, registered["workhorse.worker.id"]);

        foreach (var name in new[] { "workhorse.task.claimed", "workhorse.handler.started" })
        {
            var record = _log.Single(name);
            AssertRecord(record, LogLevel.Debug, TaskAttributes);
            AssertTask(record, taskId, worker.WorkerId);
        }

        var finished = _log.Single("workhorse.handler.finished");
        AssertRecord(finished, LogLevel.Debug, [.. TaskAttributes, "workhorse.handler.duration_ms"]);
        AssertTask(finished, taskId, worker.WorkerId);
        Assert.True(Assert.IsType<double>(finished["workhorse.handler.duration_ms"]) >= 0);

        var execution = _log.Single("workhorse.task.execution_finished");
        AssertRecord(execution, LogLevel.Information, [.. TaskAttributes, "workhorse.handler.outcome"]);
        AssertTask(execution, taskId, worker.WorkerId);
        Assert.Equal("succeeded", execution["workhorse.handler.outcome"]);
    }

    [Fact]
    public async Task ABatchHandlerRegistrationWritesItsDebugRecord()
    {
        await using var worker = Worker(options => options.Concurrency = 4);
        worker.HandleBatch<int>(
            "batched",
            new BatchOptions { MaxSize = 3, Linger = TimeSpan.FromMilliseconds(25) },
            (items, _) => Task.FromResult<IReadOnlyList<BatchHandlerOutcome>>([]));

        var record = _log.Single("workhorse.handler.registered");
        AssertRecord(record, LogLevel.Debug, "workhorse.handler.batch.linger_ms", "workhorse.handler.batch.max_size", "workhorse.task.type", "workhorse.worker.id");
        Assert.Equal("batched", record["workhorse.task.type"]);
        Assert.Equal(3, record["workhorse.handler.batch.max_size"]);
        Assert.Equal(25L, record["workhorse.handler.batch.linger_ms"]);
        Assert.Equal(worker.WorkerId, record["workhorse.worker.id"]);
    }

    [Fact]
    public async Task AnAcceptedHeartbeatWritesItsDebugRecord()
    {
        var taskId = (await Queue().EnqueueAsync("slow", 1, Token)).TaskId;
        await using var worker = Worker(options =>
        {
            options.Lease = TimeSpan.FromSeconds(3);
            options.Heartbeat = TimeSpan.FromMilliseconds(100);
        });
        worker.Handle<int>("slow", (_, _) => EventuallyAsync(() => _log.Of("workhorse.task.heartbeat_accepted").Count > 0, "a heartbeat is accepted"));
        Assert.True(await worker.RunOnceAsync(Token));

        var record = _log.Of("workhorse.task.heartbeat_accepted")[0];
        AssertRecord(record, LogLevel.Debug, "workhorse.task.attempt", "workhorse.task.id", "workhorse.task.type", "workhorse.worker.id");
        Assert.Equal(taskId, record["workhorse.task.id"]);
        Assert.Equal("slow", record["workhorse.task.type"]);
        Assert.Equal(1, record["workhorse.task.attempt"]);
        Assert.Equal(worker.WorkerId, record["workhorse.worker.id"]);
    }

    /// <summary>
    /// A heartbeat round sees the cancellation request before PostgreSQL acknowledges it. If the
    /// acknowledgement fails, or PostgreSQL refuses it, the worker settled nothing, so it writes no
    /// <c>workhorse.task.execution_finished</c>, as TypeScript does. A trigger of this test database
    /// makes the acknowledgement fail, or refuses it by deleting no row. The handler stops at the
    /// cancellation or returns after it.
    /// </summary>
    [Theory]
    [InlineData(true, false)]
    [InlineData(false, false)]
    [InlineData(true, true)]
    [InlineData(false, true)]
    public async Task AFailedCancellationAcknowledgementWritesNoExecutionRecord(bool handlerThrows, bool refused)
    {
        var taskId = (await Queue().EnqueueAsync("slow", 1, Token)).TaskId;
        var body = refused ? "RETURN NULL;" : "RAISE EXCEPTION 'the acknowledgement failed';";
        await ScalarAsync(DataSource, $"CREATE FUNCTION public.refuse_runtime_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN {body} END; $$");
        await ScalarAsync(DataSource, $"""
            CREATE TRIGGER refuse_runtime_delete BEFORE DELETE ON workhorse.task_runtime FOR EACH ROW
            WHEN (OLD.task_id = '{taskId}') EXECUTE FUNCTION public.refuse_runtime_delete()
            """);
        try
        {
            var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            await using var worker = Worker(options =>
            {
                options.Lease = TimeSpan.FromSeconds(3);
                options.Heartbeat = TimeSpan.FromMilliseconds(100);
            });
            worker.Handle<int>("slow", async (context, _) =>
            {
                started.SetResult();
                try
                {
                    await Task.Delay(Timeout.Infinite, context.CancellationToken);
                }
                catch (OperationCanceledException) when (!handlerThrows)
                {
                    // The handler returns after the cancellation.
                }
            });
            var run = worker.RunOnceAsync(Token);
            await started.Task.WaitAsync(Patience, Token);
            await Queue().CancelAsync(taskId, new CancelOptions(), Token);
            if (refused)
            {
                // A refused acknowledgement is a lost lease, which ends the attempt without an error.
                await run.WaitAsync(Patience, Token);
            }
            else
            {
                await Assert.ThrowsAnyAsync<Exception>(() => run.WaitAsync(Patience, Token));
            }
        }
        finally
        {
            await ScalarAsync(DataSource, "DROP TRIGGER refuse_runtime_delete ON workhorse.task_runtime");
            await ScalarAsync(DataSource, "DROP FUNCTION public.refuse_runtime_delete()");
        }

        Assert.Equal("active", (await TaskAsync(DataSource, taskId)).Text("state"));
        Assert.Empty(_log.Of("workhorse.task.execution_finished"));
        Assert.Single(_log.Of("workhorse.handler.finished"));
    }

    /// <summary>
    /// The worker writes <c>workhorse.worker.registered</c> after the first registration and after a
    /// change of the active slots, the draining state, or the pause state. An unchanged refresh
    /// writes nothing, as <c>Worker.refreshRegistration</c> does in TypeScript.
    /// </summary>
    [Fact]
    public async Task AnUnchangedRegistrationRefreshWritesNoRecord()
    {
        await using var worker = Worker(options =>
        {
            options.DisableRegistry = false;
            options.RegistryInterval = TimeSpan.FromMilliseconds(100);
            options.MaintenanceInterval = TimeSpan.FromHours(1);
            options.MaintenanceRoutineInterval = TimeSpan.FromHours(1);
        });
        await using var running = new RunningWorker(worker);

        // Three refreshes move the heartbeat of the registry row.
        var heartbeats = new HashSet<DateTime>();
        await EventuallyAsync(
            async () =>
            {
                if (await ScalarAsync(DataSource, "SELECT last_heartbeat_at FROM workhorse.worker_registry WHERE worker_id = $1", worker.WorkerId) is DateTime heartbeat)
                {
                    heartbeats.Add(heartbeat);
                }

                return heartbeats.Count >= 3;
            },
            "the worker refreshes its registration three times");

        var first = _log.Single("workhorse.worker.registered");
        AssertRecord(first, LogLevel.Debug, "workhorse.worker.active_slots", "workhorse.worker.concurrency", "workhorse.worker.draining", "workhorse.worker.paused", "workhorse.worker.queues", "workhorse.worker.id");
        Assert.Equal(worker.WorkerId, first["workhorse.worker.id"]);
        Assert.Equal<IEnumerable<string>>([_queue], Assert.IsAssignableFrom<IReadOnlyList<string>>(first["workhorse.worker.queues"]));
        Assert.Equal(worker.Concurrency, first["workhorse.worker.concurrency"]);
        Assert.Equal(0, first["workhorse.worker.active_slots"]);
        Assert.Equal(false, first["workhorse.worker.draining"]);
        Assert.Equal(false, first["workhorse.worker.paused"]);

        // An operator pause changes the answer of the next refresh.
        Assert.NotNull(await new Admin(DataSource).SetWorkerPausedAsync(worker.WorkerId, true, Audit(), Token));
        await EventuallyAsync(() => _log.Of("workhorse.worker.registered").Count == 2, "the paused registration is logged");
        Assert.Equal(true, _log.Of("workhorse.worker.registered")[1]["workhorse.worker.paused"]);

        await running.StopAsync();
        var registrations = _log.Of("workhorse.worker.registered");
        Assert.Equal(3, registrations.Count);
        Assert.Equal(true, registrations[2]["workhorse.worker.draining"]);
        var deregistered = _log.Single("workhorse.worker.deregistered");
        AssertRecord(deregistered, LogLevel.Debug, "workhorse.worker.deregistered", "workhorse.worker.id");
        Assert.Equal(worker.WorkerId, deregistered["workhorse.worker.id"]);
        Assert.Equal(true, deregistered["workhorse.worker.deregistered"]);
    }

    /// <summary>
    /// A run writes its first registration record also when the deregistration of the run before
    /// did not clear the saved state, for example because it passed its stop deadline.
    /// </summary>
    [Fact]
    public async Task EachRunWritesItsFirstRegistrationRecord()
    {
        await using var worker = Worker(options =>
        {
            options.DisableRegistry = false;
            options.RegistryInterval = TimeSpan.FromMilliseconds(100);
            options.MaintenanceInterval = TimeSpan.FromHours(1);
            options.MaintenanceRoutineInterval = TimeSpan.FromHours(1);
        });
        var saved = typeof(Worker).GetField("_loggedRegistration", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!;
        object? firstState;
        await using (var running = new RunningWorker(worker))
        {
            await EventuallyAsync(() => _log.Of("workhorse.worker.registered").Count == 1, "the first run registers");
            firstState = saved.GetValue(worker);
            await running.StopAsync();
        }

        // As if the deregistration did not run: the saved state is still the first registration.
        saved.SetValue(worker, firstState);
        var before = _log.Of("workhorse.worker.registered").Count;
        await using (var running = new RunningWorker(worker))
        {
            await EventuallyAsync(() => _log.Of("workhorse.worker.registered").Count > before, "the second run registers");
            await running.StopAsync();
        }
    }

    /// <summary>
    /// Each life-cycle record names the worker and carries the queues as a list value, as the
    /// TypeScript <c>workhorse.worker.queues</c> array is. An admin pause writes its own record.
    /// </summary>
    [Fact]
    public async Task AWorkerRunWritesItsLifeCycleRecordsWithItsIdAndQueues()
    {
        await using var worker = Worker(options =>
        {
            options.DisableRegistry = false;
            options.RegistryInterval = TimeSpan.FromMilliseconds(100);
            options.MaintenanceInterval = TimeSpan.FromHours(1);
            options.MaintenanceRoutineInterval = TimeSpan.FromHours(1);
        });
        var running = new RunningWorker(worker);
        await EventuallyAsync(() => _log.Of("workhorse.worker.registered").Count > 0, "the worker registers");
        worker.Pause();
        worker.Resume();
        var admin = Admin();
        Assert.NotNull(await admin.SetWorkerPausedAsync(worker.WorkerId, true, Audit(), Token));
        await EventuallyAsync(() => _log.Of("workhorse.worker.paused").Count == 3, "the remote pause is logged");
        Assert.NotNull(await admin.SetWorkerPausedAsync(worker.WorkerId, false, Audit(), Token));
        await EventuallyAsync(() => _log.Of("workhorse.worker.resumed").Count == 3, "the remote resume is logged");
        Assert.Null(await admin.SetWorkerPausedAsync("missing-worker", true, Audit(), Token));
        await running.StopAsync();

        IEnumerable<string> queues = [_queue];
        var started = _log.Single("workhorse.worker.started");
        AssertRecord(started, LogLevel.Information, "workhorse.worker.concurrency", "workhorse.worker.queues", "workhorse.worker.id");
        Assert.Equal(worker.WorkerId, started["workhorse.worker.id"]);
        Assert.Equal(queues, Assert.IsAssignableFrom<IReadOnlyList<string>>(started["workhorse.worker.queues"]));
        foreach (var name in new[] { "workhorse.worker.paused", "workhorse.worker.resumed" })
        {
            foreach (var where in new[] { "locally", "remotely" })
            {
                // The TypeScript record has no key for the place of the pause, so only the message states it.
                var record = _log.Single(name, record => record.Values.ContainsKey("workhorse.worker.queues") && record.Message.Contains($" {where} ", StringComparison.Ordinal));
                AssertRecord(record, LogLevel.Information, "workhorse.worker.queues", "workhorse.worker.id");
                Assert.Equal(worker.WorkerId, record["workhorse.worker.id"]);
                Assert.Equal(queues, Assert.IsAssignableFrom<IReadOnlyList<string>>(record["workhorse.worker.queues"]));
            }

            var byAdmin = _log.Single(name, record => !record.Values.ContainsKey("workhorse.worker.queues"));
            AssertRecord(byAdmin, LogLevel.Information, "workhorse.worker.id");
            Assert.Equal(worker.WorkerId, byAdmin["workhorse.worker.id"]);
        }

        foreach (var name in new[] { "workhorse.worker.stop_requested", "workhorse.worker.stopped" })
        {
            var record = _log.Single(name);
            AssertRecord(record, LogLevel.Information, "workhorse.worker.active_slots", "workhorse.worker.queues", "workhorse.worker.id");
            Assert.Equal(worker.WorkerId, record["workhorse.worker.id"]);
            Assert.Equal(0, record["workhorse.worker.active_slots"]);
            Assert.Equal(queues, Assert.IsAssignableFrom<IReadOnlyList<string>>(record["workhorse.worker.queues"]));
        }
    }

    /// <summary>The settlement records of an attempt carry the task identity, as in TypeScript.</summary>
    [Fact]
    public async Task AnAttemptWritesItsSettlementRecordsWithTheTaskIdentity()
    {
        var queue = Queue();
        var succeeds = (await queue.EnqueueAsync("mail", 1, Token)).TaskId;
        var fails = (await queue.EnqueueAsync("failing", 1, new EnqueueOptions { MaxAttempts = 1 }, Token)).TaskId;
        var unknown = (await queue.EnqueueAsync("unknown", 1, Token)).TaskId;
        await queue.EnqueueAsync("batched", 1, Token);
        await using var worker = Worker();
        worker.Handle<int>("mail", (_, _) => Task.CompletedTask);
        worker.Handle<int>("failing", (_, _) => throw new InvalidOperationException("never-log-this"));
        worker.HandleBatch<int>(
            "batched",
            new BatchOptions { MaxSize = 1, Linger = TimeSpan.Zero },
            (items, _) => Task.FromResult<IReadOnlyList<BatchHandlerOutcome>>([.. items.Select(_ => new BatchSucceeded(null))]));
        for (var run = 0; run < 4; run++)
        {
            await worker.RunOnceAsync(Token);
        }

        var completed = _log.Single("workhorse.task.completed", record => Equals(record["workhorse.task.id"], succeeds));
        AssertRecord(completed, LogLevel.Information, [.. TaskAttributes, "workhorse.complete.accepted"]);
        AssertTask(completed, succeeds, worker.WorkerId);
        Assert.Equal(true, completed["workhorse.complete.accepted"]);
        var failure = _log.Single("workhorse.task.failure_processed");
        AssertRecord(failure, LogLevel.Information, [.. TaskAttributes, "workhorse.attempt.outcome"]);
        AssertTask(failure, fails, worker.WorkerId);
        Assert.Equal("failed", failure["workhorse.attempt.outcome"]);
        // Each run claims and releases the task again, so it has a record for each run.
        var missing = _log.Of("workhorse.handler.missing")[0];
        AssertRecord(missing, LogLevel.Warning, TaskAttributes);
        AssertTask(missing, unknown, worker.WorkerId);
        var released = _log.Of("workhorse.task.release_processed")[0];
        AssertRecord(released, LogLevel.Information, [.. TaskAttributes, "workhorse.release.status"]);
        AssertTask(released, unknown, worker.WorkerId);
        Assert.Equal("released", released["workhorse.release.status"]);
        var batch = _log.Single("workhorse.handler.batch_dispatched");
        AssertRecord(batch, LogLevel.Information, "workhorse.handler.batch.full", "workhorse.handler.batch.linger_ms", "workhorse.queue.name", "workhorse.handler.batch.size", "workhorse.task.type", "workhorse.worker.id");
        Assert.Equal(worker.WorkerId, batch["workhorse.worker.id"]);
        Assert.Equal(_queue, batch["workhorse.queue.name"]);
    }

    [Fact]
    public async Task AMaintenancePassWritesTheRecoveryAndPhaseRecords()
    {
        var taskId = await EnqueueAsync(DataSource, _queue, "abandoned", 1);
        await using (var connection = await DataSource.OpenConnectionAsync(Token))
        {
            Assert.Single(await Sql.RowsAsync(
                connection, SqlCatalogue.ClaimManyV1, [Parameters.Text(_queue), Parameters.Text("gone-worker"), Parameters.Integer(1), Parameters.Integer(30_000)], Token));
        }

        await ScalarAsync(DataSource, "UPDATE workhorse.task_runtime SET expires_at = clock_timestamp() - interval '1 millisecond' WHERE task_id = $1", taskId);
        // The worker claims from another queue, so only its maintenance pass touches the task.
        await using var worker = new Worker(DataSource, Options(UniqueQueue("other"), options =>
        {
            options.LoggerFactory = _log;
            options.PollingOnly = true;
            options.DisableRegistry = true;
        }));
        await worker.RunOnceAsync(Token);

        var recovered = _log.Single("workhorse.leases.recovered");
        AssertRecord(recovered, LogLevel.Information, "workhorse.recovery.expired_leases", "workhorse.recovery.retried", "workhorse.recovery.rows_affected");
        Assert.True(Assert.IsType<long>(recovered["workhorse.recovery.rows_affected"]) >= 1);
        Assert.True(Assert.IsType<long>(recovered["workhorse.recovery.expired_leases"]) >= 1);
        Assert.IsType<long>(recovered["workhorse.recovery.retried"]);

        var phase = _log.Single("workhorse.maintenance.completed", record => Equals(record["workhorse.maintenance.phase"], "recover"));
        AssertRecord(phase, LogLevel.Information, "workhorse.maintenance.operation", "workhorse.maintenance.phase", "workhorse.maintenance.rows_affected", "workhorse.maintenance.skipped_lock");
        Assert.Equal("tick", phase["workhorse.maintenance.operation"]);
        Assert.Equal(recovered["workhorse.recovery.rows_affected"], phase["workhorse.maintenance.rows_affected"]);
        Assert.Equal(false, phase["workhorse.maintenance.skipped_lock"]);
        // A phase that changed no row and returned no error writes no record.
        Assert.All(_log.Of("workhorse.maintenance.completed"), record => Assert.NotEqual(0L, record["workhorse.maintenance.rows_affected"]));
    }

    /// <summary>
    /// An occurrence that PostgreSQL already holds fires no task. A trigger makes the insert of the
    /// occurrence do nothing, as a second pass that fires the same occurrence finds it.
    /// </summary>
    [Fact]
    public async Task AReplayedScheduleOccurrenceWritesItsDebugRecord()
    {
        var @namespace = $"dotnet-{Guid.NewGuid():N}";
        await Queue().SyncSchedulesAsync(
            @namespace,
            [new ScheduleDefinition { Name = "every-minute", Schedule = "* * * * *", CatchupPolicy = CatchupPolicy.Latest, Task = new ScheduledTask { TaskType = "cron" } }],
            Token);
        await ScalarAsync(DataSource, "UPDATE workhorse.schedule_definition SET last_evaluated_at = clock_timestamp() - interval '2 minutes' WHERE namespace = $1", @namespace);
        await ScalarAsync(DataSource, """
            CREATE FUNCTION public.dotnet_skip_occurrence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END; $$;
            CREATE TRIGGER dotnet_skip_occurrence BEFORE INSERT ON workhorse.schedule_occurrence
              FOR EACH ROW EXECUTE FUNCTION public.dotnet_skip_occurrence();
            """);
        try
        {
            await using var worker = Worker(options => options.ScheduleNamespaces = [@namespace]);
            await worker.RunOnceAsync(Token);
        }
        finally
        {
            await ScalarAsync(DataSource, "DROP TRIGGER dotnet_skip_occurrence ON workhorse.schedule_occurrence; DROP FUNCTION public.dotnet_skip_occurrence();");
        }

        Assert.Empty(_log.Of("workhorse.schedule.fired"));
        var record = _log.Of("workhorse.schedule.fire_replayed")[0];
        AssertRecord(record, LogLevel.Debug, "workhorse.schedule.namespace", "workhorse.schedule.name");
        Assert.Equal(@namespace, record["workhorse.schedule.namespace"]);
        Assert.Equal("every-minute", record["workhorse.schedule.name"]);
    }

    /// <summary>
    /// After the shutdown cancellation, the worker returns the task without charging the attempt. A
    /// trigger makes that release fail, so the worker writes the warning and the run fails.
    /// </summary>
    [Fact]
    public async Task AFailedReleaseAfterTheShutdownWritesItsWarning()
    {
        var taskId = (await Queue().EnqueueAsync("stuck", 1, Token)).TaskId;
        await ScalarAsync(DataSource, $"""
            CREATE FUNCTION public.dotnet_refuse_release() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
              IF OLD.task_id = '{taskId}' AND NEW.state <> 'active' THEN RAISE EXCEPTION 'release refused'; END IF;
              RETURN NEW;
            END; $$;
            CREATE TRIGGER dotnet_refuse_release BEFORE UPDATE ON workhorse.task_runtime
              FOR EACH ROW EXECUTE FUNCTION public.dotnet_refuse_release();
            """);
        try
        {
            var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            await using var worker = Worker(options => options.ShutdownGrace = TimeSpan.FromMilliseconds(100));
            worker.Handle<int>("stuck", async (context, _) =>
            {
                started.TrySetResult();
                await Task.Delay(Timeout.Infinite, context.CancellationToken);
            });
            await using var running = new RunningWorker(worker);
            await started.Task.WaitAsync(Patience, Token);
            await Assert.ThrowsAnyAsync<Exception>(running.StopAsync);

            var record = _log.Single("workhorse.worker.shutdown_settlement_failed");
            AssertRecord(record, LogLevel.Warning, [.. TaskAttributes, "error.type"]);
            AssertTask(record, taskId, worker.WorkerId);
            // The worker wraps the error of PostgreSQL, and the record holds no message.
            Assert.Equal(typeof(DatabaseException).FullName, record["error.type"]);
            Assert.Null(record.Exception);
        }
        finally
        {
            await ScalarAsync(DataSource, "DROP TRIGGER dotnet_refuse_release ON workhorse.task_runtime; DROP FUNCTION public.dotnet_refuse_release();");
        }
    }

    /// <summary>
    /// A logger that throws never changes the result of an operation and never stops a handler.
    /// Before, a throwing logger replaced the result of a purge that PostgreSQL committed, and a
    /// throwing <c>workhorse.handler.started</c> record stopped the handler after the claim.
    /// </summary>
    [Fact]
    public async Task AThrowingLoggerChangesNoOperationResult()
    {
        var throwing = new ThrowingLoggerFactory();
        var queue = new Queue(DataSource, new QueueOptions { DefaultQueue = _queue, LoggerFactory = throwing });
        var admin = new Admin(DataSource, new AdminOptions { LoggerFactory = throwing });
        await queue.EnqueueAsync("purged", 1, Token);
        await admin.PauseQueueAsync(_queue, Audit(), Token);
        await admin.ResumeQueueAsync(_queue, Audit(), Token);
        Assert.Equal(1L, await admin.PurgeQueueAsync(_queue, Audit(), Token));
        var taskId = (await queue.EnqueueAsync("mail", 1, Token)).TaskId;

        var ran = false;
        await using (var worker = Worker(options => options.LoggerFactory = throwing))
        {
            worker.Handle<int>("mail", (_, _) =>
            {
                ran = true;
                return Task.CompletedTask;
            });
            Assert.True(await worker.RunOnceAsync(Token));
        }

        Assert.True(ran, "the handler did not run");
        await TaskInStateAsync(DataSource, taskId, "succeeded");
        Assert.True(throwing.Calls > 0, "the SDK wrote no record");
    }

    /// <summary>
    /// The execution records come while the handler span is current, as in TypeScript, so a log
    /// bridge gives them the trace context of the attempt. Before, the worker ended the span first.
    /// </summary>
    [Fact]
    public async Task TheExecutionRecordsKeepTheHandlerSpan()
    {
        using var recorder = new TelemetryRecorder();
        var taskId = (await Queue().EnqueueAsync("mail", 1, Token)).TaskId;
        await using var worker = Worker();
        worker.Handle<int>("mail", (_, _) => Task.CompletedTask);
        Assert.True(await worker.RunOnceAsync(Token));

        foreach (var name in new[] { "workhorse.handler.started", "workhorse.task.execution_finished", "workhorse.handler.finished" })
        {
            var record = _log.Single(name, record => Equals(record.Values.GetValueOrDefault("workhorse.task.id"), taskId));
            Assert.Equal("workhorse.handler", record.Span);
        }
    }

    /// <summary>TypeScript writes no life-cycle record for a one-pass call, and the .NET worker wrote two.</summary>
    [Fact]
    public async Task ARunOnceCallWritesNoLifeCycleRecord()
    {
        await Queue().EnqueueAsync("mail", 1, Token);
        await using var worker = Worker();
        worker.Handle<int>("mail", (_, _) => Task.CompletedTask);
        Assert.True(await worker.RunOnceAsync(Token));

        Assert.Empty(_log.Of("workhorse.worker.started"));
        Assert.Empty(_log.Of("workhorse.worker.stopped"));
        Assert.Empty(_log.Of("workhorse.worker.polling_only"));
    }

    /// <summary>
    /// TypeScript warns once when a run starts without a notification subscription. A run under
    /// <c>PollingOnly</c> has none, and the .NET worker did not warn for it.
    /// </summary>
    [Fact]
    public async Task APollingOnlyRunWritesItsWarning()
    {
        await using var worker = Worker();
        var running = new RunningWorker(worker);
        await EventuallyAsync(() => _log.Of("workhorse.worker.started").Count > 0, "the worker starts");
        await running.StopAsync();

        var record = _log.Single("workhorse.worker.polling_only");
        AssertRecord(record, LogLevel.Warning, "workhorse.worker.pool_max_size", "workhorse.worker.queues", "workhorse.worker.id");
        Assert.Equal(worker.WorkerId, record["workhorse.worker.id"]);
        _log.Single("workhorse.worker.stopped");
    }

    /// <summary>A logger factory whose loggers throw for each record.</summary>
    private sealed class ThrowingLoggerFactory : ILoggerFactory, ILogger
    {
        private int _calls;

        internal int Calls => Volatile.Read(ref _calls);

        public ILogger CreateLogger(string categoryName) => this;

        public void AddProvider(ILoggerProvider provider)
        {
        }

        public void Dispose()
        {
        }

        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull => throw new InvalidOperationException("the logger fails");

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            Interlocked.Increment(ref _calls);
            throw new InvalidOperationException($"the logger fails for {eventId.Name}");
        }
    }

    private void AssertTask(LogRecord record, Guid taskId, string workerId)
    {
        Assert.Equal(taskId, record["workhorse.task.id"]);
        Assert.Equal(_queue, record["workhorse.queue.name"]);
        Assert.Equal(1, record["workhorse.task.attempt"]);
        Assert.Equal(workerId, record["workhorse.worker.id"]);
        Assert.IsType<string>(record["workhorse.task.type"]);
    }
}
