namespace Workhorse;

/// <summary>Why the startup compatibility check refused.</summary>
public enum CompatibilityCode
{
    /// <summary>The Workhorse schema is not installed.</summary>
    SchemaNotInstalled,

    /// <summary>The installed schema is older than this client supports.</summary>
    SchemaTooOld,

    /// <summary>The installed schema no longer serves the protocol version of this client.</summary>
    SchemaTooNew,

    /// <summary>The protocol version of this client is older than the catalogue supports.</summary>
    ClientProtocolTooOld,

    /// <summary>The protocol version of this client is newer than the catalogue supports.</summary>
    ClientProtocolTooNew,
}

/// <summary>PostgreSQL and this client cannot work together.</summary>
public sealed class CompatibilityException : WorkhorseException
{
    /// <summary>An exception for one refusal code.</summary>
    public CompatibilityException(CompatibilityCode code)
        : base($"workhorse compatibility check refused: {Wire(code)}")
    {
        Code = code;
    }

    /// <summary>The refusal code.</summary>
    public CompatibilityCode Code { get; }

    private static string Wire(CompatibilityCode code) => code switch
    {
        CompatibilityCode.SchemaNotInstalled => "schema-not-installed",
        CompatibilityCode.SchemaTooOld => "schema-too-old",
        CompatibilityCode.SchemaTooNew => "schema-too-new",
        CompatibilityCode.ClientProtocolTooOld => "client-protocol-too-old",
        CompatibilityCode.ClientProtocolTooNew => "client-protocol-too-new",
        _ => code.ToString(),
    };
}
