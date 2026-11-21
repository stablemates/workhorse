using System.Collections;
using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;

namespace Workhorse.DemoWorker;

/// <summary>
/// Writes demo log records as NDJSON, in the format of <c>typescript/demo/file-log-exporter.cjs</c>.
/// </summary>
/// <remarks>
/// The file rotates before a record would take it past the byte limit, and keeps the configured
/// count of numbered archives. A write that fails reports once to standard error and never reaches
/// the worker.
/// </remarks>
internal sealed partial class DemoLogFile
{
    internal const long DefaultMaxBytes = 10L * 1024 * 1024;
    internal const int DefaultArchives = 5;

    private readonly long _maxBytes;
    private readonly int _archives;
    private readonly IReadOnlyDictionary<string, object> _resource;
    private readonly Lock _lock = new();
    private bool _failed;

    internal DemoLogFile(string path, long maxBytes, int archives, IReadOnlyDictionary<string, object> resource)
    {
        Path = path;
        _maxBytes = maxBytes;
        _archives = archives;
        _resource = resource;
    }

    internal string Path { get; }

    /// <summary>The log file of this worker, or null when the launcher names no log directory or no service name.</summary>
    internal static DemoLogFile? FromEnvironment(Func<string, string?> environment)
    {
        var directory = environment("WORKHORSE_DEMO_LOG_DIRECTORY");
        var service = environment("WORKHORSE_DEMO_SERVICE_NAME");
        if (string.IsNullOrEmpty(directory) || string.IsNullOrEmpty(service))
        {
            return null;
        }

        var deployment = environment("WORKHORSE_DEMO_ENV");
        if (string.IsNullOrEmpty(deployment))
        {
            deployment = "development";
        }

        var maxBytes = PositiveInteger(environment, "WORKHORSE_DEMO_LOG_MAX_BYTES", DefaultMaxBytes);
        var archives = PositiveInteger(environment, "WORKHORSE_DEMO_LOG_ARCHIVES", DefaultArchives);
        var resource = new Dictionary<string, object>(StringComparer.Ordinal)
        {
            ["service.name"] = service,
            ["deployment.environment.name"] = deployment,
            ["deployment.environment"] = deployment,
            ["host.name"] = Environment.MachineName,
            ["process.pid"] = Environment.ProcessId,
            ["telemetry.sdk.language"] = "dotnet",
        };
        var path = System.IO.Path.Combine(
            System.IO.Path.GetFullPath(directory),
            SafePathSegment(deployment),
            SafePathSegment(service) + ".ndjson");
        return new DemoLogFile(path, maxBytes, (int)Math.Min(archives, int.MaxValue), resource);
    }

    internal static string SafePathSegment(string value)
    {
        var safe = UnsafePathCharacters().Replace(value, "_");
        if (safe.Length > 100)
        {
            safe = safe[..100];
        }

        return safe.Length == 0 ? "unknown" : safe;
    }

    private static long PositiveInteger(Func<string, string?> environment, string name, long fallback)
    {
        var value = environment(name);
        if (value is null)
        {
            return fallback;
        }

        return long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) && parsed >= 1
            ? parsed
            : throw new ArgumentException($"{name} must be a positive integer");
    }

    internal static string Timestamp(DateTimeOffset moment) =>
        moment.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);

    internal void Write(
        LogLevel level,
        string? eventName,
        string body,
        IEnumerable<KeyValuePair<string, object?>> attributes,
        string scope,
        DateTimeOffset time)
    {
        var (severityText, severityNumber) = level switch
        {
            LogLevel.Trace or LogLevel.Debug => ("DEBUG", 5),
            LogLevel.Information => ("INFO", 9),
            LogLevel.Warning => ("WARN", 13),
            LogLevel.Error => ("ERROR", 17),
            _ => ("FATAL", 21),
        };
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteString("timestamp", Timestamp(time));
            writer.WriteString("observedTimestamp", Timestamp(DateTimeOffset.UtcNow));
            writer.WriteString("severityText", severityText);
            writer.WriteNumber("severityNumber", severityNumber);
            if (eventName is not null)
            {
                writer.WriteString("eventName", eventName);
            }

            writer.WriteString("body", body);
            writer.WriteStartObject("attributes");
            foreach (var (key, value) in attributes)
            {
                writer.WritePropertyName(key);
                WriteValue(writer, value);
            }

            writer.WriteEndObject();
            writer.WriteStartObject("resource");
            foreach (var (key, value) in _resource)
            {
                writer.WritePropertyName(key);
                WriteValue(writer, value);
            }

            writer.WriteEndObject();
            writer.WriteStartObject("scope");
            writer.WriteString("name", scope);
            writer.WriteEndObject();
            writer.WriteEndObject();
        }

        buffer.WriteByte((byte)'\n');
        var line = buffer.ToArray();
        lock (_lock)
        {
            try
            {
                Append(line);
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                if (!_failed)
                {
                    _failed = true;
                    Console.Error.WriteLine($"Could not write the demo log file {Path}: {error.Message}");
                }
            }
        }
    }

    private static void WriteValue(Utf8JsonWriter writer, object? value)
    {
        switch (value)
        {
            case null:
                writer.WriteNullValue();
                break;
            case string text:
                writer.WriteStringValue(text);
                break;
            case bool flag:
                writer.WriteBooleanValue(flag);
                break;
            case int or long or short or byte or uint or ulong or ushort:
                writer.WriteNumberValue(Convert.ToDecimal(value, CultureInfo.InvariantCulture));
                break;
            case double or float or decimal:
                var number = Convert.ToDouble(value, CultureInfo.InvariantCulture);
                if (double.IsFinite(number))
                {
                    writer.WriteNumberValue(number);
                }
                else
                {
                    writer.WriteNullValue();
                }

                break;
            case TimeSpan span:
                writer.WriteNumberValue(span.TotalMilliseconds);
                break;
            case IDictionary map:
                writer.WriteStartObject();
                foreach (DictionaryEntry entry in map)
                {
                    writer.WritePropertyName(Convert.ToString(entry.Key, CultureInfo.InvariantCulture) ?? string.Empty);
                    WriteValue(writer, entry.Value);
                }

                writer.WriteEndObject();
                break;
            case IEnumerable<KeyValuePair<string, object?>> pairs:
                writer.WriteStartObject();
                foreach (var (key, member) in pairs)
                {
                    writer.WritePropertyName(key);
                    WriteValue(writer, member);
                }

                writer.WriteEndObject();
                break;
            case IEnumerable items:
                writer.WriteStartArray();
                foreach (var item in items)
                {
                    WriteValue(writer, item);
                }

                writer.WriteEndArray();
                break;
            default:
                writer.WriteStringValue(Convert.ToString(value, CultureInfo.InvariantCulture));
                break;
        }
    }

    private void Append(byte[] line)
    {
        var directory = System.IO.Path.GetDirectoryName(Path);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }

        var size = File.Exists(Path) ? new FileInfo(Path).Length : 0;
        if (size > 0 && size + line.Length > _maxBytes)
        {
            Rotate();
        }

        using var stream = new FileStream(Path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite);
        stream.Write(line);
    }

    private void Rotate()
    {
        File.Delete($"{Path}.{_archives}");
        for (var index = _archives - 1; index >= 1; index--)
        {
            if (File.Exists($"{Path}.{index}"))
            {
                File.Move($"{Path}.{index}", $"{Path}.{index + 1}");
            }
        }

        File.Move(Path, $"{Path}.1");
    }

    [GeneratedRegex("[^a-zA-Z0-9._-]")]
    private static partial Regex UnsafePathCharacters();
}

/// <summary>Writes each <see cref="ILogger"/> record to a <see cref="DemoLogFile"/>.</summary>
/// <remarks>
/// The <see cref="EventId"/> name of a Workhorse record is its event name. The values of its log
/// template become the attributes, without <c>{OriginalFormat}</c>.
/// </remarks>
[ProviderAlias("DemoLogFile")]
internal sealed class DemoLogFileProvider(DemoLogFile file) : ILoggerProvider
{
    public ILogger CreateLogger(string categoryName) => new DemoLogFileLogger(file, categoryName);

    public void Dispose()
    {
    }

    private sealed class DemoLogFileLogger(DemoLogFile file, string category) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => logLevel != LogLevel.None;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            if (!IsEnabled(logLevel))
            {
                return;
            }

            var attributes = new List<KeyValuePair<string, object?>>();
            if (state is IEnumerable<KeyValuePair<string, object?>> values)
            {
                attributes.AddRange(values.Where(pair => pair.Key != "{OriginalFormat}"));
            }

            if (exception is not null)
            {
                attributes.Add(new("exception.type", exception.GetType().FullName));
                attributes.Add(new("exception.message", exception.Message));
            }

            file.Write(
                logLevel,
                string.IsNullOrEmpty(eventId.Name) ? null : eventId.Name,
                formatter(state, exception),
                attributes,
                category,
                DateTimeOffset.UtcNow);
        }
    }
}
