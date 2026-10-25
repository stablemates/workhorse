using System.Text.Json;
using Npgsql;
using Workhorse.Internal;
using Workhorse.Internal.Database;
using Workhorse.Tests.Testing;

namespace Workhorse.Tests.Internal.Database;

/// <summary>The startup check runs every case of <c>protocol/v1/compatibility.json</c>.</summary>
public sealed class CompatibilityTests(ScratchDatabase database) : IClassFixture<ScratchDatabase>
{
    public static TheoryData<string> Cases() =>
        [.. Repository.Json("protocol/v1/compatibility.json").EnumerateArray().Select(item => item.GetProperty("id").GetString()!)];

    [Theory]
    [MemberData(nameof(Cases))]
    public void DecidesTheFixtureCase(string id)
    {
        var item = Repository.Json("protocol/v1/compatibility.json").EnumerateArray().Single(candidate => candidate.GetProperty("id").GetString() == id);
        var installed = item.GetProperty("installedSchemaVersion");
        var code = Compatibility.Check(
            installed.ValueKind == JsonValueKind.Null ? null : installed.GetInt32(),
            item.GetProperty("clientProtocolVersion").GetInt32(),
            [.. item.GetProperty("servedProtocolVersions").EnumerateArray().Select(version => version.GetInt32())]);
        if (item.GetProperty("compatible").GetBoolean())
        {
            Assert.Null(code);
        }
        else
        {
            Assert.NotNull(code);
            Assert.Equal(item.GetProperty("refusalCode").GetString(), new CompatibilityException(code.Value).Message.Split(": ")[1]);
        }
    }

    [Fact]
    public async Task TheInstalledSchemaIsCompatible()
    {
        var cache = new CompatibilityCache();
        await using var connection = await DataSources.OpenAsync(database.DataSource, TestContext.Current.CancellationToken);
        await cache.AssertAsync(connection, caller: false, TestContext.Current.CancellationToken);
        await cache.AssertAsync(connection, caller: true, TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task ADatabaseWithoutTheSchemaIsRefusedAndTheRefusalIsCached()
    {
        var token = TestContext.Current.CancellationToken;
        var cache = new CompatibilityCache();
        await using var connection = await DataSources.OpenAsync(database.DataSource, token);
        await using var transaction = await connection.BeginTransactionAsync(token);
        await using (var hide = new NpgsqlCommand("SET LOCAL search_path TO pg_catalog; ALTER SCHEMA workhorse RENAME TO workhorse_hidden", connection))
        {
            await hide.ExecuteNonQueryAsync(token);
        }

        var error = await Assert.ThrowsAsync<CompatibilityException>(() => cache.AssertAsync(connection, caller: true, token));
        Assert.Equal(CompatibilityCode.SchemaNotInstalled, error.Code);
        await transaction.RollbackAsync(token);

        // The refusal of this caller connection is cached, so the check does not run again.
        await Assert.ThrowsAsync<CompatibilityException>(() => cache.AssertAsync(connection, caller: true, token));
        await using var other = await DataSources.OpenAsync(database.DataSource, token);
        await cache.AssertAsync(other, caller: true, token);
    }

    [Fact]
    public void MapsTheTaskGroupRow()
    {
        var group = Guid.NewGuid();
        var callback = Guid.NewGuid();
        var created = DateTimeOffset.UtcNow;
        var mapped = TaskGroups.Group(new Row(new Dictionary<string, object?>
        {
            ["group_id"] = group,
            ["state"] = "finished",
            ["result"] = "failed",
            ["total"] = 3L,
            ["succeeded"] = 1L,
            ["failed"] = 1L,
            ["canceled"] = 1L,
            ["pending"] = 0L,
            ["created_at"] = created,
            ["sealed_at"] = created,
            ["finished_at"] = created,
            ["canceled_at"] = null,
            ["canceled_by"] = null,
            ["cancel_reason"] = null,
            ["callbacks"] = $$$"""{"on_failure":{"taskId":"{{{callback}}}"},"on_finish":{"taskId":null}}""",
        }));
        Assert.Equal(group, mapped.Id);
        Assert.Equal(TaskGroupState.Finished, mapped.State);
        Assert.Equal(TaskGroupResult.Failed, mapped.Result);
        Assert.Equal(3, mapped.Counts.Total);
        Assert.Equal(
            [new TaskGroupCallback { Kind = TaskGroupCallbackKind.OnFinish }, new TaskGroupCallback { Kind = TaskGroupCallbackKind.OnFailure, TaskId = callback }],
            mapped.Callbacks);
    }
}
