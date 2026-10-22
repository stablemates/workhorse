using System.Globalization;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using Npgsql;

[assembly: AssemblyFixture(typeof(Workhorse.Tests.Testing.ScratchDatabase))]

namespace Workhorse.Tests.Testing;

/// <summary>
/// A per-process scratch PostgreSQL database for the .NET database tests.
/// </summary>
/// <remarks>
/// A database test never uses the checkout's <c>test</c> database directly. This fixture derives a
/// scratch database from <c>DATABASE_URL_TEST</c>, named after that database plus a per-process
/// digest, and installs <c>sql/schema/current.sql</c> into it. It drops the database when the test
/// run ends. <c>pnpm db:sweep</c> recognizes the same name shape if the drop never runs.
///
/// Without <c>DATABASE_URL_TEST</c> a local run skips each database test with a visible reason.
/// <c>CI</c> or <c>WORKHORSE_REQUIRE_DATABASE=1</c> turns that skip into a failure.
/// </remarks>
public sealed class ScratchDatabase : IAsyncLifetime
{
    private const string ObjectInUse = "55006";
    private const int DropAttempts = 40;
    private static readonly string[] Loopback = ["localhost", "127.0.0.1", "::1", "[::1]"];

    private NpgsqlConnectionStringBuilder? _connectionString;
    private NpgsqlDataSource? _admin;
    private NpgsqlDataSource? _dataSource;
    private string? _skipReason;

    /// <summary>The scratch database name, or <c>null</c> when the run has no database.</summary>
    public string? Name { get; private set; }

    /// <summary>A data source for the scratch database. A test without a database skips here.</summary>
    public NpgsqlDataSource DataSource
    {
        get
        {
            if (_skipReason is not null)
            {
                Assert.Skip(_skipReason);
            }

            return _dataSource ?? throw new InvalidOperationException("The fixture did not start.");
        }
    }

    /// <summary>
    /// A new data source for the scratch database whose connection string <paramref name="configure"/>
    /// changes. Npgsql removes the password from <c>ConnectionString</c>, so a test cannot copy it
    /// from <see cref="DataSource"/>. The caller disposes the data source.
    /// </summary>
    public NpgsqlDataSource CreateDataSource(Action<NpgsqlConnectionStringBuilder> configure)
    {
        _ = DataSource;
        var builder = new NpgsqlConnectionStringBuilder(_connectionString!.ConnectionString);
        configure(builder);
        return NpgsqlDataSource.Create(builder);
    }

    /// <inheritdoc />
    public async ValueTask InitializeAsync()
    {
        var source = Environment.GetEnvironmentVariable("DATABASE_URL_TEST") ?? "";
        if (source.Length == 0)
        {
            if (Required())
            {
                throw new InvalidOperationException(
                    "DATABASE_URL_TEST is unset, but this run requires PostgreSQL (CI or WORKHORSE_REQUIRE_DATABASE=1)");
            }

            _skipReason = "DATABASE_URL_TEST is unset";
            return;
        }

        var builder = ConnectionString(new Uri(source));
        var sourceName = builder.Database ?? "";
        if (!sourceName.Contains("test", StringComparison.Ordinal))
        {
            throw new InvalidOperationException("DATABASE_URL_TEST must name a test database");
        }

        Name = ScratchName(sourceName);
        var admin = new NpgsqlConnectionStringBuilder(builder.ConnectionString) { Database = "postgres", Pooling = false };
        _admin = NpgsqlDataSource.Create(admin);
        await DropAsync(_admin, Name).ConfigureAwait(false);
        await using (var create = _admin.CreateCommand($"CREATE DATABASE {QuoteIdentifier(Name)}"))
        {
            await create.ExecuteNonQueryAsync().ConfigureAwait(false);
        }

        _connectionString = new NpgsqlConnectionStringBuilder(builder.ConnectionString) { Database = Name };
        _dataSource = NpgsqlDataSource.Create(_connectionString);
        var schema = await File.ReadAllTextAsync(SchemaPath()).ConfigureAwait(false);
        await using (var install = _dataSource.CreateCommand(schema))
        {
            await install.ExecuteNonQueryAsync().ConfigureAwait(false);
        }

        Console.Error.WriteLine($"running against scratch database {Name}");
    }

    /// <inheritdoc />
    public async ValueTask DisposeAsync()
    {
        if (_dataSource is not null)
        {
            await _dataSource.DisposeAsync().ConfigureAwait(false);
        }

        if (_admin is null || Name is null)
        {
            return;
        }

        try
        {
            await DropAsync(_admin, Name).ConfigureAwait(false);
            Console.Error.WriteLine($"dropped scratch database {Name}");
        }
        catch (NpgsqlException error)
        {
            Console.Error.WriteLine($"could not drop scratch database {Name}: {error.Message}; run pnpm db:sweep");
            throw;
        }
        finally
        {
            await _admin.DisposeAsync().ConfigureAwait(false);
        }
    }

    private static bool Required() =>
        !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("CI"))
        || Environment.GetEnvironmentVariable("WORKHORSE_REQUIRE_DATABASE") == "1";

    /// <summary>Npgsql reads no URL, so the fixture turns the URL into a connection string.</summary>
    private static NpgsqlConnectionStringBuilder ConnectionString(Uri url)
    {
        if (!Loopback.Contains(url.Host, StringComparer.Ordinal))
        {
            throw new InvalidOperationException($".NET database tests refuse a non-loopback database: {url.Host}");
        }

        var builder = new NpgsqlConnectionStringBuilder
        {
            Host = url.Host.Trim('[', ']'),
            Port = url.IsDefaultPort || url.Port < 0 ? 5432 : url.Port,
            Database = Uri.UnescapeDataString(url.AbsolutePath.TrimStart('/')),
        };
        var userInfo = url.UserInfo.Split(':', 2);
        if (userInfo[0].Length > 0)
        {
            builder.Username = Uri.UnescapeDataString(userInfo[0]);
        }

        if (userInfo.Length > 1)
        {
            builder.Password = Uri.UnescapeDataString(userInfo[1]);
        }

        foreach (var pair in url.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var parts = pair.Split('=', 2);
            if (parts[0] == "sslmode" && parts.Length > 1)
            {
                builder.SslMode = Enum.Parse<SslMode>(Uri.UnescapeDataString(parts[1]), ignoreCase: true);
            }
        }

        return builder;
    }

    /// <summary><c>&lt;source&gt;_dotnet_&lt;digest&gt;</c>, which fits the 63-byte identifier limit.</summary>
    private static string ScratchName(string source)
    {
        var seed = Encoding.UTF8.GetBytes(string.Create(CultureInfo.InvariantCulture, $"dotnet:{Environment.ProcessId}"));
        var digest = Convert.ToHexStringLower(SHA256.HashData(seed))[..10];
        return $"{source[..Math.Min(source.Length, 43)]}_dotnet_{digest}";
    }

    /// <summary>The build records the schema path, so the test reads the schema of its own checkout.</summary>
    private static string SchemaPath() =>
        typeof(ScratchDatabase).Assembly
            .GetCustomAttributes<AssemblyMetadataAttribute>()
            .Single(attribute => attribute.Key == "WorkhorseSchema")
            .Value
        ?? throw new InvalidOperationException("The build records no WorkhorseSchema path");

    /// <summary>
    /// Drops <paramref name="name"/>, and waits while short-lived sessions that the test role does
    /// not own end. <c>WITH (FORCE)</c> signals every connected role, which the local test role
    /// cannot do.
    /// </summary>
    private static async Task DropAsync(NpgsqlDataSource admin, string name)
    {
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                await using (var terminate = admin.CreateCommand(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND usename = current_user AND pid <> pg_backend_pid()"))
                {
                    terminate.Parameters.Add(new NpgsqlParameter { Value = name });
                    await terminate.ExecuteNonQueryAsync().ConfigureAwait(false);
                }

                await using var drop = admin.CreateCommand($"DROP DATABASE IF EXISTS {QuoteIdentifier(name)}");
                await drop.ExecuteNonQueryAsync().ConfigureAwait(false);
                return;
            }
            catch (PostgresException error) when (error.SqlState == ObjectInUse && attempt < DropAttempts)
            {
                await Task.Delay(25).ConfigureAwait(false);
            }
        }
    }

    private static string QuoteIdentifier(string name) => $"\"{name.Replace("\"", "\"\"", StringComparison.Ordinal)}\"";
}
