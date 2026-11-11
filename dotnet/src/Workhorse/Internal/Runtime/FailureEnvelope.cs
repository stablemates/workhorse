using System.Text;
using System.Text.Json;

namespace Workhorse.Internal.Runtime;

/// <summary>
/// The failure envelope of <c>protocol/v1/failures.json</c> for a handler exception (ADR 0107, "A
/// handler exception becomes a failure envelope").
/// </summary>
internal static class FailureEnvelope
{
    internal const string RedactedName = "RedactedTaskError";
    internal const string RedactedMessage = "Task handler failed; details redacted";

    /// <summary>The <c>genericName</c> entry of C# in <c>protocol/v1/failures.json</c>.</summary>
    internal const string GenericName = "Exception";

    /// <summary>The most exceptions that <see cref="ReplayConflict"/> reads, as in the JVM and Ruby SDKs.</summary>
    internal const int CauseDepth = 16;

    private static readonly char[] ForbiddenNameCharacters = ['*', '.', '<', ' '];

    /// <summary>The envelope as JSON text.</summary>
    internal static string Write(Exception error, bool redact)
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            if (redact)
            {
                writer.WriteString("name", RedactedName);
                writer.WriteString("message", RedactedMessage);
            }
            else
            {
                // A durable replay conflict keeps its type name through a wrapper, as in the JVM and Ruby SDKs.
                var name = Name(ReplayConflict(error) ?? error);
                var message = Storable(Format(() => error.Message, error));
                var stack = Storable(Format(error.ToString, error));
                var boundedName = Utf8Prefix(name, NameMaxBytes);
                var boundedMessage = Utf8Prefix(message, MessageMaxBytes);
                var boundedStack = Utf8Prefix(stack, StackMaxBytes);
                writer.WriteString("name", boundedName);
                writer.WriteString("message", boundedMessage);
                writer.WriteString("stack", boundedStack);
                if (boundedName.Length != name.Length || boundedMessage.Length != message.Length || boundedStack.Length != stack.Length)
                {
                    writer.WriteBoolean("truncated", true);
                }
            }

            writer.WriteEndObject();
        }

        return Encoding.UTF8.GetString(buffer.ToArray());
    }

    /// <summary>The UTF-8 byte limits of the envelope fields, as <c>protocol/v1/failures.json</c> states them (SM-1983).</summary>
    internal const int NameMaxBytes = 1024;

    /// <summary>The UTF-8 byte limit of the message.</summary>
    internal const int MessageMaxBytes = 16384;

    /// <summary>The UTF-8 byte limit of the stack.</summary>
    internal const int StackMaxBytes = 65536;

    /// <summary>
    /// The longest prefix of <paramref name="text"/> whose UTF-8 form has at most
    /// <paramref name="maxBytes"/> bytes. The cut never splits a surrogate pair.
    /// <see cref="Storable"/> already replaced each lone surrogate with U+FFFD, which has three bytes.
    /// <c>bound_error_envelope_v1</c> applies the same cut, so <c>fail_v2</c> does not change the envelope.
    /// </summary>
    internal static string Utf8Prefix(string text, int maxBytes)
    {
        // A UTF-16 code unit is at most three UTF-8 bytes, so a short text needs no count.
        if ((long)text.Length * 3 <= maxBytes)
        {
            return text;
        }

        var bytes = 0;
        for (var index = 0; index < text.Length; index++)
        {
            var unit = text[index];
            var pair = char.IsHighSurrogate(unit) && index + 1 < text.Length && char.IsLowSurrogate(text[index + 1]);
            var size = pair ? 4 : unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
            if (bytes + size > maxBytes)
            {
                return text[..index];
            }

            bytes += size;
            if (pair)
            {
                index++;
            }
        }

        return text;
    }

    /// <summary>
    /// The durable replay conflict of ADR 0098, or another terminal durable error, that
    /// <paramref name="error"/> is or wraps, or <c>null</c>. Each one ends the task with no retry.
    /// An oversized checkpoint value is terminal because a retry runs the operation again and
    /// still cannot store its value (SM-1982). A child limit or child result limit error is
    /// terminal because a retry replays the same child calls and gets the same refusal (SM-2025).
    /// Such an error is terminal also inside a wrapper (SM-1512). The walk
    /// follows
    /// <see cref="Exception.InnerException"/>, so it reads the first inner exception of an
    /// <see cref="AggregateException"/>, as the JVM follows one cause. It reads at most
    /// <see cref="CauseDepth"/> exceptions, so a cycle cannot hold it.
    /// </summary>
    internal static WorkhorseException? ReplayConflict(Exception error)
    {
        Exception? current = error;
        for (var depth = 0; depth < CauseDepth && current is not null; depth++)
        {
            if (current is ConflictException conflict)
            {
                return conflict;
            }

            // Not replay conflicts, but terminal: a retry replays the same child calls and gets the
            // same refusal (SM-2025).
            if (current is LimitExceededException { Operation: "runChild" or "runChildren" } limit)
            {
                return limit;
            }

            if (current is ChildResultLimitExceededException childResult)
            {
                return childResult;
            }

            // Not a replay conflict, but terminal for the same reason: a retry runs the operation of
            // the checkpoint again and still cannot store its value (SM-1982).
            if (current is CheckpointValueSizeLimitException oversized)
            {
                return oversized;
            }

            current = current.InnerException;
        }

        return null;
    }

    /// <summary>
    /// The text of a virtual member of a handler's exception. A member that throws must not keep the
    /// worker from recording the failure, so it gives a fallback text with the type name.
    /// </summary>
    private static string Format(Func<string?> member, Exception error)
    {
        try
        {
            return member() ?? "";
        }
        catch (Exception)
        {
            return $"{error.GetType().FullName}: the exception's text is unavailable";
        }
    }

    /// <summary>
    /// The type name of <paramref name="error"/> without a generic arity suffix, or
    /// <see cref="GenericName"/> when the name holds a forbidden character, as a compiler-generated
    /// type does.
    /// </summary>
    internal static string Name(Exception error)
    {
        var name = error.GetType().Name;
        var arity = name.IndexOf('`', StringComparison.Ordinal);
        if (arity >= 0)
        {
            name = name[..arity];
        }

        return name.Length == 0 || name.IndexOfAny(ForbiddenNameCharacters) >= 0 ? GenericName : name;
    }

    /// <summary>
    /// <paramref name="text"/> with each NUL and each lone surrogate replaced by U+FFFD. PostgreSQL
    /// <c>jsonb</c> stores neither, and a refused envelope would end the worker instead of recording
    /// the handler's failure.
    /// </summary>
    internal static string Storable(string text)
    {
        StringBuilder? output = null;
        for (var index = 0; index < text.Length; index++)
        {
            var character = text[index];
            if (char.IsHighSurrogate(character) && index + 1 < text.Length && char.IsLowSurrogate(text[index + 1]))
            {
                output?.Append(character).Append(text[index + 1]);
                index++;
                continue;
            }

            var refused = character == '\0' || char.IsSurrogate(character);
            if (refused && output is null)
            {
                output = new StringBuilder(text.Length).Append(text, 0, index);
            }

            output?.Append(refused ? '�' : character);
        }

        return output?.ToString() ?? text;
    }
}
