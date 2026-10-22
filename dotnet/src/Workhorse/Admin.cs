using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using Npgsql;
using Workhorse.Internal;
using Workhorse.Internal.Admin;
using Workhorse.Internal.Database;
using Workhorse.Internal.Json;

namespace Workhorse;

/// <summary>
/// Inspects and controls tasks, dead letters, workers, queues, and task groups. The counterpart of
/// Ruby's <c>Stablemates::Workhorse::Admin</c> and the Java <c>Admin</c> (ADR 0107, "Admin
/// surface").
/// </summary>
/// <remarks>
/// <para>
/// An instance from a constructor is the <b>source form</b>. For each call it opens a connection
/// from the data source, runs the statement in autocommit, and disposes the connection. The
/// instance that <see cref="Using"/> returns is the <b>caller form</b>. It runs each call on the
/// caller's open connection, so a control commits and rolls back with the caller's transaction.
/// <c>Admin</c> never opens, closes, begins, commits, or rolls back a caller's connection.
/// </para>
/// <para>
/// Every control except <see cref="SetQueueHistoryAsync"/> takes an <see cref="AdminAudit"/> that
/// PostgreSQL records. An invalid argument, an empty audit field included, throws an
/// <see cref="ArgumentException"/> before any statement runs. A read that can find nothing returns
/// <c>null</c>. <c>Admin</c> runs the compatibility check before its first statement, and caches
/// the result once for the data source and once for each caller connection. For the queue health
/// snapshot, use <c>Queue.HealthAsync</c>.
/// </para>
/// <para>
/// Npgsql gives PostgreSQL's error detail only when the connection string sets
/// <c>Include Error Detail=true</c>. Without it, an exception keeps its type, but its typed fields,
/// such as <see cref="FastTierUnsupportedException.Queue"/>, and the <c>Details</c> of a
/// <see cref="DiagnosedException"/> are empty or <c>"unknown"</c>. <c>Admin</c> does not change the
/// connection string.
/// </para>
/// </remarks>
public sealed class Admin
{
    private const int MaxPageSize = 1000;
    private const int MaxRedriveBatchSize = 1000;
    private const int MaxPayloadBytes = 1_048_576;
    private const int MaxRedactKeys = 50;
    private const int MaxRedactKeyLength = 200;
    private const int MaxDriftLimit = 10_000;
    private const int MaxActorLength = 200;
    private const int MaxReasonLength = 2000;
    private const int MaxRequestIdBytes = 512;
    private const int DefaultGroupPageSize = 100;
    private const int DefaultGroupLimit = 1000;

    private readonly NpgsqlDataSource _dataSource;
    private readonly NpgsqlConnection? _connection;
    private readonly CompatibilityCache _compatibility;

    /// <summary>An admin on <paramref name="dataSource"/>, in the source form.</summary>
    /// <exception cref="ArgumentException">The data source enables Npgsql multiplexing.</exception>
    /// <exception cref="InvalidOperationException">The process enables <c>Npgsql.EnableLegacyTimestampBehavior</c>.</exception>
    public Admin(NpgsqlDataSource dataSource)
        : this(dataSource, new AdminOptions())
    {
    }

    /// <summary>An admin on <paramref name="dataSource"/> with <paramref name="options"/>, in the source form.</summary>
    /// <exception cref="ArgumentException">The data source enables Npgsql multiplexing.</exception>
    /// <exception cref="InvalidOperationException">The process enables <c>Npgsql.EnableLegacyTimestampBehavior</c>.</exception>
    public Admin(NpgsqlDataSource dataSource, AdminOptions options)
    {
        DataSources.Require(dataSource, nameof(dataSource));
        ArgumentNullException.ThrowIfNull(options);
        _dataSource = dataSource;
        _compatibility = new CompatibilityCache();
    }

    private Admin(Admin source, NpgsqlConnection connection)
    {
        _dataSource = source._dataSource;
        _compatibility = source._compatibility;
        _connection = connection;
    }

    /// <summary>
    /// The caller form: an admin with the same methods that runs every call on
    /// <paramref name="connection"/>, inside its open transaction if it has one.
    /// </summary>
    /// <remarks>
    /// The connection must be open. If it is closed, the first call throws
    /// <see cref="InvalidOperationException"/>. The caller's cancellation token reaches Npgsql, so a
    /// cancellation fails the statement and aborts the caller's transaction.
    /// </remarks>
    public Admin Using(NpgsqlConnection connection)
    {
        ArgumentNullException.ThrowIfNull(connection);
        return new Admin(this, connection);
    }

    // ---------------------------------------------------------------------------------------------
    // Compatibility

    /// <summary>
    /// Runs the compatibility check once for the data source, or once for the caller connection.
    /// A refusal is cached; a database error is not.
    /// </summary>
    /// <exception cref="CompatibilityException">PostgreSQL and this client cannot work together.</exception>
    public Task AssertCompatibleAsync(CancellationToken cancellationToken = default) =>
        RunAsync(static (_, _) => Task.FromResult(true), cancellationToken);

    // ---------------------------------------------------------------------------------------------
    // Tasks

    /// <summary>One page of tasks, newest first.</summary>
    public Task<TaskPage> ListTasksAsync(TaskQuery query, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(query);
        var filter = TaskFilter(query);
        Limit(query.Limit, MaxPageSize, "list_tasks limit");
        var projection = Projection(query.Payload);
        var cursor = query.Cursor;
        return RunAsync(
            async (connection, token) =>
            {
                var rows = await Sql.RowsAsync(
                    connection,
                    SqlCatalogue.ListTasks,
                    [
                        Parameters.Json(filter),
                        Parameters.Integer(query.Limit),
                        AdminRows.CursorTime(cursor?.CreatedAt),
                        Parameters.Uuid(cursor?.TaskId),
                        Parameters.Text(cursor?.Signature),
                        Parameters.Json(projection),
                    ],
                    token).ConfigureAwait(false);
                TaskListCursor? next = null;
                if (HasMore(rows))
                {
                    var last = rows[^1];
                    next = new TaskListCursor
                    {
                        CreatedAt = last.RequiredText("cursor_created_at"),
                        TaskId = last.RequiredUuid("task_id"),
                        Signature = last.RequiredText("cursor_signature"),
                    };
                }

                return new TaskPage { Items = [.. rows.Select(TaskItem)], NextCursor = next };
            },
            cancellationToken);
    }

    /// <summary>The snapshot of the task, or <c>null</c> when no such task exists.</summary>
    public Task<TaskDetail?> GetTaskAsync(Guid taskId, CancellationToken cancellationToken = default) =>
        RunAsync(
            async (connection, token) =>
            {
                var rows = await Sql.RowsAsync(connection, SqlCatalogue.GetTask, [Parameters.Uuid(taskId)], token)
                    .ConfigureAwait(false);
                return rows.Count == 0 ? null : TaskDetail(rows[0]);
            },
            cancellationToken);

    /// <summary>One page of the events and attempts of the task, newest first.</summary>
    /// <exception cref="ArgumentException">The cursor belongs to another task.</exception>
    public Task<TimelinePage> GetTaskTimelineAsync(Guid taskId, TimelineQuery query, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(query);
        Limit(query.Limit, MaxPageSize, "get_task_timeline limit");
        var cursor = query.Cursor;
        if (cursor is not null && cursor.TaskId != taskId)
        {
            throw new ArgumentException("cursor task_id must match the requested task_id", nameof(query));
        }

        var cursorKind = cursor is null ? null : Wire.Text(cursor.Kind);
        return RunAsync(
            async (connection, token) =>
            {
                var rows = await Sql.RowsAsync(
                    connection,
                    SqlCatalogue.ListTaskTimeline,
                    [
                        Parameters.Uuid(taskId),
                        Parameters.Integer(query.Limit),
                        AdminRows.CursorTime(cursor?.OccurredAt),
                        Parameters.Text(cursorKind),
                        Parameters.Uuid(cursor?.RecordId),
                    ],
                    token).ConfigureAwait(false);
                TaskTimelineCursor? next = null;
                if (HasMore(rows))
                {
                    var last = rows[^1];
                    next = new TaskTimelineCursor
                    {
                        TaskId = taskId,
                        OccurredAt = last.RequiredText("cursor_occurred_at"),
                        Kind = Wire.Required<TaskTimelineKind>("timeline_kind", last.Text("kind")),
                        RecordId = last.RequiredUuid("record_id"),
                    };
                }

                return new TimelinePage { Items = [.. rows.Select(TimelineEntry)], NextCursor = next };
            },
            cancellationToken);
    }

    // ---------------------------------------------------------------------------------------------
    // Dead letters

    /// <summary>One page of failed tasks, most recently finished first.</summary>
    public Task<DeadLetterPage> ListDeadLettersAsync(DeadLetterQuery query, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(query);
        var filter = DeadLetterFilter(
            query.Queue, query.Type, query.Tags, query.ErrorName, query.FinishedAfter, query.FinishedBefore);
        Limit(query.Limit, MaxRedriveBatchSize, "list_dead_letters limit");
        var cursor = query.Cursor;
        return RunAsync(
            async (connection, token) =>
            {
                var rows = await Sql.RowsAsync(
                    connection,
                    SqlCatalogue.ListDeadLetters,
                    [
                        Parameters.Json(filter),
                        Parameters.Integer(query.Limit),
                        AdminRows.CursorTime(cursor?.FinishedAt),
                        Parameters.Uuid(cursor?.TaskId),
                    ],
                    token).ConfigureAwait(false);
                DeadLetterCursor? next = null;
                if (HasMore(rows))
                {
                    var last = rows[^1];
                    next = new DeadLetterCursor
                    {
                        FinishedAt = last.RequiredText("cursor_finished_at"),
                        TaskId = last.RequiredUuid("task_id"),
                    };
                }

                return new DeadLetterPage { Items = [.. rows.Select(DeadLetter)], NextCursor = next };
            },
            cancellationToken);
    }

    /// <summary>
    /// Enqueues a fresh copy of one failed task. A retry with the same request ID replays the first
    /// result.
    /// </summary>
    /// <exception cref="RedriveIdempotencyConflictException">The request ID was used for another redrive.</exception>
    public Task<RedriveResult> RedriveAsync(Guid sourceTaskId, AdminAudit audit, CancellationToken cancellationToken = default)
    {
        Audit(audit);
        return RunAsync(
            async (connection, token) =>
                RedriveResult(TaskGroups.ExactlyOne(
                    await Sql.RowsAsync(
                        connection,
                        SqlCatalogue.Redrive,
                        [Parameters.Uuid(sourceTaskId), .. AuditParameters(audit)],
                        token).ConfigureAwait(false),
                    "redrive_v1")),
            cancellationToken);
    }

    /// <summary>
    /// Redrives one page of the failed tasks that the filter selects. A dry run reports the result
    /// for each failed task and changes nothing.
    /// </summary>
    public Task<BulkRedrivePage> RedriveManyAsync(RedriveFilter filter, AdminAudit audit, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(filter);
        var document = DeadLetterFilter(
            filter.Queue, filter.Type, filter.Tags, filter.ErrorName, filter.FinishedAfter, filter.FinishedBefore);
        Audit(audit);
        Limit(filter.Limit, MaxRedriveBatchSize, "redrive_many limit");
        var cursor = filter.Cursor;
        return RunAsync(
            async (connection, token) =>
            {
                var rows = await Sql.RowsAsync(
                    connection,
                    SqlCatalogue.RedriveMany,
                    [
                        Parameters.Json(document),
                        Parameters.Integer(filter.Limit),
                        Parameters.Boolean(filter.DryRun),
                        .. AuditParameters(audit),
                        AdminRows.CursorTime(cursor?.FinishedAt),
                        Parameters.Uuid(cursor?.TaskId),
                    ],
                    token).ConfigureAwait(false);
                DeadLetterCursor? next = null;
                if (HasMore(rows))
                {
                    var last = rows[^1];
                    next = new DeadLetterCursor
                    {
                        FinishedAt = last.RequiredText("source_finished_at_cursor"),
                        TaskId = last.RequiredUuid("source_task_id"),
                    };
                }

                return new BulkRedrivePage { Results = [.. rows.Select(RedriveResult)], NextCursor = next };
            },
            cancellationToken);
    }

    // ---------------------------------------------------------------------------------------------
    // Checkpoints, progress, and waits

    /// <summary>The named checkpoint of the task, or <c>null</c>.</summary>
    public Task<TaskCheckpoint?> GetCheckpointAsync(Guid taskId, string name, CancellationToken cancellationToken = default)
    {
        Name(name, nameof(name));
        return RunAsync(
            async (connection, token) =>
            {
                var rows = await Sql.RowsAsync(
                    connection, SqlCatalogue.GetCheckpoint, [Parameters.Uuid(taskId), Parameters.Text(name)], token)
                    .ConfigureAwait(false);
                return rows.Count == 0 ? null : Checkpoint(rows[0]);
            },
            cancellationToken);
    }

    /// <summary>Every checkpoint of the task, oldest first.</summary>
    public Task<IReadOnlyList<TaskCheckpoint>> ListCheckpointsAsync(Guid taskId, CancellationToken cancellationToken = default) =>
        RunAsync<IReadOnlyList<TaskCheckpoint>>(
            async (connection, token) =>
                [.. (await Sql.RowsAsync(connection, SqlCatalogue.ListCheckpoints, [Parameters.Uuid(taskId)], token)
                    .ConfigureAwait(false)).Select(Checkpoint)],
            cancellationToken);

    /// <summary>The latest progress of the task, or <c>null</c>.</summary>
    public Task<TaskProgress?> GetProgressAsync(Guid taskId, CancellationToken cancellationToken = default) =>
        RunAsync(
            async (connection, token) =>
            {
                var rows = await Sql.RowsAsync(connection, SqlCatalogue.GetProgress, [Parameters.Uuid(taskId)], token)
                    .ConfigureAwait(false);
                if (rows.Count == 0)
                {
                    return null;
                }

                var row = rows[0];
                return new TaskProgress
                {
                    TaskId = row.RequiredUuid("task_id"),
                    Value = row.Json("progress_value"),
                    Revision = row.RequiredLong("revision"),
                    Attempt = row.RequiredInteger("attempt"),
                    FenceToken = row.RequiredLong("fence_token"),
                    WorkerId = row.RequiredText("worker_id"),
                    CreatedAt = row.RequiredInstant("created_at"),
                    UpdatedAt = row.RequiredInstant("updated_at"),
                };
            },
            cancellationToken);

    /// <summary>The named durable wait of the task, or <c>null</c>.</summary>
    public Task<TaskWait?> GetWaitAsync(Guid taskId, string name, CancellationToken cancellationToken = default)
    {
        Name(name, nameof(name));
        return RunAsync(
            async (connection, token) =>
            {
                var rows = await Sql.RowsAsync(
                    connection, SqlCatalogue.GetWait, [Parameters.Uuid(taskId), Parameters.Text(name)], token)
                    .ConfigureAwait(false);
                return rows.Count == 0 ? null : TaskWait(rows[0]);
            },
            cancellationToken);
    }

    /// <summary>Every durable wait of the task, oldest first.</summary>
    public Task<IReadOnlyList<TaskWait>> ListWaitsAsync(Guid taskId, CancellationToken cancellationToken = default) =>
        RunAsync<IReadOnlyList<TaskWait>>(
            async (connection, token) =>
                [.. (await Sql.RowsAsync(connection, SqlCatalogue.ListWaits, [Parameters.Uuid(taskId)], token)
                    .ConfigureAwait(false)).Select(TaskWait)],
            cancellationToken);

    /// <summary>One page of the tasks that wait for a signal, oldest first.</summary>
    public Task<SignalWaitPage> ListSignalWaitsAsync(SignalWaitQuery query, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(query);
        Limit(query.Limit, MaxPageSize, "external wait limit");
        return RunAsync(
            async (connection, token) =>
            {
                var rows = await ExternalWaitRowsAsync(connection, SqlCatalogue.ListSignalWaits, query.Limit, query.Cursor, token)
                    .ConfigureAwait(false);
                return new SignalWaitPage
                {
                    Items =
                    [
                        .. rows.Take(query.Limit).Select(row => new SignalWait
                        {
                            TaskId = row.RequiredUuid("task_id"),
                            Queue = row.RequiredText("queue_name"),
                            TaskType = row.RequiredText("task_type"),
                            Name = row.RequiredText("wait_name"),
                            Attempt = row.RequiredInteger("attempt"),
                            CreatedAt = row.RequiredInstant("created_at"),
                            DeadlineAt = row.RequiredInstant("deadline_at"),
                        }),
                    ],
                    NextCursor = ExternalWaitCursor(rows, query.Limit),
                };
            },
            cancellationToken);
    }

    /// <summary>One page of the tasks that wait for a human decision, oldest first.</summary>
    public Task<HumanWaitPage> ListHumanWaitsAsync(HumanWaitQuery query, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(query);
        Limit(query.Limit, MaxPageSize, "external wait limit");
        return RunAsync(
            async (connection, token) =>
            {
                var rows = await ExternalWaitRowsAsync(connection, SqlCatalogue.ListHumanWaits, query.Limit, query.Cursor, token)
                    .ConfigureAwait(false);
                return new HumanWaitPage
                {
                    Items =
                    [
                        .. rows.Take(query.Limit).Select(row => new HumanWait
                        {
                            TaskId = row.RequiredUuid("task_id"),
                            Queue = row.RequiredText("queue_name"),
                            TaskType = row.RequiredText("task_type"),
                            Name = row.RequiredText("wait_name"),
                            Attempt = row.RequiredInteger("attempt"),
                            CreatedAt = row.RequiredInstant("created_at"),
                            DeadlineAt = row.RequiredInstant("deadline_at"),
                            Context = row.Json("context"),
                        }),
                    ],
                    NextCursor = ExternalWaitCursor(rows, query.Limit),
                };
            },
            cancellationToken);
    }

    // ---------------------------------------------------------------------------------------------
    // Workers and queues

    /// <summary>Every registered worker, most recent heartbeat first.</summary>
    public Task<IReadOnlyList<WorkerInfo>> ListWorkersAsync(CancellationToken cancellationToken = default) =>
        RunAsync<IReadOnlyList<WorkerInfo>>(
            async (connection, token) =>
                [
                    .. (await Sql.RowsAsync(connection, SqlCatalogue.ListWorkers, [], token).ConfigureAwait(false))
                        .Select(row => new WorkerInfo
                        {
                            WorkerId = row.RequiredText("worker_id"),
                            Paused = row.RequiredBoolean("paused"),
                            PausedBy = row.Text("paused_by"),
                            Reason = row.Text("paused_reason"),
                            PausedAt = row.Instant("paused_at"),
                            LastHeartbeatAt = row.RequiredInstant("last_heartbeat_at"),
                            InstanceId = row.RequiredUuid("instance_id"),
                            Hostname = row.RequiredText("hostname"),
                            Pid = row.RequiredInteger("pid"),
                            Queues = row.RequiredTextList("queue_names"),
                            Queue = row.RequiredText("queue_name"),
                            Concurrency = row.RequiredInteger("concurrency"),
                            ActiveSlots = row.RequiredInteger("active_slots"),
                            Draining = row.RequiredBoolean("draining"),
                            StartedAt = row.RequiredInstant("started_at"),
                        }),
                ],
            cancellationToken);

    /// <summary>
    /// Pauses or resumes one worker. A paused worker claims no new task. Returns the pause state,
    /// or <c>null</c> when no such worker is registered.
    /// </summary>
    public Task<WorkerPauseResult?> SetWorkerPausedAsync(
        string workerId, bool paused, AdminAudit audit, CancellationToken cancellationToken = default)
    {
        Name(workerId, nameof(workerId));
        Audit(audit);
        return RunAsync(
            async (connection, token) =>
            {
                var rows = await Sql.RowsAsync(
                    connection,
                    SqlCatalogue.SetWorkerPaused,
                    [Parameters.Text(workerId), Parameters.Boolean(paused), .. AuditParameters(audit)],
                    token).ConfigureAwait(false);
                if (rows.Count == 0)
                {
                    return null;
                }

                var row = rows[0];
                return new WorkerPauseResult
                {
                    WorkerId = row.RequiredText("worker_id"),
                    Paused = row.RequiredBoolean("paused"),
                    PausedBy = row.Text("paused_by"),
                    Reason = row.Text("paused_reason"),
                    PausedAt = row.Instant("paused_at"),
                    LastHeartbeatAt = row.RequiredInstant("last_heartbeat_at"),
                };
            },
            cancellationToken);
    }

    /// <summary>Pauses the queue, so no worker claims a task from it.</summary>
    public Task PauseQueueAsync(string queue, AdminAudit audit, CancellationToken cancellationToken = default) =>
        SetQueuePausedAsync(queue, true, audit, cancellationToken);

    /// <summary>Resumes the queue.</summary>
    public Task ResumeQueueAsync(string queue, AdminAudit audit, CancellationToken cancellationToken = default) =>
        SetQueuePausedAsync(queue, false, audit, cancellationToken);

    /// <summary>
    /// Deletes the blocked, ready, and scheduled tasks of the queue, and returns how many tasks it
    /// deleted or canceled. If a task outside the purge waits for a purged task, the purge cancels
    /// that task instead. The count includes the canceled tasks.
    /// </summary>
    /// <remarks>
    /// Do not call it in a transaction that holds task row locks, for example after a cancel or an
    /// enqueue. Two purges run one after the other, so such a transaction can deadlock with another
    /// purge.
    /// </remarks>
    /// <exception cref="PurgeIdempotencyConflictException">The request ID was used for another purge.</exception>
    public Task<long> PurgeQueueAsync(string queue, AdminAudit audit, CancellationToken cancellationToken = default)
    {
        Name(queue, nameof(queue));
        Audit(audit);
        return RunAsync(
            async (connection, token) =>
                TaskGroups.ExactlyOne(
                    await Sql.RowsAsync(
                        connection, SqlCatalogue.PurgeQueue, [Parameters.Text(queue), .. AuditParameters(audit)], token)
                        .ConfigureAwait(false),
                    "purge_queue_v1").RequiredLong("deleted_count"),
            cancellationToken);
    }

    /// <summary>
    /// Moves a queue between the fast and full tiers, and returns the tier after the change. If the
    /// tier differs, Workhorse refuses the change while the queue holds a live task, so a task never
    /// changes tier. PostgreSQL does not record the request ID of the audit.
    /// </summary>
    /// <exception cref="FastTierUnsupportedException">
    /// The tier differs and the queue holds a live task, or a policy of the queue does not support
    /// the fast tier. Its <c>Queue</c> and <c>Feature</c> need <c>Include Error Detail=true</c>.
    /// </exception>
    public Task<QueueTier> SetQueueTierAsync(string queue, QueueTier tier, AdminAudit audit, CancellationToken cancellationToken = default)
    {
        Name(queue, nameof(queue));
        var wire = Wire.Text(tier);
        Audit(audit);
        return RunAsync(
            async (connection, token) =>
                Wire.Required<QueueTier>(
                    "set_queue_tier",
                    TaskGroups.ExactlyOne(
                        await Sql.RowsAsync(
                            connection,
                            SqlCatalogue.SetQueueTier,
                            [Parameters.Text(queue), Parameters.Text(wire), Parameters.Text(audit.Actor), Parameters.Text(audit.Reason)],
                            token).ConfigureAwait(false),
                        "set_queue_tier_v1").Text("tier")),
            cancellationToken);
    }

    /// <summary>
    /// Chooses the history that a fast-tier queue records, and returns both settings after the
    /// change. A <c>null</c> setting keeps its current value.
    /// </summary>
    public Task<QueueHistory> SetQueueHistoryAsync(
        string queue, bool? recordAttempts, bool? recordClaims, CancellationToken cancellationToken = default)
    {
        Name(queue, nameof(queue));
        return RunAsync(
            async (connection, token) =>
            {
                var row = TaskGroups.ExactlyOne(
                    await Sql.RowsAsync(
                        connection,
                        SqlCatalogue.SetQueueHistory,
                        [Parameters.Text(queue), Parameters.Boolean(recordAttempts), Parameters.Boolean(recordClaims)],
                        token).ConfigureAwait(false),
                    "set_queue_history_v1");
                return new QueueHistory
                {
                    RecordAttempts = row.RequiredBoolean("record_attempts"),
                    RecordClaims = row.RequiredBoolean("record_claims"),
                };
            },
            cancellationToken);
    }

    // ---------------------------------------------------------------------------------------------
    // Task groups

    /// <summary>The task group, or <c>null</c> when no such group exists.</summary>
    public Task<TaskGroup?> GetTaskGroupAsync(Guid groupId, CancellationToken cancellationToken = default) =>
        RunAsync(
            async (connection, token) =>
            {
                var rows = await Sql.RowsAsync(connection, SqlCatalogue.GetTaskGroupV1, [Parameters.Uuid(groupId)], token)
                    .ConfigureAwait(false);
                return rows.Count == 0 ? null : TaskGroups.Group(rows[0]);
            },
            cancellationToken);

    /// <summary>The first page of at most 100 member tasks.</summary>
    public Task<TaskGroupMemberPage> ListTaskGroupMembersAsync(Guid groupId, CancellationToken cancellationToken = default) =>
        ListTaskGroupMembersAsync(groupId, 0, DefaultGroupPageSize, cancellationToken);

    /// <summary>One page of at most 100 member tasks after the position <paramref name="after"/>.</summary>
    public Task<TaskGroupMemberPage> ListTaskGroupMembersAsync(Guid groupId, long after, CancellationToken cancellationToken = default) =>
        ListTaskGroupMembersAsync(groupId, after, DefaultGroupPageSize, cancellationToken);

    /// <summary>
    /// One page of at most <paramref name="limit"/> member tasks after the position
    /// <paramref name="after"/>, in the order they joined.
    /// </summary>
    /// <param name="groupId">The group.</param>
    /// <param name="after">The position after which the page starts, 0 for the first page.</param>
    /// <param name="limit">The page size, 1 to 1,000.</param>
    /// <param name="cancellationToken">The token that cancels the call.</param>
    public Task<TaskGroupMemberPage> ListTaskGroupMembersAsync(
        Guid groupId, long after, int limit, CancellationToken cancellationToken = default)
    {
        Limit(limit, MaxPageSize, "list_task_group_members limit");
        if (after is < 0 or > int.MaxValue)
        {
            throw new ArgumentOutOfRangeException(nameof(after), after, "after must be a non-negative integer within the integer range");
        }

        return RunAsync(
            (connection, token) => TaskGroups.MemberPageAsync(connection, groupId, after, limit, token),
            cancellationToken);
    }

    /// <summary>The first 1,000 events of the group, in time order.</summary>
    public Task<IReadOnlyList<TaskGroupEvent>> ListTaskGroupEventsAsync(Guid groupId, CancellationToken cancellationToken = default) =>
        ListTaskGroupEventsAsync(groupId, DefaultGroupLimit, cancellationToken);

    /// <summary>
    /// At most <paramref name="limit"/> events of the group in time order: create, seal, cancel,
    /// finish, callbacks, and repairs.
    /// </summary>
    /// <param name="groupId">The group.</param>
    /// <param name="limit">The number of events, 1 to 1,000.</param>
    /// <param name="cancellationToken">The token that cancels the call.</param>
    public Task<IReadOnlyList<TaskGroupEvent>> ListTaskGroupEventsAsync(
        Guid groupId, int limit, CancellationToken cancellationToken = default)
    {
        Limit(limit, MaxPageSize, "list_task_group_events limit");
        return RunAsync<IReadOnlyList<TaskGroupEvent>>(
            async (connection, token) =>
                [
                    .. (await Sql.RowsAsync(
                        connection,
                        SqlCatalogue.ListTaskGroupEventsV1,
                        [Parameters.Uuid(groupId), Parameters.Integer(limit)],
                        token).ConfigureAwait(false))
                        .Select(row => new TaskGroupEvent
                        {
                            Id = row.RequiredUuid("event_id"),
                            Type = Wire.Required<TaskGroupEventType>("task_group_event", row.Text("event_type")),
                            Details = row.Json("details"),
                            OccurredAt = row.RequiredInstant("occurred_at"),
                        }),
                ],
            cancellationToken);
    }

    /// <summary>
    /// Seals an open group, so no task can join it after this call, not even from a running member
    /// task. Then cancels every member task that is not terminal. The canceled member tasks count as
    /// not succeeded, so the group finishes as usual and its finish and failure callbacks run. A
    /// finished group stays unchanged. Returns the group, or <c>null</c> for an unknown group.
    /// </summary>
    public Task<TaskGroup?> CancelTaskGroupAsync(Guid groupId, AdminAudit audit, CancellationToken cancellationToken = default)
    {
        Audit(audit);
        return RunAsync(
            async (connection, token) =>
            {
                var rows = await Sql.RowsAsync(
                    connection,
                    SqlCatalogue.CancelTaskGroupV1,
                    [Parameters.Uuid(groupId), .. AuditParameters(audit)],
                    token).ConfigureAwait(false);
                return rows.Count == 0 ? null : TaskGroups.Group(rows[0]);
            },
            cancellationToken);
    }

    /// <summary>At most 1,000 groups whose counters drifted.</summary>
    public Task<IReadOnlyList<TaskGroupDrift>> ListTaskGroupDriftAsync(CancellationToken cancellationToken = default) =>
        ListTaskGroupDriftAsync(DefaultGroupLimit, cancellationToken);

    /// <summary>
    /// The groups that are not finished and whose counters disagree with their member outcomes, and
    /// the sealed groups with no pending member. It writes nothing, so it is the dry run of
    /// <see cref="RepairTaskGroupDriftAsync(AdminAudit, int, CancellationToken)"/>.
    /// </summary>
    /// <param name="limit">The number of groups, 1 to 10,000.</param>
    /// <param name="cancellationToken">The token that cancels the call.</param>
    public Task<IReadOnlyList<TaskGroupDrift>> ListTaskGroupDriftAsync(int limit, CancellationToken cancellationToken = default)
    {
        Limit(limit, MaxDriftLimit, "list_task_group_drift limit");
        return RunAsync<IReadOnlyList<TaskGroupDrift>>(
            async (connection, token) =>
                [
                    .. (await Sql.RowsAsync(
                        connection, SqlCatalogue.ListTaskGroupDriftV1, [Parameters.Integer(limit)], token).ConfigureAwait(false))
                        .Select(row => new TaskGroupDrift
                        {
                            GroupId = row.RequiredUuid("group_id"),
                            State = Wire.Required<TaskGroupState>("task_group_state", row.Text("state")),
                            Recorded = new TaskGroupCounts
                            {
                                Total = row.RequiredLong("recorded_total"),
                                Succeeded = row.RequiredLong("recorded_succeeded"),
                                Failed = row.RequiredLong("recorded_failed"),
                                Canceled = row.RequiredLong("recorded_canceled"),
                            },
                            Counted = new TaskGroupCounts
                            {
                                Total = row.RequiredLong("total"),
                                Succeeded = row.RequiredLong("succeeded"),
                                Failed = row.RequiredLong("failed"),
                                Canceled = row.RequiredLong("canceled"),
                                Pending = row.RequiredLong("pending"),
                            },
                            Action = RepairAction(row),
                        }),
                ],
            cancellationToken);
    }

    /// <summary>Repairs at most 1,000 drifted groups.</summary>
    public Task<IReadOnlyList<TaskGroupRepair>> RepairTaskGroupDriftAsync(AdminAudit audit, CancellationToken cancellationToken = default) =>
        RepairTaskGroupDriftAsync(audit, DefaultGroupLimit, cancellationToken);

    /// <summary>
    /// Recounts each group that <see cref="ListTaskGroupDriftAsync(int, CancellationToken)"/> reports
    /// from its member outcomes, and finishes a sealed group with no pending member. The
    /// <c>counter_repaired</c> event of each group records the audit. Returns one repair for each
    /// group.
    /// </summary>
    /// <param name="audit">The audit of the repair.</param>
    /// <param name="limit">The number of groups, 1 to 10,000.</param>
    /// <param name="cancellationToken">The token that cancels the call.</param>
    public Task<IReadOnlyList<TaskGroupRepair>> RepairTaskGroupDriftAsync(
        AdminAudit audit, int limit, CancellationToken cancellationToken = default)
    {
        Audit(audit);
        Limit(limit, MaxDriftLimit, "repair_task_group_drift limit");
        return RunAsync<IReadOnlyList<TaskGroupRepair>>(
            async (connection, token) =>
                [
                    .. (await Sql.RowsAsync(
                        connection,
                        SqlCatalogue.RepairTaskGroupDriftV1,
                        [Parameters.Integer(limit), .. AuditParameters(audit)],
                        token).ConfigureAwait(false))
                        .Select(row => new TaskGroupRepair
                        {
                            GroupId = row.RequiredUuid("group_id"),
                            RecordedPending = row.RequiredLong("recorded_pending"),
                            Pending = row.RequiredLong("pending"),
                            Action = RepairAction(row),
                        }),
                ],
            cancellationToken);
    }

    // ---------------------------------------------------------------------------------------------
    // Validation

    private static void Audit(AdminAudit audit)
    {
        ArgumentNullException.ThrowIfNull(audit);
        ArgumentNullException.ThrowIfNull(audit.Actor, nameof(audit));
        ArgumentNullException.ThrowIfNull(audit.Reason, nameof(audit));
        ArgumentNullException.ThrowIfNull(audit.RequestId, nameof(audit));
        var actor = audit.Actor.EnumerateRunes().Count();
        if (actor is < 1 or > MaxActorLength)
        {
            throw new ArgumentException($"actor must contain between 1 and {MaxActorLength} characters", nameof(audit));
        }

        var reason = audit.Reason.EnumerateRunes().Count();
        if (reason is < 1 or > MaxReasonLength)
        {
            throw new ArgumentException($"reason must contain between 1 and {MaxReasonLength} characters", nameof(audit));
        }

        var requestId = Encoding.UTF8.GetByteCount(audit.RequestId);
        if (requestId is < 1 or > MaxRequestIdBytes)
        {
            throw new ArgumentException($"request_id must contain between 1 and {MaxRequestIdBytes} UTF-8 bytes", nameof(audit));
        }
    }

    private static void Limit(int value, int maximum, string label)
    {
        if (value < 1 || value > maximum)
        {
            throw new ArgumentOutOfRangeException(
                nameof(value), value, string.Create(CultureInfo.InvariantCulture, $"{label} must be an integer between 1 and {maximum}"));
        }
    }

    private static void Name(string value, string parameter)
    {
        ArgumentNullException.ThrowIfNull(value, parameter);
        if (value.Length == 0)
        {
            throw new ArgumentException($"{parameter} must be a non-empty string", parameter);
        }
    }

    private static string TaskFilter(TaskQuery query)
    {
        ArgumentNullException.ThrowIfNull(query.States, nameof(query));
        var states = new HashSet<TaskState>();
        var wire = new JsonArray();
        foreach (var state in query.States)
        {
            if (!states.Add(state))
            {
                throw new ArgumentException("states must be unique", nameof(query));
            }

            wire.Add(Wire.Text(state));
        }

        if (query.CreatedAfter is { } after && query.CreatedBefore is { } before && after >= before)
        {
            throw new ArgumentException("created_after must be earlier than created_before", nameof(query));
        }

        var filter = new JsonObject();
        if (query.Queue is not null)
        {
            filter["queue"] = Utf16.Require(query.Queue, "queue");
        }

        if (query.Type is not null)
        {
            filter["type"] = Utf16.Require(query.Type, "type");
        }

        if (wire.Count > 0)
        {
            filter["states"] = wire;
        }

        if (query.CreatedAfter is { } createdAfter)
        {
            filter["createdAfter"] = Values.Timestamp(createdAfter);
        }

        if (query.CreatedBefore is { } createdBefore)
        {
            filter["createdBefore"] = Values.Timestamp(createdBefore);
        }

        return Values.Write(filter);
    }

    private static string Projection(TaskPayloadProjection payload)
    {
        ArgumentNullException.ThrowIfNull(payload);
        if (payload.MaxBytes is < 1 or > MaxPayloadBytes)
        {
            throw new ArgumentOutOfRangeException(nameof(payload), payload.MaxBytes, "payload max_bytes is out of range");
        }

        ArgumentNullException.ThrowIfNull(payload.RedactKeys, nameof(payload));
        if (payload.RedactKeys.Count > MaxRedactKeys)
        {
            throw new ArgumentException($"payload redact_keys must contain at most {MaxRedactKeys} keys", nameof(payload));
        }

        var keys = new JsonArray();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var key in payload.RedactKeys)
        {
            var length = key?.EnumerateRunes().Count() ?? 0;
            if (key is null || length is < 1 or > MaxRedactKeyLength)
            {
                throw new ArgumentException(
                    $"payload redact_keys must contain strings of 1 to {MaxRedactKeyLength} characters", nameof(payload));
            }

            if (!seen.Add(key))
            {
                throw new ArgumentException("payload redact_keys must be unique", nameof(payload));
            }

            keys.Add(Utf16.Require(key, "payload redact key"));
        }

        return Values.Write(new JsonObject
        {
            ["include"] = payload.Include,
            ["maxBytes"] = payload.MaxBytes,
            ["redactKeys"] = keys,
        });
    }

    private static string DeadLetterFilter(
        string? queue,
        string? type,
        IReadOnlyCollection<string> tags,
        string? errorName,
        DateTimeOffset? finishedAfter,
        DateTimeOffset? finishedBefore)
    {
        ArgumentNullException.ThrowIfNull(tags);
        var filter = new JsonObject();
        if (queue is not null)
        {
            filter["queue"] = Utf16.Require(queue, "queue");
        }

        if (type is not null)
        {
            filter["type"] = Utf16.Require(type, "type");
        }

        if (tags.Count > 0)
        {
            var array = new JsonArray();
            foreach (var tag in tags)
            {
                array.Add(Utf16.Require(tag ?? throw new ArgumentException("tags must not contain null", nameof(tags)), "tag"));
            }

            filter["tags"] = array;
        }

        if (!string.IsNullOrEmpty(errorName))
        {
            filter["errorName"] = Utf16.Require(errorName, "error name");
        }

        if (finishedAfter is { } after)
        {
            filter["finishedAfter"] = Values.Timestamp(after);
        }

        if (finishedBefore is { } before)
        {
            filter["finishedBefore"] = Values.Timestamp(before);
        }

        return Values.Write(filter);
    }

    private static NpgsqlParameter[] AuditParameters(AdminAudit audit) =>
        [Parameters.Text(audit.Actor), Parameters.Text(audit.Reason), Parameters.Text(audit.RequestId)];

    // ---------------------------------------------------------------------------------------------
    // Rows

    private async Task SetQueuePausedAsync(string queue, bool paused, AdminAudit audit, CancellationToken cancellationToken)
    {
        Name(queue, nameof(queue));
        Audit(audit);
        await RunAsync(
            (connection, token) => Sql.RowsAsync(
                connection,
                SqlCatalogue.SetQueuePaused,
                [Parameters.Text(queue), Parameters.Boolean(paused), .. AuditParameters(audit)],
                token),
            cancellationToken).ConfigureAwait(false);
    }

    private static Task<IReadOnlyList<Row>> ExternalWaitRowsAsync(
        NpgsqlConnection connection,
        SqlCatalogue.Statement statement,
        int limit,
        ExternalWaitCursor? cursor,
        CancellationToken cancellationToken) =>
        // The read of one more wait than the page tells a full last page from a page with more.
        Sql.RowsAsync(
            connection,
            statement,
            [
                Parameters.Integer(limit + 1),
                AdminRows.CursorTime(cursor?.CreatedAt),
                Parameters.Uuid(cursor?.TaskId),
                Parameters.Text(cursor?.Name),
            ],
            cancellationToken);

    private static ExternalWaitCursor? ExternalWaitCursor(IReadOnlyList<Row> rows, int limit)
    {
        if (rows.Count <= limit)
        {
            return null;
        }

        var last = rows[limit - 1];
        return new ExternalWaitCursor
        {
            CreatedAt = last.RequiredText("cursor_created_at"),
            TaskId = last.RequiredUuid("task_id"),
            Name = last.RequiredText("wait_name"),
        };
    }

    private static TaskListItem TaskItem(Row row) => new()
    {
        Id = row.RequiredUuid("task_id"),
        Queue = row.RequiredText("queue_name"),
        Type = row.RequiredText("task_type"),
        ConcurrencyKey = row.Text("concurrency_key"),
        Priority = row.RequiredInteger("priority"),
        Tags = row.RequiredTextList("tags"),
        State = State(row),
        PrerequisiteTaskId = row.Uuid("prerequisite_task_id"),
        PrerequisiteTaskIds = row.RequiredUuidList("prerequisite_task_ids"),
        DependencyPolicy = DependencyPolicy(row),
        BlockedReason = BlockedReason(row),
        ParentTaskId = row.Uuid("parent_task_id"),
        ChildTaskIds = row.RequiredUuidList("child_task_ids"),
        CurrentAttempt = row.RequiredInteger("current_attempt"),
        MaxAttempts = row.RequiredInteger("max_attempts"),
        RetryPolicy = row.Json("retry_policy"),
        DeadlineAt = row.Instant("deadline_at"),
        ExecutionTimeout = row.Milliseconds("execution_timeout_ms"),
        RunAt = row.RequiredInstant("run_at"),
        CancelRequestedAt = row.Instant("cancel_requested_at"),
        CancelRequestedBy = row.Text("cancel_requested_by"),
        CancelReason = row.Text("cancel_reason"),
        CreatedAt = row.RequiredInstant("created_at"),
        UpdatedAt = row.RequiredInstant("updated_at"),
        Payload = row.Json("payload"),
        PayloadStatus = Wire.Required<TaskPayloadStatus>("task_payload_status", row.Text("payload_status")),
        PayloadBytes = row.Long("payload_bytes"),
    };

    private static TaskDetail TaskDetail(Row row)
    {
        var id = row.RequiredUuid("id");
        TaskProgress? progress = null;
        if (row.Text("progress_revision") is not null)
        {
            progress = new TaskProgress
            {
                TaskId = id,
                Value = row.Json("progress_value"),
                Revision = row.RequiredLong("progress_revision"),
                Attempt = row.RequiredInteger("progress_attempt"),
                FenceToken = row.RequiredLong("progress_fence_token"),
                WorkerId = row.RequiredText("progress_worker_id"),
                CreatedAt = row.RequiredInstant("progress_created_at"),
                UpdatedAt = row.RequiredInstant("progress_updated_at"),
            };
        }

        return new TaskDetail
        {
            Id = id,
            Queue = row.RequiredText("queue_name"),
            Type = row.RequiredText("task_type"),
            ConcurrencyKey = row.Text("concurrency_key"),
            Priority = row.RequiredInteger("priority"),
            Payload = row.Json("payload"),
            ContractVersion = row.Text("contract_version"),
            Tags = row.RequiredTextList("tags"),
            State = State(row),
            PrerequisiteTaskId = row.Uuid("prerequisite_task_id"),
            PrerequisiteTaskIds = row.RequiredUuidList("prerequisite_task_ids"),
            DependencyPolicy = DependencyPolicy(row),
            BlockedReason = BlockedReason(row),
            ParentTaskId = row.Uuid("parent_task_id"),
            ChildTaskIds = row.RequiredUuidList("child_task_ids"),
            CurrentAttempt = row.RequiredInteger("current_attempt"),
            MaxAttempts = row.RequiredInteger("max_attempts"),
            RetryPolicy = row.Json("retry_policy"),
            DeadlineAt = row.Instant("deadline_at"),
            ExecutionTimeout = row.Milliseconds("execution_timeout_ms"),
            FenceToken = row.Long("version"),
            RunAt = row.RequiredInstant("run_at"),
            Result = row.Json("result"),
            Error = row.Json("error"),
            CancelRequestedAt = row.Instant("cancel_requested_at"),
            CancelRequestedBy = row.Text("cancel_requested_by"),
            CancelReason = row.Text("cancel_reason"),
            Progress = progress,
            CreatedAt = row.RequiredInstant("created_at"),
            UpdatedAt = row.RequiredInstant("updated_at"),
        };
    }

    private static TaskTimelineEntry TimelineEntry(Row row)
    {
        var recordId = row.RequiredUuid("record_id");
        var priority = row.RequiredInteger("priority");
        var attempt = row.Integer("attempt");
        var occurredAt = row.RequiredInstant("occurred_at");
        return Wire.Required<TaskTimelineKind>("timeline_kind", row.Text("kind")) switch
        {
            TaskTimelineKind.Event => new TaskTimelineEvent
            {
                RecordId = recordId,
                Priority = priority,
                Attempt = attempt,
                OccurredAt = occurredAt,
                EventType = row.RequiredText("event_type"),
                Details = row.Json("details"),
            },
            _ => new TaskTimelineAttempt
            {
                RecordId = recordId,
                Priority = priority,
                Attempt = attempt,
                OccurredAt = occurredAt,
                FenceToken = row.RequiredLong("fence_token"),
                WorkerId = row.RequiredText("worker_id"),
                Outcome = row.RequiredText("outcome"),
                StartedAt = row.RequiredInstant("started_at"),
                ClaimedAt = row.RequiredInstant("claimed_at"),
                FinishedAt = row.RequiredInstant("finished_at"),
                Error = row.Json("error"),
            },
        };
    }

    private static DeadLetter DeadLetter(Row row) => new()
    {
        TaskId = row.RequiredUuid("task_id"),
        Queue = row.RequiredText("queue_name"),
        Type = row.RequiredText("task_type"),
        ConcurrencyKey = row.Text("concurrency_key"),
        Priority = row.RequiredInteger("priority"),
        Payload = row.Json("payload"),
        Tags = row.RequiredTextList("tags"),
        CurrentAttempt = row.RequiredInteger("current_attempt"),
        MaxAttempts = row.RequiredInteger("max_attempts"),
        RetryPolicy = row.Json("retry_policy"),
        DeadlineAt = row.Instant("deadline_at"),
        ExecutionTimeout = row.Milliseconds("execution_timeout_ms"),
        Error = row.Json("error"),
        FinishedAt = row.RequiredInstant("finished_at"),
        RedriveCount = row.RequiredLong("redrive_count"),
    };

    private static RedriveResult RedriveResult(Row row)
    {
        var source = row.Text("source_state");
        var target = row.Text("target_state");
        return new RedriveResult
        {
            Status = Wire.Required<RedriveStatus>("redrive", row.Text("status")),
            SourceTaskId = row.RequiredUuid("source_task_id"),
            TargetTaskId = row.Uuid("target_task_id"),
            SourceState = source is null ? null : Wire.Required<TaskState>("state", source),
            TargetState = target is null ? null : Wire.Required<TaskState>("state", target),
            RequestedAt = row.Instant("requested_at"),
        };
    }

    private static TaskCheckpoint Checkpoint(Row row) => new()
    {
        TaskId = row.RequiredUuid("task_id"),
        Name = row.RequiredText("checkpoint_name"),
        Value = row.Json("checkpoint_value"),
        Attempt = row.RequiredInteger("attempt"),
        FenceToken = row.RequiredLong("fence_token"),
        WorkerId = row.RequiredText("worker_id"),
        CreatedAt = row.RequiredInstant("created_at"),
        InputFingerprint = row.Text("input_fingerprint"),
    };

    private static TaskWait TaskWait(Row row) => new()
    {
        TaskId = row.RequiredUuid("task_id"),
        Name = row.RequiredText("wait_name"),
        Mode = Wire.Required<TaskWaitMode>("wait_mode", row.Text("mode")),
        Duration = row.Milliseconds("duration_ms"),
        RequestedWakeAt = row.Instant("requested_wake_at"),
        WakeAt = row.RequiredInstant("wake_at"),
        Attempt = row.RequiredInteger("attempt"),
        FenceToken = row.RequiredLong("fence_token"),
        WorkerId = row.RequiredText("worker_id"),
        CreatedAt = row.RequiredInstant("created_at"),
    };

    private static TaskState State(Row row) => Wire.Required<TaskState>("state", row.Text("state"));

    private static TaskDependencyPolicy? DependencyPolicy(Row row)
    {
        var onFailure = row.Text("dependency_on_failure");
        if (onFailure is null)
        {
            return null;
        }

        return new TaskDependencyPolicy
        {
            OnSuccess = Wire.Required<DependencyPolicy>("dependency_policy", row.Text("dependency_on_success")),
            OnFailure = Wire.Required<DependencyPolicy>("dependency_policy", onFailure),
            OnCancellation = Wire.Required<DependencyPolicy>("dependency_policy", row.Text("dependency_on_cancellation")),
        };
    }

    private static TaskBlockedReason? BlockedReason(Row row)
    {
        var reason = row.Text("blocked_reason");
        return reason is null ? null : Wire.Required<TaskBlockedReason>("blocked_reason", reason);
    }

    private static TaskGroupRepairAction RepairAction(Row row) =>
        Wire.Required<TaskGroupRepairAction>("task_group_repair", row.Text("action"));

    /// <summary>True when the last row of a page reports that another page follows.</summary>
    private static bool HasMore(IReadOnlyList<Row> rows) => rows.Count > 0 && rows[^1].RequiredBoolean("has_more");

    // ---------------------------------------------------------------------------------------------
    // Connections

    /// <summary>
    /// Runs <paramref name="body"/> on the caller's connection, or on a connection from the data
    /// source. It runs the compatibility check first.
    /// </summary>
    private Task<T> RunAsync<T>(Func<NpgsqlConnection, CancellationToken, Task<T>> body, CancellationToken cancellationToken) =>
        DataSources.RunAsync(
            _dataSource,
            _connection,
            async (connection, caller) =>
            {
                await _compatibility.AssertAsync(connection, caller, cancellationToken).ConfigureAwait(false);
                return await body(connection, cancellationToken).ConfigureAwait(false);
            },
            cancellationToken);
}
