namespace Workhorse.Tests.Conformance;

/// <summary>
/// Every fixture that each <c>protocol/v1</c> category file declares, in file order. The
/// counterpart of the JVM <c>Catalogue</c>.
/// </summary>
internal sealed class Catalogue
{
    /// <summary>
    /// Files in <c>protocol/v1</c> that describe fixtures rather than declare them, and the
    /// fingerprint vectors that <c>CheckpointsTests</c> reads.
    /// </summary>
    internal static readonly IReadOnlySet<string> Metadata =
        new HashSet<string>(["manifest.json", "cron.md", "governed-surface.json", "checkpoint-fingerprints.json"], StringComparer.Ordinal);

    /// <summary>The fixture files, by the category name the list uses.</summary>
    internal static readonly IReadOnlyList<string> Categories =
        ["compatibility", "contracts", "cron-occurrences", "failures", "interpreter", "requests", "runtime", "scenarios", "schedules"];

    private readonly Dictionary<string, List<OrderedDictionary<string, object?>>> _fixtures;

    private Catalogue(Dictionary<string, List<OrderedDictionary<string, object?>>> fixtures, OrderedDictionary<string, object?> manifest)
    {
        _fixtures = fixtures;
        Manifest = manifest;
    }

    internal OrderedDictionary<string, object?> Manifest { get; }

    /// <summary>The fixtures in <paramref name="directory"/>. It refuses any file that the runner does not classify.</summary>
    internal static Catalogue Load(string directory)
    {
        var unknown = Directory.EnumerateFiles(directory)
            .Select(file => System.IO.Path.GetFileName(file))
            .Where(name => !Metadata.Contains(name) && !(name.EndsWith(".json", StringComparison.Ordinal) && Categories.Contains(name[..^5])))
            .Order(StringComparer.Ordinal)
            .ToList();
        if (unknown.Count > 0)
        {
            throw new Failure(
                $"protocol/v1 holds files the .NET runner does not classify: {string.Join(", ", unknown)}; execute them or name them as metadata");
        }

        var fixtures = new Dictionary<string, List<OrderedDictionary<string, object?>>>(StringComparer.Ordinal);
        foreach (var category in Categories)
        {
            var document = Json.Parse(File.ReadAllText(System.IO.Path.Combine(directory, category + ".json")));

            // `failures.json` wraps its fixtures beside the envelope they share.
            var list = category == "failures" && Json.Object(document) is { } wrapped ? wrapped.GetValueOrDefault("fixtures") : document;
            if (list is not List<object?> items)
            {
                throw new Failure($"{category}.json declares no fixture array");
            }

            fixtures[category] = [.. items.Select(item => Json.Object(item) ?? throw new Failure($"{category}.json holds a fixture that is not an object"))];
        }

        var manifest = Json.Object(Json.Parse(File.ReadAllText(System.IO.Path.Combine(directory, "manifest.json"))))
            ?? throw new Failure("manifest.json is not an object");
        return new Catalogue(fixtures, manifest);
    }

    internal IReadOnlyList<OrderedDictionary<string, object?>> Category(string name) =>
        _fixtures.TryGetValue(name, out var list) ? list : throw new ArgumentException($"unknown category {name}", nameof(name));

    /// <summary>Every <c>&lt;category&gt;/&lt;fixture id&gt;</c> key.</summary>
    internal IReadOnlySet<string> Declared() =>
        _fixtures.SelectMany(pair => pair.Value.Select(fixture => Key(pair.Key, fixture))).ToHashSet(StringComparer.Ordinal);

    internal static string Key(string category, OrderedDictionary<string, object?> fixture) =>
        fixture.GetValueOrDefault("id") is string id ? $"{category}/{id}" : throw new Failure("every fixture has a string id");
}
