using System.Globalization;
using System.Text.Json.Nodes;
using Npgsql;
using Workhorse.Internal;
using Workhorse.Internal.Database;

namespace Workhorse.Tests;

/// <summary>
/// Writes the rows that the <c>Admin</c> tests read. It calls the catalogue statements directly,
/// as a worker does, so the tests depend on no other SDK class.
/// </summary>
internal sealed class AdminSeed(NpgsqlDataSource dataSource, string queue, string worker)
{
    /// <summary>The worker ID that the seed claims and writes with.</summary>
    internal string Worker => worker;

    /// <summary>Runs <paramref name="statement"/> on a new connection.</summary>
    internal async Task<IReadOnlyList<Row>> SqlAsync(SqlCatalogue.Statement statement, params NpgsqlParameter[] parameters)
    {
        await using var connection = await dataSource.OpenConnectionAsync(TestContext.Current.CancellationToken);
        return await Sql.RowsAsync(connection, statement, parameters, TestContext.Current.CancellationToken);
    }

    /// <summary>The first column of the first row of <paramref name="query"/>, with one text parameter.</summary>
    internal async Task<long> ScalarAsync(string query, string parameter)
    {
        await using var command = dataSource.CreateCommand(query);
        command.Parameters.Add(Parameters.Text(parameter));
        return Convert.ToInt64(await command.ExecuteScalarAsync(TestContext.Current.CancellationToken), CultureInfo.InvariantCulture);
    }

    /// <summary>The enqueue input of one task, as <c>enqueue_many_v1</c> reads it.</summary>
    internal JsonObject Request(
        string type,
        JsonNode? payload,
        string? queueName = null,
        int maxAttempts = 3,
        IReadOnlyList<string>? tags = null,
        JsonObject? dependencies = null,
        bool runAt = true)
    {
        var request = new JsonObject
        {
            ["queue"] = queueName ?? queue,
            ["type"] = type,
            ["payload"] = payload,
            ["priority"] = 0,
            ["concurrencyKey"] = null,
            ["maxAttempts"] = maxAttempts,
            ["retryPolicy"] = null,
            ["contractVersion"] = null,
            ["payloadMaxBytes"] = SqlCatalogue.DefaultTaskValueMaxBytes,
            ["resultMaxBytes"] = SqlCatalogue.DefaultTaskValueMaxBytes,
            ["sensitivePayloadKeys"] = new JsonArray(),
            ["sensitiveResultKeys"] = new JsonArray(),
            ["deadline"] = null,
            ["budget"] = null,
            ["executionTimeoutMs"] = null,
            ["prerequisiteTaskId"] = null,
            ["dependencies"] = dependencies,
            ["tags"] = new JsonArray([.. (tags ?? []).Select(tag => (JsonNode)tag)]),
        };
        if (runAt)
        {
            request["runAt"] = DateTimeOffset.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
        }

        return request;
    }

    /// <summary>Enqueues one task and returns its ID.</summary>
    internal async Task<Guid> EnqueueAsync(JsonObject request)
    {
        var rows = await SqlAsync(SqlCatalogue.EnqueueManyV1, Parameters.Json(new JsonArray(request).ToJsonString()));
        return rows.Single().RequiredUuid("task_id");
    }

    /// <summary>Enqueues one task of <paramref name="type"/> on the test queue.</summary>
    internal Task<Guid> EnqueueAsync(string type, JsonNode? payload) => EnqueueAsync(Request(type, payload));

    /// <summary>Claims the next task of <paramref name="queueName"/>, checks that it is <paramref name="expected"/>, and returns its fence token.</summary>
    internal async Task<long> ClaimAsync(Guid expected, string? queueName = null)
    {
        var row = (await SqlAsync(
            SqlCatalogue.ClaimV1, Parameters.Text(queueName ?? queue), Parameters.Text(worker), Parameters.Integer(30_000))).Single();
        Assert.Equal(expected, row.RequiredUuid("task_id"));
        return row.RequiredLong("fence_token");
    }

    /// <summary>Fails the attempt. A <c>null</c> retry delay lets PostgreSQL choose.</summary>
    internal Task FailAsync(Guid taskId, long fence, string error, int? retryDelayMs) =>
        SqlAsync(
            SqlCatalogue.FailV1,
            Parameters.Uuid(taskId),
            Parameters.Text(worker),
            Parameters.Bigint(fence),
            Parameters.Json(error),
            Parameters.Integer(retryDelayMs));

    /// <summary>Enqueues a task with one attempt, claims it, and fails it into a dead letter.</summary>
    internal async Task<Guid> DeadLetterAsync(string type, IReadOnlyList<string> tags)
    {
        var taskId = await EnqueueAsync(Request(type, new JsonObject { ["n"] = 1 }, maxAttempts: 1, tags: tags));
        var fence = await ClaimAsync(taskId);
        await FailAsync(taskId, fence, """{"name":"Boom","message":"exploded"}""", null);
        return taskId;
    }

    /// <summary>Registers <c>worker</c> as a live worker on the test queue.</summary>
    internal Task RegisterWorkerAsync() =>
        SqlAsync(
            SqlCatalogue.RegisterWorkerV1,
            Parameters.Text(worker),
            Parameters.Uuid(Guid.NewGuid()),
            Parameters.Text("admin-test-host"),
            Parameters.Integer(42),
            Parameters.TextArray([queue]),
            Parameters.TextArray([]),
            Parameters.Integer(1),
            Parameters.Integer(30_000),
            Parameters.Integer(10_000),
            Parameters.Integer(250),
            Parameters.Integer(1000),
            Parameters.Integer(60_000),
            Parameters.Integer(5000),
            Parameters.Integer(0),
            Parameters.Boolean(false),
            Parameters.Integer(null),
            Parameters.Text(null),
            Parameters.Text(null));
}
