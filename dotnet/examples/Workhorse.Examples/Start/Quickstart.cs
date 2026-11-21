// The C# tab of step 3 of the site quickstart. The region is a whole program: a reader pastes it
// into the Program.cs of `dotnet new console`, and StartPagesExamplesTests runs its Main method.
// docs:start csharp-quickstart-run-task
using Npgsql;
using Workhorse;

namespace Quickstart;

public static class Program
{
    public static async Task Main()
    {
        // An Npgsql connection string, such as "Host=localhost;Database=app;Username=app;Password=secret"
        var connectionString = Environment.GetEnvironmentVariable("ConnectionStrings__Workhorse")
            ?? throw new InvalidOperationException("set ConnectionStrings__Workhorse");
        await using var dataSource = NpgsqlDataSource.Create(connectionString);
        var queue = new Queue(dataSource);
        var enqueued = await queue.EnqueueAsync("email.welcome", new WelcomeEmail("ada@example.com"));

        await using (var worker = new Worker(dataSource, new WorkerOptions { Queues = ["default"] }))
        {
            worker.Handle<WelcomeEmail, Delivery>(
                "email.welcome",
                (context, payload) => Task.FromResult(new Delivery(payload.To)));
            await worker.RunOnceAsync(); // one claim-and-run pass; production calls RunAsync(stoppingToken)
        }

        var task = await new Admin(dataSource).GetTaskAsync(enqueued.TaskId);
        Console.WriteLine($"{task?.State} {task?.Result}");
    }
}

public sealed record WelcomeEmail(string To);

public sealed record Delivery(string DeliveredTo);
// docs:end
