using System.Reflection;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Primitives;

namespace Workhorse.Hosting.Internal;

/// <summary>
/// Refuses configuration for an option property that <c>ConfigurationKeys.json</c> does not list
/// (SM-2041). The binder fills each public settable property that it can create. For
/// <see cref="QueueOptions.Json"/> and <see cref="WorkerOptions.Json"/> it creates a
/// <see cref="JsonSerializerOptions"/> with the general defaults, which replaces the Web defaults of
/// ADR 0107. So only the listed keys reach the options, and a host sets the other properties in code.
/// </summary>
internal static class CodeOnlyOptions
{
    private static readonly Lazy<HashSet<string>> Listed = new(ListedKeys);

    /// <summary>
    /// Binds the keys of <paramref name="section"/> that <c>ConfigurationKeys.json</c> lists, and no
    /// other key. The binder reads the section through <see cref="ListedSection"/>, so it never sees
    /// a <c>Json</c>, <c>RetryDelay</c>, or <c>LoggerFactory</c> section. It binds each listed key
    /// from the real section, with its full path, as on 0.12.
    /// </summary>
    /// <param name="section">The configuration section of the options.</param>
    /// <param name="prefix">The configuration path of the section, such as <c>Workhorse:Worker</c>.</param>
    /// <param name="options">The options object to fill.</param>
    internal static void BindListed(IConfigurationSection section, string prefix, object options) =>
        new ListedSection(section, prefix).Bind(options);

    /// <summary>
    /// Throws when <paramref name="section"/>, the section at <paramref name="prefix"/>, has a key or
    /// a child section that names a property of <paramref name="options"/> that has no listed key.
    /// A key that names no property stays ignored, as the binder ignores it.
    /// </summary>
    /// <param name="section">The configuration section of the options.</param>
    /// <param name="prefix">The configuration path of the section, such as <c>Workhorse:Worker</c>.</param>
    /// <param name="options">The options type that the section binds.</param>
    /// <param name="atRegistration">
    /// <see langword="true"/> in <c>AddWorkhorse</c>. A property that the binder can fill, such as
    /// <c>Json</c>, is refused there. The binder cannot create a delegate or an interface, so on 0.12
    /// a <c>RetryDelay</c> or <c>LoggerFactory</c> section failed only when the options were read,
    /// and only when it had a child key. This method refuses it at that read, in the same case, so
    /// a host that never reads the options keeps working.
    /// </param>
    /// <exception cref="InvalidOperationException">The section sets a code-only property.</exception>
    internal static void Refuse(IConfigurationSection section, string prefix, Type options, bool atRegistration)
    {
        // A key with a null value and no children does not exist for Exists(), so the check reads
        // the child keys.
        foreach (var child in section.GetChildren())
        {
            var property = options.GetProperty(child.Key, BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase);
            if (property is null || IsListed(prefix, property.Name))
            {
                continue;
            }

            if (!BinderCanCreate(property.PropertyType) && (atRegistration || !child.GetChildren().Any()))
            {
                continue;
            }

            var setting = property.PropertyType == typeof(JsonSerializerOptions) ? "the JSON options" : "this option";
            // QueueOptions has init-only properties, so the code form is a Queue that the
            // application registers before AddWorkhorse.
            var code = options == typeof(QueueOptions)
                ? $"register a Queue with new QueueOptions {{ {property.Name} = ... }} before AddWorkhorse"
                : $"use services.Configure<{options.Name}>(options => options.{property.Name} = ...)";
            throw new InvalidOperationException(
                $"{child.Path} is not a Workhorse configuration key. Configuration cannot set {options.Name}.{property.Name}. "
                + $"Remove the section, and set {setting} in code: {code}.");
        }
    }

    private static bool IsListed(string prefix, string key) => Listed.Value.Contains($"{prefix}:{key}");

    /// <summary>Whether the configuration binder can create a value of <paramref name="type"/>.</summary>
    private static bool BinderCanCreate(Type type) =>
        !type.IsInterface && !type.IsAbstract && !typeof(Delegate).IsAssignableFrom(type);

    /// <summary>
    /// A view of an options section that shows only its listed keys. Each other method passes to the
    /// real section, so values, paths, and reload tokens stay those of the configuration.
    /// </summary>
    private sealed class ListedSection(IConfigurationSection inner, string prefix) : IConfigurationSection
    {
        private static readonly IConfigurationRoot Empty = new ConfigurationBuilder().Build();

        public string Key => inner.Key;

        public string Path => inner.Path;

        public string? Value
        {
            get => inner.Value;
            set => inner.Value = value;
        }

        public string? this[string key]
        {
            get => Shows(key) ? inner[key] : null;
            set => inner[key] = value;
        }

        public IConfigurationSection GetSection(string key) =>
            Shows(key) ? inner.GetSection(key) : Empty.GetSection(ConfigurationPath.Combine(inner.Path, key));

        public IEnumerable<IConfigurationSection> GetChildren() => inner.GetChildren().Where(child => Shows(child.Key));

        public IChangeToken GetReloadToken() => inner.GetReloadToken();

        private bool Shows(string key) => IsListed(prefix, key.Split(ConfigurationPath.KeyDelimiter)[0]);
    }

    private static HashSet<string> ListedKeys()
    {
        using var stream = typeof(CodeOnlyOptions).Assembly.GetManifestResourceStream("Workhorse.Hosting.ConfigurationKeys.json")
            ?? throw new InvalidOperationException("Workhorse.Hosting does not embed ConfigurationKeys.json");
        using var document = JsonDocument.Parse(stream);
        return document.RootElement.GetProperty("keys").EnumerateArray()
            .Select(key => key.GetProperty("key").GetString()!)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
    }
}
