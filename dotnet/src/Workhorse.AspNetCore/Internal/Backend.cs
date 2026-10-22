using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Npgsql;

namespace Workhorse.AspNetCore.Internal;

/// <summary>One built-in procedure. It returns the JSON text of its result, or <c>null</c> for <c>{}</c>.</summary>
internal delegate Task<string?> BuiltInProcedure(JsonObject input, string actor, CancellationToken cancellationToken);

/// <summary>
/// Answers each <c>dashboard/v1</c> procedure through <see cref="Queue"/>, <see cref="Admin"/>, and the
/// catalogue statement that owns it. The counterpart of Ruby's <c>Dashboard::Backend</c>.
/// </summary>
/// <remarks>
/// Each procedure takes the validated input and the actor. Each statement runs on its own
/// connection in autocommit, and the backend opens no transaction. Redaction stays in the versioned
/// read surface (ADR 0035): the backend reads payloads and results only through the
/// <c>dashboard_*_v1</c> functions and writes their JSON text unchanged.
/// </remarks>
internal sealed class Backend
{
    /// <summary>How long one health document serves nearby reads. The other hosts use the same time.</summary>
    private static readonly TimeSpan QueueHealthLifetime = TimeSpan.FromSeconds(3);

    private static readonly string[] MaintenanceSettings =
    [
        "timezone",
        "partitionPreparationIntervalMs",
        "terminalCleanupIntervalMs",
        "historyRetentionLocalTime",
        "statisticsRollupIntervalMs",
        "statisticsGroupLimit",
        "statisticsRecomputeBuckets",
    ];

    private readonly NpgsqlDataSource _dataSource;
    private readonly Statements _statements;

    // Queue and Admin each keep their compatibility verdict, a refusal too, so Reset replaces them.
    private volatile Queue _queue;
    private volatile Admin _admin;
    private readonly string _environment;
    private readonly JsonArray _configuredWorkers;
    private readonly JsonObject _maintenanceLoops;
    private readonly bool _readOnly;
    private readonly Lock _healthGate = new();
    private (Task<string> Read, long ExpiresAt)? _health;

    internal Backend(NpgsqlDataSource dataSource, string environment, IReadOnlyList<string> configuredWorkers,
        IReadOnlyDictionary<string, JsonElement> maintenanceLoops, bool readOnly)
    {
        _dataSource = dataSource;
        _statements = new Statements(dataSource);
        _queue = new Queue(dataSource);
        _admin = new Admin(dataSource);
        _environment = environment;
        _configuredWorkers = new JsonArray([.. configuredWorkers.Select(worker => (JsonNode?)JsonValue.Create(worker))]);
        _maintenanceLoops = new JsonObject(maintenanceLoops.Select(loop =>
            KeyValuePair.Create(loop.Key, JsonSerializer.SerializeToNode(loop.Value))));
        _readOnly = readOnly;
    }

    /// <summary>
    /// Replaces the clients after a compatibility refusal, so the backend checks the schema again
    /// after an operator migrates it.
    /// </summary>
    internal void Reset()
    {
        _queue = new Queue(_dataSource);
        _admin = new Admin(_dataSource);
    }

    /// <summary>Procedure name to its built-in answer.</summary>
    internal Dictionary<string, BuiltInProcedure> Procedures() => new(StringComparer.Ordinal)
    {
        ["meta"] = (_, _, _) => Task.FromResult<string?>(Write(new JsonObject { ["environment"] = _environment })),
        ["taskCounts"] = (_, _, token) => ResultAsync(DashboardSqlCatalogue.DashboardTaskCountsV1, null, token),
        ["tasks"] = (input, _, token) => ResultAsync(DashboardSqlCatalogue.DashboardTasksV1, TaskQuery(input, !_readOnly), token),
        ["tasksCursor"] = (input, _, token) =>
            ResultAsync(DashboardSqlCatalogue.DashboardTasksCursorV1, With(input, ("canCompleteHumanWait", !_readOnly)), token),
        ["activity"] = (input, _, token) => ResultAsync(DashboardSqlCatalogue.DashboardActivityV1, input, token),
        ["taskFacets"] = (_, _, token) =>
            ResultAsync(DashboardSqlCatalogue.DashboardTaskFacetsV1, new JsonObject { ["configuredWorkers"] = _configuredWorkers.DeepClone() }, token),
        ["queues"] = (_, _, token) => ResultAsync(DashboardSqlCatalogue.DashboardQueuesV1, null, token),
        ["cron"] = (_, _, token) =>
            ResultAsync(DashboardSqlCatalogue.DashboardCronV1, new JsonObject { ["maintenanceLoops"] = _maintenanceLoops.DeepClone() }, token),
        ["workers"] = (_, _, token) => ResultAsync(
            DashboardSqlCatalogue.DashboardWorkersV1,
            new JsonObject { ["configuredWorkers"] = _configuredWorkers.DeepClone(), ["canManageWorkers"] = !_readOnly },
            token),
        ["humanWaits"] = HumanWaitsAsync,
        ["events"] = (input, _, token) => ResultAsync(DashboardSqlCatalogue.DashboardEventsV1, input, token),
        ["eventDetail"] = async (input, _, token) =>
            Found(await ResultAsync(DashboardSqlCatalogue.DashboardEventDetailV1, input, token).ConfigureAwait(false), "Event not found"),
        ["taskDetail"] = TaskDetailAsync,

        // Task detail withholds a large checkpoint value, payload, or result and reports its size,
        // so an operator opens that one value with these two procedures.
        ["checkpointValue"] = async (input, _, token) =>
            Found(await ResultAsync(DashboardSqlCatalogue.DashboardCheckpointValueV1, input, token).ConfigureAwait(false), "Checkpoint not found"),
        ["taskValue"] = async (input, _, token) =>
            Found(await ResultAsync(DashboardSqlCatalogue.DashboardTaskValueV1, input, token).ConfigureAwait(false), "Task not found"),
        ["settings"] = (_, _, token) => ResultAsync(
            DashboardSqlCatalogue.DashboardSettingsV1,
            new JsonObject { ["writable"] = !_readOnly, ["settingsController"] = true },
            token),
        ["system"] = (input, _, token) => ResultAsync(DashboardSqlCatalogue.DashboardSystemV1, input, token),

        // The function merges the definition into the current policy and caps each count.
        ["previewRetentionPolicy"] = (input, _, token) => ResultAsync(DashboardSqlCatalogue.DashboardRetentionPreviewV1, input, token),
        ["setQueuePaused"] = SetQueuePausedAsync,
        ["purgeQueue"] = async (input, actor, token) => Write(new JsonObject
        {
            ["deletedCount"] = await _admin.PurgeQueueAsync(Text(input, "queue"), Audit(input, actor), token).ConfigureAwait(false),
        }),
        ["setQueueTier"] = SetQueueTierAsync,
        ["setQueueHistory"] = SetQueueHistoryAsync,
        ["setWorkerPaused"] = SetWorkerPausedAsync,
        ["overrideMaintenancePolicy"] = OverrideMaintenanceAsync,
        ["revertMaintenancePolicy"] = (input, _, token) => RevertAsync(DashboardSqlCatalogue.RevertMaintenancePolicyV1, input, token),
        ["overrideRetentionPolicy"] = OverrideRetentionAsync,
        ["revertRetentionPolicy"] = (input, _, token) => RevertAsync(DashboardSqlCatalogue.RevertRetentionPolicyV1, input, token),
        ["runTaskNow"] = RunTaskNowAsync,
        ["cancelTask"] = CancelTaskAsync,
        ["signalTask"] = SignalTaskAsync,
        ["completeHumanWait"] = CompleteHumanWaitAsync,
        ["redriveTask"] = RedriveTaskAsync,
        ["redriveDeadLetters"] = RedriveDeadLettersAsync,

        // The task group procedures (ADR 0095) run the statements that generate-bindings.ts copies
        // from the TypeScript server, so every backend answers them with the same JSON.
        ["taskGroups"] = (input, _, token) => SharedAsync("taskGroups", V1.TaskGroups, input, token),
        ["taskGroupDetail"] = async (input, _, token) => Found(
            await SharedAsync("taskGroupDetail", V1.TaskGroupDetail, With(input, ("canCancel", !_readOnly)), token).ConfigureAwait(false),
            "Task group not found"),
        ["cancelTaskGroup"] = CancelTaskGroupAsync,
    };

    private static JsonObject TaskQuery(JsonObject input, bool canCompleteHumanWait)
    {
        var query = new JsonObject
        {
            ["filter"] = "all",
            ["queue"] = null,
            ["page"] = 1,
            ["worker"] = null,
            ["taskType"] = null,
            ["priority"] = null,
            ["sort"] = "updated",
            ["tags"] = new JsonArray(),
            ["search"] = null,
            ["pageSize"] = 50,
            ["count"] = "none",
        };
        foreach (var (name, value) in input)
        {
            query[name] = value?.DeepClone();
        }

        query["canCompleteHumanWait"] = canCompleteHumanWait;
        return query;
    }

    private async Task<string?> HumanWaitsAsync(JsonObject input, string actor, CancellationToken cancellationToken)
    {
        var health = await QueueHealthAsync(cancellationToken).ConfigureAwait(false);
        return await ResultAsync(
            DashboardSqlCatalogue.DashboardHumanWaitsV1,
            new JsonObject { ["canComplete"] = !_readOnly, ["canSignal"] = !_readOnly, ["health"] = health },
            cancellationToken).ConfigureAwait(false);
    }

    private async Task<string?> TaskDetailAsync(JsonObject input, string actor, CancellationToken cancellationToken)
    {
        var health = await QueueHealthAsync(cancellationToken).ConfigureAwait(false);
        var query = With(input, ("canSignal", !_readOnly), ("canCompleteHumanWait", !_readOnly));
        query["health"] = health;
        return Found(await ResultAsync(DashboardSqlCatalogue.DashboardTaskDetailV1, query, cancellationToken).ConfigureAwait(false), "Task not found");
    }

    private async Task<string?> SetQueuePausedAsync(JsonObject input, string actor, CancellationToken cancellationToken)
    {
        var paused = Bool(input, "paused");
        var audit = Audit(input, actor);
        if (paused)
        {
            await _admin.PauseQueueAsync(Text(input, "queue"), audit, cancellationToken).ConfigureAwait(false);
        }
        else
        {
            await _admin.ResumeQueueAsync(Text(input, "queue"), audit, cancellationToken).ConfigureAwait(false);
        }

        return Write(new JsonObject { ["paused"] = paused });
    }

    /// <summary>
    /// Moves one queue between the tiers. The guards stay in <c>set_queue_tier_v1</c>: a refused
    /// switch answers a status that names the guard, and the queue keeps its tier.
    /// </summary>
    private async Task<string?> SetQueueTierAsync(JsonObject input, string actor, CancellationToken cancellationToken)
    {
        var tier = Text(input, "tier") switch
        {
            "fast" => QueueTier.Fast,
            "full" => QueueTier.Full,
            var other => throw new ArgumentException($"tier must be fast or full, not {other}"),
        };
        var queue = Text(input, "queue");
        try
        {
            var result = await _admin.SetQueueTierAsync(queue, tier, Audit(input, actor), cancellationToken).ConfigureAwait(false);
            return Write(new JsonObject { ["status"] = "set", ["tier"] = Snake(result) });
        }
        catch (FastTierUnsupportedException error)
        {
            return Write(new JsonObject { ["status"] = TierRefusal(queue, error), ["tier"] = null });
        }
    }

    /// <summary>The <c>setQueueTier</c> status that names the guard of <c>set_queue_tier_v1</c>.</summary>
    /// <exception cref="InvalidOperationException">
    /// The exception names no known guard. Npgsql removes the PostgreSQL detail that names it unless
    /// the connection string sets <c>Include Error Detail=true</c>.
    /// </exception>
    internal static string TierRefusal(string queue, FastTierUnsupportedException error) => error.Feature switch
    {
        "tier change" => "live_tasks",
        "concurrency policies" => "concurrency_policy",
        "rate-limit policies" => "rate_limit_policy",
        var feature => throw new InvalidOperationException(
            $"set_queue_tier_v1 refused the switch of queue {queue} for the feature \"{feature}\". "
            + "Set Include Error Detail=true on the dashboard data source so that the dashboard can name the cause.",
            error),
    };

    /// <summary>Chooses the history that a fast-tier queue records. An absent setting keeps its current value.</summary>
    private async Task<string?> SetQueueHistoryAsync(JsonObject input, string actor, CancellationToken cancellationToken)
    {
        var history = await _admin.SetQueueHistoryAsync(
            Text(input, "queue"), OptionalBool(input, "recordAttempts"), OptionalBool(input, "recordClaims"), cancellationToken).ConfigureAwait(false);
        return Write(new JsonObject { ["recordAttempts"] = history.RecordAttempts, ["recordClaims"] = history.RecordClaims });
    }

    private async Task<string?> SetWorkerPausedAsync(JsonObject input, string actor, CancellationToken cancellationToken)
    {
        var result = await _admin.SetWorkerPausedAsync(Text(input, "workerId"), Bool(input, "paused"), Audit(input, actor), cancellationToken)
            .ConfigureAwait(false) ?? throw DashboardRpcException.NotFound("Worker not found");
        return Write(new JsonObject { ["paused"] = result.Paused });
    }

    private async Task<string?> RedriveTaskAsync(JsonObject input, string actor, CancellationToken cancellationToken)
    {
        var result = await _admin.RedriveAsync(Uuid(input, "id"), Audit(input, actor), cancellationToken).ConfigureAwait(false);
        return result.Status == RedriveStatus.NotFound ? throw DashboardRpcException.NotFound("Task not found") : Write(RedriveDocument(result));
    }

    private async Task<string?> RedriveDeadLettersAsync(JsonObject input, string actor, CancellationToken cancellationToken)
    {
        var cursor = input["cursor"] as JsonObject;
        var filter = new RedriveFilter
        {
            Limit = input["limit"] is JsonValue limit ? limit.GetValue<int>() : 100,
            Cursor = cursor is null ? null : new DeadLetterCursor { FinishedAt = Text(cursor, "finishedAt"), TaskId = Uuid(cursor, "taskId") },
            Queue = OptionalText(input, "queue"),
            Type = OptionalText(input, "taskType"),
            Tags = input["tags"] is JsonArray tags ? [.. tags.Select(TextOf)] : [],
        };
        var page = await _admin.RedriveManyAsync(filter, Audit(input, actor), cancellationToken).ConfigureAwait(false);
        return Write(new JsonObject
        {
            ["results"] = new JsonArray([.. page.Results.Select(result => (JsonNode?)RedriveDocument(result))]),
            ["nextCursor"] = page.NextCursor is { } next
                ? new JsonObject { ["finishedAt"] = next.FinishedAt, ["taskId"] = next.TaskId.ToString() }
                : null,
        });
    }

    private static JsonObject RedriveDocument(RedriveResult result) => new()
    {
        ["status"] = Snake(result.Status),
        ["sourceTaskId"] = result.SourceTaskId.ToString(),
        ["targetTaskId"] = result.TargetTaskId?.ToString(),
        ["sourceState"] = result.SourceState is { } source ? Snake(source) : null,
        ["targetState"] = result.TargetState is { } target ? Snake(target) : null,
        ["requestedAt"] = Iso(result.RequestedAt),
    };

    private async Task<string?> OverrideMaintenanceAsync(JsonObject input, string actor, CancellationToken cancellationToken)
    {
        var definition = ObjectOf(input, "definition");
        var parameters = new NpgsqlParameter[MaintenanceSettings.Length];
        for (var index = 0; index < MaintenanceSettings.Length; index++)
        {
            var value = definition[MaintenanceSettings[index]];
            parameters[index] = MaintenanceSettings[index] switch
            {
                "timezone" => Statements.Text(value is null ? null : TextOf(value)),
                "historyRetentionLocalTime" => Statements.Time(value is null
                    ? null
                    : TimeOnly.ParseExact(TextOf(value), "HH:mm", CultureInfo.InvariantCulture)),
                _ => Statements.Integer(value?.GetValue<int>()),
            };
        }

        await _statements.RowsAsync(DashboardSqlCatalogue.OverrideMaintenancePolicyV1.Sql, parameters, cancellationToken).ConfigureAwait(false);
        return null;
    }

    private async Task<string?> OverrideRetentionAsync(JsonObject input, string actor, CancellationToken cancellationToken)
    {
        var overrides = new JsonObject();
        foreach (var (name, value) in ObjectOf(input, "definition"))
        {
            overrides[Snake(name)] = value?.DeepClone();
        }

        await _statements.RowsAsync(
            DashboardSqlCatalogue.OverrideRetentionPolicyV1.Sql, [Statements.Text(Write(overrides))], cancellationToken).ConfigureAwait(false);
        return null;
    }

    private async Task<string?> RevertAsync(DashboardSqlCatalogue.Statement statement, JsonObject input, CancellationToken cancellationToken)
    {
        if (input["settings"] is not JsonArray settings)
        {
            throw new ArgumentException("settings must be an array");
        }

        var names = settings.Select(setting => Snake(TextOf(setting))).ToArray();
        await _statements.RowsAsync(statement.Sql, [Statements.TextArray(names)], cancellationToken).ConfigureAwait(false);
        return null;
    }

    private async Task<string?> RunTaskNowAsync(JsonObject input, string actor, CancellationToken cancellationToken)
    {
        var id = Text(input, "id");
        var audit = ObjectOf(input, "audit");
        var rows = await _statements.RowsAsync(
            DashboardSqlCatalogue.RunTaskNowV1.Sql,
            [Statements.Uuid(Guid.Parse(id, CultureInfo.InvariantCulture)), Statements.Text(actor),
                Statements.Text(OptionalText(audit, "reason")), Statements.Text(OptionalText(audit, "requestId"))],
            cancellationToken).ConfigureAwait(false);
        var row = rows.Count == 1 ? rows[0] : throw new InvalidOperationException($"run_task_now_v1 returned {rows.Count} rows; expected one");
        if (row["status"] as string == "not_found")
        {
            throw DashboardRpcException.NotFound("Task not found");
        }

        return Write(new JsonObject
        {
            ["status"] = row["status"] as string,
            ["id"] = id,
            ["state"] = row["state"] as string,
            ["runAt"] = Iso(row["run_at"]),
        });
    }

    private async Task<string?> CancelTaskAsync(JsonObject input, string actor, CancellationToken cancellationToken)
    {
        var result = await _queue.CancelAsync(
            Uuid(input, "id"),
            new CancelOptions { RequestedBy = actor, Reason = OptionalText(ObjectOf(input, "audit"), "reason") },
            cancellationToken).ConfigureAwait(false);
        if (result.Status == CancelStatus.NotFound)
        {
            throw DashboardRpcException.NotFound("Task not found");
        }

        return Write(new JsonObject
        {
            ["status"] = Snake(result.Status),
            ["taskId"] = Text(input, "id"),
            ["state"] = result.State is { } state ? Snake(state) : null,
            ["currentAttempt"] = result.CurrentAttempt,
            ["requestedAt"] = Iso(result.RequestedAt),
            ["requestedBy"] = result.RequestedBy,
            ["reason"] = result.Reason,
            ["finishedAt"] = Iso(result.FinishedAt),
        });
    }

    private async Task<string?> SignalTaskAsync(JsonObject input, string actor, CancellationToken cancellationToken)
    {
        var result = await _queue.SendSignalAsync(
            Uuid(input, "id"), Text(input, "name"), Element(input["payload"]), Text(input, "idempotencyKey"), actor, cancellationToken)
            .ConfigureAwait(false);
        if (result.Status == SignalStatus.NotFound)
        {
            throw DashboardRpcException.NotFound("Task not found");
        }

        return Write(new JsonObject
        {
            ["status"] = Snake(result.Status),
            ["taskId"] = Text(input, "id"),
            ["name"] = result.Name,
            ["payload"] = result.Payload is { } payload ? JsonSerializer.SerializeToNode(payload) : null,
            ["deliveredAt"] = Iso(result.DeliveredAt),
            ["deliveredBy"] = result.DeliveredBy,
        });
    }

    private async Task<string?> CompleteHumanWaitAsync(JsonObject input, string actor, CancellationToken cancellationToken)
    {
        var result = await _queue.CompleteHumanWaitAsync(
            Uuid(input, "id"), Text(input, "name"), Element(input["result"]), Text(input, "idempotencyKey"), actor, cancellationToken)
            .ConfigureAwait(false);
        if (result.Status == HumanWaitStatus.NotFound)
        {
            throw DashboardRpcException.NotFound("Task not found");
        }

        return Write(new JsonObject
        {
            ["status"] = Snake(result.Status),
            ["taskId"] = Text(input, "id"),
            ["name"] = result.Name,
            ["result"] = result.Payload is { } payload ? JsonSerializer.SerializeToNode(payload) : null,
            ["completedAt"] = Iso(result.CompletedAt),
            ["completedBy"] = result.CompletedBy,
        });
    }

    /// <summary>Seals the group and cancels each member task that is not terminal.</summary>
    private async Task<string?> CancelTaskGroupAsync(JsonObject input, string actor, CancellationToken cancellationToken)
    {
        var audit = ObjectOf(input, "audit");
        var request = new JsonObject
        {
            ["id"] = Text(input, "id"),
            ["actor"] = actor,
            ["reason"] = Text(audit, "reason"),
            ["requestId"] = Text(audit, "requestId"),
        };
        return Found(await SharedAsync("cancelTaskGroup", V1.CancelTaskGroup, request, cancellationToken).ConfigureAwait(false), "Task group not found");
    }

    // ---------------------------------------------------------------------------------------------
    // Statements

    private Task<string?> ResultAsync(DashboardSqlCatalogue.Statement statement, JsonObject? document, CancellationToken cancellationToken) =>
        _statements.ResultAsync(
            statement.Name,
            statement.Sql,
            statement.Arity == 0 ? [] : [Statements.Text(Write(document ?? []))],
            cancellationToken);

    /// <summary>The <c>result</c> of a shared <c>dashboard/v1</c> statement, which takes the input as <c>$1</c>.</summary>
    private Task<string?> SharedAsync(string name, string sql, JsonObject document, CancellationToken cancellationToken) =>
        _statements.ResultAsync(name, sql, [Statements.Text(Write(document))], cancellationToken);

    /// <summary>The <c>queue_health_v1</c> snapshot, shared for three seconds.</summary>
    /// <remarks>
    /// One dashboard page reads it from several procedures, and each accepts it as its
    /// <c>health</c> input, so the page pays for one pass over live queue state. Concurrent misses
    /// share one read. The backend never keeps a failed read. The shared read takes no request
    /// token, so one client that disconnects cannot fail the read of another.
    /// </remarks>
    private async Task<JsonNode?> QueueHealthAsync(CancellationToken cancellationToken)
    {
        Task<string> read;
        lock (_healthGate)
        {
            var now = Stopwatch.GetTimestamp();
            if (_health is { } shared && (!shared.Read.IsCompleted || (shared.Read.IsCompletedSuccessfully && now < shared.ExpiresAt)))
            {
                read = shared.Read;
            }
            else
            {
                read = ReadHealthAsync();
                _health = (read, now + (long)(QueueHealthLifetime.TotalSeconds * Stopwatch.Frequency));
            }
        }

        return JsonNode.Parse(await read.WaitAsync(cancellationToken).ConfigureAwait(false));
    }

    private async Task<string> ReadHealthAsync()
    {
        var health = await _queue.HealthAsync(CancellationToken.None).ConfigureAwait(false);
        return JsonSerializer.Serialize(health.Snapshot);
    }

    // ---------------------------------------------------------------------------------------------
    // Values

    /// <summary>Writes <paramref name="node"/> as compact JSON.</summary>
    internal static string Write(JsonNode node) => node.ToJsonString();

    private static string Found(string? value, string message) => value ?? throw DashboardRpcException.NotFound(message);

    private static JsonObject With(JsonObject input, params (string Name, bool Value)[] flags)
    {
        var copy = input.DeepClone().AsObject();
        foreach (var (name, value) in flags)
        {
            copy[name] = value;
        }

        return copy;
    }

    private static AdminAudit Audit(JsonObject input, string actor)
    {
        var audit = ObjectOf(input, "audit");
        return new AdminAudit { Actor = actor, Reason = Text(audit, "reason"), RequestId = Text(audit, "requestId") };
    }

    private static bool Bool(JsonObject input, string name) =>
        input[name] is JsonValue value && value.TryGetValue<bool>(out var flag) ? flag : throw new ArgumentException($"{name} must be a boolean");

    private static bool? OptionalBool(JsonObject input, string name) => input[name] is null ? null : Bool(input, name);

    private static JsonObject ObjectOf(JsonObject input, string name) =>
        input[name] as JsonObject ?? throw new ArgumentException($"{name} must be an object");

    private static string Text(JsonObject input, string name) =>
        input[name] is JsonValue value && value.TryGetValue<string>(out var text) ? text : throw new ArgumentException($"{name} must be a string");

    private static string? OptionalText(JsonObject input, string name) => input[name] is null ? null : Text(input, name);

    private static Guid Uuid(JsonObject input, string name) => Guid.Parse(Text(input, name), CultureInfo.InvariantCulture);

    /// <summary>The text of a scalar for a <c>text</c> parameter: a string as it is, any other value as JSON.</summary>
    private static string TextOf(JsonNode? value) =>
        value is JsonValue scalar && scalar.TryGetValue<string>(out var text) ? text : value?.ToJsonString() ?? "null";

    private static JsonElement Element(JsonNode? node) => JsonSerializer.SerializeToElement(node);

    /// <summary>The <c>snake_case</c> form of a <c>camelCase</c> name or a C# enum member.</summary>
    internal static string Snake(string name)
    {
        var builder = new StringBuilder(name.Length + 8);
        for (var index = 0; index < name.Length; index++)
        {
            var character = name[index];
            if (char.IsAsciiLetterUpper(character))
            {
                if (index > 0)
                {
                    builder.Append('_');
                }

                builder.Append(char.ToLowerInvariant(character));
            }
            else
            {
                builder.Append(character);
            }
        }

        return builder.ToString();
    }

    private static string Snake<T>(T value)
        where T : struct, Enum => Snake(value.ToString());

    /// <summary>
    /// A dashboard metadata timestamp: UTC with exactly three fractional digits, as JavaScript's
    /// <c>Date.toISOString()</c> writes it (<c>dashboard/v1</c>, "Conformance").
    /// </summary>
    internal static string? Iso(object? value) => value switch
    {
        null => null,
        DateTimeOffset instant => instant.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture),
        DateTime instant => instant.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture),
        _ => throw new InvalidOperationException($"a {value.GetType().Name} is not a timestamp"),
    };
}
