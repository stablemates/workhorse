using Microsoft.Extensions.Diagnostics.HealthChecks;

namespace Workhorse.Hosting.Internal;

/// <summary>
/// The <c>workhorse</c> health check (ADR 0107, "Hosting and dependency injection"). It runs the
/// compatibility query on a new connection each time, so a cached result never hides a database
/// that became unavailable.
/// </summary>
internal sealed class WorkhorseHealthCheck(WorkhorseDataSource dataSource, Queue queue, WorkerState? state) : IHealthCheck
{
    internal const string Name = "workhorse";

    public async Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(context);
        var failure = context.Registration.FailureStatus;
        var data = new Dictionary<string, object>(StringComparer.Ordinal);
        if (state is not null)
        {
            data["state"] = state.Phase.ToString().ToLowerInvariant();
            if (state.Worker is { } worker)
            {
                data["workerId"] = worker.WorkerId;
                data["queues"] = worker.Queues;
                data["paused"] = worker.IsPaused;
            }
        }

        try
        {
            var connection = await dataSource.Value.OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
            await using (connection.ConfigureAwait(false))
            {
                await queue.Using(connection).AssertCompatibleAsync(cancellationToken).ConfigureAwait(false);
            }
        }
        catch (CompatibilityException error)
        {
            return new HealthCheckResult(failure, "The Workhorse schema is not compatible with this client", error, data);
        }
        catch (Exception error) when (!cancellationToken.IsCancellationRequested)
        {
            return new HealthCheckResult(failure, "The Workhorse database is unavailable", error, data);
        }

        return state?.Phase switch
        {
            WorkerPhase.Failed => new HealthCheckResult(failure, "The Workhorse worker stopped without a stop request", state.Failure, data),
            WorkerPhase.Abandoned => new HealthCheckResult(failure, "The Workhorse worker abandoned handlers at shutdown", state.Failure, data),
            _ => HealthCheckResult.Healthy("The Workhorse database is compatible", data),
        };
    }
}
