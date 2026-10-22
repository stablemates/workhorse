using System.Text.Json;
using System.Text.RegularExpressions;
using Npgsql;

namespace Workhorse.Internal.Database;

/// <summary>Maps an <see cref="NpgsqlException"/> to the SDK exception for its SQLSTATE (ADR 0107, "Errors").</summary>
internal static partial class SqlStates
{
    internal const string FeatureNotSupported = "0A000";
    internal const string DeadlockDetected = "40P01";
    internal const string InFailedTransaction = "25P02";
    internal const string UndefinedTable = "42P01";
    internal const string InvalidSchemaName = "3F000";

    /// <summary>The SDK exception for <paramref name="error"/>.</summary>
    internal static WorkhorseException Translate(NpgsqlException error)
    {
        var postgres = error as PostgresException;
        var sqlState = postgres?.SqlState ?? error.SqlState;
        var message = string.IsNullOrEmpty(error.Message) ? "database error" : error.Message;
        switch (sqlState)
        {
            case null:
                return new DatabaseException(message, null, error);
            case "P1001":
                return new EnqueueIdempotencyConflictException(Details(postgres));
            case "P1002":
                return new RedriveIdempotencyConflictException(Details(postgres));
            case "P1003":
                return new DependencyCycleException(Details(postgres));
            case "P1005":
                return new DependencyLimitExceededException(Details(postgres));
            case "P1006":
                return new PurgeIdempotencyConflictException(Details(postgres));
            case "P1007":
                var fields = Details(postgres);
                return new FastTierUnsupportedException(
                    Member(fields, "queue") ?? "unknown",
                    Member(fields, "feature") ?? "unknown",
                    fields.TryGetValue("ordinal", out var ordinal) && ordinal.ValueKind == JsonValueKind.Number && ordinal.TryGetInt64(out var position)
                        ? position
                        : null);
            case "P1008":
                return new TaskGroupClosedException(Details(postgres));
            case "P1009":
                return new TaskGroupLimitExceededException(Details(postgres));
            case "P1010":
                return new TaskGroupMembershipConflictException(Details(postgres));
            case FeatureNotSupported:
                var match = Isolation().Match(postgres?.MessageText ?? message);
                return match.Success
                    ? new IsolationLevelException(match.Groups[1].Value, message, error)
                    : new DatabaseException(message, sqlState, error);
            default:
                return new DatabaseException(message, sqlState, error);
        }
    }

    [GeneratedRegex("^Workhorse claims require read committed isolation, not (.+)$", RegexOptions.CultureInvariant)]
    private static partial Regex Isolation();

    /// <summary>The JSON detail of PostgreSQL as members, or no members when it is absent or not an object.</summary>
    private static Dictionary<string, JsonElement> Details(PostgresException? error)
    {
        var details = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        if (string.IsNullOrEmpty(error?.Detail))
        {
            return details;
        }

        try
        {
            using var document = JsonDocument.Parse(error.Detail);
            if (document.RootElement.ValueKind == JsonValueKind.Object)
            {
                foreach (var property in document.RootElement.EnumerateObject())
                {
                    details[property.Name] = property.Value.Clone();
                }
            }
        }
        catch (JsonException)
        {
            details.Clear();
        }

        return details;
    }

    private static string? Member(Dictionary<string, JsonElement> fields, string key) =>
        fields.TryGetValue(key, out var value)
            ? value.ValueKind == JsonValueKind.String ? value.GetString() : value.GetRawText()
            : null;
}
