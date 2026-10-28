using Npgsql;
using Workhorse.Internal;
using Workhorse.Internal.Database;
using Workhorse.Tests.Testing;

namespace Workhorse.Tests.Internal.Database;

/// <summary>
/// The synchronous statement helper that the held heartbeat connection uses on its dedicated thread
/// (ADR 0107, "Concurrency").
/// </summary>
public sealed class SynchronousSqlTests(ScratchDatabase database) : IClassFixture<ScratchDatabase>
{
    [Fact]
    public void ReadsRowsAndHandsOverTheCommandBeforeItRuns()
    {
        using var connection = database.DataSource.OpenConnection();
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
        using var connection = database.DataSource.OpenConnection();
        var error = Assert.Throws<DatabaseException>(() =>
            Sql.Rows(connection, new SqlCatalogue.Statement("division_by_zero", "SELECT 1 / 0", 0), [], 5));
        Assert.Equal("22012", error.SqlState);
    }

    [Fact]
    public void RefusesTheWrongArity()
    {
        using var connection = database.DataSource.OpenConnection();
        Assert.Throws<InvalidOperationException>(() => Sql.Rows(connection, SqlCatalogue.GetTaskGroupV1, [], 5));
    }

    [Fact]
    public async Task AnotherThreadCanCancelTheCommand()
    {
        using var connection = database.DataSource.OpenConnection();
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
        using var connection = database.DataSource.OpenConnection();
        Assert.Throws<DatabaseException>(() =>
            Sql.Rows(connection, new SqlCatalogue.Statement("sleep", "SELECT pg_sleep(10)", 0), [], 1));
    }
}
