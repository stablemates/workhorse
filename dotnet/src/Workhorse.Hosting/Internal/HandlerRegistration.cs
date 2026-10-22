using Microsoft.Extensions.DependencyInjection;

namespace Workhorse.Hosting.Internal;

/// <summary>A handler service that the hosted worker registers when the host starts.</summary>
internal abstract class HandlerRegistration
{
    /// <summary>Reads the task type in a scope of its own, and registers the handler on <paramref name="worker"/>.</summary>
    internal abstract Task RegisterAsync(IServiceScopeFactory scopes, Worker worker);
}

/// <summary>
/// Registers <typeparamref name="THandler"/>. Each attempt resolves the handler in a new
/// <see cref="AsyncServiceScope"/> and disposes the scope when the handler's task completes (ADR
/// 0107, "Hosting and dependency injection", and its amendment of 2026-10-22).
/// </summary>
internal sealed class HandlerRegistration<THandler, TPayload> : HandlerRegistration
    where THandler : class, ITaskHandler<TPayload>
{
    internal override async Task RegisterAsync(IServiceScopeFactory scopes, Worker worker)
    {
        string taskType;
        var startup = scopes.CreateAsyncScope();
        await using (startup.ConfigureAwait(false))
        {
            taskType = startup.ServiceProvider.GetRequiredService<THandler>().TaskType;
        }

        worker.Handle<TPayload, object?>(taskType, async (context, payload) =>
        {
            var scope = scopes.CreateAsyncScope();
            await using (scope.ConfigureAwait(false))
            {
                var handler = scope.ServiceProvider.GetRequiredService<THandler>();
                return await handler.HandleAsync(context, payload).ConfigureAwait(false);
            }
        });
    }
}
