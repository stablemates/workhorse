using Microsoft.Extensions.Configuration;

namespace Workhorse.Hosting.Internal;

/// <summary>Binds the <c>Workhorse:Worker</c> section to <see cref="WorkerOptions"/>.</summary>
internal static class WorkerConfiguration
{
    /// <summary>
    /// Binds <paramref name="section"/>. The binder adds the items of a list key to the default list,
    /// so a configured list replaces the default here.
    /// </summary>
    internal static void Bind(IConfigurationSection section, WorkerOptions options)
    {
        section.Bind(options);
        if (List(section, nameof(WorkerOptions.Queues)) is { } queues)
        {
            options.Queues = queues;
        }

        if (List(section, nameof(WorkerOptions.ScheduleNamespaces)) is { } namespaces)
        {
            options.ScheduleNamespaces = namespaces;
        }
    }

    private static List<string>? List(IConfigurationSection section, string key)
    {
        var child = section.GetSection(key);
        return child.Exists() ? child.Get<List<string>>() ?? [] : null;
    }
}
