using Npgsql;

namespace Workhorse.Examples.Start;

/// <summary>The C# tabs of the site quickstart.</summary>
public static class QuickstartExamples
{
    // docs:start csharp-quickstart-run-task
    public sealed record WelcomeEmail(string To);

    public sealed record Delivery(string DeliveredTo);

    public static async Task<TaskDetail?> RunTaskAsync(string connectionString)
    {
        // A connection string, such as "Host=localhost;Database=app;Username=app"
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
        return task;
    }
    // docs:end

    // docs:start csharp-quickstart-enqueue-with-data
    public static async Task CreateOrderAsync(NpgsqlDataSource dataSource, Queue queue, string orderId)
    {
        await using var connection = await dataSource.OpenConnectionAsync();
        await using var transaction = await connection.BeginTransactionAsync();
        await using (var insert = new NpgsqlCommand("INSERT INTO orders (id) VALUES ($1)", connection))
        {
            insert.Parameters.AddWithValue(orderId);
            await insert.ExecuteNonQueryAsync();
        }

        await queue.Using(connection).EnqueueAsync("order.fulfill", new { orderId });
        await transaction.CommitAsync();
    }
    // docs:end
}
