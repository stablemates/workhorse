using Npgsql;
using NpgsqlTypes;
using Workhorse.Internal;
using Workhorse.Tests.Testing;

namespace Workhorse.Tests.Internal;

/// <summary>
/// PostgreSQL parses and describes every catalogue statement as Npgsql sends it. A failure names a
/// statement whose native placeholders, parameter types, or casts Npgsql cannot send.
/// </summary>
public sealed class SqlCatalogueDatabaseTests(ScratchDatabase database) : IClassFixture<ScratchDatabase>
{
    public static TheoryData<string> Statements() => [.. SqlCatalogue.All.Select(statement => statement.Name)];

    [Theory]
    [MemberData(nameof(Statements))]
    public async Task PostgresDescribesTheStatement(string name)
    {
        var statement = SqlCatalogue.All.Single(candidate => candidate.Name == name);
        await using var connection = await database.DataSource.OpenConnectionAsync(TestContext.Current.CancellationToken);
        await using var command = new NpgsqlCommand(statement.Sql, connection);
        // Prepare sends a Parse and a Describe, so the server checks the statement without running it.
        await command.PrepareAsync(TestContext.Current.CancellationToken);
        Assert.True(command.IsPrepared);
    }

    [Fact]
    public async Task RunsAStatementWithAPositionalParameter()
    {
        await using var command = database.DataSource.CreateCommand(SqlCatalogue.DeregisterWorkerV1.Sql);
        command.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Text, Value = "dotnet-skeleton-unknown-worker" });
        var deregistered = await command.ExecuteScalarAsync(TestContext.Current.CancellationToken);
        Assert.Equal(false, deregistered);
    }
}
