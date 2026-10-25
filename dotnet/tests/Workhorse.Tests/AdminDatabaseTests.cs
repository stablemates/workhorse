using System.Text.Json;
using System.Text.Json.Nodes;
using Npgsql;
using Workhorse.Internal;
using Workhorse.Internal.Database;
using Workhorse.Tests.Testing;

namespace Workhorse.Tests;

/// <summary>
/// The C# <c>Admin</c> against PostgreSQL: one or more tests for each operator cell of
/// <c>docs/parity.md</c> that <c>Admin</c> owns, as the Java <c>AdminDatabaseTest</c> has.
/// </summary>
public sealed class AdminDatabaseTests : IClassFixture<ScratchDatabase>
{
    private static readonly Guid NilTask = Guid.Empty;

    private readonly ScratchDatabase _database;
    private readonly Admin _admin;
    private readonly string _queue = Unique("admin");
    private readonly string _worker = Unique("dotnet-admin");
    private readonly AdminSeed _seed;

    public AdminDatabaseTests(ScratchDatabase database)
    {
        _database = database;
        _admin = new Admin(database.DataSource);
        _seed = new AdminSeed(database.DataSource, _queue, _worker);
    }

    private static CancellationToken Token => TestContext.Current.CancellationToken;

    private static string Unique(string prefix) => $"{prefix}-{Guid.NewGuid()}";

    private static void AssertJson(string expected, JsonElement? actual)
    {
        Assert.NotNull(actual);
        using var document = JsonDocument.Parse(expected);
        Assert.True(JsonElement.DeepEquals(document.RootElement, actual.Value), actual.Value.GetRawText());
    }

    private static AdminAudit Audit(string? requestId = null) =>
        new() { Actor = "operator", Reason = "investigating", RequestId = requestId ?? Guid.NewGuid().ToString() };

    // Task lookup, listing, and timeline.

    [Fact]
    public async Task ListsTasksWithFiltersProjectionAndACursor()
    {
        var first = await _seed.EnqueueAsync("a", new JsonObject { ["secret"] = "s", ["n"] = 1 });
        var second = await _seed.EnqueueAsync("b", new JsonObject { ["n"] = 2 });
        var query = new TaskQuery
        {
            Queue = _queue,
            Limit = 1,
            Payload = new TaskPayloadProjection { Include = true, RedactKeys = ["secret"] },
        };

        var page = await _admin.ListTasksAsync(query, Token);
        var item = Assert.Single(page.Items);
        Assert.Equal(second, item.Id);
        Assert.Equal(_queue, item.Queue);
        Assert.Equal("b", item.Type);
        Assert.Equal(TaskState.Ready, item.State);
        Assert.Equal(TaskPayloadStatus.Included, item.PayloadStatus);
        AssertJson("""{"n":2}""", item.Payload);
        Assert.Equal([], item.PrerequisiteTaskIds);
        Assert.Equal(TimeSpan.Zero, item.CreatedAt.Offset);
        Assert.NotNull(page.NextCursor);

        var rest = await _admin.ListTasksAsync(query with { Cursor = page.NextCursor }, Token);
        var last = Assert.Single(rest.Items);
        Assert.Equal(first, last.Id);
        AssertJson("""{"n":1}""", last.Payload);
        Assert.Null(rest.NextCursor);

        var omitted = await _admin.ListTasksAsync(new TaskQuery { Queue = _queue, Type = "a", States = [TaskState.Ready] }, Token);
        var bare = Assert.Single(omitted.Items);
        Assert.Null(bare.Payload);
        Assert.Equal(TaskPayloadStatus.Omitted, bare.PayloadStatus);
        Assert.Empty((await _admin.ListTasksAsync(new TaskQuery { Queue = _queue, States = [TaskState.Failed] }, Token)).Items);
        Assert.Empty((await _admin.ListTasksAsync(
            new TaskQuery { Queue = _queue, CreatedAfter = DateTimeOffset.UtcNow.AddHours(1) }, Token)).Items);
        var window = await _admin.ListTasksAsync(
            new TaskQuery
            {
                Queue = _queue,
                CreatedAfter = DateTimeOffset.UtcNow.AddHours(-1).ToOffset(TimeSpan.FromHours(5)),
                CreatedBefore = DateTimeOffset.UtcNow.AddHours(1),
            },
            Token);
        Assert.Equal(2, window.Items.Count);
    }

    [Fact]
    public async Task ReadsATaskSnapshotAndItsTimeline()
    {
        var taskId = await _seed.EnqueueAsync(_seed.Request("t", new JsonObject { ["n"] = 1 }, tags: ["x"], maxAttempts: 2));
        var fence = await _seed.ClaimAsync(taskId);
        await _seed.SqlAsync(
            SqlCatalogue.UpdateProgressV1,
            Parameters.Uuid(taskId),
            Parameters.Text(_seed.Worker),
            Parameters.Bigint(fence),
            Parameters.Json("""{"done":1}"""));

        var detail = await _admin.GetTaskAsync(taskId, Token);
        Assert.NotNull(detail);
        Assert.Equal(taskId, detail.Id);
        Assert.Equal(_queue, detail.Queue);
        AssertJson("""{"n":1}""", detail.Payload);
        Assert.Equal(["x"], detail.Tags);
        Assert.Equal(TaskState.Active, detail.State);
        Assert.Equal(1, detail.CurrentAttempt);
        Assert.Equal(2, detail.MaxAttempts);
        Assert.Equal(fence, detail.FenceToken);
        Assert.Null(detail.DependencyPolicy);
        Assert.Equal([], detail.ChildTaskIds);
        var progress = detail.Progress;
        Assert.NotNull(progress);
        AssertJson("""{"done":1}""", progress.Value);
        Assert.Equal(1, progress.Revision);
        Assert.Equal(_seed.Worker, progress.WorkerId);
        Assert.Null(await _admin.GetTaskAsync(NilTask, Token));

        var timeline = await _admin.GetTaskTimelineAsync(taskId, new TimelineQuery { Limit = 1 }, Token);
        Assert.Single(timeline.Items);
        var cursor = timeline.NextCursor;
        Assert.NotNull(cursor);
        Assert.Equal(taskId, cursor.TaskId);
        var rest = await _admin.GetTaskTimelineAsync(taskId, new TimelineQuery { Limit = 1000, Cursor = cursor }, Token);
        List<TaskTimelineEntry> entries = [.. timeline.Items, .. rest.Items];
        Assert.Contains(entries, entry => entry.Kind == TaskTimelineKind.Event);
        Assert.Equal(entries.Count, entries.Select(entry => entry.RecordId).Distinct().Count());
        var mismatch = await Assert.ThrowsAsync<ArgumentException>(
            () => _admin.GetTaskTimelineAsync(NilTask, new TimelineQuery { Cursor = cursor }, Token));
        Assert.StartsWith("cursor task_id must match the requested task_id", mismatch.Message, StringComparison.Ordinal);

        var dependent = await _seed.EnqueueAsync(_seed.Request(
            "dependent",
            null,
            dependencies: new JsonObject
            {
                ["prerequisiteTaskIds"] = new JsonArray(taskId.ToString()),
                ["onSuccess"] = "release",
                ["onFailure"] = "cancel",
                ["onCancellation"] = "fail",
            }));
        var blocked = await _admin.GetTaskAsync(dependent, Token);
        Assert.NotNull(blocked);
        Assert.Equal(TaskState.Blocked, blocked.State);
        Assert.Equal(TaskBlockedReason.PrerequisitePending, blocked.BlockedReason);
        Assert.Equal(taskId, blocked.PrerequisiteTaskId);
        Assert.Equal([taskId], blocked.PrerequisiteTaskIds);
        Assert.Equal(
            new TaskDependencyPolicy
            {
                OnSuccess = DependencyPolicy.Release,
                OnFailure = DependencyPolicy.Cancel,
                OnCancellation = DependencyPolicy.Fail,
            },
            blocked.DependencyPolicy);
        var listed = Assert.Single((await _admin.ListTasksAsync(new TaskQuery { Queue = _queue, Type = "dependent" }, Token)).Items);
        Assert.Equal([taskId], listed.PrerequisiteTaskIds);
        Assert.Equal(TaskBlockedReason.PrerequisitePending, listed.BlockedReason);
    }

    [Fact]
    public async Task PagesATimelineAcrossEventsAndFinishedAttempts()
    {
        var taskId = await _seed.EnqueueAsync(_seed.Request("t", new JsonObject(), maxAttempts: 2));
        var first = await _seed.ClaimAsync(taskId);
        await _seed.FailAsync(taskId, first, """{"name":"Boom"}""", 0);
        var second = await _seed.ClaimAsync(taskId);
        await _seed.SqlAsync(
            SqlCatalogue.CompleteV1,
            Parameters.Uuid(taskId),
            Parameters.Text(_seed.Worker),
            Parameters.Bigint(second),
            Parameters.Json("""{"ok":true}"""));

        var entries = new List<TaskTimelineEntry>();
        TaskTimelineCursor? cursor = null;
        do
        {
            var page = await _admin.GetTaskTimelineAsync(taskId, new TimelineQuery { Limit = 1, Cursor = cursor }, Token);
            Assert.True(page.Items.Count <= 1);
            entries.AddRange(page.Items);
            cursor = page.NextCursor;
        }
        while (cursor is not null);

        Assert.Equal(entries.Count, entries.Select(entry => entry.RecordId).Distinct().Count());
        for (var index = 1; index < entries.Count; index++)
        {
            Assert.True(entries[index].OccurredAt <= entries[index - 1].OccurredAt, "newest first");
        }

        Assert.Contains(entries, entry => entry is TaskTimelineEvent);
        var attempts = entries.OfType<TaskTimelineAttempt>().ToList();
        Assert.Equal(["succeeded", "retry"], attempts.Select(attempt => attempt.Outcome));
        var retried = attempts[1];
        Assert.Equal(TaskTimelineKind.Attempt, retried.Kind);
        Assert.Equal(1, retried.Attempt);
        Assert.Equal(first, retried.FenceToken);
        Assert.Equal(_seed.Worker, retried.WorkerId);
        Assert.Equal("Boom", retried.Error?.GetProperty("name").GetString());
        Assert.True(retried.FinishedAt >= retried.ClaimedAt);
        Assert.Equal(2, attempts[0].Attempt);
        Assert.Null(attempts[0].Error);
    }

    [Fact]
    public async Task ReadsAFastTierTaskThatFinishedBeforeAClaim()
    {
        await _admin.SetQueueTierAsync(_queue, QueueTier.Fast, Audit(), Token);
        var taskId = await _seed.EnqueueAsync("fast", new JsonObject());
        await _seed.SqlAsync(SqlCatalogue.CancelV1, Parameters.Uuid(taskId), Parameters.Text("operator"), Parameters.Text("not needed"));

        var detail = await _admin.GetTaskAsync(taskId, Token);
        Assert.NotNull(detail);
        Assert.Equal(TaskState.Canceled, detail.State);
        Assert.Null(detail.FenceToken);
        Assert.Equal(TaskState.Canceled, Assert.Single((await _admin.ListTasksAsync(new TaskQuery { Queue = _queue }, Token)).Items).State);
    }

    // Checkpoint, wait, and human-decision reads.

    [Fact]
    public async Task ReadsCheckpointsProgressAndWaits()
    {
        var taskId = await _seed.EnqueueAsync("t", new JsonObject());
        var fence = await _seed.ClaimAsync(taskId);
        await _seed.SqlAsync(
            SqlCatalogue.SaveCheckpointV1,
            Parameters.Uuid(taskId),
            Parameters.Text(_seed.Worker),
            Parameters.Bigint(fence),
            Parameters.Text("step-1"),
            Parameters.Json("""{"at":1}"""));
        await _seed.SqlAsync(
            SqlCatalogue.UpdateProgressV1,
            Parameters.Uuid(taskId),
            Parameters.Text(_seed.Worker),
            Parameters.Bigint(fence),
            Parameters.Json("""{"pct":50}"""));

        var checkpoint = await _admin.GetCheckpointAsync(taskId, "step-1", Token);
        Assert.NotNull(checkpoint);
        Assert.Equal(taskId, checkpoint.TaskId);
        Assert.Equal("step-1", checkpoint.Name);
        AssertJson("""{"at":1}""", checkpoint.Value);
        Assert.Equal(1, checkpoint.Attempt);
        Assert.Equal(fence, checkpoint.FenceToken);
        Assert.Equal(_seed.Worker, checkpoint.WorkerId);
        Assert.Null(checkpoint.InputFingerprint);
        Assert.Equal(checkpoint.Name, Assert.Single(await _admin.ListCheckpointsAsync(taskId, Token)).Name);
        var fingerprint = new string('a', 64);
        await _seed.SqlAsync(
            SqlCatalogue.SaveCheckpointV2,
            Parameters.Uuid(taskId),
            Parameters.Text(_seed.Worker),
            Parameters.Bigint(fence),
            Parameters.Text("step-2"),
            Parameters.Json("""{"at":2}"""),
            Parameters.Text(fingerprint));
        Assert.Equal(fingerprint, (await _admin.GetCheckpointAsync(taskId, "step-2", Token))?.InputFingerprint);
        Assert.Equal(2, (await _admin.ListCheckpointsAsync(taskId, Token)).Count);
        Assert.Null(await _admin.GetCheckpointAsync(taskId, "missing", Token));

        var progress = await _admin.GetProgressAsync(taskId, Token);
        Assert.NotNull(progress);
        AssertJson("""{"pct":50}""", progress.Value);
        Assert.Equal(1, progress.Revision);
        Assert.Null(await _admin.GetProgressAsync(NilTask, Token));

        await _seed.SqlAsync(
            SqlCatalogue.ScheduleWaitV1,
            Parameters.Uuid(taskId),
            Parameters.Text(_seed.Worker),
            Parameters.Bigint(fence),
            Parameters.Text("nap"),
            Parameters.Bigint(60_000),
            Parameters.Timestamptz(null));
        var wait = await _admin.GetWaitAsync(taskId, "nap", Token);
        Assert.NotNull(wait);
        Assert.Equal(taskId, wait.TaskId);
        Assert.Equal("nap", wait.Name);
        Assert.Equal(TaskWaitMode.Relative, wait.Mode);
        Assert.Equal(TimeSpan.FromMinutes(1), wait.Duration);
        Assert.Equal(_seed.Worker, wait.WorkerId);
        Assert.Equal(wait, Assert.Single(await _admin.ListWaitsAsync(taskId, Token)));
        Assert.Null(await _admin.GetWaitAsync(taskId, "missing", Token));
        await Assert.ThrowsAsync<ArgumentException>(() => _admin.GetWaitAsync(taskId, "", Token));
    }

    [Fact]
    public async Task ListsSignalAndHumanWaitsWithACursor()
    {
        var signalQueue = _queue + "-signal";
        var humanQueue = _queue + "-human";
        for (var index = 0; index < 2; index++)
        {
            var waiting = await _seed.EnqueueAsync(_seed.Request("wait.signal", new JsonObject(), queueName: signalQueue));
            var fence = await _seed.ClaimAsync(waiting, signalQueue);
            await _seed.SqlAsync(
                SqlCatalogue.WaitForSignalV1,
                Parameters.Uuid(waiting),
                Parameters.Text(_seed.Worker),
                Parameters.Bigint(fence),
                Parameters.Text("approved"),
                Parameters.Bigint(60_000));
        }

        var human = await _seed.EnqueueAsync(_seed.Request("wait.human", new JsonObject(), queueName: humanQueue));
        var humanFence = await _seed.ClaimAsync(human, humanQueue);
        await _seed.SqlAsync(
            SqlCatalogue.WaitForHumanV1,
            Parameters.Uuid(human),
            Parameters.Text(_seed.Worker),
            Parameters.Bigint(humanFence),
            Parameters.Text("review"),
            Parameters.Json("""{"question":"ship it?"}"""),
            Parameters.Bigint(60_000));

        var signals = new List<SignalWait>();
        ExternalWaitCursor? cursor = null;
        do
        {
            var page = await _admin.ListSignalWaitsAsync(new SignalWaitQuery { Limit = 1, Cursor = cursor }, Token);
            Assert.True(page.Items.Count <= 1);
            signals.AddRange(page.Items);
            cursor = page.NextCursor;
        }
        while (cursor is not null);

        var mine = signals.Where(wait => wait.Queue == signalQueue).ToList();
        Assert.Equal(["approved", "approved"], mine.Select(wait => wait.Name));
        Assert.All(mine, wait => Assert.Equal("wait.signal", wait.TaskType));

        var humans = (await _admin.ListHumanWaitsAsync(new HumanWaitQuery { Limit = 1000 }, Token)).Items
            .Where(wait => wait.Queue == humanQueue)
            .ToList();
        var decision = Assert.Single(humans);
        Assert.Equal(human, decision.TaskId);
        Assert.Equal("review", decision.Name);
        Assert.Equal("ship it?", decision.Context?.GetProperty("question").GetString());
    }

    // Dead-letter listing and redrive.

    [Fact]
    public async Task ListsDeadLettersAndRedrivesOne()
    {
        var source = await _seed.DeadLetterAsync("boom", ["billing"]);
        var other = await _seed.DeadLetterAsync("other", []);

        var query = new DeadLetterQuery { Queue = _queue, Limit = 1 };
        var letters = await _admin.ListDeadLettersAsync(query, Token);
        Assert.Equal(other, Assert.Single(letters.Items).TaskId);
        Assert.NotNull(letters.NextCursor);
        var rest = await _admin.ListDeadLettersAsync(query with { Limit = 100, Cursor = letters.NextCursor }, Token);
        var letter = Assert.Single(rest.Items);
        Assert.Equal(source, letter.TaskId);
        Assert.Equal("boom", letter.Type);
        Assert.Equal(["billing"], letter.Tags);
        Assert.Equal(0, letter.RedriveCount);
        Assert.Equal("Boom", letter.Error?.GetProperty("name").GetString());
        Assert.Equal(
            source,
            Assert.Single((await _admin.ListDeadLettersAsync(new DeadLetterQuery { Queue = _queue, Tags = ["billing"] }, Token)).Items).TaskId);
        Assert.Empty((await _admin.ListDeadLettersAsync(new DeadLetterQuery { Queue = _queue, ErrorName = "Other" }, Token)).Items);
        Assert.Equal(
            2,
            (await _admin.ListDeadLettersAsync(
                new DeadLetterQuery { Queue = _queue, FinishedAfter = DateTimeOffset.UtcNow.AddHours(-1) }, Token)).Items.Count);

        var request = Audit();
        var result = await _admin.RedriveAsync(source, request, Token);
        Assert.Equal(RedriveStatus.Redriven, result.Status);
        Assert.Equal(source, result.SourceTaskId);
        Assert.Equal(TaskState.Failed, result.SourceState);
        Assert.Equal(TaskState.Ready, result.TargetState);
        Assert.NotNull(result.RequestedAt);
        var replay = await _admin.RedriveAsync(source, request, Token);
        Assert.Equal(RedriveStatus.Replayed, replay.Status);
        Assert.Equal(result.TargetTaskId, replay.TargetTaskId);
        await Assert.ThrowsAsync<RedriveIdempotencyConflictException>(
            () => _admin.RedriveAsync(source, request with { Reason = "a different reason" }, Token));
        Assert.Equal(RedriveStatus.NotFound, (await _admin.RedriveAsync(NilTask, Audit(), Token)).Status);
        Assert.NotNull(result.TargetTaskId);
        Assert.Equal(RedriveStatus.NotFailed, (await _admin.RedriveAsync(result.TargetTaskId.Value, Audit(), Token)).Status);
    }

    [Fact]
    public async Task RedrivesDeadLettersInBulkWithADryRunAndACursor()
    {
        HashSet<Guid> sources = [await _seed.DeadLetterAsync("t", []), await _seed.DeadLetterAsync("t", [])];

        var dry = await _admin.RedriveManyAsync(new RedriveFilter { Queue = _queue, DryRun = true }, Audit(), Token);
        Assert.Equal([RedriveStatus.Eligible, RedriveStatus.Eligible], dry.Results.Select(item => item.Status));
        Assert.True(sources.SetEquals(dry.Results.Select(item => item.SourceTaskId)));

        var filter = new RedriveFilter { Queue = _queue, Limit = 1 };
        var first = await _admin.RedriveManyAsync(filter, Audit(), Token);
        Assert.Equal(RedriveStatus.Redriven, Assert.Single(first.Results).Status);
        Assert.NotNull(first.NextCursor);
        var second = await _admin.RedriveManyAsync(filter with { Cursor = first.NextCursor }, Audit(), Token);
        Assert.Equal(RedriveStatus.Redriven, Assert.Single(second.Results).Status);
        Assert.True(sources.SetEquals([first.Results[0].SourceTaskId, second.Results[0].SourceTaskId]));
    }

    // Durable operator worker pause.

    [Fact]
    public async Task ListsWorkersAndPausesOne()
    {
        await _seed.RegisterWorkerAsync();

        var entry = Assert.Single(await _admin.ListWorkersAsync(Token), candidate => candidate.WorkerId == _seed.Worker);
        Assert.False(entry.Paused);
        Assert.Equal("admin-test-host", entry.Hostname);
        Assert.Equal(42, entry.Pid);
        Assert.Equal([_queue], entry.Queues);
        Assert.Equal(_queue, entry.Queue);
        Assert.Equal(1, entry.Concurrency);
        Assert.False(entry.Draining);

        var paused = await _admin.SetWorkerPausedAsync(_seed.Worker, true, Audit(), Token);
        Assert.NotNull(paused);
        Assert.Equal(_seed.Worker, paused.WorkerId);
        Assert.True(paused.Paused);
        Assert.Equal("operator", paused.PausedBy);
        Assert.Equal("investigating", paused.Reason);
        Assert.NotNull(paused.PausedAt);
        var resumed = await _admin.SetWorkerPausedAsync(_seed.Worker, false, Audit(), Token);
        Assert.NotNull(resumed);
        Assert.False(resumed.Paused);
        Assert.Null(resumed.PausedBy);
        Assert.Null(await _admin.SetWorkerPausedAsync(_seed.Worker + "-missing", true, Audit(), Token));
    }

    // Queue pause, resume, and purge.

    [Fact]
    public async Task PausesResumesAndPurgesAQueue()
    {
        const string Paused = "SELECT CASE WHEN paused THEN 1 ELSE 0 END FROM workhorse.queue_control WHERE queue_name = $1";
        await _admin.PauseQueueAsync(_queue, Audit(), Token);
        Assert.Equal(1, await _seed.ScalarAsync(Paused, _queue));
        await _admin.ResumeQueueAsync(_queue, Audit(), Token);
        Assert.Equal(0, await _seed.ScalarAsync(Paused, _queue));

        for (var index = 0; index < 3; index++)
        {
            await _seed.EnqueueAsync("t", new JsonObject());
        }

        var request = Audit();
        Assert.Equal(3, await _admin.PurgeQueueAsync(_queue, request, Token));
        Assert.Equal(0, await _seed.ScalarAsync("SELECT count(*) FROM workhorse.task WHERE queue_name = $1", _queue));
        await Assert.ThrowsAsync<PurgeIdempotencyConflictException>(() => _admin.PurgeQueueAsync(_queue + "-other", request, Token));
    }

    // Queue tier and history controls.

    [Fact]
    public async Task MovesAQueueBetweenTiersAndSetsItsHistory()
    {
        const string Fast = "SELECT CASE WHEN tier = 'fast' THEN 1 ELSE 0 END FROM workhorse.queue_control WHERE queue_name = $1";
        Assert.Equal(QueueTier.Fast, await _admin.SetQueueTierAsync(_queue, QueueTier.Fast, Audit(), Token));
        Assert.Equal(1, await _seed.ScalarAsync(Fast, _queue));
        Assert.Equal(new QueueHistory { RecordAttempts = true, RecordClaims = false }, await _admin.SetQueueHistoryAsync(_queue, true, null, Token));
        Assert.Equal(new QueueHistory { RecordAttempts = true, RecordClaims = true }, await _admin.SetQueueHistoryAsync(_queue, null, true, Token));
        Assert.Equal(new QueueHistory { RecordAttempts = false, RecordClaims = true }, await _admin.SetQueueHistoryAsync(_queue, false, null, Token));

        await _seed.EnqueueAsync("t", new JsonObject());
        // Npgsql hides the DETAIL of an error by default, so the exception reads its queue and
        // feature from the copy in the HINT. With Include Error Detail, it reads them from the DETAIL.
        var refused = await Assert.ThrowsAsync<FastTierUnsupportedException>(() => _admin.SetQueueTierAsync(_queue, QueueTier.Full, Audit(), Token));
        Assert.Equal(_queue, refused.Queue);
        Assert.Equal("tier change", refused.Feature);
        await using (var detailed = _database.CreateDataSource(builder => builder.IncludeErrorDetail = true))
        {
            var rejected = await Assert.ThrowsAsync<FastTierUnsupportedException>(
                () => new Admin(detailed).SetQueueTierAsync(_queue, QueueTier.Full, Audit(), Token));
            Assert.Equal(_queue, rejected.Queue);
            Assert.Equal("tier change", rejected.Feature);
        }


        Assert.Equal(1, await _seed.ScalarAsync(Fast, _queue));

        await _admin.PurgeQueueAsync(_queue, Audit(), Token);
        Assert.Equal(QueueTier.Full, await _admin.SetQueueTierAsync(_queue, QueueTier.Full, Audit(), Token));
        Assert.Equal(0, await _seed.ScalarAsync(Fast, _queue));
    }

    // Task group cancel, and task group drift listing and repair.

    [Fact]
    public async Task CancelsAGroupReadsItsEventsAndRepairsACounterThatDrifted()
    {
        var callbacks = new JsonObject { ["onFailure"] = _seed.Request("group.failed", null, runAt: false) };
        var members = new JsonArray(_seed.Request("group.member", new JsonObject()), _seed.Request("group.member", new JsonObject()));
        var created = await _seed.SqlAsync(
            SqlCatalogue.CreateTaskGroupV1, Parameters.Json(callbacks.ToJsonString()), Parameters.Json(members.ToJsonString()), Parameters.Boolean(true));
        var groupId = created[0].RequiredUuid("group_id");

        var group = await _admin.GetTaskGroupAsync(groupId, Token);
        Assert.NotNull(group);
        Assert.Equal(TaskGroupState.Sealed, group.State);
        Assert.Equal(2, group.Counts.Total);
        var page = await _admin.ListTaskGroupMembersAsync(groupId, 0, 1, Token);
        Assert.Single(page.Members);
        Assert.NotNull(page.NextAfter);
        Assert.Single((await _admin.ListTaskGroupMembersAsync(groupId, page.NextAfter.Value, Token)).Members);
        Assert.Equal(2, (await _admin.ListTaskGroupMembersAsync(groupId, Token)).Members.Count);
        Assert.Null(await _admin.GetTaskGroupAsync(Guid.NewGuid(), Token));

        var canceled = await _admin.CancelTaskGroupAsync(groupId, Audit(), Token);
        Assert.NotNull(canceled);
        Assert.Equal(TaskGroupState.Finished, canceled.State);
        Assert.Equal(TaskGroupResult.Failed, canceled.Result);
        Assert.Equal(2, canceled.Counts.Canceled);
        Assert.Equal("operator", canceled.CanceledBy);
        Assert.Equal(canceled.FinishedAt, (await _admin.CancelTaskGroupAsync(groupId, Audit(), Token))?.FinishedAt);
        Assert.Null(await _admin.CancelTaskGroupAsync(Guid.NewGuid(), Audit(), Token));
        var events = (await _admin.ListTaskGroupEventsAsync(groupId, Token)).Select(item => item.Type).ToList();
        Assert.Superset(
            new HashSet<TaskGroupEventType>
            {
                TaskGroupEventType.Created,
                TaskGroupEventType.Sealed,
                TaskGroupEventType.Canceled,
                TaskGroupEventType.Finished,
                TaskGroupEventType.CallbackEnqueued,
            },
            events.ToHashSet());
        Assert.Single(await _admin.ListTaskGroupEventsAsync(groupId, 1, Token));

        var open = (await _seed.SqlAsync(
            SqlCatalogue.CreateTaskGroupV1,
            Parameters.Json("{}"),
            Parameters.Json(new JsonArray(_seed.Request("group.member", null)).ToJsonString()),
            Parameters.Boolean(false)))[0].RequiredUuid("group_id");
        // The counts of a group that is not finished live in its shard rows (ADR 0096).
        await using (var drift = _database.DataSource.CreateCommand(
            "UPDATE workhorse.task_group_shard SET succeeded_count = 1 WHERE group_id = $1 AND shard = 0"))
        {
            drift.Parameters.Add(Parameters.Uuid(open));
            Assert.Equal(1, await drift.ExecuteNonQueryAsync(Token));
        }

        var report = Assert.Single(await _admin.ListTaskGroupDriftAsync(Token), item => item.GroupId == open);
        Assert.Equal(new TaskGroupCounts { Total = 1, Succeeded = 1, Failed = 0, Canceled = 0 }, report.Recorded);
        Assert.Equal(TaskGroupState.Open, report.State);
        Assert.Equal(1L, report.Counted.Pending);
        Assert.Equal(TaskGroupRepairAction.Recounted, report.Action);

        var repair = Assert.Single(await _admin.RepairTaskGroupDriftAsync(Audit(), Token), item => item.GroupId == open);
        Assert.Equal(0, repair.RecordedPending);
        Assert.Equal(1, repair.Pending);
        Assert.Equal(TaskGroupRepairAction.Recounted, repair.Action);
        Assert.Equal(0, (await _admin.GetTaskGroupAsync(open, Token))?.Counts.Succeeded);
        Assert.Contains(await _admin.ListTaskGroupEventsAsync(open, Token), item => item.Type == TaskGroupEventType.CounterRepaired);
        var limit = await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => _admin.ListTaskGroupDriftAsync(10_001, Token));
        Assert.Contains("between 1 and 10000", limit.Message, StringComparison.Ordinal);
    }

    // The caller form, the source form, and validation.

    [Fact]
    public async Task JoinsTheCallerTransaction()
    {
        var dead = await _seed.DeadLetterAsync("t", []);
        await using (var connection = await _database.DataSource.OpenConnectionAsync(Token))
        {
            await using var transaction = await connection.BeginTransactionAsync(Token);
            var caller = _admin.Using(connection);
            Assert.Equal(RedriveStatus.Redriven, (await caller.RedriveAsync(dead, Audit(), Token)).Status);
            await caller.PauseQueueAsync(_queue, Audit(), Token);
            await transaction.RollbackAsync(Token);
            Assert.Equal(System.Data.ConnectionState.Open, connection.State);
        }

        Assert.Equal(0, Assert.Single((await _admin.ListDeadLettersAsync(new DeadLetterQuery { Queue = _queue }, Token)).Items).RedriveCount);
        Assert.Equal(0, await _seed.ScalarAsync("SELECT count(*) FROM workhorse.queue_control WHERE queue_name = $1", _queue));
    }

    [Fact]
    public async Task TheSourceFormIgnoresAnAmbientTransactionScope()
    {
        using (new System.Transactions.TransactionScope(System.Transactions.TransactionScopeAsyncFlowOption.Enabled))
        {
            await _admin.PauseQueueAsync(_queue, Audit(), Token);
            // The scope ends without Complete, so it rolls back whatever enlisted in it.
        }

        const string Paused = "SELECT CASE WHEN paused THEN 1 ELSE 0 END FROM workhorse.queue_control WHERE queue_name = $1";
        Assert.Equal(1, await _seed.ScalarAsync(Paused, _queue));
    }

    [Fact]
    public async Task RejectsAnInvalidArgumentBeforeAnyStatement()
    {
        // The connection never opens. A call that reached a statement would throw
        // InvalidOperationException, so each ArgumentException proves that no statement ran.
        await using var closed = _database.DataSource.CreateConnection();
        var admin = _admin.Using(closed);
        var taskId = Guid.NewGuid();
        AdminAudit[] invalid =
        [
            new() { Actor = "", Reason = "reason", RequestId = "request" },
            new() { Actor = "operator", Reason = "", RequestId = "request" },
            new() { Actor = "operator", Reason = "reason", RequestId = "" },
            new() { Actor = new string('x', 201), Reason = "reason", RequestId = "request" },
            new() { Actor = "operator", Reason = new string('x', 2001), RequestId = "request" },
            new() { Actor = "operator", Reason = "reason", RequestId = string.Concat(Enumerable.Repeat("é", 257)) },
            new() { Actor = null!, Reason = "reason", RequestId = "request" },
        ];
        foreach (var audit in invalid)
        {
            await Assert.ThrowsAnyAsync<ArgumentException>(() => admin.RedriveAsync(taskId, audit, Token));
            await Assert.ThrowsAnyAsync<ArgumentException>(() => admin.RedriveManyAsync(new RedriveFilter(), audit, Token));
            await Assert.ThrowsAnyAsync<ArgumentException>(() => admin.PauseQueueAsync(_queue, audit, Token));
            await Assert.ThrowsAnyAsync<ArgumentException>(() => admin.ResumeQueueAsync(_queue, audit, Token));
            await Assert.ThrowsAnyAsync<ArgumentException>(() => admin.PurgeQueueAsync(_queue, audit, Token));
            await Assert.ThrowsAnyAsync<ArgumentException>(() => admin.SetQueueTierAsync(_queue, QueueTier.Fast, audit, Token));
            await Assert.ThrowsAnyAsync<ArgumentException>(() => admin.SetWorkerPausedAsync(_worker, true, audit, Token));
            await Assert.ThrowsAnyAsync<ArgumentException>(() => admin.CancelTaskGroupAsync(taskId, audit, Token));
            await Assert.ThrowsAnyAsync<ArgumentException>(() => admin.RepairTaskGroupDriftAsync(audit, Token));
        }

        await Assert.ThrowsAnyAsync<ArgumentException>(() => admin.RedriveAsync(taskId, null!, Token));
        await Assert.ThrowsAnyAsync<ArgumentException>(() => admin.ResumeQueueAsync("", Audit(), Token));
        await Assert.ThrowsAnyAsync<ArgumentException>(() => admin.SetQueueTierAsync(_queue, (QueueTier)7, Audit(), Token));
        await Assert.ThrowsAnyAsync<ArgumentException>(() => admin.SetQueueHistoryAsync("", true, null, Token));
        await Assert.ThrowsAnyAsync<ArgumentException>(() => admin.ListTasksAsync(new TaskQuery { Limit = 1001 }, Token));
        await Assert.ThrowsAnyAsync<ArgumentException>(() => admin.ListTasksAsync(new TaskQuery { States = [TaskState.Ready, TaskState.Ready] }, Token));
        var now = DateTimeOffset.UtcNow;
        await Assert.ThrowsAnyAsync<ArgumentException>(() => admin.ListTasksAsync(new TaskQuery { CreatedAfter = now, CreatedBefore = now }, Token));
        await Assert.ThrowsAnyAsync<ArgumentException>(
            () => admin.ListTasksAsync(new TaskQuery { Payload = new TaskPayloadProjection { Include = true, MaxBytes = 0 } }, Token));
        await Assert.ThrowsAnyAsync<ArgumentException>(
            () => admin.ListTasksAsync(new TaskQuery { Payload = new TaskPayloadProjection { RedactKeys = ["k", "k"] } }, Token));
        await Assert.ThrowsAnyAsync<ArgumentException>(() => admin.ListTasksAsync(new TaskQuery { Queue = "\ud800" }, Token));
        await Assert.ThrowsAnyAsync<ArgumentException>(() => admin.ListDeadLettersAsync(new DeadLetterQuery { Limit = 0 }, Token));
        await Assert.ThrowsAnyAsync<ArgumentException>(() => admin.ListSignalWaitsAsync(new SignalWaitQuery { Limit = 1001 }, Token));
        await Assert.ThrowsAnyAsync<ArgumentException>(() => admin.ListHumanWaitsAsync(new HumanWaitQuery { Limit = 0 }, Token));
        await Assert.ThrowsAnyAsync<ArgumentException>(() => admin.ListTaskGroupMembersAsync(taskId, -1, 10, Token));
        await Assert.ThrowsAnyAsync<ArgumentException>(() => admin.ListTaskGroupEventsAsync(taskId, 1001, Token));
        await Assert.ThrowsAnyAsync<ArgumentException>(() => admin.GetCheckpointAsync(taskId, "", Token));
        await Assert.ThrowsAnyAsync<ArgumentException>(() => admin.GetTaskTimelineAsync(taskId, new TimelineQuery { Limit = 0 }, Token));

        // A valid call reaches the closed connection.
        await Assert.ThrowsAsync<InvalidOperationException>(() => admin.ListWorkersAsync(Token));
    }

    [Fact]
    public async Task PassesTheCompatibilityCheckInBothForms()
    {
        await _admin.AssertCompatibleAsync(Token);
        await using var connection = await _database.DataSource.OpenConnectionAsync(Token);
        await _admin.Using(connection).AssertCompatibleAsync(Token);
    }

    [Fact]
    public async Task ACanceledTokenStopsTheCall()
    {
        using var canceled = new CancellationTokenSource();
        await canceled.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => _admin.ListWorkersAsync(canceled.Token));
        await using var connection = await _database.DataSource.OpenConnectionAsync(Token);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => _admin.Using(connection).ListWorkersAsync(canceled.Token));
    }

    [Fact]
    public async Task RefusesADatabaseWithoutTheSchemaBeforeTheStatement()
    {
        await using var connection = await _database.DataSource.OpenConnectionAsync(Token);
        await using var transaction = await connection.BeginTransactionAsync(Token);
        await using (var hide = new NpgsqlCommand("ALTER SCHEMA workhorse RENAME TO workhorse_hidden", connection))
        {
            await hide.ExecuteNonQueryAsync(Token);
        }

        var error = await Assert.ThrowsAsync<CompatibilityException>(() => new Admin(_database.DataSource).Using(connection).ListWorkersAsync(Token));
        Assert.Equal(CompatibilityCode.SchemaNotInstalled, error.Code);
        await transaction.RollbackAsync(Token);
    }

    [Fact]
    public void RefusesAMultiplexingDataSource()
    {
        using var multiplexing = NpgsqlDataSource.Create("Host=localhost;Multiplexing=true");
        Assert.Throws<ArgumentException>(() => new Admin(multiplexing));
        Assert.Throws<ArgumentNullException>(() => new Admin(_database.DataSource, null!));
        Assert.Throws<ArgumentNullException>(() => _admin.Using(null!));
    }

    [Fact]
    public async Task ReturnsJsonValuesAsElements()
    {
        var taskId = await _seed.EnqueueAsync("t", null);
        var detail = await _admin.GetTaskAsync(taskId, Token);
        Assert.NotNull(detail);
        Assert.Equal(JsonValueKind.Null, detail.Payload?.ValueKind);
    }
}
