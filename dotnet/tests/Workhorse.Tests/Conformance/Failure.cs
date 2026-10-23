namespace Workhorse.Tests.Conformance;

/// <summary>A fixture that disagrees with the C# SDK. The message names the first mismatch.</summary>
internal sealed class Failure : Exception
{
    internal Failure(string message)
        : base(message)
    {
    }

    /// <summary>Fails with <paramref name="message"/> unless <paramref name="condition"/> holds.</summary>
    internal static void Check(bool condition, string message)
    {
        if (!condition)
        {
            throw new Failure(message);
        }
    }
}

/// <summary>
/// What one fixture did when the runner tried it. The counterpart of the JVM <c>Outcome</c>.
/// </summary>
/// <remarks>
/// <c>Failed</c>: the C# adapter ran and disagreed. <c>Unsupported</c>: no C# adapter can express
/// the fixture yet, because an open slice owns the surface. <c>Skipped</c>: the runner could not
/// reach the database the fixture needs.
/// </remarks>
internal sealed record Outcome(OutcomeStatus Status, string? Reason)
{
    internal static Outcome Passed() => new(OutcomeStatus.Passed, null);

    internal static Outcome Failed(string reason) => new(OutcomeStatus.Failed, reason);

    internal static Outcome Unsupported(string reason) => new(OutcomeStatus.Unsupported, reason);

    internal static Outcome Skipped(string reason) => new(OutcomeStatus.Skipped, reason);
}

internal enum OutcomeStatus
{
    Failed,
    Passed,
    Skipped,
    Unsupported,
}
