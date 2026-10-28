using Microsoft.Extensions.Configuration;

namespace Workhorse.Hosting.Internal;

/// <summary>Binds the <c>Workhorse:Worker</c> section to <see cref="WorkerOptions"/>.</summary>
internal static class WorkerConfiguration
{
    /// <summary>The key that Workhorse 0.11.0 removed, below the <c>Workhorse:Worker</c> section.</summary>
    private const string RemovedSharedHeartbeats = "SharedHeartbeats";

    /// <summary>
    /// Refuses the removed <c>SharedHeartbeats</c> key in <paramref name="section"/>, with any value,
    /// also <c>null</c>. The binder ignores a key that names no option, so the check is explicit.
    /// </summary>
    /// <exception cref="InvalidOperationException">The section sets <c>SharedHeartbeats</c>.</exception>
    internal static void RefuseRemovedKeys(IConfigurationSection section)
    {
        // A key with a null value and no children does not exist for Exists(), so the check reads
        // the child keys.
        var removed = section.GetChildren()
            .FirstOrDefault(child => string.Equals(child.Key, RemovedSharedHeartbeats, StringComparison.OrdinalIgnoreCase));
        if (removed is not null)
        {
            throw new InvalidOperationException(
                $"{removed.Path} was removed in 0.11.0. Every worker now reserves a dedicated heartbeat connection. "
                + "Remove the key, and give the worker a pool with a known maximum size of at least 3.");
        }
    }

    /// <summary>
    /// Binds <paramref name="section"/>. The binder adds the items of a list key to the default list,
    /// so a configured list replaces the default here. A reloaded configuration can add the removed
    /// key after the registration, so the bind refuses it again.
    /// </summary>
    /// <exception cref="InvalidOperationException">The section sets <c>SharedHeartbeats</c>.</exception>
    internal static void Bind(IConfigurationSection section, WorkerOptions options)
    {
        RefuseRemovedKeys(section);
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
