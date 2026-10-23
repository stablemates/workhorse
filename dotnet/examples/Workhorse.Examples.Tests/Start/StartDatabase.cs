using Npgsql;
using Workhorse.Examples.Tests.Testing;
using Workhorse.Tests.Testing;

namespace Workhorse.Examples.Tests.Start;

/// <summary>Prepares the databases of the snippet tests of the start pages.</summary>
internal static class StartDatabase
{
    /// <summary>
    /// The connection string of <paramref name="database"/>, with its password. Npgsql removes the
    /// password from <c>NpgsqlDataSource.ConnectionString</c>, so the test asks the scratch fixture.
    /// </summary>
    public static async Task<string> ConnectionStringAsync(ScratchDatabase scratch, ExampleDatabase database)
    {
        var name = new NpgsqlConnectionStringBuilder(database.DataSource.ConnectionString).Database;
        string? connectionString = null;
        await using (scratch.CreateDataSource(builder =>
        {
            builder.Database = name;
            connectionString = builder.ConnectionString;
        }))
        {
        }

        return connectionString!;
    }

    /// <summary>The number of rows of <c>orders</c> with <paramref name="orderId"/>.</summary>
    public static Task<long> OrdersAsync(ExampleDatabase database, string orderId) =>
        database.ScalarAsync<long>("SELECT count(*) FROM orders WHERE id = $1", orderId);

    /// <summary>A worker on <paramref name="queues"/> that polls often, so a short wait ends soon.</summary>
    public static Worker Worker(ExampleDatabase database, params string[] queues) =>
        new(database.DataSource, new WorkerOptions
        {
            Queues = queues,
            Concurrency = 4,
            PollInterval = TimeSpan.FromMilliseconds(100),
        });

    /// <summary>Starts <paramref name="worker"/>, runs <paramref name="body"/>, and then stops the worker.</summary>
    public static async Task RunAsync(Worker worker, Func<Task> body)
    {
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
        var run = worker.RunAsync(stop.Token);
        try
        {
            await body();
        }
        finally
        {
            await stop.CancelAsync();
            await run;
        }
    }
}
