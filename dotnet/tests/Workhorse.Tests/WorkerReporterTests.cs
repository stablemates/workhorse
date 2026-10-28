using System.Collections.Concurrent;
using System.Reflection;
using Microsoft.Extensions.Logging;
using Npgsql;
using Workhorse.Internal.Runtime;

namespace Workhorse.Tests;

/// <summary>
/// SM-1696: a reporter event handler that throws never stops the worker. SM-1726: the worker logs
/// the catalogued <c>workhorse.worker.reporter_failed</c> record, at most once in each interval.
/// </summary>
public sealed class WorkerReporterTests
{
    private static Worker UnconnectedWorker(ILoggerFactory? loggerFactory = null)
    {
        // The worker opens no connection here, so the address is never reached.
        var dataSource = NpgsqlDataSource.Create("Host=127.0.0.1;Port=1;Database=workhorse;Username=workhorse");
        return new Worker(dataSource, new WorkerOptions
        {
            Queues = ["reporters"],
            WorkerId = "reporter-worker",
            LoggerFactory = loggerFactory,
        });
    }

    private static void Raise(Worker worker, string method, Exception error) =>
        typeof(Worker).GetMethod(method, BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(worker, [error]);

    private static object Field(Worker worker, string name) =>
        typeof(Worker).GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(worker)!;

    [Theory]
    [InlineData("OnRegistrationError", "_registrationReporter", "registration_error")]
    [InlineData("OnNotificationError", "_notificationReporter", "notification_error")]
    public async Task AThrowingReporterHandlerGivesOneBoundedRecord(string method, string failuresField, string reporter)
    {
        var log = new ReporterLog();
        await using var worker = UnconnectedWorker(log);
        var calls = 0;
        EventHandler<Exception> handler = (_, _) =>
        {
            calls++;
            throw new InvalidOperationException("alert client is offline");
        };
        worker.RegistrationError += handler;
        worker.NotificationError += handler;

        Raise(worker, method, new TimeoutException("registry is offline"));
        Raise(worker, method, new TimeoutException("registry is offline"));
        Raise(worker, method, new TimeoutException("registry is offline"));

        Assert.Equal(3, calls);
        var record = Assert.Single(log.Records);
        Assert.Equal(LogLevel.Error, record.Level);
        Assert.Equal("reporter-worker", record.Values["WorkerId"]);
        Assert.Equal(reporter, record.Values["Reporter"]);
        Assert.Equal(typeof(InvalidOperationException).FullName, record.Values["ErrorType"]);
        Assert.Equal(0L, record.Values["Unreported"]);
        Assert.Null(record.Error);
        Assert.DoesNotContain("alert client is offline", record.Message, StringComparison.Ordinal);

        // After the interval, the next record states the failures that the worker did not log.
        var failures = (ReporterFailures)Field(worker, failuresField);
        failures.ReportedAt -= ReporterFailures.ReportIntervalNanos;
        Raise(worker, method, new TimeoutException("registry is offline"));

        Assert.Equal(2, log.Records.Count);
        Assert.Equal(2L, log.Records.Last().Values["Unreported"]);
    }

    [Fact]
    public async Task AThrowingLoggerDoesNotReachTheWorker()
    {
        var log = new ThrowingLog();
        await using var worker = UnconnectedWorker(log);
        worker.RegistrationError += (_, _) => throw new InvalidOperationException("alert client is offline");

        Raise(worker, "OnRegistrationError", new TimeoutException("registry is offline"));

        Assert.Equal(1, log.Attempts);
    }

    private sealed record Captured(LogLevel Level, string Message, Exception? Error, IReadOnlyDictionary<string, object?> Values);

    /// <summary>Keeps each <c>workhorse.worker.reporter_failed</c> record.</summary>
    private sealed class ReporterLog : ILoggerFactory, ILogger
    {
        internal ConcurrentQueue<Captured> Records { get; } = new();

        public ILogger CreateLogger(string categoryName) => this;

        public void AddProvider(ILoggerProvider provider)
        {
        }

        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            if (eventId.Name != "workhorse.worker.reporter_failed")
            {
                return;
            }

            var values = ((IEnumerable<KeyValuePair<string, object?>>)state!).ToDictionary(pair => pair.Key, pair => pair.Value);
            Records.Enqueue(new Captured(logLevel, formatter(state, exception), exception, values));
        }

        public void Dispose()
        {
        }
    }

    /// <summary>A logger that throws on each <c>workhorse.worker.reporter_failed</c> record.</summary>
    private sealed class ThrowingLog : ILoggerFactory, ILogger
    {
        public ILogger CreateLogger(string categoryName) => this;

        public void AddProvider(ILoggerProvider provider)
        {
        }

        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        internal int Attempts { get; private set; }

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            if (eventId.Name == "workhorse.worker.reporter_failed")
            {
                Attempts++;
                throw new InvalidOperationException("log sink is offline");
            }
        }

        public void Dispose()
        {
        }
    }
}
