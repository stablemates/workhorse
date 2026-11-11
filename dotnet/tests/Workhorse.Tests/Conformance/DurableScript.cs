using System.Globalization;
using System.Text.Json;
using Npgsql;
using Workhorse.Tests.Testing;

namespace Workhorse.Tests.Conformance;

/// <summary>
/// Runs the <c>durable-script</c> fixtures of <c>protocol/v1/runtime.json</c> (SM-1950).
/// </summary>
/// <remarks>
/// A handler runs the fixture's script through its handler context, and the runner drives the task
/// through the fixture's steps. <c>protocol/README.md</c> describes the operations and the steps.
/// The phase <c>suspend</c> runs the steps before <c>handOff</c>, and <c>replay</c> runs the steps
/// after it, so two SDKs can share one task. <c>all</c> runs every step and resets the counters at
/// <c>handOff</c>.
/// </remarks>
internal sealed class DurableScript(Func<NpgsqlDataSourceBuilder> builder, NpgsqlDataSource dataSource)
{
    /// <summary>
    /// A bound on the claims of one run step, so a defect cannot loop for ever. The run-once call of
    /// each SDK can claim more than one task, so a step names the work that ends, not a count of claims.
    /// </summary>
    private const int MaximumDrainPasses = 20;

    private int _handlerRuns;
    private int _checkpointOperations;
    private int _caughtSuspensions;

    /// <summary>Handler runs that reached the end of the script. A run that suspends never does.</summary>
    private int _completedScripts;

    /// <summary>Timer, wait, and child calls that returned. A call that suspends never returns.</summary>
    private int _returnedSuspendingCalls;

    /// <summary>The operations that can suspend the task.</summary>
    private static readonly HashSet<string> Suspending = new(StringComparer.Ordinal)
    {
        "sleep", "sleepUntil", "waitForSignal", "waitForHuman", "runChild",
    };

    internal async Task RunAsync(OrderedDictionary<string, object?> fixture, string phase)
    {
        var id = Runner.Text(fixture["id"]);
        var steps = Steps(fixture, phase);
        var taskType = Runner.Text(fixture["taskType"]);
        var taskId = await PrepareTaskAsync(fixture, phase, taskType);
        await using var taskPool = Intercept.Create(builder(), Intercept.Hook.None);
        await using var childPool = Intercept.Create(builder(), Intercept.Hook.None);
        var workers = new Dictionary<string, Worker>(StringComparer.Ordinal);
        try
        {
            var task = new Worker(taskPool.DataSource, Options($"runtime-{id}", $"dotnet-{id}"));
            task.Handle<JsonElement, object?>(taskType, (context, payload) => RunScriptAsync(fixture, payload, context));
            workers["task"] = task;
            if (fixture.GetValueOrDefault("childQueue") is string childQueue)
            {
                var child = new Worker(childPool.DataSource, Options(childQueue, $"dotnet-{id}-children"));
                child.Handle<JsonElement, object?>(
                    Runner.Text(fixture["childTaskType"]),
                    (_, payload) => Task.FromResult<object?>(new Dictionary<string, object?> { ["echo"] = payload }));
                workers["child"] = child;
            }

            for (var index = 0; index < steps.Count; index++)
            {
                var step = Runner.Object(steps[index], "step");
                var action = Runner.Text(step["action"]);
                var where = $"{id} step {index + 1} ({action})";
                switch (action)
                {
                    case "run":
                        var name = step.GetValueOrDefault("worker") is string selected ? selected : "task";
                        Failure.Check(workers.TryGetValue(name, out var worker), $"{where}: the fixture has no {name} worker");
                        await DrainAsync(worker!, where);
                        break;
                    case "sql":
                        await using (var command = dataSource.CreateCommand(Runner.Text(step["sql"])))
                        {
                            command.Parameters.Add(new NpgsqlParameter { Value = taskId });
                            await command.ExecuteNonQueryAsync();
                        }

                        break;
                    case "handOff":
                        _handlerRuns = 0;
                        _checkpointOperations = 0;
                        _caughtSuspensions = 0;
                        _completedScripts = 0;
                        _returnedSuspendingCalls = 0;
                        break;
                    case "expect":
                        await ExpectObservedAsync(fixture, taskId, step, where);
                        break;
                    default:
                        throw new Failure($"{where}: unknown action");
                }
            }
        }
        finally
        {
            foreach (var worker in workers.Values)
            {
                await worker.DisposeAsync();
            }
        }
    }

    private static WorkerOptions Options(string queue, string workerId) => new()
    {
        Queues = [queue],
        WorkerId = workerId,
        Concurrency = 1,
        PollingOnly = true,
        DisableRegistry = true,
        PollInterval = TimeSpan.FromMilliseconds(5),
        LoggerFactory = TestLog.Instance,
    };

    private static List<object?> Steps(OrderedDictionary<string, object?> fixture, string phase)
    {
        var steps = (List<object?>)fixture["steps"]!;
        if (phase == "all")
        {
            return steps;
        }

        var handOff = steps.FindIndex(step => Matcher.Same(Runner.Object(step, "step")["action"], "handOff"));
        Failure.Check(handOff >= 0, $"{Runner.Text(fixture["id"])} has no handOff step for the {phase} phase");
        return phase switch
        {
            "suspend" => steps[..handOff],
            "replay" => steps[(handOff + 1)..],
            _ => throw new Failure($"unknown phase {phase}"),
        };
    }

    private async Task<Guid> PrepareTaskAsync(OrderedDictionary<string, object?> fixture, string phase, string taskType)
    {
        if (phase == "replay")
        {
            await using var find = dataSource.CreateCommand("SELECT id FROM workhorse.task WHERE task_type = $1");
            find.Parameters.Add(new NpgsqlParameter { Value = taskType });
            var ids = new List<Guid>();
            await using (var reader = await find.ExecuteReaderAsync())
            {
                while (await reader.ReadAsync())
                {
                    ids.Add(reader.GetGuid(0));
                }
            }

            Failure.Check(ids.Count == 1, $"expected one {taskType} task, found {ids.Count}");
            return ids[0];
        }

        object? payload = Json.Members();
        if (fixture.GetValueOrDefault("payloadSql") is string payloadSql)
        {
            await using var command = dataSource.CreateCommand(payloadSql);
            payload = Json.Parse((string)(await command.ExecuteScalarAsync())!);
        }

        var queue = new Queue(dataSource);
        return (await queue.EnqueueAsync(taskType, Json.Element(payload), new EnqueueOptions { Queue = $"runtime-{Runner.Text(fixture["id"])}" })).TaskId;
    }

    private static async Task DrainAsync(Worker worker, string where)
    {
        Failure.Check(await worker.RunOnceAsync(), $"{where}: the worker claimed no task");
        for (var pass = 0; pass < MaximumDrainPasses; pass++)
        {
            if (!await worker.RunOnceAsync())
            {
                return;
            }
        }

        throw new Failure($"{where}: the queue did not drain");
    }

    private async Task ExpectObservedAsync(OrderedDictionary<string, object?> fixture, Guid taskId, OrderedDictionary<string, object?> step, string where)
    {
        await using var command = dataSource.CreateCommand(Runner.Text(fixture["observe"]));
        command.Parameters.Add(new NpgsqlParameter { Value = taskId });
        var observed = Json.Parse((string)(await command.ExecuteScalarAsync())!);
        Failure.Check(Matcher.Same(observed, step["observed"]), $"{where}: observed {Matcher.Render(observed)}, expected {Matcher.Render(step["observed"])}");
        foreach (var (name, actual) in new[]
        {
            ("handlerRuns", _handlerRuns),
            ("checkpointOperations", _checkpointOperations),
            ("caughtSuspensions", _caughtSuspensions),
            ("completedScripts", _completedScripts),
            ("returnedSuspendingCalls", _returnedSuspendingCalls),
        })
        {
            var expected = step.GetValueOrDefault(name);
            Failure.Check(expected is null || Matcher.Same((long)actual, expected), $"{where}: {name} is {actual}, expected {expected}");
        }
    }

    private async Task<object?> RunScriptAsync(OrderedDictionary<string, object?> fixture, JsonElement payload, HandlerContext context)
    {
        Interlocked.Increment(ref _handlerRuns);
        var result = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (var entry in (List<object?>)fixture["script"]!)
        {
            var operation = Runner.Object(entry, "operation");
            var key = operation.GetValueOrDefault("key") as string;
            if (Matcher.Same(operation["op"], "catchSuspension"))
            {
                try
                {
                    await RunOperationAsync(fixture, Runner.Object(operation["step"], "step"), payload, context);
                }
#pragma warning disable CA1031 // The handler catches the suspension, whatever its type.
                catch (Exception)
#pragma warning restore CA1031
                {
                    // The handler catches the suspension and returns. The worker must suspend the task anyway.
                    Interlocked.Increment(ref _caughtSuspensions);
                    return new Dictionary<string, object?> { [key!] = true };
                }

                result[key!] = false;
                continue;
            }

            var value = await RunOperationAsync(fixture, operation, payload, context);
            if (key is not null)
            {
                result[key] = value;
            }
        }

        Interlocked.Increment(ref _completedScripts);
        return result;
    }

    private static DateTimeOffset PayloadTime(JsonElement payload, object? field)
    {
        var name = Runner.Text(field);
        Failure.Check(payload.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String, $"the payload field {name} is not text");
        return DateTimeOffset.Parse(value.GetString()!, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind);
    }

    private async Task<object?> RunOperationAsync(OrderedDictionary<string, object?> fixture, OrderedDictionary<string, object?> operation, JsonElement payload, HandlerContext context)
    {
        var value = await RunOperationOnceAsync(fixture, operation, payload, context);
        if (Suspending.Contains(Runner.Text(operation["op"])))
        {
            Interlocked.Increment(ref _returnedSuspendingCalls);
        }

        return value;
    }

    private async Task<object?> RunOperationOnceAsync(OrderedDictionary<string, object?> fixture, OrderedDictionary<string, object?> operation, JsonElement payload, HandlerContext context)
    {
        var name = operation.GetValueOrDefault("name") as string ?? string.Empty;
        var childType = fixture.GetValueOrDefault("childTaskType") as string ?? string.Empty;
        var childQueue = fixture.GetValueOrDefault("childQueue") as string;
        switch (Runner.Text(operation["op"]))
        {
            case "checkpoint":
                var value = Json.Element(operation["value"]);
                Task<JsonElement> Operation(CancellationToken _)
                {
                    Interlocked.Increment(ref _checkpointOperations);
                    return Task.FromResult(value);
                }

                return operation.TryGetValue("input", out var input)
                    ? await context.CheckpointAsync(name, new CheckpointOptions { Input = Json.Element(input) }, Operation)
                    : await context.CheckpointAsync(name, Operation);
            case "sleep":
                await context.SleepAsync(name, TimeSpan.FromMilliseconds((long)operation["durationMs"]!));
                return null;
            case "sleepUntil":
                await context.SleepUntilAsync(name, PayloadTime(payload, operation["wakeAtField"]));
                return null;
            case "waitForSignal":
                return await context.WaitForSignalAsync<JsonElement>(name, null);
            case "waitForHuman":
                return await context.WaitForHumanAsync<JsonElement, JsonElement>(name, Json.Element(operation["context"]), null);
            case "runChild":
                var options = new EnqueueOptions
                {
                    Queue = childQueue,
                    Deadline = operation.TryGetValue("deadlineField", out var deadlineField) ? PayloadTime(payload, deadlineField) : null,
                    RunAt = operation.TryGetValue("runAtField", out var runAtField) ? PayloadTime(payload, runAtField) : null,
                };
                return await context.RunChildAsync<JsonElement, JsonElement>(name, childType, Json.Element(operation["payload"]), options);
            case "runChildren":
                var requests = ((List<object?>)operation["children"]!)
                    .Select(child => Runner.Object(child, "child"))
                    .Select(child => new ChildRequest
                    {
                        Name = Runner.Text(child["name"]),
                        TaskType = childType,
                        Payload = Json.Element(child["payload"]),
                        Options = new EnqueueOptions { Queue = childQueue },
                    })
                    .ToList();
                var outcomes = await context.RunChildrenAsync(requests);

                // The set join counts as returned before the runner reads its outcomes, so a wrong
                // value still counts.
                Interlocked.Increment(ref _returnedSuspendingCalls);
                return outcomes.ToDictionary(
                    outcome => outcome.Key,
                    outcome => outcome.Value.Status == ChildStatus.Succeeded
                        ? new Dictionary<string, object?> { ["status"] = "succeeded", ["result"] = outcome.Value.Result }
                        : new Dictionary<string, object?> { ["status"] = outcome.Value.Status.ToString().ToLowerInvariant() },
                    StringComparer.Ordinal);
            case "overlappingCheckpoints":
                return await OverlappingCheckpointsAsync(name, (long)operation["overlapWindowMs"]!, context);
            default:
                throw new Failure($"unknown durable-script operation {Matcher.Render(operation["op"])}");
        }
    }

    /// <summary>
    /// Starts a second call with one name while the operation of the first call runs. The operation
    /// waits until a second operation starts or the window ends, so a call that does not join the
    /// call in flight runs the operation again.
    /// </summary>
    private async Task<object?> OverlappingCheckpointsAsync(string name, long windowMs, HandlerContext context)
    {
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        async Task<Dictionary<string, object?>> Operation(CancellationToken cancellationToken)
        {
            var ordinal = Interlocked.Increment(ref _checkpointOperations);
            started.TrySetResult();
            var deadline = DateTime.UtcNow.AddMilliseconds(windowMs);
            while (Volatile.Read(ref _checkpointOperations) < 2 && DateTime.UtcNow < deadline)
            {
                await Task.Delay(10, cancellationToken);
            }

            return new Dictionary<string, object?> { ["operation"] = ordinal };
        }

        var first = context.CheckpointAsync(name, Operation);
        await Task.WhenAny(first, started.Task);
        if (first.IsCompleted && !started.Task.IsCompleted)
        {
            await first;
            throw new Failure("the first checkpoint call ended before its operation started");
        }

        var second = await context.CheckpointAsync(name, Operation);
        return new List<object?> { await first, second };
    }
}
