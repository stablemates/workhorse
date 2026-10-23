using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Npgsql;
using Workhorse.Hosting;

namespace Workhorse.Examples.Readme;

/// <summary>The C# fences of dotnet/README.md.</summary>
public static class ReadmeExamples
{
    public static async Task<Guid> RunOneTaskAsync(NpgsqlDataSource dataSource)
    {
        // docs:start csharp-readme-run-one-task
        var queue = new Queue(dataSource, new QueueOptions { DefaultQueue = "readme" });
        var enqueued = await queue.EnqueueAsync("readme.echo", new { packaged = true });

        await using var worker = new Worker(
            dataSource,
            new WorkerOptions { Queues = ["readme"], DisableRegistry = true });
        worker.Handle(
            "readme.echo",
            (HandlerContext context, JsonElement payload) => Task.FromResult(new { echo = payload }));
        if (!await worker.RunOnceAsync())
        {
            throw new InvalidOperationException("the worker ran no handler");
        }
        // docs:end

        return enqueued.TaskId;
    }

    public static async Task RunWorkerHostAsync(string[] args, NpgsqlDataSource dataSource, CancellationToken stoppingToken)
    {
        // docs:start csharp-readme-hosting
        var builder = Host.CreateApplicationBuilder(args);
        builder.Services.AddSingleton(dataSource);
        builder.Services.AddWorkhorse(builder.Configuration);
        builder.Services.AddWorkhorseWorker(handlers => handlers.Handle(
            "readme.echo",
            (HandlerContext context, JsonElement payload) => Task.FromResult(new { echo = payload })));
        await builder.Build().RunAsync(stoppingToken);
        // docs:end
    }
}
