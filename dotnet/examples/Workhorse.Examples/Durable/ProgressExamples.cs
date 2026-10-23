namespace Workhorse.Examples.Durable;

/// <summary>The payload of the <c>import.rows</c> task.</summary>
public sealed record ImportRowsPayload(string Source);

/// <summary>The file import of the site page about progress.</summary>
public interface IProgressImporter
{
    /// <summary>Reads the rows of <paramref name="source"/> in batches.</summary>
    Task<IReadOnlyList<IReadOnlyList<string>>> ReadBatchesAsync(string source);

    /// <summary>Imports one batch of rows.</summary>
    Task ImportBatchAsync(IReadOnlyList<string> batch);
}

/// <summary>The C# tab of the site page about progress.</summary>
public sealed class ProgressExamples(IProgressImporter importer)
{
    /// <summary>The handler of the import task. It returns the number of imported rows.</summary>
    public async Task<object> ImportRowsAsync(HandlerContext context, ImportRowsPayload payload)
    {
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(payload);
        var processed = 0;
        // docs:start csharp-progress-report
        await context.SetProgressAsync(new { phase = "reading", processed = 0 });
        foreach (var batch in await ReadBatchesAsync(payload.Source))
        {
            await ImportBatchAsync(batch);
            processed += batch.Count;
            await context.SetProgressAsync(new { phase = "importing", processed });
        }
        // docs:end
        return new { processed };
    }

    private Task<IReadOnlyList<IReadOnlyList<string>>> ReadBatchesAsync(string source) => importer.ReadBatchesAsync(source);

    private Task ImportBatchAsync(IReadOnlyList<string> batch) => importer.ImportBatchAsync(batch);
}
