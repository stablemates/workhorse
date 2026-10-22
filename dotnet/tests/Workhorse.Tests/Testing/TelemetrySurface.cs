using System.Text.RegularExpressions;

namespace Workhorse.Tests.Testing;

/// <summary>
/// The governed telemetry names of <c>api/telemetry.txt</c>: each instrument with its kind, unit,
/// and description, each span name, and each attribute name.
/// </summary>
internal sealed partial record TelemetrySurface(
    IReadOnlyDictionary<string, TelemetrySurface.Instrument> Instruments, IReadOnlyList<string> Spans, IReadOnlyList<string> Attributes)
{
    /// <summary>One instrument line.</summary>
    internal sealed record Instrument(string Kind, string Unit, string Description);

    /// <summary>Every name in the file.</summary>
    internal IReadOnlyList<string> Names => [.. Instruments.Keys, .. Spans, .. Attributes];

    /// <summary>The names of <c>api/telemetry.txt</c> in this checkout.</summary>
    internal static TelemetrySurface Read()
    {
        var instruments = new Dictionary<string, Instrument>(StringComparer.Ordinal);
        var spans = new List<string>();
        var attributes = new List<string>();
        var section = "";
        foreach (var line in File.ReadAllLines(Repository.Path("api/telemetry.txt")))
        {
            if (line.StartsWith("## ", StringComparison.Ordinal))
            {
                section = line[3..].Trim();
                continue;
            }

            if (string.IsNullOrWhiteSpace(line) || line.StartsWith('#'))
            {
                continue;
            }

            switch (section)
            {
                case "Instruments":
                    var fields = Whitespace().Split(line.Trim(), 4);
                    instruments.Add(fields[0], new Instrument(fields[1], fields[2], fields[3]));
                    break;
                case "Spans":
                    spans.Add(line.Trim());
                    break;
                case "Attributes":
                    attributes.Add(line.Trim());
                    break;
                default:
                    throw new InvalidOperationException($"a name outside a section: {line}");
            }
        }

        return new TelemetrySurface(instruments, spans, attributes);
    }

    [GeneratedRegex(@"\s+")]
    private static partial Regex Whitespace();
}
