using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Workhorse.Hosting.Internal;

/// <summary>
/// The logger of the hosting package. It writes to the logger of the application, and it drops a
/// record when that logger throws. Thus a logger failure never changes the startup of the host, the
/// failure that the hosted worker throws again, or the exit code. The core package has the same type
/// for the worker, the queue, and <c>Admin</c>.
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
            // A logger factory can throw. The hosting package then logs nothing.
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
            // A logger can throw. The host continues without the scope.
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
            // A logger can throw. The host drops the record, and the startup and the exit code do not change.
        }
    }
}
