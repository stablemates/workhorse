using Npgsql;

namespace Workhorse.Examples.Workers;

/// <summary>The C# tab of the site page about operations.</summary>
public sealed class OperationsExamples(NpgsqlDataSource dataSource)
{
    /// <summary>Lists the fleet and pauses <c>billing-worker-1</c>. Returns the fleet and the pause.</summary>
    public async Task<(IReadOnlyList<WorkerInfo> Workers, WorkerPauseResult? Result)> PauseWorkerAsync(
        OperationsActor actor, string incidentId)
    {
        // docs:start csharp-operations-pause-worker
        var admin = new Admin(dataSource);
        var workers = await admin.ListWorkersAsync();
        var result = await admin.SetWorkerPausedAsync(
            "billing-worker-1",
            paused: true,
            new AdminAudit { Actor = actor.Email, Reason = "investigating slow provider", RequestId = incidentId });
        // docs:end
        return (workers, result);
    }
}
