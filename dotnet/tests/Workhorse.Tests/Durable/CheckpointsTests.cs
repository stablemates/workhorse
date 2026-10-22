using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using Workhorse.Internal.Durable;
using Workhorse.Tests.Testing;

namespace Workhorse.Tests.Durable;

/// <summary>
/// The RFC 8785 canonical JSON and the checkpoint input fingerprint (ADR 0098, ADR 0107 "RFC 8785
/// canonical JSON").
/// </summary>
public sealed class CheckpointsTests
{
    private static readonly string[] LoneLowSurrogate = ["\uDE00x"];

    /// <summary>The number vectors of RFC 8785 Appendix B: the IEEE 754 bits and the ECMAScript text.</summary>
    public static TheoryData<string, string> AppendixB => new()
    {
        { "0000000000000000", "0" },
        { "8000000000000000", "0" },
        { "0000000000000001", "5e-324" },
        { "8000000000000001", "-5e-324" },
        { "7fefffffffffffff", "1.7976931348623157e+308" },
        { "ffefffffffffffff", "-1.7976931348623157e+308" },
        { "4340000000000000", "9007199254740992" },
        { "c340000000000000", "-9007199254740992" },
        { "4430000000000000", "295147905179352830000" },
        { "44b52d02c7e14af5", "9.999999999999997e+22" },
        { "44b52d02c7e14af6", "1e+23" },
        { "44b52d02c7e14af7", "1.0000000000000001e+23" },
        { "444b1ae4d6e2ef4e", "999999999999999700000" },
        { "444b1ae4d6e2ef4f", "999999999999999900000" },
        { "444b1ae4d6e2ef50", "1e+21" },
        { "3eb0c6f7a0b5ed8c", "9.999999999999997e-7" },
        { "3eb0c6f7a0b5ed8d", "0.000001" },
        { "41b3de4355555553", "333333333.3333332" },
        { "41b3de4355555554", "333333333.33333325" },
        { "41b3de4355555555", "333333333.3333333" },
        { "41b3de4355555556", "333333333.3333334" },
        { "41b3de4355555557", "333333333.33333343" },
        { "becbf647612f3696", "-0.0000033333333333333333" },
        { "43143ff3c1cb0959", "1424953923781206.2" },
    };

    /// <summary>The ids of the vectors in <c>protocol/v1/checkpoint-fingerprints.json</c>, which every SDK must give.</summary>
    public static TheoryData<string> SharedVectorIds
    {
        get
        {
            var ids = new TheoryData<string>();
            foreach (var vector in Vectors())
            {
                ids.Add(vector.GetProperty("id").GetString()!);
            }

            return ids;
        }
    }

    [Theory]
    [MemberData(nameof(AppendixB))]
    public void WritesEachNumberOfAppendixBInTheEcmaScriptForm(string bits, string expected)
    {
        var value = BitConverter.Int64BitsToDouble(long.Parse(bits, NumberStyles.HexNumber, CultureInfo.InvariantCulture));

        Assert.Equal(expected, CanonicalJson.Number(value));
    }

    [Theory]
    [InlineData("7fffffffffffffff")]
    [InlineData("7ff0000000000000")]
    public void RefusesANonFiniteNumber(string bits)
    {
        var value = BitConverter.Int64BitsToDouble(long.Parse(bits, NumberStyles.HexNumber, CultureInfo.InvariantCulture));

        Assert.Throws<ArgumentException>(() => CanonicalJson.Number(value));
    }

    /// <summary>
    /// The test decodes each input with <see cref="JsonDocument"/>, the decoder of
    /// <c>System.Text.Json</c>, and fingerprints the decoded element. The codec refuses a lone
    /// surrogate before <c>System.Text.Json</c> can replace it.
    /// </summary>
    [Theory]
    [MemberData(nameof(SharedVectorIds))]
    public void GivesTheOutcomeOfEachSharedVector(string id)
    {
        var vector = Vectors().Single(candidate => candidate.GetProperty("id").GetString() == id);
        var input = vector.GetProperty("input").GetString()!;
        if (!vector.TryGetProperty("refusal", out var refusal))
        {
            var decoded = Decode(input);
            Assert.Equal(vector.GetProperty("canonical").GetString(), CanonicalJson.Canonical(JsonSerializer.Serialize(decoded)));
            Assert.Equal(vector.GetProperty("digest").GetString(), Checkpoints.InputFingerprint(decoded));
            return;
        }

        var error = Assert.ThrowsAny<Exception>(() => Checkpoints.InputFingerprint(Decode(input)));
        Assert.True(error is ArgumentException or JsonException, $"{id}: {error.GetType().Name}");
        switch (refusal.GetString())
        {
            case "unsafeNumber":
                Assert.Equal(CanonicalJson.RangeMessage, error.Message);
                break;
            case "nonFinite":
                Assert.EndsWith("a number outside the double range", error.Message, StringComparison.Ordinal);
                break;
            case "loneSurrogate":
                Assert.Contains("surrogate", error.Message, StringComparison.Ordinal);
                break;
            default:
                Assert.Fail($"unknown refusal {refusal.GetString()}");
                break;
        }
    }

    [Fact]
    public void TwoInputsThatDifferOnlyInKeyOrderHaveOneFingerprint()
    {
        var first = Checkpoints.InputFingerprint(new Dictionary<string, object> { ["amountCents"] = 1000, ["currency"] = "EUR" });
        var second = Checkpoints.InputFingerprint(new Dictionary<string, object> { ["currency"] = "EUR", ["amountCents"] = 1000 });

        Assert.Equal(first, second);
        Assert.Equal("null", CanonicalJson.Canonical(JsonSerializer.Serialize<object?>(null)));
        Assert.Equal(64, Checkpoints.InputFingerprint<object?>(null).Length);
    }

    [Fact]
    public void AnOptionThatChangesTheTextChangesTheFingerprint()
    {
        var charge = new Charge(1000);
        var web = Checkpoints.InputFingerprint(charge);
        var pascal = Checkpoints.InputFingerprint(charge, new JsonSerializerOptions());

        Assert.Equal(Checkpoints.InputFingerprint(new Dictionary<string, object> { ["currency"] = "EUR", ["amountCents"] = 1000 }), web);
        Assert.NotEqual(web, pascal);
    }

    [Fact]
    public void ReadsTheExactTokenAtTheBound()
    {
        // The parse to a double rounds each of these decimals to 2^53 - 1, so only the exact token
        // shows that it is above the bound.
        Assert.Equal(Checkpoints.InputFingerprint(9_007_199_254_740_991L), Checkpoints.InputFingerprint(9_007_199_254_740_991m));
        foreach (var input in new object[] { 9_007_199_254_740_991.1m, -9_007_199_254_740_991.1m, new[] { 9_007_199_254_740_991.1m }, 1L << 53, Math.Pow(2, 53) })
        {
            var error = Assert.Throws<ArgumentException>(() => Checkpoints.InputFingerprint(input));
            Assert.Equal(CanonicalJson.RangeMessage, error.Message);
        }

        // A string that looks like a large number is a string.
        Assert.Equal(64, Checkpoints.InputFingerprint(new { id = "99999999999999999999", q = "9e99" }).Length);
    }

    [Fact]
    public void ADuplicateKeyCannotHideARefusedNumber()
    {
        var error = Assert.Throws<ArgumentException>(() => Checkpoints.InputFingerprint(Decode("""{"x":9007199254740992,"x":1}""")));
        Assert.Equal(CanonicalJson.RangeMessage, error.Message);
        // The last member wins, as PostgreSQL's jsonb keeps it.
        Assert.Equal("""{"x":1}""", CanonicalJson.Canonical("""{"x":2,"x":1}"""));
    }

    [Fact]
    public void ComparesALongTokenWithTheBoundExactly()
    {
        // The token has more fraction digits than PostgreSQL's numeric stores, and the double that it
        // reads as is 2^53 - 1. Only its digits show that it is above the bound.
        var above = $"9007199254740991.{new string('0', 16_383)}1";
        Assert.Equal(CanonicalJson.RangeMessage, Assert.Throws<ArgumentException>(() => CanonicalJson.Canonical(above)).Message);
        Assert.Equal("9007199254740991", CanonicalJson.Canonical($"9007199254740991.{new string('0', 16_384)}"));
        Assert.Equal("0", CanonicalJson.Canonical("1e-99999999999"));
        Assert.Equal("100", CanonicalJson.Canonical("0.0001e6"));
    }

    [Fact]
    public void RefusesAValueThatIsNotJson()
    {
        Assert.Throws<ArgumentException>(() => Checkpoints.InputFingerprint(new { amount = double.NaN }));
        Assert.Throws<ArgumentException>(() => Checkpoints.InputFingerprint("\uD800"));
        Assert.Throws<ArgumentException>(() => Checkpoints.InputFingerprint(LoneLowSurrogate));
        Assert.Throws<ArgumentException>(() => Checkpoints.InputFingerprint(new Dictionary<string, int> { ["\uD83D"] = 1 }));
    }

    [Fact]
    public void GivesAFloatTheFingerprintOfItsShortestDigits()
    {
        Assert.Equal(Checkpoints.InputFingerprint(new { rate = 0.1 }), Checkpoints.InputFingerprint(new { rate = 0.1f }));
    }

    private sealed record Charge([property: JsonPropertyName("amountCents")] int AmountCents)
    {
        // A second member that only a naming policy changes.
        public string Currency { get; init; } = "EUR";
    }

    private static JsonElement Decode(string input)
    {
        using var document = JsonDocument.Parse(input);
        return document.RootElement.Clone();
    }

    private static List<JsonElement> Vectors() =>
        [.. Repository.Json("protocol/v1/checkpoint-fingerprints.json").GetProperty("vectors").EnumerateArray()];
}
