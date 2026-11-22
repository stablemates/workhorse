using System.Diagnostics.Metrics;

namespace Workhorse.Internal.Telemetry;

/// <summary>The <c>workhorse.tasks.redrive</c> counter of the admin, as the TypeScript admin records it.</summary>
internal static class AdminTelemetry
{
    /// <summary>
    /// Holds the counter in its own static class. A listener can throw when the meter publishes the
    /// counter. Then only this class stays broken, and the redrive count is lost. The spans and the
    /// other instruments of <see cref="Instrumentation"/> stay usable.
    /// </summary>
    internal static class RedriveCounter
    {
        internal static readonly Counter<long> Instance =
            Instrumentation.Meter.CreateCounter<long>("workhorse.tasks.redrive", "{request}", "Task redrive requests by durable result");
    }

    /// <summary>
    /// Adds <paramref name="count"/> redrive results of one durable <paramref name="status"/>. The
    /// admin calls this after PostgreSQL made the redrive durable, so a listener that throws does
    /// not change the redrive result, and the count is lost. A count of zero adds nothing, as in
    /// TypeScript.
    /// </summary>
    internal static void Redrive(string status, long count)
    {
        if (count <= 0)
        {
            return;
        }

        // The first access to RedriveCounter publishes the counter, and a listener can throw there
        // too, so the check is inside the guard.
        try
        {
            var counter = RedriveCounter.Instance;
            if (counter.Enabled)
            {
                counter.Add(count, new KeyValuePair<string, object?>(Names.RedriveStatus, status));
            }
        }
        catch (Exception)
        {
            // A meter listener can throw. The redrive result does not change.
        }
    }

    /// <summary>
    /// Counts each raw status of a <c>redrive_many_v1</c> page once, with the number of its rows, in
    /// the order of its first row, as TypeScript does. A dry run counts its rows too.
    /// </summary>
    internal static void RedrivePage(IEnumerable<string?> statuses)
    {
        var counts = new List<(string Status, long Count)>();
        foreach (var status in statuses)
        {
            if (status is null)
            {
                continue;
            }

            var index = counts.FindIndex(entry => entry.Status == status);
            if (index < 0)
            {
                counts.Add((status, 1));
            }
            else
            {
                counts[index] = (status, counts[index].Count + 1);
            }
        }

        foreach (var (status, count) in counts)
        {
            Redrive(status, count);
        }
    }
}
