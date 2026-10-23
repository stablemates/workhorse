using System.Diagnostics;
using System.Reflection;
using System.Security.Cryptography;
using Npgsql;
using Workhorse.Tests.Testing;

namespace Workhorse.Examples.Programs.Tests.Testing;

/// <summary>
/// A database of its own for one program run, with the schema. The programs use fixed queues such as
/// <c>orders</c>, and a worker claims every task of its queues, so each run has a database of its
/// own. <see cref="DisposeAsync"/> drops it.
/// </summary>
public sealed class ScenarioDatabase : IAsyncDisposable
{
    /// <summary>The longest wait of a program test for observable state.</summary>
    public static readonly TimeSpan Patience = TimeSpan.FromSeconds(60);

    private readonly ScratchDatabase _scratch;
    private readonly string _name;

    private ScenarioDatabase(ScratchDatabase scratch, NpgsqlDataSource dataSource, string name, string url)
    {
        _scratch = scratch;
        _name = name;
        DataSource = dataSource;
        Url = url;
        Queue = new Queue(dataSource);
        Admin = new Admin(dataSource);
    }

    /// <summary>A data source for the database.</summary>
    public NpgsqlDataSource DataSource { get; }

    /// <summary>The PostgreSQL URL of the database, which the program reads from <c>WORKHORSE_DATABASE_URL</c>.</summary>
    public string Url { get; }

    /// <summary>A queue on <see cref="DataSource"/>.</summary>
    public Queue Queue { get; }

    /// <summary>An admin client on <see cref="DataSource"/>.</summary>
    public Admin Admin { get; }

    /// <summary>A new database with the schema.</summary>
    public static async Task<ScenarioDatabase> CreateAsync(ScratchDatabase scratch)
    {
        _ = scratch.DataSource;
        var source = scratch.Name!.Split("_dotnet_")[0];
        var name = $"{source[..Math.Min(source.Length, 43)]}_dp_{Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(5))}";
        await using (var admin = scratch.CreateDataSource(builder => { builder.Database = "postgres"; builder.Pooling = false; }))
        await using (var create = admin.CreateCommand($"CREATE DATABASE \"{name}\""))
        {
            await create.ExecuteNonQueryAsync();
        }

        var dataSource = scratch.CreateDataSource(builder => builder.Database = name);
        var schema = await File.ReadAllTextAsync(SchemaPath());
        await using (var install = dataSource.CreateCommand(schema))
        {
            await install.ExecuteNonQueryAsync();
        }

        // The scratch fixture accepts DATABASE_URL_TEST only, so the program gets the same URL with
        // the name of this database.
        var url = new UriBuilder(Environment.GetEnvironmentVariable("DATABASE_URL_TEST")!) { Path = "/" + name };
        return new ScenarioDatabase(scratch, dataSource, name, url.Uri.AbsoluteUri);
    }

    /// <summary>The detail of one task.</summary>
    public async Task<TaskDetail> DetailAsync(Guid taskId) =>
        await Admin.GetTaskAsync(taskId) ?? throw new InvalidOperationException($"task {taskId} does not exist");

    /// <summary>Waits until the task ends, and returns its detail.</summary>
    public async Task<TaskDetail> TerminalAsync(Guid taskId, ProgramProcess program, CancellationToken cancellation)
    {
        TaskDetail? detail = null;
        await EventuallyAsync(
            async () => (detail = await DetailAsync(taskId)).State is TaskState.Succeeded or TaskState.Failed or TaskState.Canceled,
            $"task {taskId} ends; {program.Describe()}",
            cancellation);
        return detail!;
    }

    /// <summary>
    /// The number of rows in <c>workhorse.worker_registry</c>. A worker deletes its own row when it
    /// ends its run, so a row left after the exit means the worker did not drain.
    /// </summary>
    public async Task<long> RegisteredWorkersAsync()
    {
        await using var command = DataSource.CreateCommand("SELECT count(*) FROM workhorse.worker_registry");
        return (long)(await command.ExecuteScalarAsync())!;
    }

    /// <summary>Waits until <paramref name="condition"/> holds, or fails after <see cref="Patience"/>.</summary>
    public static async Task EventuallyAsync(Func<Task<bool>> condition, string what, CancellationToken cancellation)
    {
        var clock = Stopwatch.StartNew();
        while (!await condition())
        {
            Assert.True(clock.Elapsed < Patience, $"Timed out after {clock.Elapsed.TotalSeconds:F1} s waiting until {what}");
            await Task.Delay(50, cancellation);
        }
    }

    /// <summary>Drops the database.</summary>
    public async ValueTask DisposeAsync()
    {
        await DataSource.DisposeAsync();
        NpgsqlConnection.ClearAllPools();
        await using var admin = _scratch.CreateDataSource(builder => { builder.Database = "postgres"; builder.Pooling = false; });
        await using var drop = admin.CreateCommand($"DROP DATABASE IF EXISTS \"{_name}\"");
        await drop.ExecuteNonQueryAsync();
    }

    private static string SchemaPath() =>
        typeof(ScenarioDatabase).Assembly
            .GetCustomAttributes<AssemblyMetadataAttribute>()
            .Single(attribute => attribute.Key == "WorkhorseSchema")
            .Value!;
}
