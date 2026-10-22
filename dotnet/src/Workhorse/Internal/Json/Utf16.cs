namespace Workhorse.Internal.Json;

/// <summary>Finds a lone surrogate, which <c>System.Text.Json</c> would replace with U+FFFD.</summary>
internal static class Utf16
{
    /// <summary>Whether <paramref name="text"/> holds a surrogate without its pair.</summary>
    internal static bool HasLoneSurrogate(string text)
    {
        for (var index = 0; index < text.Length; index++)
        {
            var character = text[index];
            if (char.IsHighSurrogate(character))
            {
                if (index + 1 >= text.Length || !char.IsLowSurrogate(text[index + 1]))
                {
                    return true;
                }

                index++;
            }
            else if (char.IsLowSurrogate(character))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>Throws <see cref="ArgumentException"/> when <paramref name="text"/> holds a lone surrogate.</summary>
    internal static string Require(string text, string label)
    {
        if (HasLoneSurrogate(text))
        {
            throw new ArgumentException($"{label} holds a lone UTF-16 surrogate, which JSON cannot carry");
        }

        return text;
    }
}
