using System.Transactions;
using Npgsql;
using Workhorse.Internal;
using Workhorse.Internal.Database;
using Workhorse.Tests.Testing;

namespace Workhorse.Tests.Internal.Database;

/// <summary>The data source rules of ADR 0107, "Connection model".</summary>
public sealed class DataSourcesTests(ScratchDatabase database)
{
    [Fact]
    public void RefusesMultiplexing()
    {
        using var dataSource = NpgsqlDataSource.Create("Host=localhost;Multiplexing=true");
        var error = Assert.Throws<ArgumentException>(() => DataSources.Require(dataSource, "dataSource"));
        Assert.Contains("Multiplexing", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AcceptsADataSourceWithoutMultiplexing()
    {
        using var dataSource = NpgsqlDataSource.Create("Host=localhost");
        Assert.Same(dataSource, DataSources.Require(dataSource, "dataSource"));
    }

    [Fact]
    public void BindsATimestampInUtc()
    {
        var local = new DateTimeOffset(2026, 10, 22, 12, 30, 0, TimeSpan.FromHours(5));
        var parameter = Parameters.Timestamptz(local);
        var bound = Assert.IsType<DateTimeOffset>(parameter.Value);
        Assert.Equal(TimeSpan.Zero, bound.Offset);
        Assert.Equal(local, bound);
    }

    [Fact]
    public async Task ReadsATimestampBackInUtc()
    {
        var local = new DateTimeOffset(2026, 10, 22, 12, 30, 0, TimeSpan.FromHours(-7));
        await using var connection = await DataSources.OpenAsync(database.DataSource, TestContext.Current.CancellationToken);
        await using var command = new NpgsqlCommand("SELECT $1::timestamptz AS at", connection);
        command.Parameters.Add(Parameters.Timestamptz(local));
        await using var reader = await command.ExecuteReaderAsync(TestContext.Current.CancellationToken);
        Assert.True(await reader.ReadAsync(TestContext.Current.CancellationToken));
        var read = reader.GetFieldValue<DateTimeOffset>(0);
        Assert.Equal(TimeSpan.Zero, read.Offset);
        Assert.Equal(local, read);
    }

    [Fact]
    public async Task OpensOutsideAnAmbientTransactionScope()
    {
        var token = TestContext.Current.CancellationToken;
        var marker = Guid.NewGuid();
        await using (var setup = database.DataSource.CreateCommand("CREATE TABLE IF NOT EXISTS dotnet_scope_probe (id uuid PRIMARY KEY)"))
        {
            await setup.ExecuteNonQueryAsync(token);
        }

        using (new TransactionScope(TransactionScopeAsyncFlowOption.Enabled))
        {
            await using var connection = await DataSources.OpenAsync(database.DataSource, token);
            await using var insert = new NpgsqlCommand("INSERT INTO dotnet_scope_probe VALUES ($1)", connection);
            insert.Parameters.Add(Parameters.Uuid(marker));
            await insert.ExecuteNonQueryAsync(token);

            // The scope ends without Complete, so an enlisted insert would roll back.
        }

        await using var read = database.DataSource.CreateCommand("SELECT count(*) FROM dotnet_scope_probe WHERE id = $1");
        read.Parameters.Add(Parameters.Uuid(marker));
        Assert.Equal(1L, await read.ExecuteScalarAsync(token));
    }

    [Fact]
    public async Task TranslatesADatabaseError()
    {
        await using var connection = await DataSources.OpenAsync(database.DataSource, TestContext.Current.CancellationToken);
        var error = await Assert.ThrowsAsync<DatabaseException>(() => Sql.RowsAsync(
            connection,
            new SqlCatalogue.Statement("division_by_zero", "SELECT 1 / 0", 0),
            [],
            TestContext.Current.CancellationToken));
        Assert.Equal("22012", error.SqlState);
        Assert.NotNull(error.InnerException);
    }

    [Fact]
    public async Task RefusesAStatementWithTheWrongArity()
    {
        await using var connection = await DataSources.OpenAsync(database.DataSource, TestContext.Current.CancellationToken);
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            Sql.RowsAsync(connection, SqlCatalogue.GetTaskGroupV1, [], TestContext.Current.CancellationToken));
    }
}

/// <summary>The legacy timestamp switch is process-wide, so this test runs alone.</summary>
[Collection(nameof(ProcessSwitches))]
public sealed class LegacyTimestampTests
{
    [Fact]
    public void RefusesTheLegacyTimestampSwitch()
    {
        AppContext.SetSwitch(DataSources.LegacyTimestampSwitch, true);
        try
        {
            var error = Assert.Throws<InvalidOperationException>(DataSources.RequireModernTimestamps);
            Assert.Contains(DataSources.LegacyTimestampSwitch, error.Message, StringComparison.Ordinal);
        }
        finally
        {
            AppContext.SetSwitch(DataSources.LegacyTimestampSwitch, false);
        }
    }
}

/// <summary>Tests that change a process-wide switch run without parallel tests.</summary>
[CollectionDefinition(nameof(ProcessSwitches), DisableParallelization = true)]
public sealed class ProcessSwitches;
