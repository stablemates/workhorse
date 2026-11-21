using Npgsql;

namespace Workhorse.Examples.Start;

/// <summary>The C# tab of step 5 of the site quickstart. Quickstart.cs holds the tab of step 3.</summary>
public static class QuickstartExamples
{
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
