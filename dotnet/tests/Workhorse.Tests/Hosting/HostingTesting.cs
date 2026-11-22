using System.Collections.Concurrent;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Npgsql;
using Workhorse.Hosting;
using Workhorse.Tests.Testing;

namespace Workhorse.Tests.Hosting;

/// <summary>Builds a Generic Host with Workhorse for one test, and captures its log events.</summary>
internal sealed class HostingTesting
{
    internal HostingTesting(NpgsqlDataSource dataSource, string queue, IDictionary<string, string?>? settings = null)
    {
        Queue = queue;
        Builder = Host.CreateEmptyApplicationBuilder(new HostApplicationBuilderSettings());
        var configuration = new Dictionary<string, string?>(StringComparer.Ordinal)
        {
            ["Workhorse:Queue:DefaultQueue"] = queue,
            ["Workhorse:Worker:Queues:0"] = queue,
            ["Workhorse:Worker:WorkerId"] = $"dotnet-hosting-{Guid.NewGuid():N}",
            ["Workhorse:Worker:PollInterval"] = "00:00:00.050",
            ["Workhorse:Worker:ShutdownGrace"] = "00:00:05",
        };
        foreach (var (key, value) in settings ?? new Dictionary<string, string?>())
        {
            configuration[key] = value;
        }

        Builder.Configuration.AddInMemoryCollection(configuration);
        Builder.Logging.SetMinimumLevel(LogLevel.Trace);
        Builder.Logging.AddProvider(Log);
        Builder.Services.AddSingleton(dataSource);
        Builder.Services.AddWorkhorse(Builder.Configuration);
    }

    internal HostApplicationBuilder Builder { get; }

    internal IServiceCollection Services => Builder.Services;

    internal string Queue { get; }

    internal CapturedLog Log { get; } = new();

    internal IHost Build() => Builder.Build();

    /// <summary>
    /// Adds a log provider that throws for each logger of the hosting package. With
    /// <paramref name="atCreate"/>, the provider throws when the host creates the logger. Otherwise
    /// it throws when the host writes a record.
    /// </summary>
    internal void ThrowFromHostingLoggers(bool atCreate) => Builder.Logging.AddProvider(new ThrowingHostingLog(atCreate));
}

/// <summary>A log provider that throws for each category of <c>Workhorse.Hosting</c>.</summary>
internal sealed class ThrowingHostingLog(bool atCreate) : ILoggerProvider
{
    public ILogger CreateLogger(string categoryName)
    {
        if (!categoryName.StartsWith("Workhorse.Hosting", StringComparison.Ordinal))
        {
            return Microsoft.Extensions.Logging.Abstractions.NullLogger.Instance;
        }

        return atCreate ? throw new InvalidOperationException("the logger factory failed") : new Logger();
    }

    public void Dispose()
    {
    }

    private sealed class Logger : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull => throw new InvalidOperationException("the logger failed");

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter) =>
            throw new InvalidOperationException("the logger failed");
    }
}

/// <summary>A log provider that keeps each event, and copies it to the test output.</summary>
internal sealed class CapturedLog : ILoggerProvider
{
    private readonly ConcurrentQueue<(LogLevel Level, string? Event, string Message)> _events = new();

    internal IReadOnlyList<(LogLevel Level, string? Event, string Message)> Events => [.. _events];

    internal int Count(string eventName) => _events.Count(entry => entry.Event == eventName);

    public ILogger CreateLogger(string categoryName) => new Logger(this);

    public void Dispose()
    {
    }

    private sealed class Logger(CapturedLog owner) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            owner._events.Enqueue((logLevel, eventId.Name, formatter(state, exception)));
            TestLog.Instance.Log(logLevel, eventId, state, exception, formatter);
        }
    }
}

/// <summary>Saves <see cref="Environment.ExitCode"/>, and restores it, so a test that sets it leaves the run's code alone.</summary>
internal sealed class ExitCodeGuard : IDisposable
{
    private readonly int _saved = Environment.ExitCode;

    public void Dispose() => Environment.ExitCode = _saved;
}
