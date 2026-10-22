using Npgsql;
using Workhorse.Internal.Database;
using Workhorse.Tests.Testing;

namespace Workhorse.Tests.Internal.Database;

/// <summary>
/// Npgsql hides the DETAIL of an error unless the connection string sets
/// <c>Include Error Detail=true</c>. PostgreSQL also sends the JSON of P1001 to P1010 in the HINT,
/// so the translation fills the typed values with the default settings (ADR 0107).
/// </summary>
public sealed class ErrorDetailTests(ScratchDatabase database)
{
    private const string Redacted =
        "Detail redacted as it may contain sensitive data. Specify 'Include Error Detail' in the connection string to include this information.";

    // complete_many_and_claim_v1 raises P1007 for a queue that is not a fast-tier queue.
    private const string CompleteOnAFullTierQueue =
        """
        SELECT * FROM workhorse.complete_many_and_claim_v1(
          'error-detail-worker', '{}'::uuid[], '{}'::bigint[], '{}'::jsonb[], 'error-detail', 1, 30000)
        """;

    [Fact]
    public async Task ADefaultDataSourceFillsTheTypedValuesFromTheHint()
    {
        var error = await RaiseAsync(database.DataSource);
        Assert.Equal("error-detail", error.Queue);
        Assert.Equal("batched completion", error.Feature);
        Assert.Null(error.Ordinal);
    }

    [Fact]
    public async Task IncludeErrorDetailGivesTheSameValues()
    {
        await using var dataSource = database.CreateDataSource(builder => builder.IncludeErrorDetail = true);
        var error = await RaiseAsync(dataSource);
        Assert.Equal("error-detail", error.Queue);
        Assert.Equal("batched completion", error.Feature);
        Assert.Null(error.Ordinal);
    }

    [Fact]
    public void AHiddenDetailReadsTheHint()
    {
        var hidden = new PostgresException(
            "the task group does not accept tasks", "ERROR", "ERROR", "P1008", Redacted,
            hint: """{"groupId":"0b3c6f0e-8f3a-4c8e-9a51-2d6f4b7a9c10","state":"sealed","reason":"sealed"}""");
        var error = Assert.IsType<TaskGroupClosedException>(SqlStates.Translate(hidden));
        Assert.Equal(Guid.Parse("0b3c6f0e-8f3a-4c8e-9a51-2d6f4b7a9c10"), error.GroupId);
        Assert.Equal(TaskGroupState.Sealed, error.State);
        Assert.Equal(TaskGroupClosedReason.Sealed, error.Reason);
        Assert.Equal(3, error.Details.Count);
    }

    [Fact]
    public void AJsonDetailWinsOverTheHint()
    {
        var visible = new PostgresException(
            "refused", "ERROR", "ERROR", "P1009",
            """{"limit":100000,"total":5,"requested":1}""",
            hint: """{"limit":1,"total":1,"requested":1}""");
        var error = Assert.IsType<TaskGroupLimitExceededException>(SqlStates.Translate(visible));
        Assert.Equal(100000, error.Limit);
        Assert.Equal(5, error.Total);
    }

    [Fact]
    public void AHiddenDetailWithoutAHintGivesEmptyDetails()
    {
        // Schema version 76 sends no HINT.
        var hidden = new PostgresException("refused", "ERROR", "ERROR", "P1008", Redacted);
        var error = Assert.IsType<TaskGroupClosedException>(SqlStates.Translate(hidden));
        Assert.Empty(error.Details);
        Assert.Null(error.GroupId);
        Assert.Null(error.Reason);
        Assert.Equal("Task group unknown does not accept tasks (unknown)", error.Message);
    }

    [Fact]
    public void AHintThatIsNotJsonGivesEmptyDetails()
    {
        var hidden = new PostgresException("refused", "ERROR", "ERROR", "P1007", Redacted, hint: "check the queue tier");
        var error = Assert.IsType<FastTierUnsupportedException>(SqlStates.Translate(hidden));
        Assert.Equal("unknown", error.Queue);
        Assert.Equal("unknown", error.Feature);
    }

    private static async Task<FastTierUnsupportedException> RaiseAsync(NpgsqlDataSource dataSource)
    {
        await using var connection = await DataSources.OpenAsync(dataSource, TestContext.Current.CancellationToken);
        return await Assert.ThrowsAsync<FastTierUnsupportedException>(() => Sql.RowsAsync(
            connection,
            new Workhorse.Internal.SqlCatalogue.Statement("complete", CompleteOnAFullTierQueue, 0),
            [],
            TestContext.Current.CancellationToken));
    }
}
