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
                writer.WriteString("name", Name(error));
                writer.WriteString("message", Storable(Format(() => error.Message, error)));
                writer.WriteString("stack", Storable(Format(error.ToString, error)));
            }

            writer.WriteEndObject();
        }

        return Encoding.UTF8.GetString(buffer.ToArray());
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
