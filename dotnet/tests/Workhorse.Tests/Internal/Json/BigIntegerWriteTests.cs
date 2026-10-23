using System.Globalization;
using System.Numerics;
using System.Text.Json;
using System.Text.Json.Serialization;
using Workhorse.Internal.Json;

namespace Workhorse.Tests.Internal.Json;

/// <summary>
/// SM-1746: the codec refuses a <see cref="BigInteger"/>, which ADR 0107 does not support, instead
/// of writing the properties of the struct as an object. A converter of the caller still wins.
/// </summary>
public sealed class BigIntegerWriteTests
{
    private static readonly JsonCodec Codec = JsonCodec.Default;

    private static readonly BigInteger Big = BigInteger.Parse("9007199254740993", CultureInfo.InvariantCulture);

    public static TheoryData<string, object> Values() => new()
    {
        { "a top-level value", Big },
        { "a nullable value", new Holder<BigInteger?> { Value = Big } },
        { "a property", new Holder<BigInteger> { Value = Big } },
        { "an object member", new Holder<object> { Value = Big } },
        { "a list item", new List<BigInteger> { Big } },
        { "a dictionary value", new Dictionary<string, BigInteger> { ["id"] = Big } },
        { "a dictionary key", new Dictionary<BigInteger, int> { [Big] = 1 } },
        { "a nested record", new Holder<Holder<List<object>>> { Value = new() { Value = [Big] } } },
    };

    [Theory]
    [MemberData(nameof(Values))]
    public void RefusesABigIntegerAtAnyDepth(string place, object value)
    {
        var error = Assert.Throws<ArgumentException>(() => Codec.Serialize(value, place));
        Assert.StartsWith($"{place} is not a JSON value", error.Message, StringComparison.Ordinal);
        Assert.Contains("BigInteger", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void RefusesABigIntegerDeclaredAsItsOwnType() =>
        Assert.Throws<ArgumentException>(() => Codec.Serialize<BigInteger?>(Big, "checkpoint input"));

    [Fact]
    public void WritesANullBigInteger() =>
        Assert.Equal("""{"value":null}""", Codec.Serialize(new Holder<BigInteger?>(), "payload"));

    [Fact]
    public void AConverterOfTheCallerInTheOptionsWins()
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web) { NumberHandling = JsonNumberHandling.Strict };
        options.Converters.Add(new ExactBigIntegerConverter());
        var codec = new JsonCodec(options);

        var json = codec.Serialize(new Holder<BigInteger> { Value = Big }, "payload");

        Assert.Equal("""{"value":9007199254740993}""", json);
        Assert.Equal(Big, codec.Deserialize<Holder<BigInteger>>(json)!.Value);
        Assert.Equal("""[9007199254740993]""", codec.Serialize(new List<object> { Big }, "payload"));
    }

    [Fact]
    public void AConverterOfTheCallerOnAPropertyWins() =>
        Assert.Equal("""{"value":9007199254740993}""", Codec.Serialize(new Annotated { Value = Big }, "payload"));

    private sealed class Holder<T>
    {
        public T? Value { get; set; }
    }

    private sealed class Annotated
    {
        [JsonConverter(typeof(ExactBigIntegerConverter))]
        public BigInteger Value { get; set; }
    }

    /// <summary>A caller's converter that writes the exact integer as a JSON number.</summary>
    private sealed class ExactBigIntegerConverter : JsonConverter<BigInteger>
    {
        public override BigInteger Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        {
            using var document = JsonDocument.ParseValue(ref reader);
            return BigInteger.Parse(document.RootElement.GetRawText(), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture);
        }

        public override void Write(Utf8JsonWriter writer, BigInteger value, JsonSerializerOptions options) =>
            writer.WriteRawValue(value.ToString(CultureInfo.InvariantCulture), skipInputValidation: false);
    }
}
