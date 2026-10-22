namespace Workhorse;

/// <summary>
/// Who asks for an operator control, why, and the request ID that makes a retry idempotent.
/// PostgreSQL records the audit with the control.
/// </summary>
/// <remarks>
/// <see cref="Admin"/> refuses an empty field, or a field that is too long, with an
/// <see cref="ArgumentException"/> before it runs a statement.
/// </remarks>
public sealed record AdminAudit
{
    /// <summary>Who asks, 1 to 200 characters.</summary>
    public required string Actor { get; init; }

    /// <summary>Why, 1 to 2,000 characters.</summary>
    public required string Reason { get; init; }

    /// <summary>The idempotency key of the control, 1 to 512 UTF-8 bytes.</summary>
    public required string RequestId { get; init; }
}
