using System.Collections.Concurrent;
using System.Globalization;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using Npgsql;
using Xunit.v3;

#if WORKHORSE_PROCESS_DATABASE
[assembly: AssemblyFixture(typeof(Workhorse.Tests.Testing.ScratchDatabase))]
#else
[assembly: AssemblyFixture(typeof(Workhorse.Tests.Testing.ScratchTemplate))]
[assembly: Workhorse.Tests.Testing.ResetScratchDatabase]
#endif

namespace Workhorse.Tests.Testing;

/// <summary>
/// The per-process schema template of the .NET database tests.
/// </summary>
/// <remarks>
/// A database test never uses the checkout's <c>test</c> database directly. This fixture derives a
/// template database from <c>DATABASE_URL_TEST</c>, named after that database plus a per-process
/// digest, and installs <c>sql/schema/current.sql</c> into it once. Each test class gets a copy of
/// it as its <see cref="ScratchDatabase"/>. When the test run ends, the fixture drops each class
/// database and then the template. <c>pnpm db:sweep</c> recognizes the same name shape if the drop
/// never runs.
///
/// Each DROP DATABASE waits for a checkpoint, and a checkpoint writes the changed pages of the whole
/// server. Drops at the same time share one checkpoint, so the fixture drops the class databases
/// together, at the end of the run.
///
/// <see cref="CreateDatabaseAsync"/> creates the template and every other .NET scratch database, so
/// their commits do not wait for the WAL flush (SM-1809). It also returns the lease that keeps
/// <c>pnpm db:sweep</c> from dropping the database while the process needs it (SM-1702).
///
/// Without <c>DATABASE_URL_TEST</c> a local run skips each database test with a visible reason.
/// <c>CI</c> or <c>WORKHORSE_REQUIRE_DATABASE=1</c> turns that skip into a failure.
/// </remarks>
public sealed class ScratchTemplate : IAsyncLifetime
{
    private const string ObjectInUse = "55006";
    private const int DropAttempts = 40;
    private static readonly string[] Loopback = ["localhost", "127.0.0.1", "::1", "[::1]"];

    private readonly ConcurrentQueue<string> _retired = new();
    private NpgsqlDataSource? _admin;
    private ScratchDatabaseLease? _lease;

    /// <summary>The template name, or <c>null</c> when the run has no database.</summary>
    public string? Name { get; private set; }

    /// <summary>Why the database tests skip, or <c>null</c> when the run has a database.</summary>
    internal string? SkipReason { get; private set; }

    /// <summary>The name of the database that <c>DATABASE_URL_TEST</c> names.</summary>
    internal string SourceName { get; private set; } = "";

    /// <summary>The policy rows after the schema install, which <see cref="ScratchDatabase.Reset"/> inserts again.</summary>
    internal string Policies { get; private set; } = "";

    /// <summary>The connection string of the template. A copy changes only the database name.</summary>
    internal NpgsqlConnectionStringBuilder? ConnectionString { get; private set; }

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

            SkipReason = "DATABASE_URL_TEST is unset";
            return;
        }

        var builder = Parse(new Uri(source));
        SourceName = builder.Database ?? "";
        if (!SourceName.Contains("test", StringComparison.Ordinal))
        {
            throw new InvalidOperationException("DATABASE_URL_TEST must name a test database");
        }

        Name = ScratchName(SourceName, string.Create(CultureInfo.InvariantCulture, $"dotnet:{Environment.ProcessId}"));
        ConnectionString = new NpgsqlConnectionStringBuilder(builder.ConnectionString) { Database = Name };
        _admin = AdminDataSource();
        await DropAsync(_admin, Name).ConfigureAwait(false);
        _lease = await CreateDatabaseAsync(Name).ConfigureAwait(false);

        // PostgreSQL copies only a template without sessions, so the install uses no pool.
        await using var install = NpgsqlDataSource.Create(new NpgsqlConnectionStringBuilder(ConnectionString.ConnectionString) { Pooling = false });
        var schema = await File.ReadAllTextAsync(SchemaPath()).ConfigureAwait(false);
        await using (var command = install.CreateCommand(schema))
        {
            await command.ExecuteNonQueryAsync().ConfigureAwait(false);
        }

        await using (var command = install.CreateCommand(ScratchDatabase.PolicySnapshot))
        {
            Policies = (string)(await command.ExecuteScalarAsync().ConfigureAwait(false))!;
        }

        Console.Error.WriteLine($"installed the schema into scratch database {Name}");
    }

    /// <inheritdoc />
    public async ValueTask DisposeAsync()
    {
        if (_admin is null || Name is null)
        {
            return;
        }

        // Eight sessions at a time keep the drops of the run on few checkpoints and few connections.
        await Parallel.ForEachAsync(_retired, new ParallelOptions { MaxDegreeOfParallelism = 8 }, async (name, _) => await DropRetiredAsync(name).ConfigureAwait(false)).ConfigureAwait(false);
        try
        {
            await DropAsync(_admin, Name).ConfigureAwait(false);
            Console.Error.WriteLine($"dropped template database {Name}");
        }
        catch (NpgsqlException error)
        {
            Console.Error.WriteLine($"could not drop template database {Name}: {error.Message}; run pnpm db:sweep");
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

    /// <summary>Records a class database without sessions that <see cref="DisposeAsync"/> drops.</summary>
    internal void Retire(string name) => _retired.Enqueue(name);

    /// <summary>Drops a class database. Its lease has ended, so if the drop fails, the sweep can drop it.</summary>
    private async Task DropRetiredAsync(string name)
    {
        await using var admin = AdminDataSource();
        try
        {
            await DropAsync(admin, name).ConfigureAwait(false);
        }
        catch (NpgsqlException error)
        {
            Console.Error.WriteLine($"could not drop scratch database {name}: {error.Message}; run pnpm db:sweep");
        }
    }

    /// <summary>
    /// Creates the scratch database <paramref name="name"/>, and returns its lease. The database is
    /// empty, or a copy of <paramref name="template"/>. The caller disposes the lease after it drops
    /// the database.
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
    /// lose such a commit, and no .NET test restarts PostgreSQL or reads the WAL. A copy does not
    /// take this setting from its template, so each database sets it.
    /// </remarks>
    public async Task<ScratchDatabaseLease> CreateDatabaseAsync(string name, string? template = null, CancellationToken cancellationToken = default)
    {
        var lease = await ScratchDatabaseLease.TakeAsync(AdminDataSource(), name, cancellationToken).ConfigureAwait(false);
        try
        {
            var copy = template is null ? "" : $" TEMPLATE {QuoteIdentifier(template)}";
            await lease.ExecuteAsync($"CREATE DATABASE {QuoteIdentifier(name)}{copy}", cancellationToken).ConfigureAwait(false);
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
    internal NpgsqlDataSource AdminDataSource()
    {
        var builder = new NpgsqlConnectionStringBuilder(ConnectionString!.ConnectionString)
        {
            Database = "postgres",
            Pooling = false,
            CommandTimeout = 300,
        };
        return NpgsqlDataSource.Create(builder);
    }

    /// <summary><c>&lt;source&gt;_dotnet_&lt;digest&gt;</c> of <paramref name="seed"/>, which fits the 63-byte identifier limit.</summary>
    internal static string ScratchName(string source, string seed)
    {
        var digest = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(seed)))[..10];
        return $"{source[..Math.Min(source.Length, 43)]}_dotnet_{digest}";
    }

    /// <summary>
    /// Drops <paramref name="name"/>, and waits while short-lived sessions that the test role does
    /// not own end. <c>WITH (FORCE)</c> signals every connected role, which the local test role
    /// cannot do.
    /// </summary>
    internal static async Task DropAsync(NpgsqlDataSource admin, string name)
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

    private static bool Required() =>
        !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("CI"))
        || Environment.GetEnvironmentVariable("WORKHORSE_REQUIRE_DATABASE") == "1";

    /// <summary>Npgsql reads no URL, so the fixture turns the URL into a connection string.</summary>
    private static NpgsqlConnectionStringBuilder Parse(Uri url)
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

    /// <summary>The build records the schema path, so the test reads the schema of its own checkout.</summary>
    private static string SchemaPath() =>
        typeof(ScratchTemplate).Assembly
            .GetCustomAttributes<AssemblyMetadataAttribute>()
            .Single(attribute => attribute.Key == "WorkhorseSchema")
            .Value
        ?? throw new InvalidOperationException("The build records no WorkhorseSchema path");

    internal static string QuoteIdentifier(string name) => $"\"{name.Replace("\"", "\"\"", StringComparison.Ordinal)}\"";
}

/// <summary>
/// The scratch PostgreSQL database of one test class: a copy of the <see cref="ScratchTemplate"/>.
/// </summary>
/// <remarks>
/// The two examples projects define <c>WORKHORSE_PROCESS_DATABASE</c>. There this type is the
/// assembly fixture: one database for the process, with no reset. A snippet test with a fixed queue
/// uses <c>ExampleDatabase.CreateIsolatedAsync</c>. Those projects already make and drop about 50
/// isolated databases. Each DROP DATABASE forces a checkpoint of the whole shared server, and a copy
/// for each class made the examples 2 to 9 times slower (SM-1732).
///
/// xUnit runs test classes in parallel, and a worker of one class acts on every task of its
/// database. Thus each test class that uses PostgreSQL declares <c>IClassFixture&lt;ScratchDatabase&gt;</c>
/// and gets a database of its own (SM-1732). Earlier, all classes shared one database, and a
/// maintenance tick of one class settled the deadline of a test in another class (SM-1684, SM-1721).
///
/// When the class ends, the fixture closes its data source and its lease. The template drops the
/// database at the end of the run. No test uses the database after its class, so the sweep can
/// drop it earlier.
///
/// The tests of one class run one at a time. <see cref="ResetScratchDatabaseAttribute"/> calls
/// <see cref="Reset"/> after each test, so each test starts with the install state: the first on
/// the fresh copy, each later one after the reset of the test before it.
/// </remarks>
public sealed class ScratchDatabase : IAsyncLifetime
{
    // The statements of the reset. They come from `createDatabaseTestHarness` in
    // `typescript/core/test/support/db.ts`, and the Ruby and JVM test support use the same text. The
    // TypeScript reset keeps the three policy tables. This reset empties them and inserts the rows
    // that PolicySnapshot read after the schema install.
    internal const string ResetTables = """
        SELECT format('%I.%I', namespace.nspname, relation.relname) AS table_name
          FROM pg_class AS relation
          JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'workhorse'
           AND relation.relkind IN ('r', 'p')
           AND relation.relname <> ALL (ARRAY[
             'schema_version', 'schema_migration', 'protocol_version', 'maintenance_state',
             'task_stat_state'
           ])
           AND NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid = relation.oid)
         ORDER BY relation.relname
        """;

    internal const string MaintenanceStateReset = """
        UPDATE workhorse.maintenance_state SET
          last_started_at = NULL,
          last_completed_at = NULL,
          last_completed_local_date = NULL,
          history_retained_before = CASE WHEN routine_name = 'history_retention'
            THEN date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
              - interval '14 days'
            ELSE NULL END,
          terminal_prune_dependency_starved = false,
          terminal_prune_fast_first = false,
          terminal_cleanup_backlog_since = NULL,
          lease_recovery_started_at = NULL,
          updated_at = clock_timestamp()
        """;

    /// <summary>The columns of maintenance_state that <see cref="MaintenanceStateReset"/> knows.</summary>
    internal static readonly string[] MaintenanceColumns =
    [
        "history_retained_before",
        "last_completed_at",
        "last_completed_local_date",
        "last_started_at",
        "lease_recovery_started_at",
        "routine_name",
        "terminal_cleanup_backlog_since",
        "terminal_prune_dependency_starved",
        "terminal_prune_fast_first",
        "updated_at",
    ];

    internal const string PolicySnapshot = """
        SELECT jsonb_build_object(
          'maintenance_policy', (SELECT to_jsonb(policy) FROM workhorse.maintenance_policy AS policy),
          'queue_health_policy', (SELECT to_jsonb(policy) FROM workhorse.queue_health_policy AS policy),
          'retention_policy', (SELECT to_jsonb(policy) FROM workhorse.retention_policy AS policy)
        )::text
        """;

    private const string PolicyRestore = """
        WITH policies AS (SELECT $1::jsonb AS value),
        maintenance AS (
          INSERT INTO workhorse.maintenance_policy
          SELECT * FROM jsonb_populate_record(
            NULL::workhorse.maintenance_policy, (SELECT value -> 'maintenance_policy' FROM policies)
          )
        ),
        queue_health AS (
          INSERT INTO workhorse.queue_health_policy
          SELECT * FROM jsonb_populate_record(
            NULL::workhorse.queue_health_policy, (SELECT value -> 'queue_health_policy' FROM policies)
          )
        )
        INSERT INTO workhorse.retention_policy
        SELECT * FROM jsonb_populate_record(
          NULL::workhorse.retention_policy, (SELECT value -> 'retention_policy' FROM policies)
        )
        """;

    private const string LockHolders = """
        SELECT pid, state, left(query, 200) AS query FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid()
        """;

    // 55P03 is lock_not_available, the error of an expired lock_timeout.
    private const string LockNotAvailable = "55P03";
    private static readonly TimeSpan ResetLockWait = TimeSpan.FromSeconds(30);
#if !WORKHORSE_PROCESS_DATABASE
    private static int _classes;
#endif

    private readonly ScratchTemplate _template;
    private NpgsqlConnectionStringBuilder? _connectionString;
    private NpgsqlDataSource? _dataSource;
#if !WORKHORSE_PROCESS_DATABASE
    private ScratchDatabaseLease? _lease;
#endif

#if WORKHORSE_PROCESS_DATABASE
    /// <summary>The database of the process. The fixture uses its own template as the database.</summary>
    public ScratchDatabase() => _template = new ScratchTemplate();
#else
    /// <summary>The database of one test class, a copy of <paramref name="template"/>.</summary>
    public ScratchDatabase(ScratchTemplate template) => _template = template;
#endif

    /// <summary>The scratch database name, or <c>null</c> when the run has no database.</summary>
    public string? Name { get; private set; }

    /// <summary>A data source for the scratch database. A test without a database skips here.</summary>
    public NpgsqlDataSource DataSource
    {
        get
        {
            if (_template.SkipReason is not null)
            {
                Assert.Skip(_template.SkipReason);
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

    /// <summary>Creates another empty scratch database, and returns its lease. See <see cref="ScratchTemplate.CreateDatabaseAsync"/>.</summary>
    public Task<ScratchDatabaseLease> CreateDatabaseAsync(string name, CancellationToken cancellationToken = default) =>
        _template.CreateDatabaseAsync(name, null, cancellationToken);

    /// <inheritdoc />
    public async ValueTask InitializeAsync()
    {
#if WORKHORSE_PROCESS_DATABASE
        await _template.InitializeAsync().ConfigureAwait(false);
        if (_template.Name is null)
        {
            return;
        }

        Name = _template.Name;
        _connectionString = new NpgsqlConnectionStringBuilder(_template.ConnectionString!.ConnectionString);
#else
        if (_template.SkipReason is not null || _template.Name is null)
        {
            return;
        }

        var seed = string.Create(CultureInfo.InvariantCulture, $"dotnet:{Environment.ProcessId}:class:{Interlocked.Increment(ref _classes)}");
        Name = ScratchTemplate.ScratchName(_template.SourceName, seed);
        _connectionString = new NpgsqlConnectionStringBuilder(_template.ConnectionString!.ConnectionString) { Database = Name };
        await using (var admin = _template.AdminDataSource())
        {
            await ScratchTemplate.DropAsync(admin, Name).ConfigureAwait(false);
        }

        _lease = await _template.CreateDatabaseAsync(Name, _template.Name).ConfigureAwait(false);
#endif
        _dataSource = NpgsqlDataSource.Create(_connectionString);
    }

    /// <inheritdoc />
    public async ValueTask DisposeAsync()
    {
        if (_dataSource is not null)
        {
            await _dataSource.DisposeAsync().ConfigureAwait(false);
        }

#if WORKHORSE_PROCESS_DATABASE
        await _template.DisposeAsync().ConfigureAwait(false);
#else
        if (Name is null)
        {
            return;
        }

        _template.Retire(Name);
        if (_lease is not null)
        {
            await _lease.DisposeAsync().ConfigureAwait(false);
        }
#endif
    }

    /// <summary>Returns the scratch database to its install state. A run without a database does nothing.</summary>
    /// <remarks>
    /// The reset runs in one transaction. It empties every table apart from the version tables and
    /// the routine state. It returns each maintenance_state column to its install value. Then it
    /// inserts the policy rows that the template had after the schema install.
    ///
    /// TRUNCATE locks each table in list order, and a worker statement of the test before can lock
    /// the same tables in another order. PostgreSQL looks for a deadlock only after
    /// <c>deadlock_timeout</c>, and the lock wait of each attempt ends before that. The reset then
    /// rolls back and tries again (SM-1436). If the locks stay held, the error names the sessions.
    ///
    /// xUnit calls the hooks of <see cref="BeforeAfterTestAttribute"/> without an await, so the reset
    /// uses the synchronous Npgsql calls.
    /// </remarks>
    public void Reset()
    {
        if (_dataSource is null)
        {
            return;
        }

        using var connection = _dataSource.OpenConnection();
        int lockTimeoutMs;
        using (var command = new NpgsqlCommand("SELECT setting::integer FROM pg_settings WHERE name = 'deadlock_timeout'", connection))
        {
            lockTimeoutMs = Math.Clamp((int)command.ExecuteScalar()! / 5, 1, 200);
        }

        var tables = new List<string>();
        using (var command = new NpgsqlCommand(ResetTables, connection))
        using (var reader = command.ExecuteReader())
        {
            while (reader.Read())
            {
                tables.Add(reader.GetString(0));
            }
        }

        var deadline = DateTime.UtcNow + ResetLockWait;
        while (true)
        {
            using var transaction = connection.BeginTransaction();
            try
            {
                Execute(connection, string.Create(CultureInfo.InvariantCulture, $"SET LOCAL lock_timeout = {lockTimeoutMs}"));
                Execute(connection, $"TRUNCATE {string.Join(", ", tables)} RESTART IDENTITY CASCADE");
                Execute(connection, MaintenanceStateReset);
                using (var restore = new NpgsqlCommand(PolicyRestore, connection))
                {
                    restore.Parameters.Add(new NpgsqlParameter { Value = _template.Policies });
                    restore.ExecuteNonQuery();
                }

                transaction.Commit();
                return;
            }
            catch (PostgresException error) when (error.SqlState == LockNotAvailable)
            {
                transaction.Rollback();
                if (DateTime.UtcNow >= deadline)
                {
                    throw new InvalidOperationException(
                        $"The reset could not lock the tables within {ResetLockWait.TotalSeconds} s. Sessions of the scratch database:{Holders(connection)}",
                        error);
                }
            }

            Thread.Sleep(20);
        }
    }

    private static void Execute(NpgsqlConnection connection, string sql)
    {
        using var command = new NpgsqlCommand(sql, connection);
        command.ExecuteNonQuery();
    }

    private static string Holders(NpgsqlConnection connection)
    {
        var holders = new StringBuilder();
        using var command = new NpgsqlCommand(LockHolders, connection);
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            holders.Append(CultureInfo.InvariantCulture, $"\n  pid {reader.GetInt32(0)} {(reader.IsDBNull(1) ? "" : reader.GetString(1))}: {(reader.IsDBNull(2) ? "" : reader.GetString(2))}");
        }

        return holders.ToString();
    }
}

/// <summary>
/// Resets the <see cref="ScratchDatabase"/> of the test class after each test (SM-1732).
/// </summary>
/// <remarks>
/// xUnit creates the test class before it calls <see cref="BeforeAfterTestAttribute.Before"/>, and
/// a constructor can write rows. A reset there would delete them. Thus the reset runs after each
/// test, and the first test of a class starts on the fresh copy of the _template.
/// </remarks>
[AttributeUsage(AttributeTargets.Assembly)]
public sealed class ResetScratchDatabaseAttribute : BeforeAfterTestAttribute
{
    /// <inheritdoc />
    public override void After(MethodInfo methodUnderTest, IXunitTest test)
    {
        var fixture = TestContext.Current.GetFixture(typeof(ScratchDatabase)).AsTask().GetAwaiter().GetResult();
        (fixture as ScratchDatabase)?.Reset();
    }
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
