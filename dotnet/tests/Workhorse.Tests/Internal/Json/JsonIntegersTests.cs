using System.Text.Json;
using System.Text.Json.Nodes;
using Workhorse.Internal.Json;

namespace Workhorse.Tests.Internal.Json;

/// <summary>
/// The integer rules that the "Integer semantics" section of <c>docs/parity.md</c> states for .NET.
/// Each integer keeps its exact value up to 2^53 - 1 in magnitude in every SDK. Beyond that bound,
/// .NET reads an untyped value exactly, and a typed value as its declared type allows.
/// </summary>
public sealed class JsonIntegersTests
{
    private const long PortableIntegerBound = 9007199254740991;

    private static readonly JsonCodec Codec = JsonCodec.Default;

    [Theory]
    [InlineData(0L)]
    [InlineData(1L)]
    [InlineData(-1L)]
    [InlineData(1L << 31)]
    [InlineData(PortableIntegerBound)]
    [InlineData(-PortableIntegerBound)]
    public void RoundTripsEveryIntegerInsideThePortableBoundExactly(long value)
    {
        var json = Codec.Serialize(new Order { Id = value }, "payload");
        Assert.Equal(value, Codec.Deserialize<Order>(json)!.Id);
        Assert.Equal(value, Codec.Deserialize<JsonElement>(json).GetProperty("id").GetInt64());
    }

    [Theory]
    [InlineData("9007199254740993")]
    [InlineData("18446744073709551616")]
    [InlineData("123456789012345678901234567890")]
    public void KeepsAnUntypedIntegerBeyondThePortableBoundExactly(string number)
    {
        var json = $$"""{"id":{{number}}}""";
        var element = Codec.Deserialize<JsonElement>(json);
        Assert.Equal(number, element.GetProperty("id").GetRawText());
        Assert.Equal(json, Codec.Serialize(element, "payload"));
        Assert.Equal(json, Codec.Serialize(Codec.Deserialize<JsonNode>(json), "payload"));
    }

    [Fact]
    public void ReadsALongUpToTheSigned64BitBoundAndRefusesALargerInteger()
    {
        Assert.Equal(9007199254740993L, Codec.Deserialize<Order>("""{"id":9007199254740993}""")!.Id);
        Assert.Equal(long.MaxValue, Codec.Deserialize<Order>("""{"id":9223372036854775807}""")!.Id);
        Assert.Throws<JsonException>(() => Codec.Deserialize<Order>("""{"id":9223372036854775808}"""));
    }

    [Fact]
    public void ReadsADecimalUpTo2To96Minus1AndRefusesALargerInteger()
    {
        Assert.Equal(18446744073709551616m, Codec.Deserialize<decimal>("18446744073709551616"));
        Assert.Equal(decimal.MaxValue, Codec.Deserialize<decimal>("79228162514264337593543950335"));
        Assert.Equal(decimal.MinValue, Codec.Deserialize<decimal>("-79228162514264337593543950335"));
        Assert.Throws<JsonException>(() => Codec.Deserialize<decimal>("79228162514264337593543950336"));
    }

    [Fact]
    public void RoundsAnIntegerBeyondThePortableBoundThatADoubleHolds()
    {
        // A double holds the same value that a TypeScript or Go worker reads, and reports no error.
        Assert.Equal(9007199254740992d, Codec.Deserialize<double>("9007199254740993"));
    }

    private sealed class Order
    {
        public long Id { get; init; }
    }
}
