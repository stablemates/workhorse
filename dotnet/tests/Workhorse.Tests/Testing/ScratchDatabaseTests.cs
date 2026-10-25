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

    private static async Task<string?> SynchronousCommitAsync(NpgsqlDataSource dataSource)
    {
        await using var command = dataSource.CreateCommand("SHOW synchronous_commit");
        return (string?)await command.ExecuteScalarAsync(TestContext.Current.CancellationToken);
    }
}
