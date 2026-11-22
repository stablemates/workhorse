using System.Collections.Concurrent;
using System.Diagnostics;
using Microsoft.Extensions.Logging;

namespace Workhorse.Tests.Testing;

/// <summary>
/// A logger factory whose loggers keep each record with its event name, its level, its named
/// template values, and the name of the activity that was current where the SDK wrote it. A test
/// reads the records of one event with <see cref="Of"/>.
/// </summary>
internal sealed class LogRecorder : ILoggerFactory, ILogger
{
    private readonly ConcurrentQueue<LogRecord> _records = new();

    /// <summary>The records of <paramref name="eventName"/>, in the order that they were written.</summary>
    internal List<LogRecord> Of(string eventName) => [.. _records.Where(record => record.Event == eventName)];

    /// <summary>The single record of <paramref name="eventName"/> that <paramref name="match"/> selects.</summary>
    internal LogRecord Single(string eventName, Func<LogRecord, bool>? match = null)
    {
        List<LogRecord> selected = [.. _records.Where(record => record.Event == eventName && (match is null || match(record)))];
        return Assert.Single(selected);
    }

    public ILogger CreateLogger(string categoryName) => this;

    public void AddProvider(ILoggerProvider provider)
    {
    }

    public void Dispose()
    {
    }

    public IDisposable? BeginScope<TState>(TState state)
        where TState : notnull => null;

    public bool IsEnabled(LogLevel logLevel) => true;

    public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
    {
        var values = state is IEnumerable<KeyValuePair<string, object?>> pairs
            ? pairs.Where(pair => pair.Key != "{OriginalFormat}").ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal)
            : new Dictionary<string, object?>(StringComparer.Ordinal);
        _records.Enqueue(new LogRecord(logLevel, eventId.Name, values, exception, Activity.Current?.OperationName));
    }
}

/// <summary>
/// One log record: its level, its event name, its named template values, its exception, and the
/// name of the current activity.
/// </summary>
internal sealed record LogRecord(LogLevel Level, string? Event, IReadOnlyDictionary<string, object?> Values, Exception? Exception, string? Span)
{
    /// <summary>The value of the template name <paramref name="key"/>.</summary>
    internal object? this[string key] => Values.TryGetValue(key, out var value) ? value : throw new KeyNotFoundException($"{Event} has no value {key}");
}
