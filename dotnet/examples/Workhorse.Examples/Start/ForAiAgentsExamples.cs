using Npgsql;

namespace Workhorse.Examples.Start;

/// <summary>The C# tab of the site page for AI agents.</summary>
public static class ForAiAgentsExamples
{
    // docs:start csharp-for-ai-agents-integrate
    public sealed record OrderCreated(string OrderId);

    public sealed record OrderProcessed(string ProcessedOrderId, string Receipt);

    public static Task<string> SendConfirmationEmailAsync(string orderId) =>
        Task.FromResult($"receipt-for-{orderId}");

    public static async Task<TaskDetail?> IntegrateAsync(string connectionString)
    {
        // A connection string, such as "Host=localhost;Database=app;Username=app"
        await using var dataSource = NpgsqlDataSource.Create(connectionString);
        var queue = new Queue(dataSource);

        Guid taskId;
        await using (var connection = await dataSource.OpenConnectionAsync())
        await using (var transaction = await connection.BeginTransactionAsync())
        {
            await using (var insert = new NpgsqlCommand(
                "INSERT INTO orders (id, status) VALUES ($1, $2)", connection))
            {
                insert.Parameters.AddWithValue("order-42");
                insert.Parameters.AddWithValue("new");
                await insert.ExecuteNonQueryAsync();
            }

            var enqueued = await queue.Using(connection).EnqueueAsync(
                "order.created",
                new OrderCreated("order-42"),
                new EnqueueOptions
                {
                    MaxAttempts = 5,
                    RetryPolicy = RetryPolicy.Fixed(TimeSpan.FromSeconds(1)),
                });
            taskId = enqueued.TaskId;
            await transaction.CommitAsync();
        }

        await using (var worker = new Worker(dataSource, new WorkerOptions { PollingOnly = true }))
        {
            worker.Handle<OrderCreated, OrderProcessed>("order.created", async (context, order) =>
            {
                // After Workhorse saves the receipt, a replay reuses it and skips the send.
                var receipt = await context.CheckpointAsync(
                    "confirmation-email",
                    _ => SendConfirmationEmailAsync(order.OrderId));
                return new OrderProcessed(order.OrderId, receipt);
            });
            await worker.RunOnceAsync(); // Production workers call RunAsync(stoppingToken).
        }

        var task = await new Admin(dataSource).GetTaskAsync(taskId);
        Console.WriteLine($"{task?.State} {task?.Result}");
        return task;
    }
    // docs:end
}
