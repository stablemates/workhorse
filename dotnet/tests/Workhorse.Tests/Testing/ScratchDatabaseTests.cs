using Npgsql;
using Workhorse.Tests.Conformance;

namespace Workhorse.Tests.Testing;

/// <summary>The scratch databases of the .NET tests.</summary>
public sealed class ScratchDatabaseTests(ScratchTemplate template, ScratchDatabase database) : IClassFixture<ScratchDatabase>
{
    private static CancellationToken Token => TestContext.Current.CancellationToken;

    /// <summary>
    /// xUnit runs test classes in parallel, so each class gets a copy of the schema template as a
    /// database of its own (SM-1732). A row of one class database is not in another.
    /// </summary>
    [Fact]
    public async Task EachTestClassGetsADatabaseOfItsOwn()
    {
        // A run without a database skips here, before the names are compared.
        _ = database.DataSource;
        await using var other = new ScratchDatabase(template);
        await other.InitializeAsync();
        Assert.NotEqual(database.Name, other.Name);
        Assert.NotEqual(template.Name, database.Name);
        Assert.Equal(database.Name, await TextAsync(database.DataSource, "SELECT current_database()"));
        Assert.Equal(other.Name, await TextAsync(other.DataSource, "SELECT current_database()"));

        await ExecuteAsync(database.DataSource, "INSERT INTO workhorse.queue_control(queue_name, paused) VALUES ('dotnet-own', true)");
        Assert.Equal("0", await TextAsync(other.DataSource, "SELECT count(*)::text FROM workhorse.queue_control"));
        Assert.Equal("true", await TextAsync(other.DataSource, "SELECT (count(*) > 0)::text FROM workhorse.schema_version"));
    }

    /// <summary>
    /// The reset after each test returns the class database to its install state, as the reset of
    /// the TypeScript harness does (SM-1717, SM-1732).
    /// </summary>
    [Fact]
    public async Task TheResetEmptiesTheRowsAndReturnsTheRoutineStateAndThePolicyRows()
    {
        var installed = await TextAsync(database.DataSource, ScratchDatabase.PolicySnapshot);
        await ExecuteAsync(database.DataSource, "INSERT INTO workhorse.queue_control(queue_name, paused) VALUES ('dotnet-leftover', true)");
        await ExecuteAsync(database.DataSource, """
            UPDATE workhorse.maintenance_state SET
              last_started_at = clock_timestamp(),
              last_completed_at = clock_timestamp(),
              last_completed_local_date = CASE WHEN routine_name = 'history_retention'
                THEN current_date END,
              history_retained_before = CASE WHEN routine_name = 'history_retention'
                THEN clock_timestamp() END,
              terminal_prune_dependency_starved = routine_name = 'terminal_storage',
              terminal_prune_fast_first = true,
              terminal_cleanup_backlog_since = clock_timestamp(),
              lease_recovery_started_at = clock_timestamp(),
              updated_at = timestamptz '2000-01-01 00:00:00+00'
            """);
        await ExecuteAsync(database.DataSource, "UPDATE workhorse.maintenance_policy SET timezone = 'Europe/Berlin'");
        await ExecuteAsync(database.DataSource, "UPDATE workhorse.queue_health_policy SET promotion_lag_ms = 1");
        await ExecuteAsync(database.DataSource, "UPDATE workhorse.retention_policy SET terminal_task_prune_limit = 1");

        database.Reset();

        Assert.Equal("0", await TextAsync(database.DataSource, "SELECT count(*)::text FROM workhorse.queue_control"));
        Assert.Equal(
            "history_partitions|true,history_retention|true,terminal_storage|true,tick|true",
            await TextAsync(database.DataSource, """
                SELECT string_agg(routine_name || '|' || (
                  last_started_at IS NULL AND last_completed_at IS NULL
                  AND last_completed_local_date IS NULL
                  AND CASE WHEN routine_name = 'history_retention'
                    THEN history_retained_before IN (
                      date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                        - interval '14 days',
                      date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                        - interval '15 days')
                    ELSE history_retained_before IS NULL END
                  AND NOT terminal_prune_dependency_starved AND NOT terminal_prune_fast_first
                  AND terminal_cleanup_backlog_since IS NULL AND lease_recovery_started_at IS NULL
                  AND updated_at > timestamptz '2001-01-01 00:00:00+00')::text, ',' ORDER BY routine_name)
                  FROM workhorse.maintenance_state
                """));
        Assert.Equal(installed, await TextAsync(database.DataSource, ScratchDatabase.PolicySnapshot));
        Assert.Equal(
            "UTC|10000|1000",
            await TextAsync(
                database.DataSource,
                "SELECT m.timezone || '|' || q.promotion_lag_ms || '|' || r.terminal_task_prune_limit FROM workhorse.maintenance_policy m, workhorse.queue_health_policy q, workhorse.retention_policy r"));
    }

    /// <summary>A new maintenance_state column needs a value in the reset (SM-1717).</summary>
    [Fact]
    public async Task TheResetKnowsEveryColumnOfMaintenanceState()
    {
        Assert.Equal(
            string.Join(",", ScratchDatabase.MaintenanceColumns),
            await TextAsync(
                database.DataSource,
                "SELECT string_agg(column_name::text, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema = 'workhorse' AND table_name = 'maintenance_state'"));
    }

    /// <summary>
    /// A host I/O stall can make a WAL flush take seconds, so a commit in a test does not wait for
    /// it (SM-1809). A new session of the scratch database and of an extra database takes the setting.
    /// </summary>
    [Fact]
    public async Task CommitsWithoutWaitingForTheWalFlush()
    {
        Assert.Equal("off", await SynchronousCommitAsync(database.DataSource));
        await using var extra = await new ConformanceDatabases(database).CreateAsync("synchronous_commit");
        Assert.Equal("off", await SynchronousCommitAsync(extra.DataSource));
    }

    /// <summary>
    /// A test can have no session on a scratch database, so <c>pnpm db:sweep</c> relies on its
    /// advisory lock (SM-1702). The lock of a conformance database ends with its drop.
    /// </summary>
    [Fact]
    public async Task HoldsTheSweepLockUntilTheDrop()
    {
        await using var sweep = database.CreateDataSource(builder =>
        {
            builder.Database = "postgres";
            builder.Pooling = false;
        });
        Assert.False(await SweepLocksAsync(sweep, database.Name!), "the sweep could take the lock of the live scratch database");

        string name;
        await using (var extra = await new ConformanceDatabases(database).CreateAsync("sweep_lease"))
        {
            await using var current = extra.DataSource.CreateCommand("SELECT current_database()");
            name = (string)(await current.ExecuteScalarAsync(TestContext.Current.CancellationToken))!;
            Assert.False(await SweepLocksAsync(sweep, name), "the sweep could take the lock of a live conformance database");
        }

        Assert.True(await SweepLocksAsync(sweep, name), "the lock of the conformance database outlived its drop");
    }

    internal static async Task<string?> TextAsync(NpgsqlDataSource dataSource, string sql)
    {
        await using var command = dataSource.CreateCommand(sql);
        return (string?)await command.ExecuteScalarAsync(Token);
    }

    internal static async Task ExecuteAsync(NpgsqlDataSource dataSource, string sql)
    {
        await using var command = dataSource.CreateCommand(sql);
        await command.ExecuteNonQueryAsync(Token);
    }

    /// <summary>Whether the lock attempt of the sweep succeeds. The data source has no pool, so the lock ends with the session.</summary>
    private static async Task<bool> SweepLocksAsync(NpgsqlDataSource sweep, string name)
    {
        await using var command = sweep.CreateCommand("SELECT pg_try_advisory_lock(hashtextextended($1, 0))");
        command.Parameters.Add(new NpgsqlParameter { Value = name });
        return (bool)(await command.ExecuteScalarAsync(TestContext.Current.CancellationToken))!;
    }

    private static async Task<string?> SynchronousCommitAsync(NpgsqlDataSource dataSource)
    {
        await using var command = dataSource.CreateCommand("SHOW synchronous_commit");
        return (string?)await command.ExecuteScalarAsync(TestContext.Current.CancellationToken);
    }
}

/// <summary>
/// The reset after each test (SM-1732). Each test expects no row and no routine state from the
/// other, and then leaves both behind. Without the reset, the test that runs second fails.
/// </summary>
public sealed class ScratchDatabaseResetTests(ScratchDatabase database) : IClassFixture<ScratchDatabase>
{
    [Fact]
    public Task TheFirstTestLeavesStateBehind() => ExpectNoLeftoverThenLeaveSomeAsync("first");

    [Fact]
    public Task TheSecondTestLeavesStateBehind() => ExpectNoLeftoverThenLeaveSomeAsync("second");

    private async Task ExpectNoLeftoverThenLeaveSomeAsync(string test)
    {
        Assert.Equal("0", await ScratchDatabaseTests.TextAsync(database.DataSource, "SELECT count(*)::text FROM workhorse.queue_control"));
        Assert.Equal("false", await ScratchDatabaseTests.TextAsync(database.DataSource, "SELECT bool_or(terminal_prune_fast_first)::text FROM workhorse.maintenance_state"));
        await ScratchDatabaseTests.ExecuteAsync(database.DataSource, $"INSERT INTO workhorse.queue_control(queue_name, paused) VALUES ('dotnet-{test}', true)");
        await ScratchDatabaseTests.ExecuteAsync(database.DataSource, "UPDATE workhorse.maintenance_state SET terminal_prune_fast_first = true");
    }
}
