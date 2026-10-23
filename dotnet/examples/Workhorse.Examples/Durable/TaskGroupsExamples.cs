using Npgsql;

namespace Workhorse.Examples.Durable;

/// <summary>The uploaded file that the snippets of the site page about task groups import.</summary>
public sealed record ImportFile(IReadOnlyList<string> Rows);

/// <summary>The payload of the <c>imports.report</c> callback.</summary>
public sealed record ImportReport(string ImportId);

/// <summary>Sends the report of one import, for the snippets of the site page about task groups.</summary>
public interface IImportReporter
{
    /// <summary>Sends the counts of the import <paramref name="importId"/>.</summary>
    Task SendAsync(string importId, long succeeded, long failed);
}

/// <summary>The C# tabs of the site page about task groups.</summary>
public sealed class TaskGroupsExamples(NpgsqlDataSource dataSource, Queue queue, IImportReporter reporter)
{
    /// <summary>Creates and seals a group with one task for each row of the file.</summary>
    public async Task<TaskGroup> ImportRowsAsync(ImportFile file)
    {
        ArgumentNullException.ThrowIfNull(file);
        // docs:start csharp-task-groups-create
        var imports = new EnqueueOptions { Queue = "imports" };
        var report = new EnqueueRequest
        {
            TaskType = "imports.report",
            Payload = new { importId = "imp-7" },
            Options = imports,
        };

        var created = await queue.TaskGroupAsync(
            new TaskGroupCallbacks { OnFinish = report },
            builder =>
            {
                foreach (var row in file.Rows)
                {
                    builder.Add("imports.row", new { importId = "imp-7", row }, imports);
                }
            });
        var group = created.Group;
        // docs:end
        return group;
    }

    /// <summary>Builds a worker that sends the report of a group, and does not run it.</summary>
    public Worker ReportWorker()
    {
        // docs:start csharp-task-groups-read-counts
        var worker = new Worker(dataSource, new WorkerOptions { Queues = ["imports"] });
        worker.Handle<ImportReport, object>(
            "imports.report",
            async (context, report) =>
            {
                var link = await context.TaskGroup.GetAsync();
                var counts = link!.Group.Counts;
                await reporter.SendAsync(report.ImportId, counts.Succeeded, counts.Failed);
                return new { sent = true };
            });
        // docs:end
        return worker;
    }
}
