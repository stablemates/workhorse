using System.Collections.Concurrent;
using System.Text;

namespace Workhorse.Internal;

/// <summary>
/// The protocol spelling of an enum member: its name in lower snake case, such as
/// <c>not_running_member</c> for <c>NotRunningMember</c>.
/// </summary>
internal static class Wire
{
    private static readonly ConcurrentDictionary<Type, IReadOnlyDictionary<string, object>> Parsers = new();

    /// <summary>The protocol text of <paramref name="value"/>.</summary>
    /// <exception cref="ArgumentException">The value is not a defined member, such as <c>(DebounceSchedule)99</c>.
    /// PostgreSQL would refuse it, and the refusal would abort the transaction of a caller.</exception>
    internal static string Text<TEnum>(TEnum value)
        where TEnum : struct, Enum =>
        Enum.IsDefined(value)
            ? Snake(value.ToString())
            : throw new ArgumentException($"{value} is not a defined {typeof(TEnum).Name} member");

    /// <summary>The member whose protocol text is <paramref name="text"/>, or <c>null</c>.</summary>
    internal static TEnum? Optional<TEnum>(string? text)
        where TEnum : struct, Enum
    {
        if (text is null)
        {
            return null;
        }

        var members = Parsers.GetOrAdd(
            typeof(TEnum),
            _ => Enum.GetValues<TEnum>().ToDictionary(member => Text(member), member => (object)member, StringComparer.Ordinal));
        return members.TryGetValue(text, out var value) ? (TEnum)value : null;
    }

    /// <summary>
    /// The member whose protocol text is <paramref name="text"/>. An unknown or missing text throws
    /// <see cref="UnexpectedStatusException"/>, because an unknown status is never a success.
    /// </summary>
    internal static TEnum Required<TEnum>(string operation, string? text)
        where TEnum : struct, Enum =>
        Optional<TEnum>(text) ?? throw new UnexpectedStatusException(operation, text);

    private static string Snake(string name)
    {
        var builder = new StringBuilder(name.Length + 4);
        for (var index = 0; index < name.Length; index++)
        {
            var character = name[index];
            if (char.IsUpper(character))
            {
                if (index > 0)
                {
                    builder.Append('_');
                }

                builder.Append(char.ToLowerInvariant(character));
            }
            else
            {
                builder.Append(character);
            }
        }

        return builder.ToString();
    }
}
