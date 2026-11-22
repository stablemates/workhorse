using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Workhorse.Internal.Telemetry;

/// <summary>
/// The logger of the SDK. It writes to the logger of the application, and it drops a record when
/// that logger throws. Thus a logger failure never changes the result of a queue, admin, dashboard,
/// or worker operation, and it never stops a handler. Each SDK logger comes from <see cref="Create"/>.
/// </summary>
internal sealed class ContainedLogger : ILogger
{
    private readonly ILogger _inner;

    private ContainedLogger(ILogger inner) => _inner = inner;

    /// <summary>
    /// The logger of <typeparamref name="T"/> from <paramref name="factory"/>. A missing factory, or a
    /// factory that throws, gives a logger that writes nothing.
    /// </summary>
    internal static ILogger Create<T>(ILoggerFactory? factory)
    {
        if (factory is null)
        {
            return NullLogger.Instance;
        }

        try
        {
            return new ContainedLogger(factory.CreateLogger<T>());
        }
        catch (Exception)
        {
            // A logger factory can throw. The SDK then logs nothing.
            return NullLogger.Instance;
        }
    }

    public IDisposable? BeginScope<TState>(TState state)
        where TState : notnull
    {
        try
        {
            return _inner.BeginScope(state);
        }
        catch (Exception)
        {
            // A logger can throw. The operation continues without the scope.
            return null;
        }
    }

    public bool IsEnabled(LogLevel logLevel)
    {
        try
        {
            return _inner.IsEnabled(logLevel);
        }
        catch (Exception)
        {
            // A logger that cannot answer gets no record.
            return false;
        }
    }

    public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
    {
        try
        {
            _inner.Log(logLevel, eventId, state, exception, formatter);
        }
        catch (Exception)
        {
            // A logger can throw. The SDK drops the record, and the operation keeps its result.
        }
    }
}
