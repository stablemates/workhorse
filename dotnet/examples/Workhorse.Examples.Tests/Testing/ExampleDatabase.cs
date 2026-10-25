using System.Diagnostics;
using System.Security.Cryptography;
using Npgsql;
using Workhorse.Tests.Testing;

namespace Workhorse.Examples.Tests.Testing;

/// <summary>
/// Reads and prepares a scratch database for the snippet tests. The shared instance wraps the
/// per-process scratch database. <see cref="CreateIsolatedAsync"/> makes a database of its own for a
/// snippet that runs a worker on a fixed queue, such as <c>default</c> or <c>billing</c>: a worker
/// claims every task of its queues, so in the shared database it would also claim the tasks that
/// other snippet tests leave there.
/// </summary>
public sealed class ExampleDatabase : IAsyncDisposable
{
    /// <summary>The longest wait of a snippet test for observable state.</summary>
    public static readonly TimeSpan Patience = TimeSpan.FromSeconds(60);

    private readonly ScratchDatabase _scratch;
    private readonly string? _isolatedName;
    private readonly ScratchDatabaseLease? _lease;

    private ExampleDatabase(ScratchDatabase scratch, NpgsqlDataSource dataSource, string? isolatedName, ScratchDatabaseLease? lease)
    {
        _scratch = scratch;
        _lease = lease;
        DataSource = dataSource;
        _isolatedName = isolatedName;
        Queue = new Queue(dataSource);
        Admin = new Admin(dataSource);
    }

    /// <summary>A data source for the database.</summary>
    public NpgsqlDataSource DataSource { get; }

    /// <summary>A queue on <see cref="DataSource"/>.</summary>
    public Queue Queue { get; }

    /// <summary>An admin client on <see cref="DataSource"/>.</summary>
    public Admin Admin { get; }

    /// <summary>The shared scratch database of the process. Disposing it does nothing.</summary>
    public static ExampleDatabase Shared(ScratchDatabase scratch) => new(scratch, scratch.DataSource, null, null);

    /// <summary>A new database with the schema, which <see cref="DisposeAsync"/> drops.</summary>
    public static async Task<ExampleDatabase> CreateIsolatedAsync(ScratchDatabase scratch)
    {
        _ = scratch.DataSource;
        var source = scratch.Name!.Split("_dotnet_")[0];
        var name = $"{source[..Math.Min(source.Length, 43)]}_dx_{Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(5))}";
        var lease = await scratch.CreateDatabaseAsync(name);

        var database = new ExampleDatabase(scratch, scratch.CreateDataSource(builder => builder.Database = name), name, lease);
        try
        {
            await database.ExecuteAsync(await File.ReadAllTextAsync(SchemaPath()));
        }
        catch
        {
            // The caller gets no database to dispose, so the drop and the end of the lease run here.
            await database.DisposeAsync();
            throw;
        }

        return database;
    }

    /// <summary>Runs one SQL statement with positional parameters.</summary>
    public async Task ExecuteAsync(string sql, params object[] parameters)
    {
        await using var command = Command(sql, parameters);
        await command.ExecuteNonQueryAsync();
    }

    /// <summary>The first column of the first row of one SQL statement.</summary>
    public async Task<T> ScalarAsync<T>(string sql, params object[] parameters)
    {
        await using var command = Command(sql, parameters);
        return (T)(await command.ExecuteScalarAsync())!;
    }

    /// <summary>The tasks of <paramref name="taskType"/> whose payload holds <paramref name="key"/> with <paramref name="value"/>.</summary>
    public async Task<IReadOnlyList<Guid>> TasksAsync(string taskType, string key, string value)
    {
        await using var command = Command(
            "SELECT id FROM workhorse.task WHERE task_type = $1 AND payload ->> $2 = $3 ORDER BY created_at, id",
            taskType,
            key,
            value);
        await using var reader = await command.ExecuteReaderAsync();
        var ids = new List<Guid>();
        while (await reader.ReadAsync())
        {
            ids.Add(reader.GetGuid(0));
        }

        return ids;
    }

    /// <summary>The detail of the one task of <paramref name="taskType"/> whose payload holds <paramref name="key"/> with <paramref name="value"/>.</summary>
    public async Task<TaskDetail> TaskAsync(string taskType, string key, string value)
    {
        var ids = await TasksAsync(taskType, key, value);
        Assert.True(ids.Count == 1, $"{ids.Count} {taskType} tasks with {key}={value}");
        return await DetailAsync(ids[0]);
    }

    /// <summary>The detail of one task.</summary>
    public async Task<TaskDetail> DetailAsync(Guid taskId) =>
        await Admin.GetTaskAsync(taskId) ?? throw new InvalidOperationException($"task {taskId} does not exist");

    /// <summary>Waits until the task ends, and returns its detail.</summary>
    public async Task<TaskDetail> TerminalAsync(Guid taskId)
    {
        TaskDetail? detail = null;
        await EventuallyAsync(
            async () => (detail = await DetailAsync(taskId)).State is TaskState.Succeeded or TaskState.Failed or TaskState.Canceled,
            $"task {taskId} ends");
        return detail!;
    }

    /// <summary>Waits until <paramref name="condition"/> holds, or fails after <see cref="Patience"/>.</summary>
    public static async Task EventuallyAsync(Func<Task<bool>> condition, string what)
    {
        var clock = Stopwatch.StartNew();
        while (!await condition())
        {
            Assert.True(clock.Elapsed < Patience, $"Timed out after {clock.Elapsed.TotalSeconds:F1} s waiting until {what}");
            await Task.Delay(50);
        }
    }

    /// <summary>Drops an isolated database. The shared database stays.</summary>
    public async ValueTask DisposeAsync()
    {
        if (_isolatedName is null)
        {
            return;
        }

        await DataSource.DisposeAsync();
        NpgsqlConnection.ClearAllPools();
        try
        {
            await using var admin = _scratch.CreateDataSource(builder => { builder.Database = "postgres"; builder.Pooling = false; });
            await using var drop = admin.CreateCommand($"DROP DATABASE IF EXISTS \"{_isolatedName}\"");
            await drop.ExecuteNonQueryAsync();
        }
        finally
        {
            // The lease ends after the drop. If the drop failed, the sweep can drop the database.
            await _lease!.DisposeAsync();
        }
    }

    private NpgsqlCommand Command(string sql, params object[] parameters)
    {
        var command = DataSource.CreateCommand(sql);
        foreach (var parameter in parameters)
        {
            command.Parameters.Add(new NpgsqlParameter { Value = parameter });
        }

        return command;
    }

    private static string SchemaPath() =>
        typeof(ExampleDatabase).Assembly
            .GetCustomAttributes(typeof(System.Reflection.AssemblyMetadataAttribute), false)
            .Cast<System.Reflection.AssemblyMetadataAttribute>()
            .Single(attribute => attribute.Key == "WorkhorseSchema")
            .Value!;
}
