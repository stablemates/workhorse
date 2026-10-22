using System.Transactions;
using Npgsql;
using Workhorse.Internal;
using Workhorse.Internal.Database;
using Workhorse.Tests.Testing;

namespace Workhorse.Tests.Internal.Database;

/// <summary>
/// The synchronous helpers that the heartbeat and the listener use on their dedicated threads
/// (ADR 0107, "Concurrency").
/// </summary>
public sealed class SynchronousSqlTests(ScratchDatabase database)
{
    [Fact]
    public void OpensOutsideAnAmbientTransactionScope()
    {
        var marker = Guid.NewGuid();
        using (var setup = database.DataSource.CreateCommand("CREATE TABLE IF NOT EXISTS dotnet_sync_scope_probe (id uuid PRIMARY KEY)"))
        {
            setup.ExecuteNonQuery();
        }

        using (new TransactionScope())
        {
            using var connection = DataSources.Open(database.DataSource);
            using var insert = new NpgsqlCommand("INSERT INTO dotnet_sync_scope_probe VALUES ($1)", connection);
            insert.Parameters.Add(Parameters.Uuid(marker));
            insert.ExecuteNonQuery();
        }

        using var read = database.DataSource.CreateCommand("SELECT count(*) FROM dotnet_sync_scope_probe WHERE id = $1");
        read.Parameters.Add(Parameters.Uuid(marker));
        Assert.Equal(1L, read.ExecuteScalar());
    }

    [Fact]
    public void ReadsRowsAndHandsOverTheCommandBeforeItRuns()
    {
        using var connection = DataSources.Open(database.DataSource);
        NpgsqlCommand? seen = null;
        var at = new DateTimeOffset(2026, 10, 22, 9, 0, 0, TimeSpan.FromHours(2));
        var rows = Sql.Rows(
            connection,
            new SqlCatalogue.Statement("probe", "SELECT $1::timestamptz AS at, NULL::text AS missing", 1),
            [Parameters.Timestamptz(at)],
            7,
            command =>
            {
                Assert.Equal(7, command.CommandTimeout);
                seen = command;
            });
        Assert.NotNull(seen);
        var row = Assert.Single(rows);
        Assert.Equal(at, row.RequiredInstant("at"));
        Assert.Equal(TimeSpan.Zero, row.RequiredInstant("at").Offset);
        Assert.Null(row.Text("missing"));
    }

    [Fact]
    public void TranslatesADatabaseError()
    {
        using var connection = DataSources.Open(database.DataSource);
        var error = Assert.Throws<DatabaseException>(() =>
            Sql.Rows(connection, new SqlCatalogue.Statement("division_by_zero", "SELECT 1 / 0", 0), [], 5));
        Assert.Equal("22012", error.SqlState);
    }

    [Fact]
    public void RefusesTheWrongArity()
    {
        using var connection = DataSources.Open(database.DataSource);
        Assert.Throws<InvalidOperationException>(() => Sql.Rows(connection, SqlCatalogue.GetTaskGroupV1, [], 5));
    }

    [Fact]
    public async Task AnotherThreadCanCancelTheCommand()
    {
        using var connection = DataSources.Open(database.DataSource);
        using var handed = new SemaphoreSlim(0);
        NpgsqlCommand? running = null;
        var statement = Task.Run(() => Sql.Rows(
            connection,
            new SqlCatalogue.Statement("sleep", "SELECT pg_sleep(30)", 0),
            [],
            60,
            command =>
            {
                running = command;
                handed.Release();
            }));
        await handed.WaitAsync(TestContext.Current.CancellationToken);
        await Task.Delay(200, TestContext.Current.CancellationToken);
        running!.Cancel();
        // Npgsql reports a cancel request as a cancellation, as it does for a cancelled token.
        var error = await Assert.ThrowsAsync<OperationCanceledException>(() => statement);
        Assert.Equal("57014", Assert.IsType<PostgresException>(error.InnerException).SqlState);
    }

    [Fact]
    public void TheCommandTimeoutEndsAStatement()
    {
        using var connection = DataSources.Open(database.DataSource);
        Assert.Throws<DatabaseException>(() =>
            Sql.Rows(connection, new SqlCatalogue.Statement("sleep", "SELECT pg_sleep(10)", 0), [], 1));
    }
}
