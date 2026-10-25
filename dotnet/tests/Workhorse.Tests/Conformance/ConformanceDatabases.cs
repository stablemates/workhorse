using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Npgsql;
using Workhorse.Tests.Testing;

namespace Workhorse.Tests.Conformance;

/// <summary>
/// The scratch databases of the conformance lane. Each one holds the schema of this checkout and is
/// named <c>&lt;source&gt;_dotnet_&lt;digest&gt;</c>, so that <c>pnpm db:sweep</c> recognizes it.
/// </summary>
/// <remarks>
/// The compatibility fixtures rewrite the version tables, the request fixtures rename functions, and
/// the runtime fixtures replace functions. So the lane uses databases of its own, and a reset of the
/// class database does not undo those changes. A test that needs the only worker of a database also
/// creates one here (SM-1738).
/// </remarks>
internal sealed class ConformanceDatabases(ScratchDatabase scratch)
{
    /// <summary>A new database for <paramref name="purpose"/>, with the schema installed.</summary>
    internal async Task<ConformanceDatabase> CreateAsync(string purpose, Action<NpgsqlConnectionStringBuilder>? configure = null)
    {
        // A run without a database skips here, before the URL is read.
        _ = scratch.DataSource;
        var source = new Uri(Environment.GetEnvironmentVariable("DATABASE_URL_TEST")!).AbsolutePath.TrimStart('/');
        var seed = Encoding.UTF8.GetBytes(string.Create(CultureInfo.InvariantCulture, $"dotnet:{purpose}:{Environment.ProcessId}"));
        var name = $"{source[..Math.Min(source.Length, 43)]}_dotnet_{Convert.ToHexStringLower(SHA256.HashData(seed))[..10]}";
        var admin = scratch.CreateDataSource(builder =>
        {
            builder.Database = "postgres";
            builder.Pooling = false;

            // CREATE DATABASE waits for the template, and a busy shared server can hold it.
            builder.CommandTimeout = 300;
        });
        await ExecuteAsync(admin, $"DROP DATABASE IF EXISTS \"{name}\" WITH (FORCE)");
        var lease = await scratch.CreateDatabaseAsync(name);
        var database = new ConformanceDatabase(scratch, admin, lease, name, configure);
        try
        {
            await ExecuteAsync(database.DataSource, await File.ReadAllTextAsync(Repository.Path("sql/schema/current.sql")));
        }
        catch
        {
            // The caller gets no database to dispose, so the drop and the end of the lease run here.
            await database.DisposeAsync();
            throw;
        }

        return database;
    }

    internal static async Task ExecuteAsync(NpgsqlDataSource dataSource, string sql)
    {
        await using var command = dataSource.CreateCommand(sql);
        await command.ExecuteNonQueryAsync();
    }
}

/// <summary>One conformance database. Disposing it drops the database.</summary>
internal sealed class ConformanceDatabase : IAsyncDisposable
{
    private readonly ScratchDatabase _scratch;
    private readonly NpgsqlDataSource _admin;
    private readonly ScratchDatabaseLease _lease;
    private readonly string _name;
    private readonly Action<NpgsqlConnectionStringBuilder>? _configure;

    internal ConformanceDatabase(ScratchDatabase scratch, NpgsqlDataSource admin, ScratchDatabaseLease lease, string name, Action<NpgsqlConnectionStringBuilder>? configure)
    {
        _scratch = scratch;
        _admin = admin;
        _lease = lease;
        _name = name;
        _configure = configure;
        DataSource = CreateDataSource();
    }

    /// <summary>A data source for the database, with the settings of its creator.</summary>
    internal NpgsqlDataSource DataSource { get; }

    /// <summary>A new data source builder for the database. The caller builds and disposes the data source.</summary>
    internal NpgsqlDataSourceBuilder Builder()
    {
        NpgsqlConnectionStringBuilder? connection = null;
        using (var probe = _scratch.CreateDataSource(builder =>
        {
            Configure(builder);
            connection = builder;
        }))
        {
            return new NpgsqlDataSourceBuilder(connection!.ConnectionString);
        }
    }

    /// <summary>Opens one connection of its own, outside every pool.</summary>
    internal async Task<NpgsqlConnection> OpenAsync()
    {
        var connection = new NpgsqlConnection(Builder().ConnectionString) { };
        await connection.OpenAsync();
        return connection;
    }

    public async ValueTask DisposeAsync()
    {
        await DataSource.DisposeAsync();
        try
        {
            await ConformanceDatabases.ExecuteAsync(_admin, $"DROP DATABASE IF EXISTS \"{_name}\" WITH (FORCE)");
        }
        catch (PostgresException error)
        {
            await Console.Error.WriteLineAsync($"could not drop {_name}: {error.MessageText}; run pnpm db:sweep");
        }
        finally
        {
            // The lease ends after the drop. If the drop failed, the sweep can drop the database.
            await _lease.DisposeAsync();
            await _admin.DisposeAsync();
        }
    }

    private NpgsqlDataSource CreateDataSource() => _scratch.CreateDataSource(Configure);

    private void Configure(NpgsqlConnectionStringBuilder builder)
    {
        builder.Database = _name;
        builder.CommandTimeout = 300;
        _configure?.Invoke(builder);
    }
}
