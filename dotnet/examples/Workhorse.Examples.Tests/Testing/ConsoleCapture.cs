namespace Workhorse.Examples.Tests.Testing;

/// <summary>
/// The tests that capture standard output. <see cref="Console.SetOut"/> changes the writer of the
/// whole process, so xUnit runs this collection alone, and no other test writes during a capture.
/// </summary>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class ConsoleCapture
{
    /// <summary>The collection name.</summary>
    public const string Name = "Console";
}
