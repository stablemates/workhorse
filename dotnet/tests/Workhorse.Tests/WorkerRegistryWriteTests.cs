using System.Reflection;
using Npgsql;

namespace Workhorse.Tests;

/// <summary>
/// SM-1855: a registry write waits for the write before it, but does not keep it. SM-1846 found that
/// each JVM registry write kept the write before it, so a busy worker filled its heap. The .NET write
/// captures the earlier task in the same shape. Thus an early write must be collectable after later
/// writes end.
/// </summary>
public sealed class WorkerRegistryWriteTests
{
    /// <summary>The full collections before the test decides that a later write keeps the early write.</summary>
    private const int Collections = 50;

    private static Worker UnconnectedWorker()
    {
        // The worker opens no connection here, so the address is never reached.
        var dataSource = NpgsqlDataSource.Create("Host=127.0.0.1;Port=1;Database=workhorse;Username=workhorse");
        return new Worker(dataSource, new WorkerOptions { Queues = ["registry"] });
    }

    private static Task RegistryStep(Worker worker, Func<Task> body) =>
        (Task)typeof(Worker).GetMethod("RegistryStep", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(worker, [body])!;

    /// <summary>
    /// Runs one write to its end and gives only a weak reference to it. The strong reference ends with
    /// this method, so no local of the caller keeps the write.
    /// </summary>
    private static async Task<WeakReference> EndedWeakWrite(Worker worker, Func<Task> body)
    {
        var write = RegistryStep(worker, body);
        await write.ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
        return new WeakReference(write);
    }

    [Fact]
    public async Task ARegistryWriteDoesNotKeepTheWritesBeforeIt()
    {
        await using var worker = UnconnectedWorker();
        var early = await EndedWeakWrite(worker, () => Task.FromException(new NpgsqlException("registry write failed")));

        // The first later write captures the early write. Each write ends before the next one starts.
        for (var write = 0; write < 6; write++)
        {
            Func<Task> body = write % 2 == 0
                ? () => Task.CompletedTask
                : () => Task.FromException(new NpgsqlException("registry write failed"));
            await RegistryStep(worker, body).ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing | ConfigureAwaitOptions.ContinueOnCapturedContext);
        }

        // A thread that ended the early write can still be on its way back to the pool. The yield lets
        // it return. A later write that keeps the early write keeps it after every collection.
        for (var collection = 0; collection < Collections && early.IsAlive; collection++)
        {
            await Task.Yield();
            GC.Collect();
            GC.WaitForPendingFinalizers();
            GC.Collect();
        }

        Assert.False(early.IsAlive, "a later registry write keeps the early write");
    }
}
