using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Workhorse.Hosting.Internal;

/// <summary>
/// The hosted worker (ADR 0107, "Hosting and dependency injection"). It runs
/// <see cref="Worker.RunAsync"/> until the host stops, and the worker then drains.
/// </summary>
internal sealed class WorkerService(
    IServiceProvider services,
    WorkhorseDataSource dataSource,
    IOptions<WorkerOptions> options,
    WorkerHandlers handlers,
    WorkerState state,
    ILogger<WorkerService> logger) : BackgroundService, IAsyncDisposable
{
    /// <summary>The unwind window after the shutdown grace (ADR 0107, "Shutdown").</summary>
    internal static readonly TimeSpan UnwindWindow = TimeSpan.FromMilliseconds(250);

    private Worker? _worker;

    public override async Task StartAsync(CancellationToken cancellationToken)
    {
        var settings = options.Value;
        var worker = new Worker(dataSource.Value, settings);
        try
        {
            var scopes = services.GetRequiredService<IServiceScopeFactory>();
            foreach (var registration in services.GetServices<HandlerRegistration>())
            {
                await registration.RegisterAsync(scopes, worker).ConfigureAwait(false);
            }

            handlers.Apply(services, worker);
        }
        catch
        {
            await worker.DisposeAsync().ConfigureAwait(false);
            throw;
        }

        if (HostShutdownTimeout(services) is { } timeout && timeout < settings.ShutdownGrace + UnwindWindow)
        {
            HostingLog.ShutdownTimeoutShort(logger, timeout, settings.ShutdownGrace, UnwindWindow);
        }

        _worker = worker;
        state.Started(worker);
        await base.StartAsync(cancellationToken).ConfigureAwait(false);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var worker = _worker ?? throw new InvalidOperationException("The hosted worker did not start");
        try
        {
            await worker.RunAsync(stoppingToken).ConfigureAwait(false);
        }
        catch (Exception error)
        {
            state.Faulted(error);
            HostingLog.WorkerFailed(logger, error);
            Environment.ExitCode = 1;
            throw;
        }

        if (!stoppingToken.IsCancellationRequested)
        {
            state.Ended(stopRequested: false);
            HostingLog.WorkerEnded(logger);
            Environment.ExitCode = 1;
            throw new InvalidOperationException("The hosted Workhorse worker stopped without a stop request");
        }

        state.Ended(stopRequested: true);
    }

    public async ValueTask DisposeAsync()
    {
        // Dispose cancels the stopping token first, so a host that is disposed without a stop
        // drains as a requested stop and not as a failure.
        Dispose();
        if (_worker is { } worker)
        {
            await worker.DisposeAsync().ConfigureAwait(false);
        }
    }

    /// <summary>
    /// <c>HostOptions.ShutdownTimeout</c>, or <c>null</c> without a Generic Host. <c>HostOptions</c>
    /// is in <c>Microsoft.Extensions.Hosting</c>, which this package does not take (ADR 0107,
    /// "Packages and their dependencies"), so the service reads it by name.
    /// </summary>
    internal static TimeSpan? HostShutdownTimeout(IServiceProvider services)
    {
        var type = Type.GetType("Microsoft.Extensions.Hosting.HostOptions, Microsoft.Extensions.Hosting", throwOnError: false);
        if (type is null)
        {
            return null;
        }

        var accessor = services.GetService(typeof(IOptions<>).MakeGenericType(type));
        var value = accessor?.GetType().GetProperty(nameof(IOptions<object>.Value))?.GetValue(accessor);
        return value?.GetType().GetProperty("ShutdownTimeout")?.GetValue(value) as TimeSpan?;
    }
}
