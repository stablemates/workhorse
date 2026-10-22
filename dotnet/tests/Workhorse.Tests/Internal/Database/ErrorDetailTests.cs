using Npgsql;
using Workhorse.Internal.Database;
using Workhorse.Tests.Testing;

namespace Workhorse.Tests.Internal.Database;

/// <summary>
/// Npgsql hides the DETAIL of an error unless the connection string sets
/// <c>Include Error Detail=true</c>. The translation still gives the typed exception.
/// </summary>
public sealed class ErrorDetailTests(ScratchDatabase database)
{
    // P1007 is the SQLSTATE that enqueue_many_v1 raises for a fast-tier refusal (ADR 0077).
    private const string RaiseFastTier =
        """
        DO $$ BEGIN RAISE EXCEPTION 'fast-tier queue refused the request' USING ERRCODE = 'P1007',
          DETAIL = '{"queue":"fast","feature":"dependencies","ordinal":2}'; END $$
        """;

    [Fact]
    public async Task ADefaultDataSourceGivesTheTypedExceptionWithFallbackValues()
    {
        var error = await RaiseAsync(database.DataSource);
        Assert.Equal("unknown", error.Queue);
        Assert.Equal("unknown", error.Feature);
        Assert.Null(error.Ordinal);
    }

    [Fact]
    public async Task IncludeErrorDetailFillsTheTypedValues()
    {
        await using var dataSource = database.CreateDataSource(builder => builder.IncludeErrorDetail = true);
        var error = await RaiseAsync(dataSource);
        Assert.Equal("fast", error.Queue);
        Assert.Equal("dependencies", error.Feature);
        Assert.Equal(2, error.Ordinal);
    }

    [Fact]
    public void AHiddenDetailGivesEmptyDetails()
    {
        var hidden = new PostgresException(
            "refused", "ERROR", "ERROR", "P1008",
            "Detail redacted as it may contain sensitive data. Specify 'Include Error Detail' in the connection string to include this information.");
        var error = Assert.IsType<TaskGroupClosedException>(SqlStates.Translate(hidden));
        Assert.Empty(error.Details);
        Assert.Null(error.GroupId);
        Assert.Null(error.Reason);
        Assert.Equal("Task group unknown does not accept tasks (unknown)", error.Message);
    }

    private static async Task<FastTierUnsupportedException> RaiseAsync(NpgsqlDataSource dataSource)
    {
        await using var connection = await DataSources.OpenAsync(dataSource, TestContext.Current.CancellationToken);
        return await Assert.ThrowsAsync<FastTierUnsupportedException>(() => Sql.RowsAsync(
            connection,
            new Workhorse.Internal.SqlCatalogue.Statement("raise", RaiseFastTier, 0),
            [],
            TestContext.Current.CancellationToken));
    }
}
