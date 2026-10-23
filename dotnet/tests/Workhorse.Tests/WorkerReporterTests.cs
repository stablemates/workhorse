using System.Reflection;
using Npgsql;

namespace Workhorse.Tests;

/// <summary>SM-1696: a reporter event handler that throws never stops the worker.</summary>
public sealed class WorkerReporterTests
{
    private static Worker UnconnectedWorker()
    {
        // The worker opens no connection here, so the address is never reached.
        var dataSource = NpgsqlDataSource.Create("Host=127.0.0.1;Port=1;Database=workhorse;Username=workhorse");
        return new Worker(dataSource, new WorkerOptions { Queues = ["reporters"], SharedHeartbeats = true });
    }

    private static void Raise(Worker worker, string method, Exception error) =>
        typeof(Worker).GetMethod(method, BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(worker, [error]);

    [Theory]
    [InlineData("OnRegistrationError")]
    [InlineData("OnNotificationError")]
    public async Task AThrowingReporterHandlerDoesNotReachTheWorker(string method)
    {
        await using var worker = UnconnectedWorker();
        var calls = 0;
        EventHandler<Exception> reporter = (_, _) =>
        {
            calls++;
            throw new InvalidOperationException("alert client is offline");
        };
        worker.RegistrationError += reporter;
        worker.NotificationError += reporter;

        Raise(worker, method, new TimeoutException("registry is offline"));
        Raise(worker, method, new TimeoutException("registry is offline"));

        Assert.Equal(2, calls);
    }
}
