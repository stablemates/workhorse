using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace Workhorse;

/// <summary>The settings of a <see cref="Queue"/>.</summary>
public sealed record QueueOptions
{
    /// <summary>The queue of a request that names none. The default is <c>default</c>.</summary>
    public string DefaultQueue { get; init; } = "default";

    /// <summary>
    /// The JSON options for payloads and results, or <c>null</c> for
    /// <see cref="JsonSerializerDefaults.Web"/> with strict number handling (ADR 0107).
    /// </summary>
    public JsonSerializerOptions? Json { get; init; }

    /// <summary>The logger factory of the queue. The default logs nothing.</summary>
    public ILoggerFactory? LoggerFactory { get; init; }
}
