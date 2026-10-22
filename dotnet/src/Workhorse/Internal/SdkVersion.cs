using System.Reflection;

namespace Workhorse.Internal;

/// <summary>
/// The SDK version that a worker registers as <c>sdk_version</c>, and the language that it registers
/// as <c>sdk_language</c>. The dashboard and the telemetry read the version here too, so this class
/// is the only reader of the assembly's version (ADR 0107, "Governed surface and release").
/// </summary>
/// <remarks>
/// <c>Directory.Build.props</c> sets the train version, and the informational version holds no
/// commit suffix. If the attribute is absent or empty, the version is <c>null</c>, and the registry
/// stores <c>NULL</c>. A guessed string would look like a real version.
/// </remarks>
internal static class SdkVersion
{
    /// <summary>The <c>sdk_language</c> of the worker registry.</summary>
    internal const string Language = "csharp";

    /// <summary>The train version of this SDK, or <c>null</c>.</summary>
    internal static string? Current { get; } = Read(typeof(SdkVersion).Assembly);

    internal static string? Read(Assembly assembly)
    {
        var version = assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion.Trim();
        return string.IsNullOrEmpty(version) ? null : version;
    }
}
