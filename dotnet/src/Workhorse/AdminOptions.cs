using Microsoft.Extensions.Logging;

namespace Workhorse;

/// <summary>
/// The settings of an <see cref="Admin"/>. A later setting is a new property with a default that
/// keeps the current behavior.
/// </summary>
public sealed record AdminOptions
{
    /// <summary>The logger factory of the admin client. The default logs nothing.</summary>
    public ILoggerFactory? LoggerFactory { get; init; }
}
