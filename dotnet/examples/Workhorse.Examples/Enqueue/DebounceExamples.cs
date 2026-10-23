namespace Workhorse.Examples.Enqueue;

/// <summary>The C# tabs of the site page about debounce.</summary>
public sealed class DebounceExamples(Queue queue)
{
    public async Task<EnqueueResult> DebounceAsync(string documentId, int revision, TimeSpan quietPeriod)
    {
        // docs:start csharp-debounce-enqueue
        var result = await queue.EnqueueAsync(
            "search.reindex",
            new { documentId, revision },
            new EnqueueOptions
            {
                Debounce = new Debounce
                {
                    Key = documentId,
                    Window = quietPeriod,
                    Schedule = DebounceSchedule.Reset,
                    Scope = "search-index",
                },
            });
        // docs:end
        return result;
    }
}
