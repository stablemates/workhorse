using System.Collections;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using Microsoft.Extensions.Logging;

namespace Workhorse.Internal.Telemetry;

/// <summary>
/// One log event of the SDK. A record of the event carries each value under the key that
/// <c>docs/architecture/telemetry.md</c> gives for the event, such as <c>workhorse.task.id</c>, as
/// the other six SDKs do. Thus one query on a key matches the records of every SDK (SM-2064).
/// </summary>
/// <remarks>
/// <para>
/// The template of a record names each key in a hole, such as
/// <c>"Task {workhorse.task.id} completed"</c>. A <c>LoggerMessage</c> template takes the name of a
/// method parameter, and a parameter name cannot hold a dot, so the SDK does not use the source
/// generator. The state of a record holds the values under the keys of the holes, in order, and the
/// template under <c>{OriginalFormat}</c>, as a <c>LoggerMessage</c> state does. Its message is the
/// template with the values. A record never carries an exception, because the exception holds the
/// error message.
/// </para>
/// <para>
/// A caller checks <see cref="Enabled"/> first, so a disabled logger costs no work.
/// </para>
/// </remarks>
internal sealed class SdkLog
{
    private const string OriginalFormat = "{OriginalFormat}";

    private readonly LogLevel _level;
    private readonly EventId _eventId;

    /// <summary>The event <paramref name="name"/> at <paramref name="level"/>.</summary>
    internal SdkLog(string name, LogLevel level)
    {
        _level = level;
        _eventId = new EventId(StableId(name), name);
    }

    /// <summary>Whether <paramref name="logger"/> writes this event.</summary>
    internal bool Enabled(ILogger logger) => logger.IsEnabled(_level);

    /// <summary>
    /// Writes one record. Each hole of <paramref name="template"/> names the key of the value at the
    /// same position in <paramref name="values"/>. <c>{{</c> and <c>}}</c> are literal braces.
    /// </summary>
    internal void Write(ILogger logger, string template, params ReadOnlySpan<object?> values)
    {
        if (!logger.IsEnabled(_level))
        {
            return;
        }

        var pairs = new KeyValuePair<string, object?>[values.Length + 1];
        var message = new StringBuilder(template.Length + 16 * values.Length);
        var count = 0;
        for (var index = 0; index < template.Length; index++)
        {
            var character = template[index];
            if ((character == '{' || character == '}') && index + 1 < template.Length && template[index + 1] == character)
            {
                message.Append(character);
                index++;
            }
            else if (character == '{')
            {
                var end = template.IndexOf('}', index + 1);
                var value = values[count];
                pairs[count] = new KeyValuePair<string, object?>(template[(index + 1)..end], value);
                message.Append(Text(value));
                count++;
                index = end;
            }
            else
            {
                message.Append(character);
            }
        }

        Debug.Assert(count == values.Length, $"The template of {_eventId.Name} has {count} holes for {values.Length} values");
        pairs[count] = new KeyValuePair<string, object?>(OriginalFormat, template);
        logger.Log(_level, _eventId, new State(pairs, message.ToString()), null, State.Format);
    }

    /// <summary>
    /// The event ID that the <c>LoggerMessage</c> source generator gave each event before SM-2064: the
    /// FNV-1a hash of the event name, made positive. A sink that filters on the ID keeps its filter.
    /// </summary>
    internal static int StableId(string name)
    {
        var hash = 2166136261u;
        foreach (var character in name)
        {
            hash = (character ^ hash) * 16777619u;
        }

        return Math.Abs(unchecked((int)hash));
    }

    /// <summary>
    /// A value as the message states it, as a <c>LoggerMessage</c> message does: <c>(null)</c> for no
    /// value, the items of a list separated by commas, and other values in the invariant culture.
    /// </summary>
    private static string Text(object? value) => value switch
    {
        null => "(null)",
        string text => text,
        IEnumerable items => string.Join(", ", items.Cast<object?>().Select(Text)),
        IFormattable formattable => formattable.ToString(null, CultureInfo.InvariantCulture),
        _ => value.ToString() ?? "(null)",
    };

    /// <summary>The state of one record: the values under their keys, the template, and the message.</summary>
    private sealed class State(KeyValuePair<string, object?>[] values, string message) : IReadOnlyList<KeyValuePair<string, object?>>
    {
        internal static readonly Func<State, Exception?, string> Format = (state, _) => state.ToString();

        public int Count => values.Length;

        public KeyValuePair<string, object?> this[int index] => values[index];

        public IEnumerator<KeyValuePair<string, object?>> GetEnumerator() => ((IEnumerable<KeyValuePair<string, object?>>)values).GetEnumerator();

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();

        public override string ToString() => message;
    }
}
