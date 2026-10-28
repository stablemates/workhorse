using System.Diagnostics.CodeAnalysis;
using System.Text.Json;
using System.Text.Json.Nodes;
using Npgsql;
using Workhorse.Internal;
using Workhorse.Internal.Contracts;
using Workhorse.Internal.Database;
using Workhorse.Internal.Json;
using Workhorse.Internal.Telemetry;

namespace Workhorse;

/// <summary>
/// Submits and controls tasks. It is the counterpart of Ruby's <c>Stablemates::Workhorse::Queue</c>
/// and of the JVM <c>Queue</c>.
/// </summary>
/// <remarks>
/// <para>
/// A queue has two forms (ADR 0107, "Connection model"). The <b>source form</b>, from the
/// constructor, opens a connection from the data source for each call, and runs the call in
/// autocommit inside a suppressed <c>TransactionScope</c>. The <b>caller form</b>, from
/// <see cref="Using"/>, runs each call on the open connection of the caller, inside its
/// transaction. It never opens, closes, begins, commits, or rolls back that connection.
/// </para>
/// <para>
/// The queue runs the startup compatibility check before its first statement. It caches the result
/// once for the data source, and once for each caller connection. A refusal is cached; a driver
/// error is not. An invalid argument throws <see cref="ArgumentException"/> before any statement runs.
/// </para>
/// </remarks>
[SuppressMessage("Naming", "CA1711:Identifiers should not have incorrect suffix", Justification = "ADR 0107 names the type Queue, as every other SDK does.")]
public sealed partial class Queue
{
    private const long DefaultIdempotencyTtlMs = 86_400_000L;
    private const int DefaultMaxAttempts = 25;
    private const int MaxTaskDependencies = 100;
    private const int MaxExternalValueBytes = 65_536;
    private const long MaxDurationMs = 31_536_000_000L;
    private const long MaxRateIntervalMs = 86_400_000L;
    private const int MaxPolicyValue = 1_000_000;
    private const int MaxPolicyDefinitions = 10_000;
    private const int MaxNameBytes = 256;
    private const int MaxKeyBytes = 512;
    private const int MaxTags = 20;
    private const int MaxTagLength = 100;
    private const int MaxPageSize = 1000;
    private const int DefaultPageSize = 100;
    private const string Whitespace = "\0\t\n\u000B\f\r ";

    private readonly NpgsqlDataSource _dataSource;
    private readonly NpgsqlConnection? _caller;
    private readonly Shared _shared;

    /// <summary>A queue on <paramref name="dataSource"/> with the default options.</summary>
    /// <exception cref="ArgumentException">The data source uses multiplexing.</exception>
    /// <exception cref="InvalidOperationException">The process sets <c>Npgsql.EnableLegacyTimestampBehavior</c>.</exception>
    public Queue(NpgsqlDataSource dataSource)
        : this(dataSource, new QueueOptions())
    {
    }

    /// <summary>A queue on <paramref name="dataSource"/>.</summary>
    /// <exception cref="ArgumentException">The data source uses multiplexing, or an option is invalid.</exception>
    /// <exception cref="InvalidOperationException">The process sets <c>Npgsql.EnableLegacyTimestampBehavior</c>.</exception>
    public Queue(NpgsqlDataSource dataSource, QueueOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        _dataSource = DataSources.Require(dataSource, nameof(dataSource));
        var defaultQueue = options.DefaultQueue ?? throw new ArgumentException("default queue must be a String", nameof(options));
        RequiredBytes(Utf16.Require(defaultQueue, "default queue"), MaxNameBytes, "default queue");
        _shared = new Shared(defaultQueue, new JsonCodec(options.Json));
    }

    private Queue(Queue source, NpgsqlConnection caller)
    {
        _dataSource = source._dataSource;
        _shared = source._shared;
        _caller = caller;
    }

    /// <summary>The queue of a request that names none.</summary>
    public string DefaultQueue => _shared.DefaultQueue;

    /// <summary>
    /// The caller form: a queue with the same methods that runs every call on
    /// <paramref name="connection"/>, inside its open transaction. It shares the caches of this queue.
    /// </summary>
    /// <remarks>
    /// The connection must be open when a call starts, or the call throws
    /// <see cref="InvalidOperationException"/>. A cancelled token cancels the running statement, and
    /// PostgreSQL then aborts the transaction of the caller.
    /// </remarks>
    public Queue Using(NpgsqlConnection connection)
    {
        ArgumentNullException.ThrowIfNull(connection);
        return new Queue(this, connection);
    }

    // ---------------------------------------------------------------------------------------------
    // Compatibility

    /// <summary>Runs the startup compatibility check once for the data source, or for the caller connection.</summary>
    /// <exception cref="CompatibilityException">PostgreSQL and this client cannot work together.</exception>
    public Task AssertCompatibleAsync(CancellationToken cancellationToken = default) =>
        RunAsync(async call =>
        {
            await AssertCompatibleAsync(call, cancellationToken).ConfigureAwait(false);
            return true;
        }, cancellationToken);

    // ---------------------------------------------------------------------------------------------
    // Enqueue

    /// <summary>Submits one task with the default options.</summary>
    public Task<EnqueueResult> EnqueueAsync<TPayload>(string taskType, TPayload payload, CancellationToken cancellationToken = default) =>
        EnqueueAsync(taskType, payload, new EnqueueOptions(), cancellationToken);

    /// <summary>Submits one task.</summary>
    public async Task<EnqueueResult> EnqueueAsync<TPayload>(
        string taskType, TPayload payload, EnqueueOptions options, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(options);
        var request = new Pending(taskType, options, _shared.Codec.Serialize(payload, "payload"));
        SerializeRequests([request]);
        var results = await RunAsync(call => EnqueueManyAsync(call, [request], cancellationToken), cancellationToken).ConfigureAwait(false);
        return results[0];
    }

    /// <summary>
    /// Submits one atomic batch of at most 1,000 requests, and returns the results of PostgreSQL in
    /// request order.
    /// </summary>
    public async Task<IReadOnlyList<EnqueueResult>> EnqueueManyAsync(
        IEnumerable<EnqueueRequest> requests, CancellationToken cancellationToken = default)
    {
        var pending = Prepare(requests, "enqueue");
        if (pending.Count > SqlCatalogue.MaxEnqueueBatchSize)
        {
            throw new ArgumentException("enqueue batch exceeds the shared limit", nameof(requests));
        }

        if (pending.Count == 0)
        {
            return [];
        }

        SerializeRequests(pending);
        return await RunAsync(call => EnqueueManyAsync(call, pending, cancellationToken), cancellationToken).ConfigureAwait(false);
    }

    private async Task<IReadOnlyList<EnqueueResult>> EnqueueManyAsync(Call call, IReadOnlyList<Pending> requests, CancellationToken cancellationToken)
    {
        using var span = QueueTelemetry.StartEnqueue(requests, _shared.DefaultQueue, static request => request.Options.Queue, static request => request.TaskType);
        try
        {
            var rows = await SubmitAsync(
                call,
                requests,
                document => Sql.RowsAsync(call.Connection, SqlCatalogue.EnqueueManyV1, [Parameters.Json(document)], cancellationToken),
                cancellationToken).ConfigureAwait(false);
            var results = EnqueueResults(rows, requests.Count);
            QueueTelemetry.Enqueued(span, results);
            return results;
        }
        catch (Exception error)
        {
            QueueTelemetry.Failed(span, error);
            throw;
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Task groups

    /// <summary>
    /// Creates an open task group (ADR 0095). Add tasks with <see cref="AddToTaskGroupAsync"/>, then
    /// seal the group with <see cref="SealTaskGroupAsync"/>.
    /// </summary>
    public async Task<TaskGroup> CreateTaskGroupAsync(TaskGroupCallbacks callbacks, CancellationToken cancellationToken = default)
    {
        var entries = CallbackEntries(callbacks);
        var result = await RunAsync(call => CreateGroupAsync(call, entries, [], false, cancellationToken), cancellationToken).ConfigureAwait(false);
        return result.Group;
    }

    /// <summary>
    /// Creates a task group, gives <paramref name="build"/> a <see cref="TaskGroupBuilder"/>, adds the
    /// tasks that it collects, and seals the group, in one statement. If <paramref name="build"/>
    /// throws, nothing is enqueued. A group with no tasks finishes at the seal.
    /// </summary>
    public Task<TaskGroupBlockResult> TaskGroupAsync(
        TaskGroupCallbacks callbacks, Action<TaskGroupBuilder> build, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(build);
        var entries = CallbackEntries(callbacks);
        var builder = new TaskGroupBuilder();
        build(builder);
        var pending = Prepare(builder.Requests, "task group");
        SerializeRequests(pending);
        return RunAsync(call => CreateGroupAsync(call, entries, pending, true, cancellationToken), cancellationToken);
    }

    /// <summary>
    /// Enqueues at most 1,000 requests as member tasks of an open group, and returns their results in
    /// request order. A request cannot use debounce or throttle.
    /// </summary>
    public async Task<IReadOnlyList<EnqueueResult>> AddToTaskGroupAsync(
        Guid groupId, IEnumerable<EnqueueRequest> requests, CancellationToken cancellationToken = default)
    {
        var pending = Prepare(requests, "task group add");
        ValidateGroupAdd(pending);
        if (pending.Count == 0)
        {
            return [];
        }

        SerializeRequests(pending);

        return await RunAsync(
            async call =>
            {
                var rows = await SubmitAsync(
                    call,
                    pending,
                    document => Sql.RowsAsync(
                        call.Connection,
                        SqlCatalogue.AddTaskGroupMembersV1,
                        [Parameters.Uuid(groupId), Parameters.Json(document), Parameters.Uuid(null), Parameters.Text(null), Parameters.Bigint(null)],
                        cancellationToken),
                    cancellationToken).ConfigureAwait(false);
                return EnqueueResults(rows, pending.Count);
            },
            cancellationToken).ConfigureAwait(false);
    }

    /// <summary>
    /// Seals an open group. A group with no pending member finishes at once. Sealing a sealed or
    /// finished group changes nothing.
    /// </summary>
    public Task<TaskGroup> SealTaskGroupAsync(Guid groupId, CancellationToken cancellationToken = default) =>
        RunAsync(
            async call =>
            {
                await AssertCompatibleAsync(call, cancellationToken).ConfigureAwait(false);
                var rows = await Sql.RowsAsync(call.Connection, SqlCatalogue.SealTaskGroupV1, [Parameters.Uuid(groupId)], cancellationToken).ConfigureAwait(false);
                return TaskGroups.Group(TaskGroups.ExactlyOne(rows, "seal_task_group_v1"));
            },
            cancellationToken);

    /// <summary>The task group, or <c>null</c> when no such group exists.</summary>
    public Task<TaskGroup?> GetTaskGroupAsync(Guid groupId, CancellationToken cancellationToken = default) =>
        RunAsync(call => GetTaskGroupAsync(call, groupId, cancellationToken), cancellationToken);

    /// <summary>The first page of at most 100 member tasks.</summary>
    public Task<TaskGroupMemberPage> ListTaskGroupMembersAsync(Guid groupId, CancellationToken cancellationToken = default) =>
        ListTaskGroupMembersAsync(groupId, 0, DefaultPageSize, cancellationToken);

    /// <summary>
    /// One page of at most <paramref name="limit"/> member tasks after the position
    /// <paramref name="after"/>, in the order they joined.
    /// </summary>
    /// <param name="groupId">The group.</param>
    /// <param name="after">The position after which the page starts, 0 for the first page.</param>
    /// <param name="limit">The page size, 1 to 1,000.</param>
    /// <param name="cancellationToken">Cancels the call.</param>
    public Task<TaskGroupMemberPage> ListTaskGroupMembersAsync(Guid groupId, long after, int limit, CancellationToken cancellationToken = default)
    {
        if (limit is < 1 or > MaxPageSize)
        {
            throw new ArgumentOutOfRangeException(nameof(limit), limit, $"list task group members limit must be an Integer between 1 and {MaxPageSize}");
        }

        if (after is < 0 or > int.MaxValue)
        {
            throw new ArgumentOutOfRangeException(nameof(after), after, "after must be a non-negative Integer");
        }

        return RunAsync(
            async call =>
            {
                await AssertCompatibleAsync(call, cancellationToken).ConfigureAwait(false);
                return await TaskGroups.MemberPageAsync(call.Connection, groupId, after, limit, cancellationToken).ConfigureAwait(false);
            },
            cancellationToken);
    }

    /// <summary>The group that <paramref name="taskId"/> is a member of, or whose callback it is, or <c>null</c>.</summary>
    public Task<TaskGroupLink?> FindTaskGroupAsync(Guid taskId, CancellationToken cancellationToken = default) =>
        RunAsync(
            async call =>
            {
                await AssertCompatibleAsync(call, cancellationToken).ConfigureAwait(false);
                var rows = await Sql.RowsAsync(call.Connection, SqlCatalogue.TaskGroupForTaskV1, [Parameters.Uuid(taskId)], cancellationToken).ConfigureAwait(false);
                if (rows.Count == 0)
                {
                    return null;
                }

                var row = rows[0];
                return (TaskGroupLink?)new TaskGroupLink
                {
                    Role = Wire.Required<TaskGroupRole>("task_group_role", row.RequiredText("role")),
                    Callback = row.Text("callback_kind") is { } kind ? Wire.Required<TaskGroupCallbackKind>("task_group_callback", kind) : null,
                    Group = TaskGroups.Group(row),
                };
            },
            cancellationToken);

    private async Task<TaskGroup?> GetTaskGroupAsync(Call call, Guid groupId, CancellationToken cancellationToken)
    {
        await AssertCompatibleAsync(call, cancellationToken).ConfigureAwait(false);
        var rows = await Sql.RowsAsync(call.Connection, SqlCatalogue.GetTaskGroupV1, [Parameters.Uuid(groupId)], cancellationToken).ConfigureAwait(false);
        return rows.Count == 0 ? null : TaskGroups.Group(rows[0]);
    }

    /// <summary>
    /// Creates a group with <paramref name="requests"/> as its member tasks, and seals it when
    /// <paramref name="seal"/> is true. A contract mismatch creates nothing, and the retry
    /// serializes the callbacks again.
    /// </summary>
    private async Task<TaskGroupBlockResult> CreateGroupAsync(
        Call call, IReadOnlyList<(string Key, Pending Request)> callbacks, IReadOnlyList<Pending> requests, bool seal, CancellationToken cancellationToken)
    {
        var rows = await SubmitAsync(
            call,
            requests,
            async document => await Sql.RowsAsync(
                call.Connection,
                SqlCatalogue.CreateTaskGroupV1,
                [Parameters.Json(await CallbackDocumentAsync(call, callbacks, cancellationToken).ConfigureAwait(false)), Parameters.Json(document), Parameters.Boolean(seal)],
                cancellationToken).ConfigureAwait(false),
            cancellationToken).ConfigureAwait(false);
        var groupId = rows.Count == 0 ? null : rows[0].Uuid("group_id");
        if (groupId is not { } id)
        {
            throw new WorkhorseException("PostgreSQL created no task group");
        }

        var group = await GetTaskGroupAsync(call, id, cancellationToken).ConfigureAwait(false)
            ?? throw new WorkhorseException($"Task group {id} disappeared after its creation");
        var members = rows.Where(row => row.Value("ordinal") is not null).ToList();
        return new TaskGroupBlockResult { Group = group, Tasks = EnqueueResults(members, requests.Count) };
    }

    private List<(string Key, Pending Request)> CallbackEntries(TaskGroupCallbacks callbacks)
    {
        ArgumentNullException.ThrowIfNull(callbacks);
        var entries = new List<(string Key, Pending Request)>();
        foreach (var (key, label, request) in new[]
                 {
                     ("onFinish", "on finish", callbacks.OnFinish),
                     ("onSuccess", "on success", callbacks.OnSuccess),
                     ("onFailure", "on failure", callbacks.OnFailure),
                 })
        {
            if (request is null)
            {
                continue;
            }

            if (request.Options is { Idempotency: not null } or { Debounce: not null } or { Throttle: not null })
            {
                throw new ArgumentException("task group callbacks cannot use enqueue idempotency, debounce, or throttle", nameof(callbacks));
            }

            try
            {
                var pending = Pending.From(request, _shared.Codec);
                SerializeRequest(pending, DateTimeOffset.UtcNow);
                entries.Add((key, pending));
            }
            catch (ArgumentException error)
            {
                throw new ArgumentException($"{label} callback: {error.Message}", nameof(callbacks), error);
            }
        }

        return entries;
    }

    /// <summary>The callback document. A callback carries no run time unless the caller set one.</summary>
    private async Task<string> CallbackDocumentAsync(Call call, IReadOnlyList<(string Key, Pending Request)> callbacks, CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.UtcNow;
        var trace = Instrumentation.InjectTraceContext();
        var document = new JsonObject();
        foreach (var (key, request) in callbacks)
        {
            var input = SerializeRequest(request, now);
            if (request.Options.RunAt is null)
            {
                input.Remove("runAt");
            }

            if (trace is not null)
            {
                input["traceContext"] = trace.DeepClone();
            }

            await ApplyContractAsync(call, input, request.TaskType, cancellationToken).ConfigureAwait(false);
            document[key] = input;
        }

        return Values.Write(document);
    }

    private static void ValidateGroupAdd(IReadOnlyList<Pending> requests)
    {
        if (requests.Count > SqlCatalogue.MaxEnqueueBatchSize)
        {
            throw new ArgumentException($"a task group add accepts at most {SqlCatalogue.MaxEnqueueBatchSize} tasks", nameof(requests));
        }

        if (requests.Any(request => request.Options is { Debounce: not null } or { Throttle: not null }))
        {
            throw new ArgumentException("a task group add cannot use debounce or throttle", nameof(requests));
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Controls

    /// <summary>Requests cancellation. An active task stops at its next checkpoint that PostgreSQL owns.</summary>
    public Task<CancelResult> CancelAsync(Guid taskId, CancelOptions options, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(options);
        if (options.RequestedBy is { } requestedBy)
        {
            Utf16.Require(requestedBy, "requested by");
        }

        if (options.Reason is { } reason)
        {
            Utf16.Require(reason, "reason");
        }

        return RunAsync(
            async call =>
            {
                await AssertCompatibleAsync(call, cancellationToken).ConfigureAwait(false);
                var rows = await Sql.RowsAsync(
                    call.Connection,
                    SqlCatalogue.CancelV1,
                    [Parameters.Uuid(taskId), Parameters.Text(options.RequestedBy), Parameters.Text(options.Reason)],
                    cancellationToken).ConfigureAwait(false);
                var row = TaskGroups.ExactlyOne(rows, "cancel_v1");
                return new CancelResult
                {
                    Status = Wire.Required<CancelStatus>("cancel", row.Text("status")),
                    TaskId = taskId,
                    State = row.Text("state") is { } state ? Wire.Required<TaskState>("cancel", state) : null,
                    CurrentAttempt = row.Integer("current_attempt"),
                    RequestedAt = row.Instant("requested_at"),
                    RequestedBy = row.Text("requested_by"),
                    Reason = row.Text("reason"),
                    FinishedAt = row.Instant("finished_at"),
                };
            },
            cancellationToken);
    }

    /// <summary>Delivers a named signal to a task that waits for it.</summary>
    /// <param name="taskId">The task.</param>
    /// <param name="name">The signal name, 1 to 200 characters without surrounding whitespace.</param>
    /// <param name="payload">The JSON payload, at most 65,536 bytes of <c>jsonb</c> text.</param>
    /// <param name="idempotencyKey">1 to 512 UTF-8 bytes.</param>
    /// <param name="requestedBy">1 to 200 characters.</param>
    /// <param name="cancellationToken">Cancels the call.</param>
    /// <exception cref="SignalIdempotencyConflictException">The key was retained for a different request.</exception>
    public Task<SignalDeliveryResult> SendSignalAsync<TPayload>(
        Guid taskId, string name, TPayload payload, string idempotencyKey, string requestedBy, CancellationToken cancellationToken = default)
    {
        var document = ValidateDelivery("signal", "signal payload", name, payload, idempotencyKey, requestedBy);
        return RunAsync(
            async call =>
            {
                await AssertCompatibleAsync(call, cancellationToken).ConfigureAwait(false);
                var rows = await Sql.RowsAsync(
                    call.Connection,
                    SqlCatalogue.SendSignalV1,
                    [Parameters.Uuid(taskId), Parameters.Text(name), Parameters.Json(document), Parameters.Text(idempotencyKey), Parameters.Text(requestedBy)],
                    cancellationToken).ConfigureAwait(false);
                var row = TaskGroups.ExactlyOne(rows, "send_signal_v1");
                if (row.Text("status") == "conflict")
                {
                    throw new SignalIdempotencyConflictException(taskId, name);
                }

                return new SignalDeliveryResult
                {
                    Status = Wire.Required<SignalStatus>("send_signal", row.Text("status")),
                    TaskId = taskId,
                    Name = name,
                    Payload = row.Json("payload"),
                    DeliveredAt = row.Instant("delivered_at"),
                    DeliveredBy = row.Text("delivered_by"),
                };
            },
            cancellationToken);
    }

    /// <summary>Records a human decision for a task that waits for it.</summary>
    /// <param name="taskId">The task.</param>
    /// <param name="name">The wait name, 1 to 200 characters without surrounding whitespace.</param>
    /// <param name="result">The JSON decision, at most 65,536 bytes of <c>jsonb</c> text.</param>
    /// <param name="idempotencyKey">1 to 512 UTF-8 bytes.</param>
    /// <param name="requestedBy">1 to 200 characters.</param>
    /// <param name="cancellationToken">Cancels the call.</param>
    /// <exception cref="HumanWaitIdempotencyConflictException">The key was retained for a different decision.</exception>
    public Task<HumanWaitCompletionResult> CompleteHumanWaitAsync<TResult>(
        Guid taskId, string name, TResult result, string idempotencyKey, string requestedBy, CancellationToken cancellationToken = default)
    {
        var document = ValidateDelivery("human wait", "human wait result", name, result, idempotencyKey, requestedBy);
        return RunAsync(
            async call =>
            {
                await AssertCompatibleAsync(call, cancellationToken).ConfigureAwait(false);
                var rows = await Sql.RowsAsync(
                    call.Connection,
                    SqlCatalogue.CompleteHumanWaitV1,
                    [Parameters.Uuid(taskId), Parameters.Text(name), Parameters.Json(document), Parameters.Text(idempotencyKey), Parameters.Text(requestedBy)],
                    cancellationToken).ConfigureAwait(false);
                var row = TaskGroups.ExactlyOne(rows, "complete_human_wait_v1");
                if (row.Text("status") == "conflict")
                {
                    throw new HumanWaitIdempotencyConflictException(taskId, name);
                }

                return new HumanWaitCompletionResult
                {
                    Status = Wire.Required<HumanWaitStatus>("complete_human_wait", row.Text("status")),
                    TaskId = taskId,
                    Name = name,
                    Payload = row.Json("result"),
                    CompletedAt = row.Instant("completed_at"),
                    CompletedBy = row.Text("completed_by"),
                };
            },
            cancellationToken);
    }

    private string ValidateDelivery<T>(string label, string valueLabel, string name, T value, string idempotencyKey, string requestedBy)
    {
        ArgumentNullException.ThrowIfNull(name);
        ArgumentNullException.ThrowIfNull(idempotencyKey);
        ArgumentNullException.ThrowIfNull(requestedBy);
        var length = CodePoints(name);
        if (length is < 1 or > 200 || Whitespace.Contains(name[0], StringComparison.Ordinal) || Whitespace.Contains(name[^1], StringComparison.Ordinal))
        {
            throw new ArgumentException($"{label} name must contain between 1 and 200 characters without surrounding whitespace", nameof(name));
        }

        Utf16.Require(name, $"{label} name");
        var document = Values.Write(Values.Node(_shared.Codec.Serialize(value, valueLabel)));
        if (JsonbSize.Of(document) > MaxExternalValueBytes)
        {
            throw new ArgumentException($"{valueLabel} must be at most {MaxExternalValueBytes} bytes of JSON");
        }

        var keyBytes = Values.Bytes(Utf16.Require(idempotencyKey, $"{label} idempotency key"));
        if (keyBytes is < 1 or > MaxKeyBytes)
        {
            throw new ArgumentException($"{label} idempotency key must contain between 1 and {MaxKeyBytes} UTF-8 bytes", nameof(idempotencyKey));
        }

        if (CodePoints(Utf16.Require(requestedBy, $"{label} requested by")) is < 1 or > 200)
        {
            throw new ArgumentException($"{label} requested by must contain between 1 and 200 characters", nameof(requestedBy));
        }

        return document;
    }

    /// <summary>The queue health snapshot of PostgreSQL over the last day.</summary>
    public Task<QueueHealth> HealthAsync(CancellationToken cancellationToken = default) =>
        RunAsync(
            async call =>
            {
                await AssertCompatibleAsync(call, cancellationToken).ConfigureAwait(false);
                var rows = await Sql.RowsAsync(
                    call.Connection,
                    SqlCatalogue.QueueHealthV1,
                    [Parameters.Timestamptz(DateTimeOffset.UtcNow.AddDays(-1))],
                    cancellationToken).ConfigureAwait(false);
                var snapshot = TaskGroups.ExactlyOne(rows, "queue_health_v1").Json("snapshot");
                if (snapshot is not { ValueKind: JsonValueKind.Object } members)
                {
                    throw new WorkhorseException("workhorse.queue_health_v1 returned a non-object snapshot");
                }

                var values = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
                foreach (var property in members.EnumerateObject())
                {
                    values[property.Name] = property.Value;
                }

                return new QueueHealth { Snapshot = values };
            },
            cancellationToken);

    // ---------------------------------------------------------------------------------------------
    // Schedules and contracts

    /// <summary>Makes <paramref name="schedules"/> the schedules of the namespace, and removes its others.</summary>
    public Task SyncSchedulesAsync(string @namespace, IEnumerable<ScheduleDefinition> schedules, CancellationToken cancellationToken = default) =>
        SyncSchedulesAsync(@namespace, schedules, true, cancellationToken);

    /// <summary>Makes <paramref name="schedules"/> the schedules of the namespace.</summary>
    /// <param name="namespace">The namespace.</param>
    /// <param name="schedules">The schedules.</param>
    /// <param name="prune">Whether to remove the other schedules of the namespace.</param>
    /// <param name="cancellationToken">Cancels the call.</param>
    public Task SyncSchedulesAsync(string @namespace, IEnumerable<ScheduleDefinition> schedules, bool prune, CancellationToken cancellationToken = default)
    {
        RequiredString(@namespace, "namespace");
        ArgumentNullException.ThrowIfNull(schedules);
        var definitions = schedules.ToList();
        var documents = new List<(string TaskType, JsonObject Document)>();
        for (var index = 0; index < definitions.Count; index++)
        {
            try
            {
                documents.Add(ScheduleDocument(definitions[index] ?? throw new ArgumentException("schedule definition is null")));
            }
            catch (ArgumentException error)
            {
                throw new ArgumentException($"schedule definition {index + 1}: invalid schedule definition: {error.Message}", nameof(schedules), error);
            }
        }

        return RunAsync(
            async call =>
            {
                await AssertCompatibleAsync(call, cancellationToken).ConfigureAwait(false);

                // Each type's current contract comes from PostgreSQL, not the cache: a fired
                // occurrence never checks the contract policy, so a stale version would persist.
                var loaded = new Dictionary<string, PayloadContract?>(StringComparer.Ordinal);
                var document = new JsonArray();
                foreach (var (taskType, input) in documents)
                {
                    if (!loaded.TryGetValue(taskType, out var contract))
                    {
                        contract = await ContractStore.LoadAsync(call.Connection, taskType, null, cancellationToken).ConfigureAwait(false);
                        loaded[taskType] = contract;
                    }

                    StampContract(input, taskType, contract);
                    document.Add(input);
                }

                await Sql.RowsAsync(
                    call.Connection,
                    SqlCatalogue.SyncScheduleDefinitionsV2,
                    [Parameters.Text(@namespace), Parameters.Json(Values.Write(document)), Parameters.Boolean(prune)],
                    cancellationToken).ConfigureAwait(false);
                return true;
            },
            cancellationToken);
    }

    private (string TaskType, JsonObject Document) ScheduleDocument(ScheduleDefinition definition)
    {
        var task = definition.Task ?? throw new ArgumentException("task must be a ScheduledTask");
        var input = TaskInput(task.TaskType, _shared.Codec.Serialize(task.Payload, "payload"), task.Queue, task.Priority, task.ConcurrencyKey, task.MaxAttempts, task.RetryPolicy);
        input["name"] = RequiredString(definition.Name, "name");
        input["schedule"] = RequiredString(definition.Schedule, "schedule");
        input["timezone"] = RequiredString(definition.Timezone, "timezone");
        input["catchupPolicy"] = Wire.Text(definition.CatchupPolicy);
        input["enabled"] = definition.Enabled;
        return (task.TaskType, input);
    }

    /// <summary>
    /// Makes <paramref name="contracts"/>, keyed by task type, the contract definitions of
    /// PostgreSQL, and validates later enqueues against them.
    /// </summary>
    /// <exception cref="ArgumentException">A schema is outside the Workhorse contract profile.</exception>
    public Task SyncContractsAsync(IReadOnlyDictionary<string, TaskTypeContracts> contracts, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(contracts);
        var document = ContractStore.Document(contracts);
        return RunAsync(
            async call =>
            {
                await AssertCompatibleAsync(call, cancellationToken).ConfigureAwait(false);
                await Sql.RowsAsync(call.Connection, SqlCatalogue.SyncContractDefinitionsV1, [Parameters.Json(document)], cancellationToken).ConfigureAwait(false);
                _shared.ContractsSynced();
                return true;
            },
            cancellationToken);
    }

    // ---------------------------------------------------------------------------------------------
    // Policies and budgets

    /// <summary>Makes <paramref name="definitions"/> the concurrency policies of the namespace, and removes its others.</summary>
    public Task<IReadOnlyList<ConcurrencyPolicy>> SyncConcurrencyPoliciesAsync(
        string @namespace, IEnumerable<ConcurrencyPolicyDefinition> definitions, CancellationToken cancellationToken = default) =>
        SyncConcurrencyPoliciesAsync(@namespace, definitions, true, cancellationToken);

    /// <summary>Makes <paramref name="definitions"/> the concurrency policies of the namespace, and returns the stored policies.</summary>
    /// <param name="namespace">The namespace.</param>
    /// <param name="definitions">The policies.</param>
    /// <param name="prune">Whether to remove the other policies of the namespace.</param>
    /// <param name="cancellationToken">Cancels the call.</param>
    public Task<IReadOnlyList<ConcurrencyPolicy>> SyncConcurrencyPoliciesAsync(
        string @namespace, IEnumerable<ConcurrencyPolicyDefinition> definitions, bool prune, CancellationToken cancellationToken = default)
    {
        var document = SyncDocument(definitions, "concurrency policy", "queue", definition => definition.Queue, definition =>
        {
            var maxActive = Range(definition.MaxActive, 1, MaxPolicyValue, "max active");
            return new JsonObject
            {
                ["queue"] = definition.Queue,
                ["maxActive"] = maxActive,
                ["maxActivePerKey"] = definition.MaxActivePerKey is { } perKey ? Range(perKey, 1, maxActive, "max active per key") : null,
            };
        });
        RequiredBytes(@namespace, MaxNameBytes, "namespace");
        return RunAsync(
            async call =>
            {
                await AssertCompatibleAsync(call, cancellationToken).ConfigureAwait(false);
                var rows = await Sql.FencedRowsAsync(
                    call.Connection,
                    SqlCatalogue.SyncConcurrencyPoliciesV1,
                    () => [Parameters.Text(@namespace), Parameters.Json(document), Parameters.Boolean(prune)],
                    cancellationToken).ConfigureAwait(false);
                return (IReadOnlyList<ConcurrencyPolicy>)[.. rows.Select(ConcurrencyPolicyOf)];
            },
            cancellationToken);
    }

    /// <summary>Makes <paramref name="definitions"/> the rate limit policies of the namespace, and removes its others.</summary>
    public Task<IReadOnlyList<RateLimitPolicy>> SyncRateLimitPoliciesAsync(
        string @namespace, IEnumerable<RateLimitPolicyDefinition> definitions, CancellationToken cancellationToken = default) =>
        SyncRateLimitPoliciesAsync(@namespace, definitions, true, cancellationToken);

    /// <summary>Makes <paramref name="definitions"/> the rate limit policies of the namespace, and returns the stored policies.</summary>
    /// <param name="namespace">The namespace.</param>
    /// <param name="definitions">The policies.</param>
    /// <param name="prune">Whether to remove the other policies of the namespace.</param>
    /// <param name="cancellationToken">Cancels the call.</param>
    public Task<IReadOnlyList<RateLimitPolicy>> SyncRateLimitPoliciesAsync(
        string @namespace, IEnumerable<RateLimitPolicyDefinition> definitions, bool prune, CancellationToken cancellationToken = default)
    {
        var document = SyncDocument(definitions, "rate limit policy", "queue", definition => definition.Queue, definition => new JsonObject
        {
            ["queue"] = definition.Queue,
            ["rate"] = RateLimitDocument(definition.Rate ?? throw new ArgumentException("rate must be a RateLimit"), "rate"),
            ["perKey"] = definition.PerKey is { } perKey ? RateLimitDocument(perKey, "per key") : null,
        });
        RequiredBytes(@namespace, MaxNameBytes, "namespace");
        return RunAsync(
            async call =>
            {
                await AssertCompatibleAsync(call, cancellationToken).ConfigureAwait(false);
                var rows = await Sql.RowsAsync(
                    call.Connection,
                    SqlCatalogue.SyncRateLimitPoliciesV1,
                    [Parameters.Text(@namespace), Parameters.Json(document), Parameters.Boolean(prune)],
                    cancellationToken).ConfigureAwait(false);
                return (IReadOnlyList<RateLimitPolicy>)[.. rows.Select(RateLimitPolicyOf)];
            },
            cancellationToken);
    }

    /// <summary>Makes <paramref name="definitions"/> the budgets of the namespace, and removes its others.</summary>
    public Task<IReadOnlyList<Budget>> SyncBudgetsAsync(
        string @namespace, IEnumerable<BudgetDefinition> definitions, CancellationToken cancellationToken = default) =>
        SyncBudgetsAsync(@namespace, definitions, true, cancellationToken);

    /// <summary>Makes <paramref name="definitions"/> the budgets of the namespace, and returns the stored budgets.</summary>
    /// <param name="namespace">The namespace.</param>
    /// <param name="definitions">The budgets.</param>
    /// <param name="prune">Whether to remove the other budgets of the namespace.</param>
    /// <param name="cancellationToken">Cancels the call.</param>
    public Task<IReadOnlyList<Budget>> SyncBudgetsAsync(
        string @namespace, IEnumerable<BudgetDefinition> definitions, bool prune, CancellationToken cancellationToken = default)
    {
        var document = SyncDocument(definitions, "budget", "name", definition => definition.Name, definition =>
        {
            if (definition.MaxActive is null && definition.Rate is null)
            {
                throw new ArgumentException("budget requires max active, rate, or both");
            }

            return new JsonObject
            {
                ["name"] = definition.Name,
                ["maxActive"] = definition.MaxActive is { } maxActive ? Range(maxActive, 1, MaxPolicyValue, "max active") : null,
                ["rate"] = definition.Rate is { } rate ? RateLimitDocument(rate, "rate") : null,
            };
        });
        RequiredBytes(@namespace, MaxNameBytes, "namespace");
        return RunAsync(
            async call =>
            {
                await AssertCompatibleAsync(call, cancellationToken).ConfigureAwait(false);
                var rows = await Sql.RowsAsync(
                    call.Connection,
                    SqlCatalogue.SyncBudgetsV1,
                    [Parameters.Text(@namespace), Parameters.Json(document), Parameters.Boolean(prune)],
                    cancellationToken).ConfigureAwait(false);
                return (IReadOnlyList<Budget>)[.. rows.Select(BudgetOf)];
            },
            cancellationToken);
    }

    /// <summary>The concurrency policies of every queue.</summary>
    public Task<IReadOnlyList<ConcurrencyPolicy>> ListConcurrencyPoliciesAsync(CancellationToken cancellationToken = default) =>
        ListConcurrencyPoliciesAsync([], cancellationToken);

    /// <summary>The concurrency policies of <paramref name="queues"/>, or of every queue when it is empty.</summary>
    public Task<IReadOnlyList<ConcurrencyPolicy>> ListConcurrencyPoliciesAsync(IReadOnlyCollection<string> queues, CancellationToken cancellationToken = default) =>
        ListAsync(SqlCatalogue.ListConcurrencyPolicies, queues, ConcurrencyPolicyOf, cancellationToken);

    /// <summary>The rate limit policies of every queue.</summary>
    public Task<IReadOnlyList<RateLimitPolicy>> ListRateLimitPoliciesAsync(CancellationToken cancellationToken = default) =>
        ListRateLimitPoliciesAsync([], cancellationToken);

    /// <summary>The rate limit policies of <paramref name="queues"/>, or of every queue when it is empty.</summary>
    public Task<IReadOnlyList<RateLimitPolicy>> ListRateLimitPoliciesAsync(IReadOnlyCollection<string> queues, CancellationToken cancellationToken = default) =>
        ListAsync(SqlCatalogue.ListRateLimitPolicies, queues, RateLimitPolicyOf, cancellationToken);

    /// <summary>Every budget.</summary>
    public Task<IReadOnlyList<Budget>> ListBudgetsAsync(CancellationToken cancellationToken = default) =>
        ListBudgetsAsync([], cancellationToken);

    /// <summary>The budgets named in <paramref name="names"/>, or every budget when it is empty.</summary>
    public Task<IReadOnlyList<Budget>> ListBudgetsAsync(IReadOnlyCollection<string> names, CancellationToken cancellationToken = default) =>
        ListAsync(SqlCatalogue.ListBudgets, names, BudgetOf, cancellationToken);

    private Task<IReadOnlyList<T>> ListAsync<T>(SqlCatalogue.Statement statement, IReadOnlyCollection<string> names, Func<Row, T> map, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(names);
        var array = names.Select(name => Utf16.Require(name ?? throw new ArgumentException("a name is null", nameof(names)), "name")).ToArray();
        return RunAsync(
            async call =>
            {
                await AssertCompatibleAsync(call, cancellationToken).ConfigureAwait(false);
                var rows = await Sql.RowsAsync(call.Connection, statement, [Parameters.TextArray(array)], cancellationToken).ConfigureAwait(false);
                return (IReadOnlyList<T>)[.. rows.Select(map)];
            },
            cancellationToken);
    }

    private static ConcurrencyPolicy ConcurrencyPolicyOf(Row row) => new()
    {
        Namespace = row.RequiredText("namespace"),
        Queue = row.RequiredText("queue_name"),
        MaxActive = row.RequiredInteger("max_active"),
        MaxActivePerKey = row.Integer("max_active_per_key"),
        UpdatedAt = row.RequiredInstant("updated_at"),
    };

    private static RateLimitPolicy RateLimitPolicyOf(Row row) => new()
    {
        Namespace = row.RequiredText("namespace"),
        Queue = row.RequiredText("queue_name"),
        Rate = RateLimitOf(row, "rate_", "rate_limit") ?? throw new WorkhorseException("PostgreSQL returned a rate limit policy without a rate"),
        PerKey = RateLimitOf(row, "per_key_", "per_key_limit"),
        UpdatedAt = row.RequiredInstant("updated_at"),
    };

    private static Budget BudgetOf(Row row) => new()
    {
        Namespace = row.RequiredText("namespace"),
        Name = row.RequiredText("budget_name"),
        MaxActive = row.Integer("max_active"),
        Rate = RateLimitOf(row, "rate_", "rate_limit"),
        UpdatedAt = row.RequiredInstant("updated_at"),
    };

    /// <summary>The rate limit whose columns share <paramref name="prefix"/>, or <c>null</c> when its limit is null.</summary>
    private static RateLimit? RateLimitOf(Row row, string prefix, string limitColumn) =>
        row.Integer(limitColumn) is { } limit
            ? new RateLimit
            {
                Limit = limit,
                Interval = TimeSpan.FromMilliseconds(row.RequiredLong(prefix + "interval_ms")),
                Burst = row.RequiredInteger(prefix + "burst"),
            }
            : null;

    /// <summary>The JSON array that a policy sync sends. The name of each definition must be unique.</summary>
    private static string SyncDocument<T>(IEnumerable<T> definitions, string label, string nameLabel, Func<T, string> name, Func<T, JsonObject> encode)
    {
        ArgumentNullException.ThrowIfNull(definitions);
        var list = definitions.ToList();
        if (list.Count > MaxPolicyDefinitions)
        {
            throw new ArgumentException($"{label} definitions exceed the limit of {MaxPolicyDefinitions}", nameof(definitions));
        }

        var document = new JsonArray();
        var names = new HashSet<string>(StringComparer.Ordinal);
        var unique = true;
        for (var index = 0; index < list.Count; index++)
        {
            var definition = list[index];
            try
            {
                if (definition is null)
                {
                    throw new ArgumentException($"{label} definition is null");
                }

                RequiredBytes(name(definition), MaxNameBytes, nameLabel);
                document.Add(encode(definition));
                unique &= names.Add(name(definition));
            }
            catch (ArgumentException error)
            {
                throw new ArgumentException($"{label} definition {index + 1}: {error.Message}", nameof(definitions), error);
            }
        }

        return unique ? Values.Write(document) : throw new ArgumentException($"{label} {nameLabel} names must be unique", nameof(definitions));
    }

    private static JsonObject RateLimitDocument(RateLimit rate, string label) => new()
    {
        ["limit"] = Range(rate.Limit, 1, MaxPolicyValue, $"{label} limit"),
        ["intervalMs"] = Values.Milliseconds(rate.Interval, $"{label} interval", 1, MaxRateIntervalMs),
        ["burst"] = Range(rate.Burst, 1, MaxPolicyValue, $"{label} burst"),
    };

    // ---------------------------------------------------------------------------------------------
    // Request serialization

    /// <summary>
    /// Serializes the payload of each request before any statement, so a value that is not JSON
    /// throws <see cref="ArgumentException"/> first.
    /// </summary>
    private List<Pending> Prepare(IEnumerable<EnqueueRequest> requests, string label)
    {
        ArgumentNullException.ThrowIfNull(requests);
        var pending = new List<Pending>();
        foreach (var request in requests)
        {
            try
            {
                pending.Add(Pending.From(request ?? throw new ArgumentException("request is null"), _shared.Codec));
            }
            catch (ArgumentException error)
            {
                throw new ArgumentException($"{label} request {pending.Count + 1}: {error.Message}", nameof(requests), error);
            }
        }

        return pending;
    }

    /// <summary>
    /// Serializes <paramref name="requests"/>, passes their JSON document to
    /// <paramref name="statement"/>, and returns its rows. On a contract mismatch, PostgreSQL
    /// enqueued nothing: the queue reloads the named contracts and runs the statement one more time.
    /// </summary>
    private async Task<IReadOnlyList<Row>> SubmitAsync(
        Call call, IReadOnlyList<Pending> requests, Func<string, Task<IReadOnlyList<Row>>> statement, CancellationToken cancellationToken)
    {
        for (var attempt = 0; attempt < 2; attempt++)
        {
            var rows = await statement(await SerializeRequestsAsync(call, requests, cancellationToken).ConfigureAwait(false)).ConfigureAwait(false);
            if (ContractMismatch(rows) is not { } taskTypes)
            {
                return rows;
            }

            foreach (var taskType in taskTypes)
            {
                Remember(call, taskType, await ContractStore.LoadAsync(call.Connection, taskType, null, cancellationToken).ConfigureAwait(false));
            }
        }

        throw new ContractPolicyChangedException();
    }

    private async Task<string> SerializeRequestsAsync(Call call, IReadOnlyList<Pending> requests, CancellationToken cancellationToken)
    {
        var inputs = SerializeRequests(requests);
        // Each task carries the trace context of the current activity, the enqueue span when one runs.
        if (Instrumentation.InjectTraceContext() is { } trace)
        {
            foreach (var input in inputs)
            {
                input["traceContext"] = trace.DeepClone();
            }
        }

        await AssertCompatibleAsync(call, cancellationToken).ConfigureAwait(false);
        for (var index = 0; index < requests.Count; index++)
        {
            await ApplyContractAsync(call, inputs[index], requests[index].TaskType, cancellationToken).ConfigureAwait(false);
        }

        return Values.Write(new JsonArray([.. inputs]));
    }

    /// <summary>
    /// The request documents. Each public method calls it once before it opens a connection, so an
    /// invalid argument throws <see cref="ArgumentException"/> before any statement.
    /// </summary>
    private List<JsonObject> SerializeRequests(IReadOnlyList<Pending> requests)
    {
        var now = DateTimeOffset.UtcNow;
        var inputs = new List<JsonObject>(requests.Count);
        for (var index = 0; index < requests.Count; index++)
        {
            try
            {
                inputs.Add(SerializeRequest(requests[index], now));
            }
            catch (ArgumentException error)
            {
                throw new ArgumentException($"enqueue request {index + 1}: {error.Message}", error);
            }
        }

        return inputs;
    }

    private JsonObject SerializeRequest(Pending request, DateTimeOffset now)
    {
        var options = request.Options;
        try
        {
            ValidateOptions(options);
        }
        catch (ArgumentException error)
        {
            throw new ArgumentException($"invalid enqueue options: {error.Message}", error);
        }

        var input = TaskInput(request.TaskType, request.Payload, options.Queue, options.Priority ?? 0, options.ConcurrencyKey, options.MaxAttempts, options.RetryPolicy);
        var keyed = options.Idempotency is not null || options.Debounce is not null || options.Throttle is not null;
        if (options.RunAt is not null || !keyed)
        {
            input["runAt"] = Values.Timestamp(options.RunAt ?? now);
        }

        input["deadline"] = options.Deadline is { } deadline ? Values.Timestamp(deadline) : null;
        input["budget"] = OptionalBytes(options.Budget, MaxNameBytes, "budget");
        input["executionTimeoutMs"] = ExecutionTimeout(options.ExecutionTimeout);
        input["prerequisiteTaskId"] = null;
        input["dependencies"] = options.Dependencies is { } dependencies ? DependenciesDocument(dependencies) : null;
        input["tags"] = Tags(options.Tags);
        if (options.Idempotency is { } idempotency)
        {
            input["idempotency"] = new JsonObject
            {
                ["key"] = RequiredBytes(idempotency.Key, MaxKeyBytes, "idempotency key"),
                ["scope"] = Scope(idempotency.Scope),
                ["ttlMs"] = IdempotencyTtl(idempotency.Ttl),
            };
        }

        if (options.Debounce is { } debounce)
        {
            input["debounce"] = new JsonObject
            {
                ["key"] = RequiredBytes(debounce.Key, MaxKeyBytes, "debounce key"),
                ["scope"] = Scope(debounce.Scope),
                ["windowMs"] = Values.Milliseconds(debounce.Window, "debounce window", 1, MaxDurationMs),
                ["schedule"] = Wire.Text(debounce.Schedule),
            };
        }

        if (options.Throttle is { } throttle)
        {
            input["throttle"] = new JsonObject
            {
                ["key"] = RequiredBytes(throttle.Key, MaxKeyBytes, "throttle key"),
                ["scope"] = Scope(throttle.Scope),
                ["windowMs"] = Values.Milliseconds(throttle.Window, "throttle window", 1, MaxDurationMs),
            };
        }

        return input;
    }

    private static void ValidateOptions(EnqueueOptions options)
    {
        var keyed = (options.Idempotency is null ? 0 : 1) + (options.Debounce is null ? 0 : 1) + (options.Throttle is null ? 0 : 1);
        if (keyed > 1)
        {
            throw new ArgumentException("cannot combine idempotency, debounce, or throttle");
        }

        if (options.Debounce is not null && options.RunAt is not null)
        {
            throw new ArgumentException("debounced enqueue uses its PostgreSQL-owned window instead of run at");
        }

        if (options.Dependencies is not { } dependencies)
        {
            return;
        }

        if (options.Debounce is not null || options.Throttle is not null)
        {
            throw new ArgumentException("cannot combine debounce or throttle with dependencies");
        }

        var ids = dependencies.PrerequisiteTaskIds ?? [];
        if (ids.Count == 0 || ids.Distinct().Count() != ids.Count)
        {
            throw new ArgumentException("dependencies must contain unique prerequisite task IDs");
        }

        if (ids.Count > MaxTaskDependencies)
        {
            throw new ArgumentException($"dependencies accepts at most {MaxTaskDependencies} prerequisite task IDs");
        }
    }

    /// <summary>The fields that an enqueued task and a scheduled task share.</summary>
    private JsonObject TaskInput(
        string taskType, string payload, string? queue, int priority, string? concurrencyKey, int? maxAttempts, RetryPolicy? retryPolicy) => new()
        {
            ["queue"] = OptionalBytes(queue, MaxNameBytes, "queue") ?? _shared.DefaultQueue,
            ["type"] = RequiredString(taskType, "task type"),
            ["payload"] = Values.Node(payload),
            ["priority"] = Range(priority, 0, 100, "priority"),
            ["concurrencyKey"] = OptionalBytes(concurrencyKey, MaxNameBytes, "concurrency key"),
            ["maxAttempts"] = maxAttempts is null or 0 ? DefaultMaxAttempts : Range(maxAttempts.Value, 1, 100, "max attempts"),
            ["retryPolicy"] = RetryPolicyDocument(retryPolicy),
            ["contractVersion"] = null,
            ["payloadMaxBytes"] = SqlCatalogue.DefaultTaskValueMaxBytes,
            ["resultMaxBytes"] = SqlCatalogue.DefaultTaskValueMaxBytes,
            ["sensitivePayloadKeys"] = new JsonArray(),
            ["sensitiveResultKeys"] = new JsonArray(),
        };

    private static JsonObject DependenciesDocument(Dependencies dependencies) => new()
    {
        ["prerequisiteTaskIds"] = new JsonArray([.. dependencies.PrerequisiteTaskIds.Select(id => id.ToString()).Order(StringComparer.Ordinal).Select(id => (JsonNode?)id)]),
        ["onSuccess"] = Wire.Text(dependencies.OnSuccess),
        ["onFailure"] = Wire.Text(dependencies.OnFailure),
        ["onCancellation"] = Wire.Text(dependencies.OnCancellation),
    };

    /// <summary>The retry policy, after a check of the shape and bounds that PostgreSQL accepts.</summary>
    private static JsonObject? RetryPolicyDocument(RetryPolicy? policy)
    {
        if (policy is null)
        {
            return null;
        }

        long Delay(TimeSpan? value, string field) =>
            value is { } delay
                ? Values.Milliseconds(delay, $"retry policy {field}", 0, MaxDurationMs)
                : throw new ArgumentException($"retry policy {field} is required");

        var document = policy.Kind switch
        {
            RetryPolicyKind.Fixed => new JsonObject { ["type"] = "fixed", ["delayMs"] = Delay(policy.Delay, "delay") },
            RetryPolicyKind.Exponential => new JsonObject
            {
                ["type"] = "exponential",
                ["initialDelayMs"] = Delay(policy.InitialDelay, "initial delay"),
                ["multiplier"] = Range(policy.Multiplier ?? throw new ArgumentException("retry policy multiplier is required"), 1, 100, "retry policy multiplier"),
                ["maxDelayMs"] = Delay(policy.MaxDelay, "max delay"),
            },
            RetryPolicyKind.DecorrelatedJitter => new JsonObject
            {
                ["type"] = "decorrelated-jitter",
                ["baseDelayMs"] = Delay(policy.BaseDelay, "base delay"),
                ["maxDelayMs"] = Delay(policy.MaxDelay, "max delay"),
            },
            _ => throw new ArgumentException("retry policy type must be fixed, exponential, or decorrelated-jitter"),
        };
        var extra = policy.Kind switch
        {
            RetryPolicyKind.Fixed => policy.InitialDelay ?? policy.BaseDelay ?? policy.MaxDelay ?? (object?)policy.Multiplier,
            RetryPolicyKind.Exponential => policy.Delay ?? policy.BaseDelay,
            _ => policy.Delay ?? policy.InitialDelay ?? (object?)policy.Multiplier,
        };
        if (extra is not null)
        {
            throw new ArgumentException($"{Wire.Text(policy.Kind)} retry policy has a field of another kind");
        }

        var floor = document["initialDelayMs"] ?? document["baseDelayMs"];
        if (floor is not null && document["maxDelayMs"]!.GetValue<long>() < floor.GetValue<long>())
        {
            throw new ArgumentException($"retry policy maxDelayMs must be at least {floor.GetValue<long>()}");
        }

        return document;
    }

    /// <summary>Validates a contracted payload and stamps the contract fields that PostgreSQL enforces.</summary>
    private async Task ApplyContractAsync(Call call, JsonObject input, string taskType, CancellationToken cancellationToken)
    {
        PayloadContract? contract;
        if (!call.Loaded.TryGetValue(taskType, out contract))
        {
            var (known, cached, enabled) = _shared.Lookup(taskType);
            contract = cached;
            if (!known && enabled)
            {
                contract = await ContractStore.LoadAsync(call.Connection, taskType, null, cancellationToken).ConfigureAwait(false);
                Remember(call, taskType, contract);
            }
        }

        StampContract(input, taskType, contract);
    }

    /// <summary>
    /// Keeps a contract that the call loaded. A contract read inside the transaction of a caller can
    /// be uncommitted, so only the call uses it, and the shared cache stays as it is.
    /// </summary>
    private void Remember(Call call, string taskType, PayloadContract? contract)
    {
        call.Loaded[taskType] = contract;
        if (!call.Caller)
        {
            _shared.Remember(taskType, contract);
        }
    }

    private static void StampContract(JsonObject input, string taskType, PayloadContract? contract)
    {
        if (contract is null)
        {
            return;
        }

        if (!contract.Schema.Valid(JsonTree.Parse(Values.Write(input["payload"]))))
        {
            throw new ContractValidationException(taskType, contract.Version);
        }

        input["contractVersion"] = contract.Version;
        input["payloadMaxBytes"] = contract.PayloadMaxBytes;
        input["resultMaxBytes"] = contract.ResultMaxBytes;
        input["sensitivePayloadKeys"] = new JsonArray([.. contract.PayloadRedactKeys.Select(key => (JsonNode?)key)]);
        input["sensitiveResultKeys"] = new JsonArray([.. contract.ResultRedactKeys.Select(key => (JsonNode?)key)]);
    }

    /// <summary>The task types that PostgreSQL named when a batch carried a stale contract, or <c>null</c>.</summary>
    private static List<string>? ContractMismatch(IReadOnlyList<Row> rows)
    {
        foreach (var row in rows)
        {
            if (row.Text("outcome") != "contract_mismatch")
            {
                continue;
            }

            try
            {
                using var detail = JsonDocument.Parse(row.Text("reason") ?? "null");
                if (detail.RootElement.ValueKind == JsonValueKind.Object
                    && detail.RootElement.TryGetProperty("taskTypes", out var taskTypes)
                    && taskTypes.ValueKind == JsonValueKind.Array
                    && taskTypes.EnumerateArray().All(item => item.ValueKind == JsonValueKind.String))
                {
                    return [.. taskTypes.EnumerateArray().Select(item => item.GetString()!)];
                }
            }
            catch (JsonException)
            {
                // An unreadable detail is an invalid result, as below.
            }

            throw InvalidResult();
        }

        return null;
    }

    private static List<EnqueueResult> EnqueueResults(IReadOnlyList<Row> rows, int count)
    {
        if (rows.Count != count)
        {
            throw InvalidResult();
        }

        var results = new EnqueueResult?[count];
        foreach (var row in rows)
        {
            var index = row.RequiredLong("ordinal") - 1;
            if (index < 0 || index >= count || results[index] is not null)
            {
                throw InvalidResult();
            }

            var outcome = Wire.Required<EnqueueOutcome>("enqueue", row.Text("outcome"));
            var reason = row.Text("reason");
            EnqueueNonReplaceableReason? because = null;
            if (outcome == EnqueueOutcome.NonReplaceable)
            {
                because = Wire.Required<EnqueueNonReplaceableReason>("enqueue", reason);
            }
            else if (reason is not null)
            {
                throw InvalidResult();
            }

            results[index] = new EnqueueResult { TaskId = row.RequiredUuid("task_id"), Outcome = outcome, Reason = because };
        }

        return [.. results.Select(result => result!)];
    }

    private static WorkhorseException InvalidResult() => new("PostgreSQL returned an invalid enqueue result");

    // ---------------------------------------------------------------------------------------------
    // Values

    private static JsonArray Tags(IReadOnlyList<string>? values)
    {
        values ??= [];
        var valid = values.Count <= MaxTags && values.All(tag => tag is not null && CodePoints(tag) is >= 1 and <= MaxTagLength && !Utf16.HasLoneSurrogate(tag));
        return valid
            ? new JsonArray([.. values.Select(tag => (JsonNode?)tag)])
            : throw new ArgumentException($"tags must be a List of at most {MaxTags} Strings of 1 to {MaxTagLength} characters");
    }

    private static int Range(int value, int minimum, int maximum, string label) =>
        value >= minimum && value <= maximum
            ? value
            : throw new ArgumentException($"{label} must be an Integer between {minimum} and {maximum}");

    private static string Scope(string? value) => OptionalBytes(value, MaxNameBytes, "scope") ?? "default";

    private static string RequiredString(string? value, string label) =>
        string.IsNullOrEmpty(value)
            ? throw new ArgumentException($"{label} must be a non-empty String")
            : Utf16.Require(value, label);

    private static string RequiredBytes(string? value, int maximum, string label)
    {
        var length = value is null ? 0 : Values.Bytes(Utf16.Require(value, label));
        return length >= 1 && length <= maximum
            ? value!
            : throw new ArgumentException($"{label} must contain between 1 and {maximum} UTF-8 bytes");
    }

    /// <summary>
    /// The protocol value of an execution timeout. Zero means no timeout, as <c>null</c> does. A
    /// nonzero duration that rounds to 0 ms is refused, so it cannot remove the timeout.
    /// </summary>
    private static long? ExecutionTimeout(TimeSpan? timeout) =>
        timeout is not { } value || value == TimeSpan.Zero
            ? null
            : Values.Milliseconds(value, "execution timeout", 1, MaxDurationMs);

    /// <summary>
    /// The protocol value of an idempotency TTL. Zero takes the default. A nonzero duration that
    /// rounds to 0 ms is refused, so a unit mistake cannot select the default.
    /// </summary>
    private static long IdempotencyTtl(TimeSpan ttl) =>
        ttl == TimeSpan.Zero ? DefaultIdempotencyTtlMs : Values.Milliseconds(ttl, "idempotency TTL", 1, MaxDurationMs);

    /// <summary>The value, or <c>null</c> when it is null or empty. A value longer than the maximum throws.</summary>
    private static string? OptionalBytes(string? value, int maximum, string label)
    {
        if (string.IsNullOrEmpty(value))
        {
            return null;
        }

        return Values.Bytes(Utf16.Require(value, label)) <= maximum
            ? value
            : throw new ArgumentException($"{label} must contain at most {maximum} UTF-8 bytes");
    }

    private static int CodePoints(string text)
    {
        var count = 0;
        for (var index = 0; index < text.Length; index++)
        {
            if (char.IsHighSurrogate(text[index]) && index + 1 < text.Length && char.IsLowSurrogate(text[index + 1]))
            {
                index++;
            }

            count++;
        }

        return count;
    }

    // ---------------------------------------------------------------------------------------------
    // Connections

    private Task AssertCompatibleAsync(Call call, CancellationToken cancellationToken) =>
        _shared.Compatibility.AssertAsync(call.Connection, call.Caller, cancellationToken);

    private Task<T> RunAsync<T>(Func<Call, Task<T>> body, CancellationToken cancellationToken) =>
        DataSources.RunAsync(_dataSource, _caller, (connection, caller) => body(new Call(connection, caller)), cancellationToken);

    /// <summary>
    /// The connection of one call. <see cref="Caller"/> is true when the caller owns the connection;
    /// then a contract that the call reads can be uncommitted. <see cref="Loaded"/> holds the
    /// contracts that the call loaded.
    /// </summary>
    private sealed class Call(NpgsqlConnection connection, bool caller)
    {
        internal NpgsqlConnection Connection { get; } = connection;

        internal bool Caller { get; } = caller;

        internal Dictionary<string, PayloadContract?> Loaded { get; } = new(StringComparer.Ordinal);
    }

    /// <summary>One request with its payload already serialized.</summary>
    private sealed record Pending(string TaskType, EnqueueOptions Options, string Payload)
    {
        internal static Pending From(EnqueueRequest request, JsonCodec codec) =>
            new(request.TaskType, request.Options ?? new EnqueueOptions(), codec.Serialize(request.Payload, "payload"));
    }

    /// <summary>The state that a queue and each of its caller forms share.</summary>
    private sealed class Shared(string defaultQueue, JsonCodec codec)
    {
        private readonly Lock _lock = new();
        private readonly Dictionary<string, PayloadContract?> _contracts = new(StringComparer.Ordinal);
        private bool _contractsEnabled;

        internal string DefaultQueue { get; } = defaultQueue;

        internal JsonCodec Codec { get; } = codec;

        internal CompatibilityCache Compatibility { get; } = new();

        internal (bool Known, PayloadContract? Contract, bool Enabled) Lookup(string taskType)
        {
            lock (_lock)
            {
                return (_contracts.TryGetValue(taskType, out var contract), contract, _contractsEnabled);
            }
        }

        internal void Remember(string taskType, PayloadContract? contract)
        {
            lock (_lock)
            {
                _contracts[taskType] = contract;
            }
        }

        internal void ContractsSynced()
        {
            lock (_lock)
            {
                _contracts.Clear();
                _contractsEnabled = true;
            }
        }
    }
}
