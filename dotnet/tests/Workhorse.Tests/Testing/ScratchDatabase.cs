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
/// <see cref="CreateDatabaseAsync"/> creates this database and every other .NET scratch database,
/// so their commits do not wait for the WAL flush (SM-1809). It also returns the lease that keeps
/// <c>pnpm db:sweep</c> from dropping the database while the process needs it (SM-1702).
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
    private ScratchDatabaseLease? _lease;
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

    /// <summary>A new data source builder for the scratch database. The caller builds and disposes the data source.</summary>
    public NpgsqlDataSourceBuilder CreateDataSourceBuilder()
    {
        _ = DataSource;
        return new NpgsqlDataSourceBuilder(_connectionString!.ConnectionString);
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
        _connectionString = new NpgsqlConnectionStringBuilder(builder.ConnectionString) { Database = Name };
        _admin = AdminDataSource();
        await DropAsync(_admin, Name).ConfigureAwait(false);
        _lease = await CreateDatabaseAsync(Name).ConfigureAwait(false);

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
            // The lease ends after the drop. If the drop failed, the sweep can drop the database.
            if (_lease is not null)
            {
                await _lease.DisposeAsync().ConfigureAwait(false);
            }

            await _admin.DisposeAsync().ConfigureAwait(false);
        }
    }

    /// <summary>
    /// Creates the empty scratch database <paramref name="name"/>, and returns its lease. The caller
    /// disposes the lease after it drops the database.
    /// </summary>
    /// <remarks>
    /// A session on <c>postgres</c> takes the lease before it creates the database: a shared advisory
    /// lock on <c>hashtextextended(name, 0)</c>. A test can have no session on its scratch database,
    /// for example after a pool prunes its idle connections. <c>pnpm db:sweep</c> takes the exclusive
    /// lock with no wait before it drops a scratch database, so it skips a database under the lease.
    /// If the process stops or crashes, PostgreSQL ends the session and its lock, and the sweep can
    /// drop the database again (SM-1702).
    ///
    /// A scratch database is for tests only, so its commits do not wait for the WAL flush. A host
    /// I/O stall can make one flush take seconds, and a lease of a few seconds then lapses although
    /// the worker is correct (SM-1809). Visibility and order do not change. Only a server crash can
    /// lose such a commit, and no .NET test restarts PostgreSQL or reads the WAL.
    /// </remarks>
    public async Task<ScratchDatabaseLease> CreateDatabaseAsync(string name, CancellationToken cancellationToken = default)
    {
        var lease = await ScratchDatabaseLease.TakeAsync(AdminDataSource(), name, cancellationToken).ConfigureAwait(false);
        try
        {
            await lease.ExecuteAsync($"CREATE DATABASE {QuoteIdentifier(name)}", cancellationToken).ConfigureAwait(false);
            await lease.ExecuteAsync($"ALTER DATABASE {QuoteIdentifier(name)} SET synchronous_commit = off", cancellationToken).ConfigureAwait(false);
        }
        catch
        {
            await lease.DisposeAsync().ConfigureAwait(false);
            throw;
        }

        return lease;
    }

    /// <summary>
    /// A data source for the <c>postgres</c> database without a pool. CREATE DATABASE waits for its
    /// template, and a busy shared server can hold it, so a command can take up to 300 s.
    /// </summary>
    private NpgsqlDataSource AdminDataSource()
    {
        var builder = new NpgsqlConnectionStringBuilder(_connectionString!.ConnectionString)
        {
            Database = "postgres",
            Pooling = false,
            CommandTimeout = 300,
        };
        return NpgsqlDataSource.Create(builder);
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

/// <summary>
/// The session on <c>postgres</c> that holds the shared advisory lock of one scratch database, so
/// <c>pnpm db:sweep</c> skips it. Disposing the lease ends the session and the lock.
/// </summary>
public sealed class ScratchDatabaseLease : IAsyncDisposable
{
    private readonly NpgsqlDataSource _admin;
    private readonly NpgsqlConnection _session;

    private ScratchDatabaseLease(NpgsqlDataSource admin, NpgsqlConnection session)
    {
        _admin = admin;
        _session = session;
    }

    /// <summary>Opens a session on <paramref name="admin"/> and takes the lock of <paramref name="name"/>. The lease owns <paramref name="admin"/>.</summary>
    internal static async Task<ScratchDatabaseLease> TakeAsync(NpgsqlDataSource admin, string name, CancellationToken cancellationToken)
    {
        NpgsqlConnection? session = null;
        try
        {
            session = await admin.OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
            await using var command = new NpgsqlCommand("SELECT pg_advisory_lock_shared(hashtextextended($1, 0))", session);
            command.Parameters.Add(new NpgsqlParameter { Value = name });
            await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
            return new ScratchDatabaseLease(admin, session);
        }
        catch
        {
            if (session is not null)
            {
                await session.DisposeAsync().ConfigureAwait(false);
            }

            await admin.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    internal async Task ExecuteAsync(string sql, CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand(sql, _session);
        await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask DisposeAsync()
    {
        // The data source has no pool, so closing the connection ends the session and its lock.
        await _session.DisposeAsync().ConfigureAwait(false);
        await _admin.DisposeAsync().ConfigureAwait(false);
    }
}
