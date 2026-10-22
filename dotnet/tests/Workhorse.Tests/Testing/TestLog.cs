using Microsoft.Extensions.Logging;

namespace Workhorse.Tests.Testing;

/// <summary>
/// Writes the worker's log events to the test output, so a failed test shows what the worker did.
/// <c>WORKHORSE_DOTNET_TEST_LOG=1</c> also writes them to standard error.
/// </summary>
internal sealed class TestLog : ILoggerFactory, ILoggerProvider, ILogger
{
    private static readonly bool ToStandardError = Environment.GetEnvironmentVariable("WORKHORSE_DOTNET_TEST_LOG") == "1";

    internal static TestLog Instance { get; } = new();

    public ILogger CreateLogger(string categoryName) => this;

    public void AddProvider(ILoggerProvider provider)
    {
    }

    public IDisposable? BeginScope<TState>(TState state)
        where TState : notnull => null;

    public bool IsEnabled(LogLevel logLevel) => true;

    public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
    {
        var line = $"{DateTime.UtcNow:HH:mm:ss.fff} {logLevel} {eventId.Name}: {formatter(state, exception)}{(exception is null ? "" : $" ({exception.GetType().Name}: {exception.Message})")}";
        TestContext.Current.TestOutputHelper?.WriteLine(line);
        if (ToStandardError)
        {
            Console.Error.WriteLine(line);
        }
    }

    public void Dispose()
    {
    }
}
