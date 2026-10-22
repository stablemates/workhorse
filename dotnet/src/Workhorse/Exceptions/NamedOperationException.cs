namespace Workhorse;

/// <summary>The base of the named-primitive refusals, which carry an operation and a name.</summary>
public class NamedOperationException : WorkhorseException
{
    /// <summary>An exception whose message is the operation, the name, and <paramref name="detail"/>.</summary>
    protected NamedOperationException(string operation, string name, string detail)
        : base($"{operation} {name} {detail}")
    {
        Operation = operation;
        Name = name;
    }

    /// <summary>The operation, such as <c>checkpoint</c> or <c>child</c>.</summary>
    public string Operation { get; }

    /// <summary>The name of the primitive.</summary>
    public string Name { get; }
}

/// <summary>A named primitive received a different request under its retained identity.</summary>
public class ConflictException : NamedOperationException
{
    /// <summary>An exception for a conflicting request.</summary>
    public ConflictException(string operation, string name)
        : this(operation, name, null)
    {
    }

    /// <summary>An exception for a conflicting request, with the child name that PostgreSQL stored.</summary>
    public ConflictException(string operation, string name, string? storedName)
        : base(operation, name, Detail(name, storedName))
    {
        StoredName = storedName;
    }

    /// <summary>An exception with its own message detail, for a subclass.</summary>
    protected ConflictException(string operation, string name, string? storedName, string detail)
        : base(operation, name, detail)
    {
        StoredName = storedName;
    }

    /// <summary>The child name that PostgreSQL stored, or <c>null</c>.</summary>
    public string? StoredName { get; }

    private static string Detail(string name, string? storedName) =>
        storedName is null || storedName == name
            ? "conflicts with a different retained request"
            : $"conflicts: stored child \"{storedName}\", requested child \"{name}\"";
}

/// <summary>
/// A checkpoint call gave an input whose fingerprint differs from the stored fingerprint, or from
/// the fingerprint of an overlapping call with the same name (ADR 0098). The block does not run.
/// </summary>
public sealed class CheckpointInputConflictException : ConflictException
{
    /// <summary>An exception for the checkpoint and its two fingerprints.</summary>
    public CheckpointInputConflictException(string name, string storedFingerprint, string requestedFingerprint)
        : base(
            "checkpoint",
            name,
            null,
            $"input conflicts: stored fingerprint {storedFingerprint}, requested fingerprint {requestedFingerprint}")
    {
        StoredFingerprint = storedFingerprint;
        RequestedFingerprint = requestedFingerprint;
    }

    /// <summary>The fingerprint that PostgreSQL stored.</summary>
    public string StoredFingerprint { get; }

    /// <summary>The fingerprint of the request.</summary>
    public string RequestedFingerprint { get; }
}

/// <summary>A named primitive exceeded its limit.</summary>
public sealed class LimitExceededException : NamedOperationException
{
    /// <summary>An exception for the operation and the name.</summary>
    public LimitExceededException(string operation, string name)
        : base(operation, name, "exceeded its limit")
    {
    }
}

/// <summary>A wait with the same name is already open.</summary>
public sealed class AlreadyWaitingException : NamedOperationException
{
    /// <summary>An exception for the operation and the name.</summary>
    public AlreadyWaitingException(string operation, string name)
        : base(operation, name, "is already waiting")
    {
    }
}
