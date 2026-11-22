using Microsoft.Extensions.Logging;

namespace Workhorse.AspNetCore.Internal;

/// <summary>
/// The logger of the dashboard host. It writes to the logger of the application, and it drops a
/// record when that logger throws. Thus a logger failure never changes the answer of the dashboard.
/// The core package has the same type for the worker, the queue, and <c>Admin</c>.
/// </summary>
internal sealed class ContainedLogger(ILogger inner) : ILogger
{
    public IDisposable? BeginScope<TState>(TState state)
        where TState : notnull
    {
        try
        {
            return inner.BeginScope(state);
        }
        catch (Exception)
        {
            // A logger can throw. The request continues without the scope.
            return null;
        }
    }

    public bool IsEnabled(LogLevel logLevel)
    {
        try
        {
            return inner.IsEnabled(logLevel);
        }
        catch (Exception)
        {
            // A logger that cannot answer gets no record.
            return false;
        }
    }

    public void Log<TState>(
        LogLevel logLevel,
        EventId eventId,
        TState state,
        Exception? exception,
        Func<TState, Exception?, string> formatter)
    {
        try
        {
            inner.Log(logLevel, eventId, state, exception, formatter);
        }
        catch (Exception)
        {
            // A logger can throw. The dashboard drops the record and answers as before.
        }
    }
}
