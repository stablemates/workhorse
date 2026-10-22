using System.Reflection;
using System.Text.Json;

namespace Workhorse.Tests.Testing;

/// <summary>Files of the checkout that the test build came from.</summary>
internal static class Repository
{
    /// <summary>The absolute path of <paramref name="relative"/> in the checkout.</summary>
    internal static string Path(string relative) =>
        System.IO.Path.Combine(
            typeof(Repository).Assembly
                .GetCustomAttributes<AssemblyMetadataAttribute>()
                .Single(attribute => attribute.Key == "WorkhorseRepository")
                .Value ?? throw new InvalidOperationException("The build records no WorkhorseRepository path"),
            relative);

    /// <summary>The JSON document at <paramref name="relative"/>.</summary>
    internal static JsonElement Json(string relative)
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path(relative)));
        return document.RootElement.Clone();
    }
}
