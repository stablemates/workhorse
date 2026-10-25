using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Npgsql;
using Workhorse.Tests.Testing;

namespace Workhorse.AspNetCore.Tests.Testing;

/// <summary>
/// A second scratch database, with or without the schema of this checkout, named
/// <c>&lt;source&gt;_dotnet_&lt;digest&gt;</c> so that <c>pnpm db:sweep</c> recognizes it.
/// </summary>
internal sealed class ExtraDatabase : IAsyncDisposable
{
    private readonly NpgsqlDataSource _admin;
    private readonly ScratchDatabaseLease _lease;
    private readonly string _name;

    private ExtraDatabase(NpgsqlDataSource admin, ScratchDatabaseLease lease, NpgsqlDataSource dataSource, string name)
    {
        _admin = admin;
        _lease = lease;
        DataSource = dataSource;
        _name = name;
    }

    internal NpgsqlDataSource DataSource { get; }

    internal static async Task<ExtraDatabase> CreateAsync(ScratchDatabase scratch, string purpose, bool install, CancellationToken cancellationToken)
    {
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
        await ExecuteAsync(admin, $"DROP DATABASE IF EXISTS \"{name}\"", cancellationToken);
        var lease = await scratch.CreateDatabaseAsync(name, cancellationToken);

        var dataSource = scratch.CreateDataSource(builder =>
        {
            builder.Database = name;
            builder.CommandTimeout = 300;
        });
        var database = new ExtraDatabase(admin, lease, dataSource, name);
        if (install)
        {
            try
            {
                await database.InstallAsync(cancellationToken);
            }
            catch
            {
                // The caller gets no database to dispose, so the drop and the end of the lease run here.
                await database.DisposeAsync();
                throw;
            }
        }

        return database;
    }

    /// <summary>Installs the schema of this checkout.</summary>
    internal Task InstallAsync(CancellationToken cancellationToken) => InstallAsync(DataSource, cancellationToken);

    private static async Task InstallAsync(NpgsqlDataSource dataSource, CancellationToken cancellationToken) =>
        await ExecuteAsync(dataSource, await File.ReadAllTextAsync(Repository.Path("sql/schema/current.sql"), cancellationToken), cancellationToken);

    private static async Task ExecuteAsync(NpgsqlDataSource dataSource, string sql, CancellationToken cancellationToken)
    {
        await using var command = dataSource.CreateCommand(sql);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    public async ValueTask DisposeAsync()
    {
        await DataSource.DisposeAsync();
        try
        {
            await ExecuteAsync(_admin, $"DROP DATABASE IF EXISTS \"{_name}\" WITH (FORCE)", CancellationToken.None);
        }
        catch (PostgresException error)
        {
            Console.Error.WriteLine($"could not drop {_name}: {error.MessageText}; run pnpm db:sweep");
        }
        finally
        {
            // The lease ends after the drop. If the drop failed, the sweep can drop the database.
            await _lease.DisposeAsync();
            await _admin.DisposeAsync();
        }
    }
}
