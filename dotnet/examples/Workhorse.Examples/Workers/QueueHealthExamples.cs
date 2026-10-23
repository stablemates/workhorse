using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Npgsql;
using Workhorse.Hosting;

namespace Workhorse.Examples.Workers;

/// <summary>The C# tabs of the site page about queue health.</summary>
public sealed class QueueHealthExamples(Queue queue)
{
    public async Task<QueueHealth> CheckHealthAsync()
    {
        // docs:start csharp-queue-health-verdict
        var health = await queue.HealthAsync();
        if (health.Snapshot.TryGetValue("status", out var status)
            && status.GetProperty("level").GetString() != "healthy")
        {
            Console.Error.WriteLine(status.GetProperty("reasons"));
        }
        // docs:end
        return health;
    }

    /// <summary>Builds a host with the <c>workhorse</c> health check, and does not run it.</summary>
    public static IHost HealthCheckHost(string[] args, NpgsqlDataSource dataSource)
    {
        var builder = Host.CreateApplicationBuilder(args);
        builder.Services.AddSingleton(dataSource);
        // docs:start csharp-queue-health-health-check
        builder.Services.AddWorkhorse(builder.Configuration);
        builder.Services.AddHealthChecks().AddWorkhorse();
        // docs:end
        return builder.Build();
    }
}
