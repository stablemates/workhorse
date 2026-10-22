using System.Globalization;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using Workhorse.Internal.Contracts;

namespace Workhorse.Internal;

/// <summary>Encodes the times, durations, and documents that cross the protocol.</summary>
internal static class Values
{
    /// <summary>
    /// The options of a protocol document. A document is <c>jsonb</c> input, not HTML, so it keeps
    /// non-ASCII text as it is.
    /// </summary>
    internal static readonly JsonSerializerOptions DocumentOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        MaxDepth = JsonTree.MaxDepth + 16,
    };

    /// <summary>The protocol timestamp text of <paramref name="time"/>, in UTC with milliseconds.</summary>
    internal static string Timestamp(DateTimeOffset time)
    {
        var utc = time.ToUniversalTime();
        utc = utc.AddTicks(-(utc.Ticks % TimeSpan.TicksPerMillisecond));
        return utc.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
    }

    /// <summary>
    /// Whole milliseconds of <paramref name="duration"/>, rounded half up, within
    /// <paramref name="minimum"/> and <paramref name="maximum"/> milliseconds.
    /// </summary>
    /// <exception cref="ArgumentException">The duration is outside the range.</exception>
    internal static long Milliseconds(TimeSpan duration, string label, long minimum, long maximum)
    {
        var milliseconds = duration < TimeSpan.Zero
            ? -1
            : (duration.Ticks / TimeSpan.TicksPerMillisecond) + (duration.Ticks % TimeSpan.TicksPerMillisecond >= TimeSpan.TicksPerMillisecond / 2 ? 1 : 0);
        if (milliseconds < minimum || milliseconds > maximum)
        {
            throw new ArgumentException(string.Create(
                CultureInfo.InvariantCulture,
                $"{label} must be a TimeSpan between {Seconds(minimum)} and {Seconds(maximum)} seconds"));
        }

        return milliseconds;
    }

    /// <summary>The JSON text of a protocol document.</summary>
    internal static string Write(JsonNode? document) => document?.ToJsonString(DocumentOptions) ?? "null";

    /// <summary>The node of the JSON text <paramref name="json"/>, with every number token unchanged.</summary>
    internal static JsonNode? Node(string json) => JsonNode.Parse(json, null, JsonTree.DocumentOptions);

    /// <summary>The number of UTF-8 bytes of <paramref name="text"/>.</summary>
    internal static int Bytes(string text) => Encoding.UTF8.GetByteCount(text);

    private static string Seconds(long milliseconds) =>
        ((decimal)milliseconds / 1000).ToString("0.###", CultureInfo.InvariantCulture);
}
