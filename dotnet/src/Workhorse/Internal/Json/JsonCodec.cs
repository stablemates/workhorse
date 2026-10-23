using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;

namespace Workhorse.Internal.Json;

/// <summary>
/// Reads and writes the JSON values of one <c>Queue</c>, <c>Admin</c>, or <c>Worker</c> with a copy
/// of the options of the caller (ADR 0107, "Values and durations").
/// </summary>
/// <remarks>
/// <para>
/// The codec writes with <see cref="Options"/> and reads with <see cref="ReadOptions"/>. The write
/// copy refuses a lone surrogate and a non-finite <see cref="double"/>, <see cref="float"/>, or
/// <see cref="Half"/> with <see cref="ArgumentException"/>, before the writer sees it:
/// </para>
/// <list type="bullet">
/// <item>Converters check each string, <see cref="char"/>, dictionary key, and floating-point number.</item>
/// <item>A resolver modifier checks the property names of each type that the serializer resolves,
/// also a runtime type behind <see cref="object"/>, and the keys of an extension-data member.</item>
/// <item>A converter for every <see cref="JsonNode"/> type, <see cref="JsonElement"/>, and
/// <see cref="JsonDocument"/> writes those values itself, at any depth, and checks them.</item>
/// </list>
/// <para>
/// The write copy adds converters only for leaf and tree types, so the framework keeps its own
/// handling of collections, dictionaries, references, and polymorphism. It overrides a converter
/// of the caller for one of those types. A read needs no check, so <see cref="ReadOptions"/> is the
/// options of the caller unchanged.
/// </para>
/// <para>
/// The write copy also refuses a <see cref="System.Numerics.BigInteger"/> with
/// <see cref="ArgumentException"/>, at any depth, because it is not a supported payload type. That
/// converter comes after the converters of the caller. If the caller adds a converter for
/// <see cref="System.Numerics.BigInteger"/>, in the options or on a property, the codec writes with it.
/// </para>
/// </remarks>
internal sealed class JsonCodec
{
    /// <summary>A codec with the options of <paramref name="options"/>, or the SDK default.</summary>
    internal JsonCodec(JsonSerializerOptions? options)
    {
        Options = Prepare(options);
        var reading = options is null ? DefaultOptions() : new JsonSerializerOptions(options);
        reading.MakeReadOnly(populateMissingResolver: true);
        ReadOptions = reading;
    }

    /// <summary>The SDK default codec.</summary>
    internal static JsonCodec Default { get; } = new(null);

    /// <summary>The read-only options copy that the codec writes with.</summary>
    internal JsonSerializerOptions Options { get; }

    /// <summary>The read-only options copy that the codec reads with: the options of the caller, or the SDK default.</summary>
    internal JsonSerializerOptions ReadOptions { get; }

    /// <summary>
    /// <see cref="JsonSerializerDefaults.Web"/> with <see cref="JsonNumberHandling.Strict"/>, so a
    /// number never reads from a string.
    /// </summary>
    internal static JsonSerializerOptions DefaultOptions() =>
        new(JsonSerializerDefaults.Web) { NumberHandling = JsonNumberHandling.Strict };

    /// <summary>
    /// The copy of <paramref name="options"/> that the SDK writes with. It refuses options that
    /// allow named floating-point literals.
    /// </summary>
    internal static JsonSerializerOptions Prepare(JsonSerializerOptions? options)
    {
        if (options is not null && (options.NumberHandling & JsonNumberHandling.AllowNamedFloatingPointLiterals) != 0)
        {
            throw new ArgumentException(
                "JSON options must not allow named floating-point literals, because JSON cannot carry a non-finite number",
                nameof(options));
        }

        var copy = options is null ? DefaultOptions() : new JsonSerializerOptions(options);
        copy.Converters.Insert(0, new StrictStringConverter());
        copy.Converters.Insert(0, new StrictCharConverter());
        copy.Converters.Insert(0, new FiniteDoubleConverter());
        copy.Converters.Insert(0, new FiniteSingleConverter());
        copy.Converters.Insert(0, new FiniteHalfConverter());
        copy.Converters.Insert(0, new StrictTreeConverterFactory());
        // Last, so that a BigInteger converter of the caller wins.
        copy.Converters.Add(new UnsupportedBigIntegerConverter());
        // HandledNumber.Resolver comes first, so the internal wrapper has metadata also when the
        // caller resolves only through a source-generated JsonSerializerContext.
        copy.TypeInfoResolver = JsonTypeInfoResolver
            .Combine(new HandledNumber.Resolver(), copy.TypeInfoResolver ?? new DefaultJsonTypeInfoResolver())
            .WithAddedModifier(CheckTypeInfo);
        copy.MakeReadOnly();
        return copy;
    }

    /// <summary>The JSON text of <paramref name="value"/>.</summary>
    /// <exception cref="ArgumentException">The value holds a non-finite number or a lone surrogate,
    /// or it is not a JSON value. The message starts with <paramref name="label"/>.</exception>
    internal string Serialize<T>(T value, string label)
    {
        if (value is null)
        {
            return "null";
        }

        try
        {
            // The declared type keeps polymorphism; a value declared as object writes its runtime type.
            return JsonSerializer.Serialize(value, typeof(T) == typeof(object) ? value.GetType() : typeof(T), Options);
        }
        catch (Exception error) when (error is ArgumentException or JsonException or NotSupportedException or InvalidOperationException)
        {
            throw new ArgumentException($"{label} is not a JSON value: {error.Message}", error);
        }
    }

    /// <summary>The value of <paramref name="json"/> as <typeparamref name="T"/>.</summary>
    internal T? Deserialize<T>(string json) => JsonSerializer.Deserialize<T>(json, ReadOptions);

    /// <summary>The value of <paramref name="element"/> as <typeparamref name="T"/>.</summary>
    internal T? Deserialize<T>(JsonElement element) => element.Deserialize<T>(ReadOptions);

    /// <summary>
    /// Refuses a property name with a lone surrogate, because a property name does not pass through
    /// a converter. It also checks the keys of an extension-data member before each write, because
    /// they do not pass through the key converter either. The values of that member do.
    /// </summary>
    private static void CheckTypeInfo(JsonTypeInfo info)
    {
        if (info.PolymorphismOptions is { } polymorphism)
        {
            Utf16.Require(polymorphism.TypeDiscriminatorPropertyName, $"type discriminator property of {info.Type.Name}");
            foreach (var derived in polymorphism.DerivedTypes)
            {
                if (derived.TypeDiscriminator is string discriminator)
                {
                    Utf16.Require(discriminator, $"type discriminator of {derived.DerivedType.Name}");
                }
            }
        }

        if (info.Kind != JsonTypeInfoKind.Object)
        {
            return;
        }

        foreach (var property in info.Properties)
        {
            Utf16.Require(property.Name, $"property name of {info.Type.Name}");
            BindNumberHandling(property, property.NumberHandling ?? info.NumberHandling);
            if (!property.IsExtensionData)
            {
                continue;
            }

            if (property.PropertyType == typeof(JsonObject))
            {
                // System.Text.Json writes such a member as invalid JSON, such as {"id":1,{"a":1}}, on
                // .NET 10, and it allows no converter but its own for it.
                throw new ArgumentException(
                    $"System.Text.Json writes the [JsonExtensionData] JsonObject member {info.Type.Name}.{property.Name} as invalid JSON; declare it as Dictionary<string, JsonElement> or Dictionary<string, object>");
            }

            if (property.Get is { } get)
            {
                var earlier = info.OnSerializing;
                info.OnSerializing = target =>
                {
                    earlier?.Invoke(target);
                    CheckExtensionKeys(get(target));
                };
            }
        }
    }

    /// <summary>
    /// A custom converter does not see the number handling of a property or a type, so a
    /// floating-point property with its own handling gets a finite converter bound to that handling.
    /// </summary>
    private static void BindNumberHandling(JsonPropertyInfo property, JsonNumberHandling? handling)
    {
        if (handling is not { } effective || property.CustomConverter is not null)
        {
            return;
        }

        var type = property.PropertyType;
        if (type == typeof(object))
        {
            // The framework writes a value of an object property with the converter of its runtime
            // type, which does not see this handling. The getter turns a floating-point value into
            // the form that the handling selects, and leaves every other value to the framework.
            if (property.Get is { } get)
            {
                property.Get = target => HandledNumber.Of(get(target), effective);

                // A ShouldSerialize predicate, also the one of an ignore condition, sees the
                // original value of the same getter call.
                if (property.ShouldSerialize is { } should)
                {
                    property.ShouldSerialize = (target, value) => should(target, value is HandledNumber handled ? handled.Original : value);
                }
            }

            return;
        }

        property.CustomConverter = type switch
        {
            _ when type == typeof(double) => new FiniteDoubleConverter(effective),
            _ when type == typeof(double?) => new NullableFiniteConverter<double>(new FiniteDoubleConverter(effective)),
            _ when type == typeof(float) => new FiniteSingleConverter(effective),
            _ when type == typeof(float?) => new NullableFiniteConverter<float>(new FiniteSingleConverter(effective)),
            _ when type == typeof(Half) => new FiniteHalfConverter(effective),
            _ when type == typeof(Half?) => new NullableFiniteConverter<Half>(new FiniteHalfConverter(effective)),
            _ => null,
        };
    }

    /// <summary>Checks the keys of an extension-data member. It reads no value, so it consumes no sequence.</summary>
    private static void CheckExtensionKeys(object? members)
    {
        IEnumerable<string> keys = members switch
        {
            null => [],
            IEnumerable<KeyValuePair<string, JsonElement>> elements => elements.Select(pair => pair.Key),
            IEnumerable<KeyValuePair<string, object?>> values => values.Select(pair => pair.Key),
            _ => throw new ArgumentException($"the extension data type {members.GetType().Name} is not supported"),
        };
        foreach (var key in keys)
        {
            Utf16.Require(key, "a JSON property name");
        }
    }
}

/// <summary>
/// Writes a <see cref="JsonNode"/>, a <see cref="JsonElement"/>, or a <see cref="JsonDocument"/>
/// after a check of every string and number in it. The built-in converters write a node with its
/// own converters, which would bypass the refusals of the codec.
/// </summary>
internal sealed class StrictTreeConverterFactory : JsonConverterFactory
{
    public override bool CanConvert(Type typeToConvert) =>
        typeof(JsonNode).IsAssignableFrom(typeToConvert) || typeToConvert == typeof(JsonElement) || typeToConvert == typeof(JsonDocument);

    public override JsonConverter CreateConverter(Type typeToConvert, JsonSerializerOptions options) =>
        (JsonConverter)Activator.CreateInstance(typeof(TreeConverter<>).MakeGenericType(typeToConvert))!;

    /// <summary>Writes a tree value at any depth.</summary>
    internal static void Write(Utf8JsonWriter writer, object? value, JsonSerializerOptions options)
    {
        switch (value)
        {
            case null:
                writer.WriteNullValue();
                break;
            case JsonObject members:
                writer.WriteStartObject();
                foreach (var (name, child) in members)
                {
                    writer.WritePropertyName(Utf16.Require(name, "a JSON property name"));
                    Write(writer, child, options);
                }

                writer.WriteEndObject();
                break;
            case JsonArray items:
                writer.WriteStartArray();
                foreach (var item in items)
                {
                    Write(writer, item, options);
                }

                writer.WriteEndArray();
                break;
            case JsonValue leaf when leaf.TryGetValue<JsonElement>(out var element):
                WriteElement(writer, element);
                break;
            case JsonValue leaf when leaf.TryGetValue<object>(out var held):
                // A value node holds a .NET value. The codec options write it at the type that the
                // node declares, as JsonValue.Create<T> does, so its converters apply.
                JsonSerializer.Serialize(writer, held, DeclaredType(leaf, held), options);
                break;
            case JsonElement element:
                WriteElement(writer, element);
                break;
            case JsonDocument document:
                WriteElement(writer, document.RootElement);
                break;
            default:
                throw new ArgumentException($"cannot write {value.GetType().Name} as a JSON tree value");
        }
    }

    /// <summary>The type argument of a <c>JsonValue</c> implementation, or else the runtime type of the value.</summary>
    private static Type DeclaredType(JsonValue leaf, object held)
    {
        for (var type = leaf.GetType(); type is not null && type != typeof(JsonValue); type = type.BaseType)
        {
            if (type.IsGenericType && type.GetGenericArguments() is [var argument] && argument.IsInstanceOfType(held))
            {
                return argument;
            }
        }

        return held.GetType();
    }

    private static void WriteElement(Utf8JsonWriter writer, JsonElement element)
    {
        Check(element);
        element.WriteTo(writer);
    }

    private static void Check(JsonElement element)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                foreach (var property in element.EnumerateObject())
                {
                    Utf16.Require(Read(() => property.Name), "a JSON property name");
                    Check(property.Value);
                }

                break;
            case JsonValueKind.Array:
                foreach (var item in element.EnumerateArray())
                {
                    Check(item);
                }

                break;
            case JsonValueKind.String:
                Utf16.Require(Read(() => element.GetString() ?? ""), "a JSON string");
                break;
            default:
                break;
        }
    }

    /// <summary>An escaped lone surrogate makes the reader throw; the codec reports it as an argument error.</summary>
    private static string Read(Func<string> read)
    {
        try
        {
            return read();
        }
        catch (InvalidOperationException error)
        {
            throw new ArgumentException("a JSON string holds a lone UTF-16 surrogate, which JSON cannot carry", error);
        }
    }

    private sealed class TreeConverter<T> : JsonConverter<T>
    {
        public override T? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        {
            if (typeToConvert == typeof(JsonElement))
            {
                return (T)(object)JsonElement.ParseValue(ref reader);
            }

            if (typeToConvert == typeof(JsonDocument))
            {
                return (T)(object)JsonDocument.ParseValue(ref reader);
            }

            var node = JsonNode.Parse(ref reader, new JsonNodeOptions { PropertyNameCaseInsensitive = options.PropertyNameCaseInsensitive });
            return node is null ? default : node is T typed ? typed : throw new JsonException($"the JSON value is not a {typeToConvert.Name}");
        }

        public override void Write(Utf8JsonWriter writer, T value, JsonSerializerOptions options) =>
            StrictTreeConverterFactory.Write(writer, value, options);
    }
}

/// <summary>
/// A floating-point value of an <see cref="object"/> property whose property or type sets its own
/// number handling. The framework writes such a value with the converter of its runtime type, which
/// does not see that handling. So the getter returns this wrapper, and its converter writes a string
/// under <see cref="JsonNumberHandling.WriteAsString"/>, or else a number. The wrapper keeps the
/// original value for a <c>ShouldSerialize</c> predicate.
/// </summary>
internal sealed class HandledNumber
{
    private readonly string _text;
    private readonly bool _asString;

    private HandledNumber(object original, string text, bool asString)
    {
        Original = original;
        _text = text;
        _asString = asString;
    }

    /// <summary>The value that the getter of the property returned.</summary>
    internal object Original { get; }

    /// <summary>The wrapper of a floating-point <paramref name="value"/>, or the value itself. A non-finite value throws.</summary>
    internal static object? Of(object? value, JsonNumberHandling handling)
    {
        var text = value switch
        {
            double number when double.IsFinite(number) => number.ToString("R", CultureInfo.InvariantCulture),
            float number when float.IsFinite(number) => number.ToString("R", CultureInfo.InvariantCulture),
            Half number when Half.IsFinite(number) => number.ToString("R", CultureInfo.InvariantCulture),
            double or float or Half => throw new ArgumentException($"JSON cannot carry the non-finite number {value}"),
            _ => null,
        };
        return text is null ? value : new HandledNumber(value!, text, (handling & JsonNumberHandling.WriteAsString) != 0);
    }

    /// <summary>Supplies the metadata of the wrapper, and no other metadata.</summary>
    internal sealed class Resolver : IJsonTypeInfoResolver
    {
        public JsonTypeInfo? GetTypeInfo(Type type, JsonSerializerOptions options) =>
            type == typeof(HandledNumber) ? JsonMetadataServices.CreateValueInfo<HandledNumber>(options, new Converter()) : null;
    }

    /// <summary>Writes the wrapper. The SDK never reads one.</summary>
    internal sealed class Converter : JsonConverter<HandledNumber>
    {
        public override HandledNumber Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
            throw new NotSupportedException("the SDK writes a handled number but never reads one");

        public override void Write(Utf8JsonWriter writer, HandledNumber value, JsonSerializerOptions options)
        {
            if (value._asString)
            {
                writer.WriteStringValue(value._text);
            }
            else
            {
                writer.WriteRawValue(value._text);
            }
        }
    }
}
