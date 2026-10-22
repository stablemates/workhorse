using System.Globalization;
using System.Numerics;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Workhorse.Internal.Json;

/// <summary>
/// Refuses a string with a lone surrogate before the writer sees it. The writer would replace the
/// surrogate with U+FFFD, so a check of the encoded text cannot find it (ADR 0107, "Values and
/// durations").
/// </summary>
internal sealed class StrictStringConverter : JsonConverter<string>
{
    public override string? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        reader.GetString();

    public override void Write(Utf8JsonWriter writer, string value, JsonSerializerOptions options) =>
        writer.WriteStringValue(Utf16.Require(value, "a JSON string"));

    public override string ReadAsPropertyName(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        reader.GetString() ?? throw new JsonException("a property name is null");

    /// <summary>
    /// Writes a dictionary key. The built-in converter applies <see cref="JsonSerializerOptions.DictionaryKeyPolicy"/>
    /// here, so this one does too. An extension-data key does not pass through this method.
    /// </summary>
    public override void WriteAsPropertyName(Utf8JsonWriter writer, string value, JsonSerializerOptions options)
    {
        // The original key is checked too, because a policy can hide a lone surrogate.
        var key = Utf16.Require(value, "a JSON property name");
        var name = options.DictionaryKeyPolicy?.ConvertName(key) ?? key;
        writer.WritePropertyName(Utf16.Require(name, "a JSON property name"));
    }
}

/// <summary>
/// Refuses a <see cref="char"/> that is a surrogate, which the writer would replace with U+FFFD.
/// </summary>
internal sealed class StrictCharConverter : JsonConverter<char>
{
    public override char Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        var text = reader.GetString();
        return text is { Length: 1 } ? text[0] : throw new JsonException("a char must be a JSON string of one UTF-16 code unit");
    }

    public override void Write(Utf8JsonWriter writer, char value, JsonSerializerOptions options) =>
        writer.WriteStringValue(Require(value).ToString());

    public override char ReadAsPropertyName(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        Read(ref reader, typeToConvert, options);

    public override void WriteAsPropertyName(Utf8JsonWriter writer, char value, JsonSerializerOptions options) =>
        writer.WritePropertyName(Require(value).ToString());

    private static char Require(char value) =>
        char.IsSurrogate(value)
            ? throw new ArgumentException("a char holds a lone UTF-16 surrogate, which JSON cannot carry")
            : value;
}

/// <summary>
/// The shared rule of the floating-point converters: a non-finite value is refused before the
/// writer sees it, and never becomes a string or a dictionary key. The converter keeps the number
/// handling that applies: the one it was made with for one property, or else the one of the options.
/// The SDK reads with the options of the caller, so these converters only write.
/// </summary>
internal abstract class FiniteConverter<T>(JsonNumberHandling? handling) : JsonConverter<T>
    where T : struct, IFloatingPoint<T>, ISpanFormattable, ISpanParsable<T>
{
    public override T Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType == JsonTokenType.String
            && ((handling ?? options.NumberHandling) & JsonNumberHandling.AllowReadingFromString) != 0)
        {
            var text = reader.GetString();
            return T.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed) && T.IsFinite(parsed)
                ? parsed
                : throw new JsonException($"'{text}' is not a finite JSON number");
        }

        return ReadNumber(ref reader);
    }

    public override void Write(Utf8JsonWriter writer, T value, JsonSerializerOptions options)
    {
        Require(value);
        if (((handling ?? options.NumberHandling) & JsonNumberHandling.WriteAsString) != 0)
        {
            writer.WriteStringValue(Text(value));
            return;
        }

        WriteNumber(writer, value);
    }

    public override T ReadAsPropertyName(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        var text = reader.GetString();
        return T.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed) && T.IsFinite(parsed)
            ? parsed
            : throw new JsonException($"'{text}' is not a finite JSON number");
    }

    /// <summary>A dictionary key; the built-in converter would write <c>NaN</c> or <c>Infinity</c>.</summary>
    public override void WriteAsPropertyName(Utf8JsonWriter writer, T value, JsonSerializerOptions options) =>
        writer.WritePropertyName(Text(Require(value)));

    private protected abstract T ReadNumber(ref Utf8JsonReader reader);

    private protected abstract void WriteNumber(Utf8JsonWriter writer, T value);

    private static string Text(T value) => value.ToString(null, CultureInfo.InvariantCulture);

    private static T Require(T value) =>
        T.IsFinite(value)
            ? value
            : throw new ArgumentException($"JSON cannot carry the non-finite number {Text(value)}");
}

/// <summary>A <see cref="double"/> converter that refuses a non-finite value.</summary>
internal sealed class FiniteDoubleConverter(JsonNumberHandling? handling = null) : FiniteConverter<double>(handling)
{
    private protected override double ReadNumber(ref Utf8JsonReader reader) => reader.GetDouble();

    private protected override void WriteNumber(Utf8JsonWriter writer, double value) => writer.WriteNumberValue(value);
}

/// <summary>A <see cref="float"/> converter that refuses a non-finite value.</summary>
internal sealed class FiniteSingleConverter(JsonNumberHandling? handling = null) : FiniteConverter<float>(handling)
{
    private protected override float ReadNumber(ref Utf8JsonReader reader) => reader.GetSingle();

    private protected override void WriteNumber(Utf8JsonWriter writer, float value) => writer.WriteNumberValue(value);
}

/// <summary>A <see cref="Half"/> converter that refuses a non-finite value.</summary>
internal sealed class FiniteHalfConverter(JsonNumberHandling? handling = null) : FiniteConverter<Half>(handling)
{
    private protected override Half ReadNumber(ref Utf8JsonReader reader)
    {
        var value = (Half)reader.GetDouble();
        return Half.IsFinite(value) ? value : throw new JsonException("the JSON number is outside the Half range");
    }

    // The shortest round-trip text of a Half, as the built-in converter writes it.
    private protected override void WriteNumber(Utf8JsonWriter writer, Half value) =>
        writer.WriteRawValue(value.ToString("R", CultureInfo.InvariantCulture), skipInputValidation: false);
}

/// <summary>Writes a nullable floating-point property through its finite converter.</summary>
internal sealed class NullableFiniteConverter<T>(JsonConverter<T> inner) : JsonConverter<T?>
    where T : struct
{
    public override bool HandleNull => true;

    public override T? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        reader.TokenType == JsonTokenType.Null ? null : inner.Read(ref reader, typeof(T), options);

    public override void Write(Utf8JsonWriter writer, T? value, JsonSerializerOptions options)
    {
        if (value is { } present)
        {
            inner.Write(writer, present, options);
        }
        else
        {
            writer.WriteNullValue();
        }
    }
}
