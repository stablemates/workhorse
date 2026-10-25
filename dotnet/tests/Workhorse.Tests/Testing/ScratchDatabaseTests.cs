using Npgsql;
using Workhorse.Tests.Conformance;

namespace Workhorse.Tests.Testing;

/// <summary>The scratch databases of the .NET tests.</summary>
public sealed class ScratchDatabaseTests(ScratchDatabase database)
{
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
