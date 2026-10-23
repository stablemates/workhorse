namespace Workhorse.Examples.Enqueue;

/// <summary>The C# tab of the site page about task dependencies.</summary>
public sealed class TaskDependenciesExamples(Queue queue)
{
    /// <summary>Enqueues an import and a notification that waits for it, and returns the ID of the import.</summary>
    public async Task<Guid> EnqueueImportAndNotifyAsync()
    {
        // docs:start csharp-task-dependencies-enqueue
        var importId = (await queue.EnqueueAsync("contacts.import", new { source = "upload" })).TaskId;
        await queue.EnqueueAsync(
            "contacts.notify",
            new { importId },
            new EnqueueOptions
            {
                Dependencies = new Dependencies
                {
                    PrerequisiteTaskIds = [importId],
                    OnSuccess = DependencyPolicy.Release,
                    OnFailure = DependencyPolicy.Fail,
                    OnCancellation = DependencyPolicy.Cancel,
                },
            });
        // docs:end
        return importId;
    }
}
