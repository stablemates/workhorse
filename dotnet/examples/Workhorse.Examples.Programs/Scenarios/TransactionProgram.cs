namespace Workhorse.Examples.Programs.Scenarios;

/// <summary>
/// Enqueues a task inside a caller-owned transaction, so it exists only if the caller commits.
/// </summary>
/// <remarks>Documentation: https://workhorse.run/docs/enqueue</remarks>
public static class TransactionProgram
{
    public static async Task RunAsync()
    {
        await using var dataSource = ProgramDatabase.DataSource();
        var queue = new Queue(dataSource, new QueueOptions { DefaultQueue = "orders" });
        var options = new EnqueueOptions
        {
            MaxAttempts = 3,
            RetryPolicy = RetryPolicy.Exponential(
                initialDelay: TimeSpan.FromSeconds(1),
                multiplier: 2,
                maxDelay: TimeSpan.FromSeconds(60)),
        };

        await using var connection = await dataSource.OpenConnectionAsync();
        await using var transaction = await connection.BeginTransactionAsync();
        // Application writes can use the connection here. The task becomes visible only if the
        // caller commits the same transaction. Disposing the transaction without a commit rolls
        // it back.
        var result = await queue.Using(connection).EnqueueAsync(
            "order.accepted",
            new { orderId = "order-42" },
            options);
        await transaction.CommitAsync();
        Console.WriteLine(result.TaskId);
    }
}
