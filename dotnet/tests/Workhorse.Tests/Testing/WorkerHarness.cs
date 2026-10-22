using System.Diagnostics;
using System.Text.Json;
using Npgsql;
using Workhorse.Internal;
using Workhorse.Internal.Database;

namespace Workhorse.Tests.Testing;

/// <summary>
/// Test support for the worker: enqueue and read tasks through the catalogue, run a worker in the
/// background, and wait for observable state instead of a fixed sleep (SM-1155).
/// </summary>
internal static class WorkerHarness
{
    /// <summary>The longest wait for observable state. A busy shared machine can be slow.</summary>
    internal static readonly TimeSpan Patience = TimeSpan.FromSeconds(30);

    /// <summary>A queue name of its own for each test, so parallel tests share no queue.</summary>
    internal static string UniqueQueue(string prefix) => $"{prefix}-{Guid.NewGuid():N}"[..Math.Min(prefix.Length + 13, 60)];

    /// <summary>Enqueues one task through <c>enqueue_many_v1</c>, and returns its ID.</summary>
    internal static async Task<Guid> EnqueueAsync(NpgsqlDataSource dataSource, string queue, string type, object? payload, object? extra = null)
    {
        var request = new Dictionary<string, object?> { ["queue"] = queue, ["type"] = type, ["payload"] = payload };
        if (extra is not null)
        {
            foreach (var property in JsonSerializer.SerializeToElement(extra).EnumerateObject())
            {
                request[property.Name] = property.Value;
            }
        }

        await using var connection = await dataSource.OpenConnectionAsync();
        var rows = await Sql.RowsAsync(
            connection, SqlCatalogue.EnqueueManyV1, [Parameters.Json(JsonSerializer.Serialize(new[] { request }))], CancellationToken.None);
        return rows[0].RequiredUuid("task_id");
    }

    /// <summary>The <c>get_task</c> row of <paramref name="taskId"/>.</summary>
    internal static async Task<Row> TaskAsync(NpgsqlDataSource dataSource, Guid taskId)
    {
        await using var connection = await dataSource.OpenConnectionAsync();
        var rows = await Sql.RowsAsync(connection, SqlCatalogue.GetTask, [Parameters.Uuid(taskId)], CancellationToken.None);
        return rows.Single();
    }

    /// <summary>Waits until <paramref name="taskId"/> reaches <paramref name="state"/>, and returns its row.</summary>
    internal static async Task<Row> TaskInStateAsync(NpgsqlDataSource dataSource, Guid taskId, string state)
    {
        Row? row = null;
        await EventuallyAsync(async () => (row = await TaskAsync(dataSource, taskId)).Text("state") == state, $"task {taskId} reaches {state}");
        return row!;
    }

    /// <summary>Runs one SQL text with positional parameters, and returns the first column of the first row.</summary>
    internal static async Task<object?> ScalarAsync(NpgsqlDataSource dataSource, string sql, params object[] parameters)
    {
        await using var command = dataSource.CreateCommand(sql);
        foreach (var parameter in parameters)
        {
            command.Parameters.Add(new NpgsqlParameter { Value = parameter });
        }

        return await command.ExecuteScalarAsync();
    }

    /// <summary>Waits until <paramref name="condition"/> holds, or fails after <see cref="Patience"/>.</summary>
    internal static async Task EventuallyAsync(Func<Task<bool>> condition, string what, TimeSpan? patience = null)
    {
        var clock = Stopwatch.StartNew();
        while (!await condition())
        {
            if (clock.Elapsed > (patience ?? Patience))
            {
                Assert.Fail($"Timed out after {clock.Elapsed.TotalSeconds:F1} s waiting until {what}");
            }

            await Task.Delay(20);
        }
    }

    /// <summary>Waits until <paramref name="condition"/> holds, or fails after <see cref="Patience"/>.</summary>
    internal static Task EventuallyAsync(Func<bool> condition, string what, TimeSpan? patience = null) =>
        EventuallyAsync(() => Task.FromResult(condition()), what, patience);

    /// <summary>A worker options object for one queue, with short intervals for tests.</summary>
    internal static WorkerOptions Options(string queue, Action<WorkerOptions>? configure = null)
    {
        var options = new WorkerOptions
        {
            Queues = [queue],
            WorkerId = $"dotnet-test-{Guid.NewGuid():N}",
            PollInterval = TimeSpan.FromMilliseconds(50),
            ShutdownGrace = TimeSpan.FromSeconds(5),
            LoggerFactory = TestLog.Instance,
        };
        configure?.Invoke(options);
        return options;
    }
}

/// <summary>A worker that runs in the background until the test stops it.</summary>
internal sealed class RunningWorker : IAsyncDisposable
{
    private readonly CancellationTokenSource _stop = new();

    internal RunningWorker(Worker worker)
    {
        Worker = worker;
        Run = Task.Run(() => worker.RunAsync(_stop.Token));
    }

    internal Worker Worker { get; }

    internal Task Run { get; }

    /// <summary>Cancels the run's token and waits for <see cref="Worker.RunAsync"/> to return.</summary>
    internal async Task StopAsync()
    {
        await _stop.CancelAsync();
        await Run.WaitAsync(WorkerHarness.Patience);
    }

    public async ValueTask DisposeAsync()
    {
        await _stop.CancelAsync();
        try
        {
            await Run.WaitAsync(WorkerHarness.Patience);
        }
        catch (Exception)
        {
            // A test that expects an error from the run awaits Run itself.
        }

        _stop.Dispose();
    }
}
