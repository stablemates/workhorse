using Microsoft.Extensions.DependencyInjection;
using Npgsql;

namespace Workhorse.Hosting.Internal;

/// <summary>The data source that the Workhorse services use, resolved once from the container.</summary>
internal sealed class WorkhorseDataSource(NpgsqlDataSource value)
{
    internal NpgsqlDataSource Value { get; } = value;

    /// <summary>
    /// The keyed data source that <paramref name="key"/> names, or the data source without a key
    /// when <paramref name="key"/> is empty.
    /// </summary>
    internal static WorkhorseDataSource Resolve(IServiceProvider services, string? key)
    {
        var dataSource = string.IsNullOrEmpty(key)
            ? services.GetService<NpgsqlDataSource>()
              ?? throw new InvalidOperationException(
                  "Workhorse needs an NpgsqlDataSource in the container; register one, for example with AddNpgsqlDataSource")
            : services.GetKeyedService<NpgsqlDataSource>(key)
              ?? throw new InvalidOperationException(
                  $"Workhorse:DataSourceKey names the keyed NpgsqlDataSource '{key}', but the container has none");
        return new WorkhorseDataSource(dataSource);
    }
}
