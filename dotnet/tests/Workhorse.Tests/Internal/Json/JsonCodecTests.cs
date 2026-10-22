using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;
using Workhorse.Internal.Json;

namespace Workhorse.Tests.Internal.Json;

/// <summary>The JSON rules of ADR 0107, "Values and durations".</summary>
public sealed class JsonCodecTests
{
    private static readonly JsonCodec Codec = JsonCodec.Default;

    [Fact]
    public void WritesCamelCaseAndReadsNoNumberFromAString()
    {
        Assert.Equal("""{"orderId":7}""", Codec.Serialize(new Order { OrderId = 7 }, "payload"));
        Assert.Throws<JsonException>(() => Codec.Deserialize<Order>("""{"orderId":"7"}"""));
        Assert.Equal(7, Codec.Deserialize<Order>("""{"ORDERID":7}""")!.OrderId);
    }

    [Fact]
    public void RefusesALoneSurrogateInAStringValue()
    {
        var error = Assert.Throws<ArgumentException>(() => Codec.Serialize(new Note { Text = "a\uD800b" }, "payload"));
        Assert.StartsWith("payload is not a JSON value", error.Message, StringComparison.Ordinal);
        Assert.Throws<ArgumentException>(() => Codec.Serialize("\uDC00", "payload"));
        Assert.Equal("\"\\uD83D\\uDE00\"", Codec.Serialize("😀", "payload"));
    }

    [Fact]
    public void RefusesALoneSurrogateInADictionaryKey() =>
        Assert.Throws<ArgumentException>(() => Codec.Serialize(new Dictionary<string, int> { ["\uD800"] = 1 }, "payload"));

    [Fact]
    public void AnAttributeCannotCarryALoneSurrogate()
    {
        // The compiler stores an attribute string as UTF-8, so the name holds U+FFFD before any
        // serializer reads it. The resolver path below is how a lone surrogate reaches a name.
        var name = typeof(Attributed).GetProperty(nameof(Attributed.X))!
            .GetCustomAttributes(typeof(JsonPropertyNameAttribute), false)
            .Cast<JsonPropertyNameAttribute>()
            .Single()
            .Name;
        Assert.DoesNotContain('\uD800', name);
    }

    [Fact]
    public void RefusesALoneSurrogateInAPropertyNameFromATypeInfoModifier()
    {
        var resolver = new DefaultJsonTypeInfoResolver();
        resolver.Modifiers.Add(info =>
        {
            if (info.Type == typeof(Order))
            {
                info.Properties[0].Name = "order\uD800";
            }
        });
        var codec = new JsonCodec(new JsonSerializerOptions(JsonSerializerDefaults.Web) { TypeInfoResolver = resolver });
        var error = Assert.Throws<ArgumentException>(() => codec.Serialize(new Wrapper { Inner = new Order() }, "payload"));
        Assert.Contains("property name of Order", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void RefusesALoneSurrogateInAPropertyNameFromANamingPolicy()
    {
        var codec = new JsonCodec(new JsonSerializerOptions { PropertyNamingPolicy = new SurrogatePolicy() });
        Assert.Throws<ArgumentException>(() => codec.Serialize(new Order { OrderId = 1 }, "payload"));
    }

    [Fact]
    public void RefusesALoneSurrogateInAJsonNodeValue()
    {
        Assert.Throws<ArgumentException>(() => Codec.Serialize(new JsonObject { ["note"] = "\uD800" }, "payload"));
        Assert.Throws<ArgumentException>(() => Codec.Serialize(new JsonObject { ["\uD800"] = 1 }, "payload"));
        Assert.Throws<ArgumentException>(() => Codec.Serialize(new JsonArray("ok", "\uDFFF"), "payload"));
        Assert.Equal("""{"note":"ok"}""", Codec.Serialize(new JsonObject { ["note"] = "ok" }, "payload"));
    }

    [Fact]
    public void RefusesALoneSurrogateInANodeInsideAnObjectOrACollection()
    {
        Assert.Throws<ArgumentException>(() => Codec.Serialize(new { data = new JsonObject { ["text"] = "\uD800" } }, "payload"));
        Assert.Throws<ArgumentException>(() => Codec.Serialize(new List<JsonNode?> { JsonValue.Create("\uDC00") }, "payload"));
        using var document = JsonDocument.Parse("""{"note":"\ud800"}""");
        Assert.Throws<ArgumentException>(() => Codec.Serialize(new Dictionary<string, JsonElement> { ["inner"] = document.RootElement }, "payload"));
        Assert.Equal("""{"data":{"text":"ok"}}""", Codec.Serialize(new { data = new JsonObject { ["text"] = "ok" } }, "payload"));
    }

    [Fact]
    public void RefusesALoneSurrogateInThePropertyNameOfARuntimeType()
    {
        var codec = new JsonCodec(new JsonSerializerOptions { PropertyNamingPolicy = new SurrogatePolicy() });
        Assert.Throws<ArgumentException>(() => codec.Serialize(new object[] { new Order { OrderId = 1 } }, "payload"));
    }

    [Fact]
    public void RefusesALoneSurrogateInAnExtensionDataKey() =>
        Assert.Throws<ArgumentException>(() => Codec.Serialize(new Extended { Extra = new() { ["\uD800"] = 1 } }, "payload"));

    [Fact]
    public void RefusesToWriteJsonObjectExtensionDataAndReadsIt()
    {
        // System.Text.Json itself writes this member as {"id":1,{"a":1}}, so the codec refuses it.
        var error = Assert.Throws<ArgumentException>(() => Codec.Serialize(new ObjectExtended { Id = 1, Extra = new JsonObject { ["a"] = 1 } }, "payload"));
        Assert.Contains("Dictionary<string, JsonElement>", error.Message, StringComparison.Ordinal);
        Assert.Throws<ArgumentException>(() => Codec.Serialize(new ObjectExtended { Id = 1 }, "payload"));
        var read = Codec.Deserialize<ObjectExtended>("""{"id":2,"b":"x"}""")!;
        Assert.Equal(2, read.Id);
        Assert.Equal("x", read.Extra!["b"]!.GetValue<string>());
    }

    [Fact]
    public void RefusesALoneSurrogateInAnExtensionDataValue()
    {
        Assert.Throws<ArgumentException>(() => Codec.Serialize(new Extended { Extra = new() { ["text"] = "\uD800" } }, "payload"));
        Assert.Throws<ArgumentException>(() => Codec.Serialize(new Extended { Extra = new() { ["node"] = new JsonObject { ["text"] = "\uDC00" } } }, "payload"));
        Assert.Throws<ArgumentException>(() => Codec.Serialize(new Extended { Extra = new() { ["number"] = double.NaN } }, "payload"));
        Assert.Equal("""{"text":"ok"}""", Codec.Serialize(new Extended { Extra = new() { ["text"] = "ok" } }, "payload"));
    }

    [Fact]
    public void RefusesALoneSurrogateInAnExpandoObjectExtensionDataKey()
    {
        var extra = new System.Dynamic.ExpandoObject();
        ((IDictionary<string, object?>)extra)["\uD800"] = 1;
        Assert.Throws<ArgumentException>(() => Codec.Serialize(new ExpandoExtended { Extra = extra }, "payload"));
    }

    [Fact]
    public void RefusesASurrogateChar()
    {
        Assert.Throws<ArgumentException>(() => Codec.Serialize(new { Value = '\uD800' }, "payload"));
        Assert.Throws<ArgumentException>(() => Codec.Serialize(new { Value = (char?)'\uDC00' }, "payload"));
        Assert.Throws<ArgumentException>(() => Codec.Serialize(new Dictionary<char, int> { ['\uD800'] = 1 }, "payload"));
        Assert.Throws<ArgumentException>(() => Codec.Serialize(new List<char> { 'a', '\uD800' }, "payload"));
        Assert.Equal("""{"value":"a"}""", Codec.Serialize(new { Value = 'a' }, "payload"));
        Assert.Equal('a', Codec.Deserialize<char>("\"a\""));
    }

    [Fact]
    public void ChecksAJsonObjectAsARootAPropertyAnObjectValueAndACollectionElement()
    {
        Assert.Throws<ArgumentException>(() => Codec.Serialize(new Dictionary<string, object> { ["k"] = new JsonObject { ["text"] = "\uD800" } }, "payload"));
        Assert.Throws<ArgumentException>(() => Codec.Serialize(new { data = (object)new JsonObject { ["text"] = "\uD800" } }, "payload"));
        Assert.Equal("""{"k":{"a":1},"n":2}""", Codec.Serialize(new Dictionary<string, object> { ["k"] = new JsonObject { ["a"] = 1 }, ["n"] = 2 }, "payload"));
        Assert.Equal(JsonValueKind.Number, Assert.IsType<JsonElement>(Codec.Deserialize<Dictionary<string, object>>("""{"n":2}""")!["n"]).ValueKind);
        Assert.Throws<ArgumentException>(() => Codec.Serialize(new JsonObject { ["text"] = "\uD800" }, "payload"));
        Assert.Throws<ArgumentException>(() => Codec.Serialize(new Holder { Data = new JsonObject { ["text"] = "\uD800" } }, "payload"));
        Assert.Throws<ArgumentException>(() => Codec.Serialize(new List<JsonObject> { new() { ["text"] = "\uD800" } }, "payload"));
        Assert.Throws<ArgumentException>(() => Codec.Serialize(new Dictionary<string, JsonObject> { ["k"] = new() { ["n"] = float.NaN } }, "payload"));
        Assert.Equal("""[{"a":1}]""", Codec.Serialize(new List<JsonObject> { new() { ["a"] = 1 } }, "payload"));
        Assert.Equal("""{"data":{"a":1}}""", Codec.Serialize(new Holder { Data = new JsonObject { ["a"] = 1 } }, "payload"));
        Assert.Equal(1, Codec.Deserialize<List<JsonObject>>("""[{"a":1}]""")![0]["a"]!.GetValue<int>());
        Assert.Equal(1, Codec.Deserialize<Holder>("""{"data":{"a":1}}""")!.Data!["a"]!.GetValue<int>());
    }

    [Fact]
    public void ChecksAJsonObjectUnderADictionaryWithAnyKeyType()
    {
        Assert.Throws<ArgumentException>(() => Codec.Serialize(new Dictionary<int, JsonObject> { [1] = new() { ["text"] = "\uD800" } }, "payload"));
        Assert.Throws<ArgumentException>(() => Codec.Serialize(new Dictionary<Guid, JsonObject> { [Guid.Empty] = new() { ["text"] = "\uD800" } }, "payload"));
    }

    [Fact]
    public void KeepsTheArrayShapeOfAListOfPairs()
    {
        var pairs = new List<KeyValuePair<string, JsonObject>> { new("a", new JsonObject { ["n"] = 1 }) };
        var json = Codec.Serialize(pairs, "payload");
        Assert.Equal("""[{"key":"a","value":{"n":1}}]""", json);
        Assert.Equal("a", Codec.Deserialize<List<KeyValuePair<string, JsonObject>>>(json)![0].Key);
    }

    [Fact]
    public void KeepsReferenceHandling()
    {
        var shared = new Note { Text = "x" };
        var preserve = new JsonCodec(new JsonSerializerOptions { ReferenceHandler = ReferenceHandler.Preserve });
        var json = preserve.Serialize(new Pair { First = shared, Second = shared }, "payload");
        Assert.Contains("\"$ref\":\"2\"", json, StringComparison.Ordinal);
        var read = preserve.Deserialize<Pair>(json)!;
        Assert.Same(read.First, read.Second);

        var cycles = new JsonCodec(new JsonSerializerOptions { ReferenceHandler = ReferenceHandler.IgnoreCycles });
        var node = new Cycle();
        node.Self = node;
        Assert.Equal("""{"Self":null}""", cycles.Serialize(node, "payload"));
    }

    [Fact]
    public void WritesAOnceOnlySequenceInExtensionDataOnce()
    {
        var value = new Extended { Extra = new() { ["items"] = Once() } };
        Assert.Equal("""{"items":[42]}""", Codec.Serialize(value, "payload"));

        static IEnumerable<int> Once()
        {
            yield return 42;
        }
    }

    [Fact]
    public void KeepsACallerConverterForACollection()
    {
        var options = new JsonSerializerOptions();
        options.Converters.Add(new SpecialListConverter());
        var codec = new JsonCodec(options);
        Assert.Equal("\"special\"", codec.Serialize(new List<JsonObject> { new() { ["a"] = 1 } }, "payload"));
        Assert.Empty(codec.Deserialize<List<JsonObject>>("\"special\"")!);
    }

    [Fact]
    public void RefusesANonFiniteDictionaryKey()
    {
        Assert.Throws<ArgumentException>(() => Codec.Serialize(new Dictionary<float, int> { [float.PositiveInfinity] = 1 }, "payload"));
        Assert.Throws<ArgumentException>(() => Codec.Serialize(new Dictionary<Half, int> { [Half.NaN] = 1 }, "payload"));
        Assert.Throws<ArgumentException>(() => Codec.Serialize(new Dictionary<double, int> { [double.NegativeInfinity] = 1 }, "payload"));
        Assert.Equal("""{"1.5":1}""", Codec.Serialize(new Dictionary<double, int> { [1.5] = 1 }, "payload"));
    }

    [Fact]
    public void RefusesALoneSurrogateInATypeDiscriminator()
    {
        var resolver = new DefaultJsonTypeInfoResolver();
        resolver.Modifiers.Add(info =>
        {
            if (info.Type == typeof(Shape))
            {
                info.PolymorphismOptions = new JsonPolymorphismOptions { DerivedTypes = { new JsonDerivedType(typeof(Circle), "circle\uD800") } };
            }
        });
        var codec = new JsonCodec(new JsonSerializerOptions { TypeInfoResolver = resolver });
        Assert.Throws<ArgumentException>(() => codec.Serialize(new List<Shape> { new Circle { Radius = 1 } }, "payload"));
    }

    [Fact]
    public void WritesATypedValueNodeAtItsDeclaredType()
    {
        var node = new JsonObject { ["shape"] = JsonValue.Create<Shape>(new Circle { Radius = 2 }) };
        Assert.Equal("""{"shape":{"kind":"circle","radius":2}}""", Codec.Serialize(node, "payload"));
    }

    [Fact]
    public void HonorsTheNumberHandlingOfAPropertyAndAType()
    {
        Assert.Equal("""{"value":"1.5","plain":2.5}""", Codec.Serialize(new Handled { Value = 1.5, Plain = 2.5 }, "payload"));
        Assert.Throws<ArgumentException>(() => Codec.Serialize(new Handled { Value = double.NaN }, "payload"));
        Assert.Throws<ArgumentException>(() => Codec.Serialize(new Named { Value = double.NaN }, "payload"));
        Assert.Equal("""{"value":"0.5","maybe":null}""", Codec.Serialize(new TypeHandled { Value = 0.5f }, "payload"));
        var strings = new JsonCodec(new JsonSerializerOptions(JsonSerializerDefaults.Web) { NumberHandling = JsonNumberHandling.WriteAsString });
        Assert.Equal("""{"value":1.5}""", strings.Serialize(new StrictProperty { Value = 1.5 }, "payload"));
    }

    [Fact]
    public void WritesTheRootAtItsDeclaredType()
    {
        Assert.Equal("""{"kind":"circle","radius":2}""", Codec.Serialize<Shape>(new Circle { Radius = 2 }, "payload"));
        // A value declared as object writes its runtime type, Circle, which declares no discriminator.
        Assert.Equal("""{"radius":2}""", Codec.Serialize<object>(new Circle { Radius = 2 }, "payload"));
    }

    [Fact]
    public void HonorsTheNumberHandlingOfAnObjectProperty()
    {
        Assert.Equal("""{"value":"1.5"}""", Codec.Serialize(new ObjectHandled { Value = 1.5 }, "payload"));
        Assert.Equal("""{"value":"x"}""", Codec.Serialize(new ObjectHandled { Value = "x" }, "payload"));
        Assert.Throws<ArgumentException>(() => Codec.Serialize(new ObjectHandled { Value = float.NaN }, "payload"));
        var strings = new JsonCodec(new JsonSerializerOptions(JsonSerializerDefaults.Web) { NumberHandling = JsonNumberHandling.WriteAsString });
        Assert.Equal("""{"value":0.1}""", strings.Serialize(new ObjectStrict { Value = 0.1 }, "payload"));
    }

    [Fact]
    public void AShouldSerializePredicateSeesTheOriginalNumber()
    {
        var resolver = new DefaultJsonTypeInfoResolver();
        resolver.Modifiers.Add(info =>
        {
            if (info.Type == typeof(ObjectHandled) || info.Type == typeof(Changing))
            {
                info.Properties[0].ShouldSerialize = (_, value) => value is double number && number > 0;
            }
        });
        var codec = new JsonCodec(new JsonSerializerOptions(JsonSerializerDefaults.Web) { TypeInfoResolver = resolver });
        Assert.Equal("""{"value":"1.5"}""", codec.Serialize(new ObjectHandled { Value = 1.5 }, "payload"));
        Assert.Equal("{}", codec.Serialize(new ObjectHandled { Value = -1.5 }, "payload"));

        // The predicate sees the value of the same getter call that the writer uses.
        Assert.Equal("""{"value":"1.5"}""", codec.Serialize(new Changing(1.5, -1.5), "payload"));
    }

    [Fact]
    public void HonorsTheNumberHandlingOfAnObjectPropertyWithASourceGeneratedContext()
    {
        var codec = new JsonCodec(new JsonSerializerOptions { TypeInfoResolver = GeneratedContext.Default });
        Assert.Equal("""{"Value":"1.5"}""", codec.Serialize(new ObjectHandled { Value = 1.5 }, "payload"));
    }

    [Fact]
    public void AnIgnoreConditionSeesTheValueOfTheSameGetterCall()
    {
        Assert.Equal("{}", Codec.Serialize(new ChangingIgnored(null, 1.5), "payload"));
        Assert.Equal("""{"value":"2.5"}""", Codec.Serialize(new ChangingIgnored(2.5, null), "payload"));
    }

    [Fact]
    public void ChecksTheKeyBeforeTheDictionaryKeyPolicy()
    {
        var codec = new JsonCodec(new JsonSerializerOptions { DictionaryKeyPolicy = new ConstantPolicy() });
        Assert.Throws<ArgumentException>(() => codec.Serialize(new Dictionary<string, int> { ["\uD800"] = 1 }, "payload"));
    }

    [Fact]
    public void RefusesANonFiniteNumberInANodeOfAnyFloatingPointType()
    {
        var codec = new JsonCodec(new JsonSerializerOptions { NumberHandling = JsonNumberHandling.WriteAsString });
        Assert.Throws<ArgumentException>(() => codec.Serialize(new JsonObject { ["value"] = float.NaN }, "payload"));
        Assert.Throws<ArgumentException>(() => codec.Serialize(new JsonObject { ["value"] = JsonValue.Create(Half.PositiveInfinity) }, "payload"));
        Assert.Throws<ArgumentException>(() => codec.Serialize(new { inner = new JsonArray(double.NegativeInfinity) }, "payload"));
    }

    [Fact]
    public void AppliesTheDictionaryKeyPolicyButNotToExtensionData()
    {
        var codec = new JsonCodec(new JsonSerializerOptions(JsonSerializerDefaults.Web) { DictionaryKeyPolicy = JsonNamingPolicy.CamelCase });
        Assert.Equal("""{"orderId":7}""", codec.Serialize(new Dictionary<string, int> { ["OrderId"] = 7 }, "payload"));
        Assert.Equal("""{"KeepCase":1}""", codec.Serialize(new Extended { Extra = new() { ["KeepCase"] = 1 } }, "payload"));
    }

    [Fact]
    public void ReadsTreeValues()
    {
        Assert.Equal(7, Codec.Deserialize<JsonObject>("""{"orderId":7}""")!["orderId"]!.GetValue<int>());
        Assert.Equal(JsonValueKind.Array, Codec.Deserialize<JsonElement>("[1]").ValueKind);
        Assert.Null(Codec.Deserialize<JsonNode>("null"));
    }

    [Fact]
    public void RefusesAnEscapedLoneSurrogateInAJsonElement()
    {
        using var document = JsonDocument.Parse("""{"note":"\ud800"}""");
        Assert.Throws<ArgumentException>(() => Codec.Serialize(document.RootElement, "payload"));
    }

    [Theory]
    [InlineData(double.NaN)]
    [InlineData(double.PositiveInfinity)]
    [InlineData(double.NegativeInfinity)]
    public void RefusesANonFiniteNumber(double value)
    {
        Assert.Throws<ArgumentException>(() => Codec.Serialize(new Measure { Value = value }, "payload"));
        Assert.Throws<ArgumentException>(() => Codec.Serialize(new SingleMeasure { Value = (float)value }, "payload"));
        Assert.Throws<ArgumentException>(() => Codec.Serialize(new HalfMeasure { Value = (Half)value }, "payload"));
        Assert.Throws<ArgumentException>(() => Codec.Serialize(new NullableMeasure { Value = value }, "payload"));
        Assert.Throws<ArgumentException>(() => Codec.Serialize(new JsonObject { ["value"] = value }, "payload"));
    }

    [Fact]
    public void RefusesANonFiniteNumberWhenTheOptionsWriteNumbersAsStrings()
    {
        var codec = new JsonCodec(new JsonSerializerOptions { NumberHandling = JsonNumberHandling.WriteAsString });
        Assert.Throws<ArgumentException>(() => codec.Serialize(new Measure { Value = double.NaN }, "payload"));
        Assert.Equal("""{"Value":"1.5"}""", codec.Serialize(new Measure { Value = 1.5 }, "payload"));
    }

    [Fact]
    public void WritesFiniteNumbers() =>
        Assert.Equal("""{"value":1.5}""", Codec.Serialize(new HalfMeasure { Value = (Half)1.5 }, "payload"));

    [Fact]
    public void RefusesOptionsThatAllowNamedFloatingPointLiterals() =>
        Assert.Throws<ArgumentException>(() => new JsonCodec(new JsonSerializerOptions { NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals }));

    [Fact]
    public void DoesNotChangeTheOptionsOfTheCaller()
    {
        var options = new JsonSerializerOptions();
        _ = new JsonCodec(options);
        Assert.Empty(options.Converters);
        Assert.False(options.IsReadOnly);
    }

    public sealed class Order
    {
        public int OrderId { get; set; }
    }

    public sealed class Note
    {
        public string? Text { get; set; }
    }

    public sealed class Wrapper
    {
        public Order? Inner { get; set; }
    }

    public sealed class Attributed
    {
        [JsonPropertyName("x\uD800")]
        public int X { get; set; }
    }

    public sealed class Measure
    {
        public double Value { get; set; }
    }

    public sealed class SingleMeasure
    {
        public float Value { get; set; }
    }

    public sealed class HalfMeasure
    {
        public Half Value { get; set; }
    }

    public sealed class NullableMeasure
    {
        public double? Value { get; set; }
    }

    [JsonPolymorphic(TypeDiscriminatorPropertyName = "kind")]
    [JsonDerivedType(typeof(Circle), "circle")]
    public class Shape;

    public sealed class Circle : Shape
    {
        public int Radius { get; set; }
    }

    public sealed class Handled
    {
        [JsonNumberHandling(JsonNumberHandling.WriteAsString)]
        public double Value { get; set; }

        public double Plain { get; set; }
    }

    public sealed class Named
    {
        [JsonNumberHandling(JsonNumberHandling.AllowNamedFloatingPointLiterals)]
        public double Value { get; set; }
    }

    [JsonNumberHandling(JsonNumberHandling.WriteAsString)]
    public sealed class TypeHandled
    {
        public float Value { get; set; }

        public Half? Maybe { get; set; }
    }

    public sealed class StrictProperty
    {
        [JsonNumberHandling(JsonNumberHandling.Strict)]
        public double Value { get; set; }
    }

    public sealed class ObjectHandled
    {
        [JsonNumberHandling(JsonNumberHandling.WriteAsString)]
        public object? Value { get; set; }
    }

    /// <summary>A getter that returns its values in turn, one for each call.</summary>
    public sealed class Changing(params object?[] values)
    {
        private int _calls;

        [JsonNumberHandling(JsonNumberHandling.WriteAsString)]
        public object? Value => values[Math.Min(_calls++, values.Length - 1)];
    }

    public sealed class ChangingIgnored(params object?[] values)
    {
        private int _calls;

        [JsonNumberHandling(JsonNumberHandling.WriteAsString)]
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public object? Value => values[Math.Min(_calls++, values.Length - 1)];
    }

    public sealed class ObjectStrict
    {
        [JsonNumberHandling(JsonNumberHandling.Strict)]
        public object? Value { get; set; }
    }

    private sealed class ConstantPolicy : JsonNamingPolicy
    {
        public override string ConvertName(string name) => "key";
    }

    public sealed class Pair
    {
        public Note? First { get; set; }

        public Note? Second { get; set; }
    }

    public sealed class Cycle
    {
        public Cycle? Self { get; set; }
    }

    private sealed class SpecialListConverter : JsonConverter<List<JsonObject>>
    {
        public override List<JsonObject> Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        {
            reader.GetString();
            return [];
        }

        public override void Write(Utf8JsonWriter writer, List<JsonObject> value, JsonSerializerOptions options) =>
            writer.WriteStringValue("special");
    }

    public sealed class ObjectExtended
    {
        public int Id { get; set; }

        [JsonExtensionData]
        public JsonObject? Extra { get; set; }
    }

    public sealed class ExpandoExtended
    {
        [JsonExtensionData]
        public System.Dynamic.ExpandoObject? Extra { get; set; }
    }

    public sealed class Holder
    {
        public JsonObject? Data { get; set; }
    }

    public sealed class Extended
    {
        [JsonExtensionData]
        public Dictionary<string, object>? Extra { get; set; }
    }

    private sealed class SurrogatePolicy : JsonNamingPolicy
    {
        public override string ConvertName(string name) => name + "\uD800";
    }
}

[JsonSerializable(typeof(JsonCodecTests.ObjectHandled))]
[JsonSerializable(typeof(double))]
internal sealed partial class GeneratedContext : JsonSerializerContext;
