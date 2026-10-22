using System.Text.Json;

namespace Workhorse;

/// <summary>
/// One version of the payload and result contract of a task type. A schema is a Draft 2020-12
/// JSON Schema inside the Workhorse contract profile (ADR 0039): an object or a boolean. An unset
/// schema is <c>true</c>, which accepts anything. A byte limit of <c>null</c> or 0 uses the protocol
/// default.
/// </summary>
public sealed record TaskContractVersion
{
    /// <summary>The payload schema.</summary>
    public JsonElement PayloadSchema { get; init; }

    /// <summary>The result schema.</summary>
    public JsonElement ResultSchema { get; init; }

    /// <summary>The payload limit in bytes, or <c>null</c>.</summary>
    public long? MaxPayloadBytes { get; init; }

    /// <summary>The result limit in bytes, or <c>null</c>.</summary>
    public long? MaxResultBytes { get; init; }

    /// <summary>The top-level payload keys that reads redact.</summary>
    public IReadOnlyList<string> SensitivePayloadKeys { get; init; } = [];

    /// <summary>The top-level result keys that reads redact.</summary>
    public IReadOnlyList<string> SensitiveResultKeys { get; init; } = [];
}

/// <summary>Every retained contract version of one task type, keyed by version, and the version that new tasks use.</summary>
public sealed record TaskTypeContracts
{
    /// <summary>The version that new tasks use.</summary>
    public required string CurrentVersion { get; init; }

    /// <summary>Every retained version.</summary>
    public required IReadOnlyDictionary<string, TaskContractVersion> Versions { get; init; }
}
