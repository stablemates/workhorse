namespace Workhorse;

/// <summary>SQLSTATE <c>P1007</c>: a request and the tier of a queue disagree (ADR 0077).</summary>
/// <remarks>
/// PostgreSQL sends the queue, the feature, and the position in the DETAIL of the error. Npgsql
/// hides the DETAIL unless the connection string sets <c>Include Error Detail=true</c>. Without it,
/// <see cref="Queue"/> and <see cref="Feature"/> are <c>unknown</c>, and <see cref="Ordinal"/> is
/// <c>null</c>.
/// </remarks>
public sealed class FastTierUnsupportedException : WorkhorseException
{
    /// <summary>An exception for the queue, the feature, and the position of the request.</summary>
    public FastTierUnsupportedException(string queue, string feature, long? ordinal)
        : base($"Fast-tier queue {queue} does not support {feature}")
    {
        Queue = queue;
        Feature = feature;
        Ordinal = ordinal;
    }

    /// <summary>The fast-tier queue, or <c>unknown</c> without <c>Include Error Detail=true</c>.</summary>
    public string Queue { get; }

    /// <summary>The feature that the queue does not support, or <c>unknown</c> without <c>Include Error Detail=true</c>.</summary>
    public string Feature { get; }

    /// <summary>The 1-based position of the rejected request in an enqueue batch, or <c>null</c>. It is <c>null</c> without <c>Include Error Detail=true</c>.</summary>
    public long? Ordinal { get; }
}
