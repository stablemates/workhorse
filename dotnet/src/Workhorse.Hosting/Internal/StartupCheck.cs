using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Workhorse.Hosting.Internal;

/// <summary>
/// Logs one warning at startup when handlers are registered and no worker is (ADR 0107, "The
/// worker is an explicit registration").
/// </summary>
internal sealed class StartupCheck(IServiceProvider services, ILogger<StartupCheck> logger) : IHostedService
{
    public Task StartAsync(CancellationToken cancellationToken)
    {
        if (services.GetService<WorkerState>() is null && services.GetServices<HandlerRegistration>().Any())
        {
            HostingLog.HandlersWithoutWorker(logger);
        }

        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
