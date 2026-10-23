using System.Text.Json;

namespace Workhorse.Examples.Programs.Scenarios;

/// <summary>
/// Enqueues one task, runs the worker once, and prints the task's outcome.
/// </summary>
/// <remarks>Documentation: https://workhorse.run/docs/quickstart</remarks>
public static class QuickstartProgram
{
    public static async Task RunAsync()
    {
        await using var dataSource = ProgramDatabase.DataSource();
        var queue = new Queue(dataSource);
        var enqueued = await queue.EnqueueAsync("email.welcome", new { to = "ada@example.com" });

        await using (var worker = new Worker(dataSource, new WorkerOptions()))
        {
            worker.Handle(
                "email.welcome",
                (HandlerContext context, WelcomeEmail payload) => Task.FromResult(new { deliveredTo = payload.To }));
            await worker.RunOnceAsync(); // production uses worker.RunAsync(stoppingToken)
        }

        var task = await new Admin(dataSource).GetTaskAsync(enqueued.TaskId)
            ?? throw new InvalidOperationException($"task {enqueued.TaskId} does not exist");
        Console.WriteLine($"{task.State.ToString().ToLowerInvariant()} {JsonSerializer.Serialize(task.Result)}");
    }

    /// <summary>The payload of <c>email.welcome</c>.</summary>
    public sealed record WelcomeEmail(string To);
}
