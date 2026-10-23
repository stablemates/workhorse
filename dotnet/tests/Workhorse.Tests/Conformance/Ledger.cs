using System.Text.Json;
using System.Text.RegularExpressions;

namespace Workhorse.Tests.Conformance;

/// <summary>
/// The reconciliation between fixture outcomes and the expected-unsupported list. The counterpart
/// of the JVM <c>Ledger</c>.
/// </summary>
/// <remarks>
/// Every fixture must pass through a C# adapter, or appear on the list with the Issue that owns the
/// gap. A listed fixture that passes also fails the run, so the list cannot outlive its fix.
/// </remarks>
internal static partial class Ledger
{
    /// <summary>The list, relative to the repository root.</summary>
    internal const string Path = "dotnet/tests/Workhorse.Tests/Conformance/expected-unsupported.json";

    /// <summary>One list entry: a fixture key, the Issue that owns its gap, and why it does not pass.</summary>
    internal sealed record Entry(string Fixture, string Issue, string Reason);

    /// <summary>The entries of the list at <paramref name="path"/>.</summary>
    internal static IReadOnlyList<Entry> Load(string path)
    {
        using var document = JsonDocument.Parse(File.ReadAllText(path));
        var root = document.RootElement;
        var keys = root.EnumerateObject().Select(property => property.Name).Order(StringComparer.Ordinal).ToList();
        if (!keys.SequenceEqual(["$comment", "fixtures"]))
        {
            throw new InvalidOperationException($"{path} must hold exactly $comment and fixtures");
        }

        var entries = new List<Entry>();
        foreach (var item in root.GetProperty("fixtures").EnumerateArray())
        {
            var fields = item.EnumerateObject().Select(property => property.Name).Order(StringComparer.Ordinal).ToList();
            if (!fields.SequenceEqual(["fixture", "issue", "reason"]))
            {
                throw new InvalidOperationException($"{path} entry {item.GetRawText()} must hold fixture, issue, and reason");
            }

            entries.Add(new Entry(item.GetProperty("fixture").GetString()!, item.GetProperty("issue").GetString()!, item.GetProperty("reason").GetString()!));
        }

        return entries;
    }

    /// <summary>Every disagreement between the outcomes and the list. An empty result is a clean run.</summary>
    /// <remarks>
    /// <paramref name="declared"/> holds every fixture that the protocol files define, so a list entry
    /// for a fixture that no longer exists is reported too.
    /// </remarks>
    internal static IReadOnlyList<string> Reconcile(IReadOnlySet<string> declared, IReadOnlyDictionary<string, Outcome> outcomes, IReadOnlyList<Entry> entries)
    {
        var problems = new List<string>();
        var listed = new Dictionary<string, Entry>(StringComparer.Ordinal);
        foreach (var entry in entries)
        {
            if (!Issue().IsMatch(entry.Issue))
            {
                problems.Add($"{entry.Fixture} names tracking issue \"{entry.Issue}\", not SM-<number>");
            }

            if (string.IsNullOrWhiteSpace(entry.Reason))
            {
                problems.Add($"{entry.Fixture} records no reason");
            }

            if (!declared.Contains(entry.Fixture))
            {
                problems.Add($"{entry.Fixture} is listed but no protocol/v1 fixture declares it");
            }

            if (!listed.TryAdd(entry.Fixture, entry))
            {
                problems.Add($"{entry.Fixture} is listed twice");
            }
        }

        foreach (var fixture in declared.Order(StringComparer.Ordinal))
        {
            if (!outcomes.ContainsKey(fixture))
            {
                problems.Add($"{fixture} was never executed");
            }
        }

        foreach (var (fixture, outcome) in outcomes.OrderBy(pair => pair.Key, StringComparer.Ordinal))
        {
            if (!declared.Contains(fixture))
            {
                problems.Add($"{fixture} was executed but no protocol/v1 fixture declares it");
            }

            listed.TryGetValue(fixture, out var entry);
            switch (outcome.Status)
            {
                case OutcomeStatus.Passed when entry is not null:
                    problems.Add($"{fixture} now passes; remove it from the expected-unsupported list ({entry.Issue})");
                    break;
                case OutcomeStatus.Failed or OutcomeStatus.Unsupported when entry is null:
                    problems.Add($"{fixture} does not pass and is not listed: {outcome.Reason}");
                    break;
                default:
                    break;
            }
        }

        return problems;
    }

    [GeneratedRegex(@"^SM-\d+$")]
    private static partial Regex Issue();
}
