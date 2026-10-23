using Npgsql;

namespace Workhorse.Examples.Enqueue;

/// <summary>The C# tabs of the site page about schedules.</summary>
public sealed class SchedulesExamples(Queue queue, NpgsqlDataSource dataSource)
{
    public async Task SyncSchedulesAsync(string nightlyCron)
    {
        // docs:start csharp-schedules-sync
        var task = new ScheduledTask
        {
            TaskType = "invoice.generate",
            Payload = new { scope = "due" },
            Queue = "billing",
        };
        await queue.SyncSchedulesAsync(
            "billing-production",
            [
                new ScheduleDefinition
                {
                    Name = "invoice-run",
                    Schedule = nightlyCron,
                    Task = task,
                    Timezone = "America/New_York",
                    CatchupPolicy = CatchupPolicy.Skip,
                },
            ]);
        // docs:end
    }

    public Worker ScheduleWorker()
    {
        // docs:start csharp-schedules-namespaces
        var worker = new Worker(
            dataSource,
            new WorkerOptions { ScheduleNamespaces = ["billing-production"] });
        // docs:end
        return worker;
    }
}
