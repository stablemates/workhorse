namespace Workhorse.Hosting;

/// <summary>
/// The delegate handlers of the hosted worker, which
/// <see cref="WorkhorseServiceCollectionExtensions.AddWorkhorseWorker"/> configures.
/// </summary>
/// <remarks>
/// Each method records a registration. The hosted worker applies the registrations in order when
/// the host starts, after the handlers of
/// <see cref="WorkhorseServiceCollectionExtensions.AddWorkhorseHandler{THandler, TPayload}"/>. So
/// a delegate handler replaces a service handler of the same task type.
/// </remarks>
public sealed class WorkerHandlers
{
    private readonly List<Action<IServiceProvider, Worker>> _registrations = [];

    internal WorkerHandlers()
    {
    }

    /// <summary>Registers a handler that returns a result, as <see cref="Worker.Handle{TPayload, TResult}"/> does.</summary>
    public WorkerHandlers Handle<TPayload, TResult>(string taskType, Func<HandlerContext, TPayload, Task<TResult>> handler)
    {
        ArgumentNullException.ThrowIfNull(handler);
        return Configure((_, worker) => worker.Handle(taskType, handler));
    }

    /// <summary>Registers a handler without a result, as <see cref="Worker.Handle{TPayload}(string, Func{HandlerContext, TPayload, Task})"/> does.</summary>
    public WorkerHandlers Handle<TPayload>(string taskType, Func<HandlerContext, TPayload, Task> handler)
    {
        ArgumentNullException.ThrowIfNull(handler);
        return Configure((_, worker) => worker.Handle(taskType, handler));
    }

    /// <summary>
    /// Runs <paramref name="configure"/> on the worker when the host starts, before the worker's
    /// first run. Use it for a registration that needs a service, or for a worker event.
    /// </summary>
    public WorkerHandlers Configure(Action<IServiceProvider, Worker> configure)
    {
        ArgumentNullException.ThrowIfNull(configure);
        lock (_registrations)
        {
            _registrations.Add(configure);
        }

        return this;
    }

    internal void Apply(IServiceProvider services, Worker worker)
    {
        Action<IServiceProvider, Worker>[] registrations;
        lock (_registrations)
        {
            registrations = [.. _registrations];
        }

        foreach (var registration in registrations)
        {
            registration(services, worker);
        }
    }
}
