using System.Text;
using Workhorse.Examples.Tests.Testing;

namespace Workhorse.Examples.Tests.Landing;

/// <summary>Runs a worker or a snippet until a condition holds, and captures standard output.</summary>
internal static class LandingSupport
{
    private static readonly SemaphoreSlim ConsoleLock = new(1, 1);

    /// <summary>
    /// Starts <paramref name="run"/> with a stop token, waits until <paramref name="condition"/>
    /// holds, then stops the run and waits for its end.
    /// </summary>
    public static async Task RunUntilAsync(
        Func<CancellationToken, Task> run, Func<Task<bool>> condition, string what, CancellationToken token)
    {
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(token);
        var running = Task.Run(() => run(stop.Token), CancellationToken.None);
        try
        {
            await ExampleDatabase.EventuallyAsync(
                async () =>
                {
                    if (running.IsCompleted)
                    {
                        await running;
                        throw new InvalidOperationException($"the run ended before {what}");
                    }

                    return await condition();
                },
                what);
        }
        finally
        {
            await stop.CancelAsync();
            await running.WaitAsync(ExampleDatabase.Patience, CancellationToken.None);
        }
    }

    /// <summary>Runs <paramref name="worker"/> until <paramref name="condition"/> holds.</summary>
    public static Task RunUntilAsync(Worker worker, Func<Task<bool>> condition, string what, CancellationToken token) =>
        RunUntilAsync(worker.RunAsync, condition, what, token);

    /// <summary>Runs <paramref name="worker"/> until the task reaches <paramref name="state"/>.</summary>
    public static Task RunUntilAsync(Worker worker, ExampleDatabase db, Guid taskId, TaskState state, CancellationToken token) =>
        RunUntilAsync(worker, async () => (await db.DetailAsync(taskId)).State == state, $"task {taskId} is {state}", token);

    /// <summary>The lines that <paramref name="action"/> writes to standard output.</summary>
    public static async Task<IReadOnlyList<string>> StandardOutputAsync(Func<Task> action)
    {
        await ConsoleLock.WaitAsync();
        var previous = Console.Out;
        var captured = new StringWriter(new StringBuilder());
        try
        {
            Console.SetOut(captured);
            await action();
        }
        finally
        {
            Console.SetOut(previous);
            ConsoleLock.Release();
        }

        return captured.ToString().Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    }
}
