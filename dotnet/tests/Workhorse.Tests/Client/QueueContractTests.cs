using System.Text.Json;
using System.Text.Json.Nodes;
using Workhorse.Tests.Testing;
using static Workhorse.Tests.Client.QueueTesting;

namespace Workhorse.Tests.Client;

/// <summary>Payload contracts in the restricted profile of ADR 0039.</summary>
public sealed class QueueContractTests(ScratchDatabase database)
{
    private sealed record Email(string Recipient);

    [Fact]
    public async Task ValidatesAndStampsAContractedPayload()
    {
        var taskType = UniqueName("email.send");
        var queue = new Queue(database.DataSource, new QueueOptions { DefaultQueue = UniqueName("contracts") });
        await queue.SyncContractsAsync(Contracts(taskType, "v1", RecipientSchema, maxPayloadBytes: 4096, sensitive: ["recipient"]), Token);

        var accepted = await queue.EnqueueAsync(taskType, new Email("person@example.test"), Token);
        var row = (await TaskAsync(database, accepted.TaskId))!;
        Assert.Equal("v1", row.Text("contract_version"));
        Assert.Equal(4096, row.Long("payload_max_bytes"));

        var error = await Assert.ThrowsAsync<ContractValidationException>(() => queue.EnqueueAsync(taskType, new Email(""), Token));
        Assert.Equal("v1", error.Version);
        Assert.Equal("payload", error.Part);
    }

    [Fact]
    public async Task SyncsTheResultContract()
    {
        var taskType = UniqueName("email.send");
        var queue = new Queue(database.DataSource);
        await queue.SyncContractsAsync(new Dictionary<string, TaskTypeContracts>
        {
            [taskType] = new()
            {
                CurrentVersion = "v1",
                Versions = new Dictionary<string, TaskContractVersion>
                {
                    ["v1"] = new()
                    {
                        PayloadSchema = Json(RecipientSchema),
                        ResultSchema = Json("""{"type":"object","required":["messageId"]}"""),
                        MaxResultBytes = 2048,
                        SensitiveResultKeys = ["messageId"],
                    },
                },
            },
        }, Token);
        var stored = (await ContractRowAsync(taskType))!;
        Assert.Equal(2048, stored.Long("result_max_bytes"));
        Assert.Equal(["messageId"], stored.TextList("result_redact_keys")!);
        Assert.Equal(["messageId"], stored.Json("schema")!.Value.GetProperty("result").GetProperty("required").EnumerateArray().Select(item => item.GetString()));
    }

    [Fact]
    public async Task ADeepContractSyncsAndThenValidatesAnEnqueue()
    {
        var taskType = UniqueName("deep");
        var queue = new Queue(database.DataSource, new QueueOptions { DefaultQueue = UniqueName("deep") });
        var schema = "{\"type\":\"integer\"}";
        var payload = "1";
        for (var level = 0; level < 40; level++)
        {
            schema = "{\"type\":\"object\",\"properties\":{\"a\":" + schema + "}}";
            payload = "{\"a\":" + payload + "}";
        }

        await queue.SyncContractsAsync(Contracts(taskType, "v1", schema), Token);
        var accepted = await queue.EnqueueAsync(taskType, JsonNode.Parse(payload), Token);
        Assert.Equal("v1", (await TaskAsync(database, accepted.TaskId))!.Text("contract_version"));
    }

    [Fact]
    public async Task RefusesALoneSurrogateInAContractIdentifier()
    {
        var queue = new Queue(database.DataSource);
        await Assert.ThrowsAsync<ArgumentException>(() => queue.SyncContractsAsync(Contracts("type\uD800", "v1", RecipientSchema), Token));
        await Assert.ThrowsAsync<ArgumentException>(() => queue.SyncContractsAsync(Contracts(UniqueName("t"), "v\uDC00", RecipientSchema), Token));
    }

    [Fact]
    public async Task RefusesAPatternOrPatternPropertiesContract()
    {
        var queue = new Queue(database.DataSource);
        var pattern = await Assert.ThrowsAsync<ArgumentException>(() => queue.SyncContractsAsync(
            Contracts(UniqueName("t"), "v1", """{"type":"object","properties":{"code":{"type":"string","pattern":"^a$"}}}"""), Token));
        Assert.Contains("$.properties.code.pattern is outside the Workhorse contract profile", pattern.Message, StringComparison.Ordinal);
        var properties = await Assert.ThrowsAsync<ArgumentException>(() => queue.SyncContractsAsync(
            Contracts(UniqueName("t"), "v1", """{"type":"object","patternProperties":{"^a":true}}"""), Token));
        Assert.Contains("$.patternProperties is outside the Workhorse contract profile", properties.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ReloadsAContractThatChangedAndRetriesOnce()
    {
        var taskType = UniqueName("email.send");
        var queueName = UniqueName("contract-change");
        var first = new Queue(database.DataSource, new QueueOptions { DefaultQueue = queueName });
        var second = new Queue(database.DataSource, new QueueOptions { DefaultQueue = queueName });
        var v1 = Contracts(taskType, "v1", RecipientSchema);
        await first.SyncContractsAsync(v1, Token);
        Assert.Equal("v1", (await TaskAsync(database, (await first.EnqueueAsync(taskType, new Email("a@example.test"), Token)).TaskId))!.Text("contract_version"));

        var both = new Dictionary<string, TaskTypeContracts>
        {
            [taskType] = new()
            {
                CurrentVersion = "v2",
                Versions = new Dictionary<string, TaskContractVersion>
                {
                    ["v1"] = v1[taskType].Versions["v1"],
                    ["v2"] = new() { PayloadSchema = Json("""{"type":"object","required":["recipient","priority"]}""") },
                },
            },
        };
        await second.SyncContractsAsync(both, Token);

        // The first queue still caches v1. PostgreSQL reports the mismatch, and the queue reloads v2.
        await Assert.ThrowsAsync<ContractValidationException>(() => first.EnqueueAsync(taskType, new Email("b@example.test"), Token));
        var accepted = await first.EnqueueAsync(taskType, new { recipient = "c@example.test", priority = 1 }, Token);
        Assert.Equal("v2", (await TaskAsync(database, accepted.TaskId))!.Text("contract_version"));
    }

    [Fact]
    public async Task ACallerTransactionKeepsAnUncommittedContractToItself()
    {
        var taskType = UniqueName("email.send");
        var queue = new Queue(database.DataSource, new QueueOptions { DefaultQueue = UniqueName("contract-caller") });
        await queue.SyncContractsAsync(new Dictionary<string, TaskTypeContracts>(), Token);
        await using var connection = await database.DataSource.OpenConnectionAsync(Token);
        await using (var transaction = await connection.BeginTransactionAsync(Token))
        {
            await queue.Using(connection).SyncContractsAsync(Contracts(taskType, "v1", RecipientSchema), Token);
            await Assert.ThrowsAsync<ContractValidationException>(() => queue.Using(connection).EnqueueAsync(taskType, new Email(""), Token));
            await transaction.RollbackAsync(Token);
        }

        // The contract rolled back, so the source form accepts any payload.
        var accepted = await queue.EnqueueAsync(taskType, new Email(""), Token);
        Assert.Null((await TaskAsync(database, accepted.TaskId))!.Text("contract_version"));
    }

    private async Task<Workhorse.Internal.Database.Row?> ContractRowAsync(string taskType)
    {
        await using var connection = await database.DataSource.OpenConnectionAsync(Token);
        var rows = await Workhorse.Internal.Database.Sql.RowsAsync(
            connection,
            Workhorse.Internal.SqlCatalogue.GetContractDefinitionV1,
            [Workhorse.Internal.Database.Parameters.Text(taskType), Workhorse.Internal.Database.Parameters.Text(null)],
            Token);
        return rows.Count == 0 ? null : rows[0];
    }

    private const string RecipientSchema =
        """{"type":"object","required":["recipient"],"properties":{"recipient":{"type":"string","minLength":1}},"additionalProperties":false}""";

    private static Dictionary<string, TaskTypeContracts> Contracts(
        string taskType, string version, string payloadSchema, long? maxPayloadBytes = null, IReadOnlyList<string>? sensitive = null) => new()
        {
            [taskType] = new()
            {
                CurrentVersion = version,
                Versions = new Dictionary<string, TaskContractVersion>
                {
                    [version] = new()
                    {
                        PayloadSchema = Json(payloadSchema),
                        MaxPayloadBytes = maxPayloadBytes,
                        SensitivePayloadKeys = sensitive ?? [],
                    },
                },
            },
        };

    private static JsonElement Json(string text)
    {
        using var document = JsonDocument.Parse(text, Workhorse.Internal.Contracts.JsonTree.DocumentOptions);
        return document.RootElement.Clone();
    }
}
