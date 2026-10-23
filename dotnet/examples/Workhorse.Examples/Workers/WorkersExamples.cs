using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Npgsql;
using Workhorse.Hosting;

namespace Workhorse.Examples.Workers;

/// <summary>The C# tabs of the site page about workers, and guide 310.</summary>
public sealed class WorkersExamples(NpgsqlDataSource dataSource, IMailer mailer, int workerConcurrency, TimeSpan workerLease)
{
    /// <summary>Runs the worker until <paramref name="stoppingToken"/> is cancelled.</summary>
    public async Task RegisterAndRunAsync(CancellationToken stoppingToken)
    {
        // docs:start csharp-workers-register-handler
        await using var worker = new Worker(dataSource, new WorkerOptions
        {
            Queues = ["email", "billing"],
            Concurrency = workerConcurrency,
        });
        worker.Handle("email.send", (HandlerContext context, Email email) =>
            mailer.SendAsync(email, context.CancellationToken));
        await worker.RunAsync(stoppingToken);
        // docs:end
    }

    /// <summary>Builds a worker with the options of the page, and does not run it.</summary>
    public Worker WithOptions()
    {
        // docs:start csharp-workers-options
        var worker = new Worker(dataSource, new WorkerOptions
        {
            Queues = ["email", "billing"],
            Concurrency = workerConcurrency,
            Lease = workerLease,
            WorkerId = "email-worker-1",
        });
        // docs:end
        return worker;
    }

    /// <summary>Runs the worker in a Generic Host until <paramref name="stoppingToken"/> is cancelled, as SIGTERM does.</summary>
    public async Task RunHostAsync(string[] args, CancellationToken stoppingToken)
    {
        // docs:start csharp-workers-host
        var builder = Host.CreateApplicationBuilder(args);
        builder.Services.AddSingleton(dataSource);
        builder.Services.AddWorkhorse(builder.Configuration);
        builder.Services.Configure<WorkerOptions>(options =>
        {
            options.Queues = ["email", "billing"];
            options.Concurrency = workerConcurrency;
        });
        builder.Services.AddWorkhorseWorker(handlers => handlers.Handle(
            "email.send",
            (HandlerContext context, Email email) => mailer.SendAsync(email, context.CancellationToken)));
        using var host = builder.Build();
        await host.RunAsync(stoppingToken);
        // docs:end
    }

    /// <summary>Runs the scoped <see cref="SendEmailHandler"/> in a Generic Host until <paramref name="stoppingToken"/> is cancelled.</summary>
    public async Task RunScopedHandlerAsync(string[] args, CancellationToken stoppingToken)
    {
        var builder = Host.CreateApplicationBuilder(args);
        builder.Services.AddSingleton(dataSource);
        builder.Services.AddSingleton(mailer);
        builder.Services.AddWorkhorse(builder.Configuration);
        builder.Services.Configure<WorkerOptions>(options => options.Queues = ["email", "billing"]);
        // docs:start csharp-workers-scoped-handler-registration
        builder.Services.AddScoped<MailSession>();
        builder.Services.AddWorkhorseHandler<SendEmailHandler, Email>();
        builder.Services.AddWorkhorseWorker(_ => { });
        // docs:end
        using var host = builder.Build();
        await host.RunAsync(stoppingToken);
    }
}

// docs:start csharp-workers-scoped-handler
public sealed class SendEmailHandler(MailSession session) : ITaskHandler<Email>
{
    public string TaskType => "email.send";

    public async Task<object?> HandleAsync(HandlerContext context, Email payload) =>
        await session.SendAsync(payload, context.CancellationToken);
}
// docs:end
