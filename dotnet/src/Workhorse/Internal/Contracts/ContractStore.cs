using System.Text.Json;
using System.Text.Json.Nodes;
using Npgsql;
using Workhorse.Internal.Database;

namespace Workhorse.Internal.Contracts;

/// <summary>
/// The current contract that PostgreSQL holds for one task type.
/// </summary>
/// <param name="Version">The contract version that new tasks stamp.</param>
/// <param name="Schema">The compiled payload schema.</param>
/// <param name="StoredSchema">The stored schema document, with its <c>payload</c> and <c>result</c> members.</param>
/// <param name="PayloadMaxBytes">The payload limit.</param>
/// <param name="ResultMaxBytes">The result limit.</param>
/// <param name="PayloadRedactKeys">The payload keys that reads redact.</param>
/// <param name="ResultRedactKeys">The result keys that reads redact.</param>
internal sealed record PayloadContract(
    string Version,
    ContractSchema Schema,
    JsonElement StoredSchema,
    long PayloadMaxBytes,
    long ResultMaxBytes,
    IReadOnlyList<string> PayloadRedactKeys,
    IReadOnlyList<string> ResultRedactKeys);

/// <summary>Loads and renders payload contracts.</summary>
internal static class ContractStore
{
    /// <summary>
    /// The current contract of <paramref name="taskType"/>, or its <paramref name="version"/> when
    /// that is not <c>null</c>, or <c>null</c> when there is none.
    /// </summary>
    internal static async Task<PayloadContract?> LoadAsync(
        NpgsqlConnection connection, string taskType, string? version, CancellationToken cancellationToken)
    {
        var rows = await Sql.RowsAsync(
            connection,
            SqlCatalogue.GetContractDefinitionV1,
            [Parameters.Text(taskType), Parameters.Text(version)],
            cancellationToken).ConfigureAwait(false);
        return rows.Count switch
        {
            0 => null,
            1 => Decode(rows[0]),
            _ => throw InvalidDefinition(null),
        };
    }

    /// <summary>
    /// Compiles every schema, then renders the <c>sync_contract_definitions_v1</c> document.
    /// </summary>
    /// <exception cref="ArgumentException">A schema is outside the profile.</exception>
    internal static string Document(IReadOnlyDictionary<string, TaskTypeContracts> contracts)
    {
        var document = new JsonArray();
        foreach (var (taskType, definition) in contracts)
        {
            ArgumentNullException.ThrowIfNull(definition, nameof(contracts));
            Identifier(taskType, "contract task type");
            Identifier(definition.CurrentVersion, $"{taskType} current version");
            var versions = new JsonObject();
            foreach (var (version, contract) in definition.Versions ?? throw new ArgumentException($"{taskType} contract versions must be a dictionary"))
            {
                Identifier(version, $"{taskType} contract version");
                try
                {
                    versions[version] = VersionDocument(contract);
                }
                catch (ArgumentException error)
                {
                    throw new ArgumentException($"{taskType} contract version {version}: {error.Message}", error);
                }
            }

            document.Add(new JsonObject
            {
                ["taskType"] = taskType,
                ["currentVersion"] = definition.CurrentVersion,
                ["versions"] = versions,
            });
        }

        return Values.Write(document);
    }

    /// <summary>
    /// Refuses an empty identifier and one with a lone surrogate, which the writer would change to
    /// U+FFFD, so the contract would install under another name.
    /// </summary>
    private static void Identifier(string? value, string label)
    {
        if (string.IsNullOrEmpty(value))
        {
            throw new ArgumentException($"{label} must be a non-empty String");
        }

        Json.Utf16.Require(value, label);
    }

    private static JsonObject VersionDocument(TaskContractVersion contract)
    {
        ArgumentNullException.ThrowIfNull(contract);
        return new JsonObject
        {
            ["payloadSchema"] = Schema(contract.PayloadSchema),
            ["resultSchema"] = Schema(contract.ResultSchema),
            ["maxPayloadBytes"] = Limit(contract.MaxPayloadBytes),
            ["maxResultBytes"] = Limit(contract.MaxResultBytes),
            ["sensitivePayloadKeys"] = new JsonArray([.. contract.SensitivePayloadKeys.Select(key => (JsonNode?)Json.Utf16.Require(key, "sensitive key"))]),
            ["sensitiveResultKeys"] = new JsonArray([.. contract.SensitiveResultKeys.Select(key => (JsonNode?)Json.Utf16.Require(key, "sensitive key"))]),
        };
    }

    /// <summary>The schema node, after the profile check. An undefined schema is <c>true</c>.</summary>
    private static JsonNode? Schema(JsonElement schema)
    {
        if (schema.ValueKind == JsonValueKind.Undefined)
        {
            return JsonValue.Create(true);
        }

        _ = new ContractSchema(schema);
        return Values.Node(schema.GetRawText());
    }

    private static long Limit(long? value) =>
        value is null or 0 ? SqlCatalogue.DefaultTaskValueMaxBytes : value.Value;

    private static PayloadContract Decode(Row row)
    {
        try
        {
            var schema = row.Json("schema");
            if (schema is not { ValueKind: JsonValueKind.Object } stored || !stored.TryGetProperty("payload", out var payload))
            {
                throw InvalidDefinition(null);
            }

            return new PayloadContract(
                row.RequiredText("version"),
                new ContractSchema(payload),
                stored,
                row.RequiredLong("payload_max_bytes"),
                row.RequiredLong("result_max_bytes"),
                row.TextList("payload_redact_keys") ?? [],
                row.TextList("result_redact_keys") ?? []);
        }
        catch (Exception error) when (error is ArgumentException or JsonException or (WorkhorseException and not DatabaseException))
        {
            throw InvalidDefinition(error);
        }
    }

    private static WorkhorseException InvalidDefinition(Exception? cause) =>
        new("invalid contract definition returned by PostgreSQL", cause);
}
