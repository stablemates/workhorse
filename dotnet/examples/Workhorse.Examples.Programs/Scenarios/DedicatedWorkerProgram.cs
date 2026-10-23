using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Workhorse.Hosting;

namespace Workhorse.Examples.Programs.Scenarios;

/// <summary>
/// Runs a dedicated worker process in a Generic Host until SIGINT or SIGTERM, then drains its
/// active tasks.
/// </summary>
/// <remarks>Documentation: https://workhorse.run/docs/worker-processes</remarks>
public static class DedicatedWorkerProgram
{
    public static async Task RunAsync(string[] args)
    {
        var builder = Host.CreateApplicationBuilder(args);
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Workhorse:Worker:Queues:0"] = "orders",
            ["Workhorse:Worker:WorkerId"] = "orders-worker",
            ["Workhorse:Worker:Concurrency"] = "8",
            ["Workhorse:Worker:ShutdownGrace"] = "00:00:20",
        });
        builder.Services.AddSingleton(_ => ProgramDatabase.DataSource());
        builder.Services.AddWorkhorse(builder.Configuration);
        builder.Services.AddWorkhorseWorker(handlers => handlers.Handle(
            "order.accepted",
            (HandlerContext context, JsonElement payload) =>
            {
                context.CancellationToken.ThrowIfCancellationRequested();
                return Task.FromResult(new { payload, prepared = true });
            }));

        // The host stops on SIGINT or SIGTERM, and the worker drains within ShutdownGrace.
        await builder.Build().RunAsync();
    }
}
