using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Workhorse.Hosting.Internal;

namespace Workhorse.Hosting;

/// <summary>
/// Registers Workhorse in a Generic Host application (ADR 0107, "Hosting and dependency injection").
/// </summary>
public static class WorkhorseServiceCollectionExtensions
{
    /// <summary>The configuration section that <see cref="AddWorkhorse(IServiceCollection, IConfiguration)"/> reads.</summary>
    private const string Section = "Workhorse";

    /// <summary>
    /// Registers <see cref="Queue"/> and <see cref="Admin"/> singletons on an <c>NpgsqlDataSource</c>
    /// from the container, and binds <see cref="QueueOptions"/> and <see cref="WorkerOptions"/> from
    /// the <c>Workhorse</c> section of <paramref name="configuration"/>.
    /// </summary>
    /// <remarks>
    /// <c>Workhorse:DataSourceKey</c> selects a keyed data source. Without it, the package resolves
    /// the data source that has no key. A <see cref="Queue"/> or <see cref="Admin"/> that the
    /// application registers first stays. This method registers no worker: see
    /// <see cref="AddWorkhorseWorker"/>. If handlers are registered and no worker is, the host logs
    /// one warning at startup.
    /// </remarks>
    /// <param name="services">The service collection.</param>
    /// <param name="configuration">The application configuration. The method reads its <c>Workhorse</c> section.</param>
    /// <exception cref="InvalidOperationException">The configuration sets the removed key <c>Workhorse:Worker:SharedHeartbeats</c>.</exception>
    public static IServiceCollection AddWorkhorse(this IServiceCollection services, IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(configuration);
        if (services.Any(descriptor => descriptor.ServiceType == typeof(WorkhorseDataSource)))
        {
            return services;
        }

        var section = configuration.GetSection(Section);
        // The removed key fails the registration, also in a process that never reads the worker options.
        WorkerConfiguration.RefuseRemovedKeys(section.GetSection("Worker"));
        services.AddOptions();
        services.AddOptions<QueueOptions>().Bind(section.GetSection("Queue"));
        services.AddOptions<WorkerOptions>()
            .Configure(options => WorkerConfiguration.Bind(section.GetSection("Worker"), options))
            .PostConfigure<IServiceProvider>((options, provider) => options.LoggerFactory ??= provider.GetService<ILoggerFactory>());
        services.AddSingleton(provider => WorkhorseDataSource.Resolve(provider, section["DataSourceKey"]));
        services.TryAddSingleton(provider =>
            new Queue(provider.GetRequiredService<WorkhorseDataSource>().Value, provider.GetRequiredService<IOptions<QueueOptions>>().Value));
        services.TryAddSingleton(provider => new Admin(provider.GetRequiredService<WorkhorseDataSource>().Value));
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IHostedService, StartupCheck>());
        return services;
    }

    /// <summary>
    /// Registers the hosted worker. A process that does not call this method runs no worker.
    /// </summary>
    /// <remarks>
    /// The worker runs <see cref="Worker.RunAsync"/> until the host stops, and then drains within
    /// <see cref="WorkerOptions.ShutdownGrace"/>. It handles each <see cref="ITaskHandler{TPayload}"/>
    /// that <see cref="AddWorkhorseHandler{THandler, TPayload}"/> registers, and the handlers of
    /// <paramref name="configure"/>. A later call adds to the handlers of an earlier call.
    /// </remarks>
    /// <param name="services">The service collection. <see cref="AddWorkhorse(IServiceCollection, IConfiguration)"/> must come first.</param>
    /// <param name="configure">Registers delegate handlers on the worker.</param>
    /// <exception cref="InvalidOperationException"><see cref="AddWorkhorse(IServiceCollection, IConfiguration)"/> was not called first.</exception>
    public static IServiceCollection AddWorkhorseWorker(this IServiceCollection services, Action<WorkerHandlers> configure)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(configure);
        if (!services.Any(descriptor => descriptor.ServiceType == typeof(WorkhorseDataSource)))
        {
            throw new InvalidOperationException("Call AddWorkhorse before AddWorkhorseWorker");
        }

        var handlers = services
            .Where(descriptor => descriptor.ServiceType == typeof(WorkerHandlers))
            .Select(descriptor => descriptor.ImplementationInstance)
            .OfType<WorkerHandlers>()
            .FirstOrDefault();
        if (handlers is null)
        {
            handlers = new WorkerHandlers();
            services.AddSingleton(handlers);
            services.AddSingleton<WorkerState>();
            services.AddSingleton<WorkerService>();
            services.AddSingleton<IHostedService>(provider => provider.GetRequiredService<WorkerService>());
        }

        configure(handlers);
        return services;
    }

    /// <summary>
    /// Registers <typeparamref name="THandler"/> as a scoped service, and as a handler of the hosted
    /// worker.
    /// </summary>
    /// <remarks>
    /// For each attempt, the worker creates an <see cref="AsyncServiceScope"/>, resolves the handler
    /// in it, and disposes the scope when the handler's task completes. So a handler can take a
    /// scoped service, for example a <c>DbContext</c>. At startup the worker resolves the handler
    /// once in its own scope to read <see cref="ITaskHandler{TPayload}.TaskType"/>. A lifetime that
    /// the application registers for <typeparamref name="THandler"/> first stays.
    /// </remarks>
    public static IServiceCollection AddWorkhorseHandler<THandler, TPayload>(this IServiceCollection services)
        where THandler : class, ITaskHandler<TPayload>
    {
        ArgumentNullException.ThrowIfNull(services);
        services.TryAddScoped<THandler>();
        services.TryAddEnumerable(ServiceDescriptor.Singleton<HandlerRegistration, HandlerRegistration<THandler, TPayload>>());
        return services;
    }

    /// <summary>
    /// Adds the <c>workhorse</c> health check. It runs the compatibility query on a new connection,
    /// and reports the registration's failure status, <c>Unhealthy</c> by default, when the database
    /// is unavailable or the schema is not compatible. When the process runs a worker, it also
    /// reports that status after the worker stopped without a stop request or abandoned a handler.
    /// </summary>
    /// <param name="builder">The health checks builder.</param>
    public static IHealthChecksBuilder AddWorkhorse(this IHealthChecksBuilder builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        return builder.Add(new HealthCheckRegistration(
            WorkhorseHealthCheck.Name,
            provider => new WorkhorseHealthCheck(
                provider.GetRequiredService<WorkhorseDataSource>(),
                provider.GetRequiredService<Queue>(),
                provider.GetService<WorkerState>()),
            failureStatus: null,
            tags: null));
    }
}
