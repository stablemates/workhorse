using System.Collections.Frozen;
using System.Formats.Tar;
using System.IO.Compression;
using System.Text.Json;

namespace Workhorse.AspNetCore.Internal;

/// <summary>
/// The browser bundle's files by archive path, read from the resources of this assembly.
/// </summary>
/// <remarks>
/// The assembly carries <c>bundle.json</c> and the <c>read-surface-*.tar.gz</c> archive that it
/// names, as <c>pnpm dashboard-bundle:generate</c> publishes them. The archive is a gzip ustar file.
/// </remarks>
internal static class Bundle
{
    private const string Prefix = "Workhorse.AspNetCore.Bundle.";

    private static readonly Lazy<FrozenDictionary<string, byte[]>> Unpacked = new(Unpack);

    /// <summary>The files of the archive, unpacked once.</summary>
    internal static FrozenDictionary<string, byte[]> Files => Unpacked.Value;

    /// <summary>The archive name that <c>bundle.json</c> names.</summary>
    internal static string Archive()
    {
        using var document = JsonDocument.Parse(Resource("bundle.json"));
        return document.RootElement.TryGetProperty("archive", out var archive)
            && archive.ValueKind == JsonValueKind.String
            && archive.GetString() is { Length: > 0 } name
            && !name.Contains('/', StringComparison.Ordinal)
                ? name
                : throw new InvalidOperationException("the dashboard bundle.json names no archive");
    }

    private static FrozenDictionary<string, byte[]> Unpack()
    {
        var files = new Dictionary<string, byte[]>(StringComparer.Ordinal);
        using var gzip = new GZipStream(new MemoryStream(Resource(Archive())), CompressionMode.Decompress);
        using var reader = new TarReader(gzip);
        while (reader.GetNextEntry() is { } entry)
        {
            if (entry.EntryType is not (TarEntryType.RegularFile or TarEntryType.V7RegularFile) || entry.DataStream is null)
            {
                continue;
            }

            using var content = new MemoryStream();
            entry.DataStream.CopyTo(content);
            var name = entry.Name.StartsWith("./", StringComparison.Ordinal) ? entry.Name[2..] : entry.Name;
            files[name] = content.ToArray();
        }

        return files.ToFrozenDictionary(StringComparer.Ordinal);
    }

    private static byte[] Resource(string name)
    {
        using var stream = typeof(Bundle).Assembly.GetManifestResourceStream(Prefix + name)
            ?? throw new InvalidOperationException($"the dashboard browser bundle resource {name} is not in the assembly");
        using var copy = new MemoryStream();
        stream.CopyTo(copy);
        return copy.ToArray();
    }
}
