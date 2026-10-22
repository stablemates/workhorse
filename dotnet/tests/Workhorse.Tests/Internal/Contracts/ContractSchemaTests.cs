using System.Text.Json;
using Workhorse.Internal.Contracts;
using Workhorse.Tests.Testing;

namespace Workhorse.Tests.Internal.Contracts;

/// <summary>The contract validator runs every case of <c>protocol/v1/contracts.json</c> (ADR 0039).</summary>
public sealed class ContractSchemaTests
{
    public static TheoryData<string> Cases() =>
        [.. Fixture().EnumerateArray().Select(item => item.GetProperty("id").GetString()!)];

    [Theory]
    [MemberData(nameof(Cases))]
    public void DecidesTheFixtureCase(string id)
    {
        var item = Fixture().EnumerateArray().Single(candidate => candidate.GetProperty("id").GetString() == id);
        var schema = item.TryGetProperty("schemaJson", out var text)
            ? JsonTree.Parse(text.GetString()!)
            : JsonTree.From(item.GetProperty("schema"));
        if (item.TryGetProperty("schemaError", out var error) && error.GetBoolean())
        {
            Assert.Throws<ArgumentException>(() => new ContractSchema(schema));
            return;
        }

        var compiled = new ContractSchema(schema);
        foreach (var instance in item.GetProperty("instances").EnumerateArray())
        {
            var value = instance.TryGetProperty("json", out var json)
                ? JsonTree.Parse(json.GetString()!)
                : JsonTree.From(instance.GetProperty("value"));
            Assert.True(
                instance.GetProperty("valid").GetBoolean() == compiled.Valid(value),
                $"{id}: {(instance.TryGetProperty("json", out var raw) ? raw.GetString() : instance.GetProperty("value").GetRawText())}");
        }
    }

    [Theory]
    [InlineData("""{"type":"string","pattern":"^a$"}""", "$.pattern is outside the Workhorse contract profile")]
    [InlineData("""{"properties":{"a":{"patternProperties":{"^a":true}}}}""", "$.properties.a.patternProperties is outside the Workhorse contract profile")]
    [InlineData("""{"items":{"allOf":[{"pattern":"x"}]}}""", "$.items.allOf[0].pattern is outside the Workhorse contract profile")]
    public void RefusesThePatternKeywordsAtAnyDepthWithTheProfileError(string schema, string message)
    {
        var error = Assert.Throws<ArgumentException>(() => new ContractSchema(JsonTree.Parse(schema)));
        Assert.Equal(message, error.Message);
    }

    [Fact]
    public void ValidatesAJsonElementAndTreatsAnUndefinedSchemaAsTrue()
    {
        using var schema = JsonDocument.Parse("""{"type":"object","required":["id"]}""");
        var compiled = new ContractSchema(schema.RootElement);
        using var good = JsonDocument.Parse("""{"id":1}""");
        using var bad = JsonDocument.Parse("{}");
        Assert.True(compiled.Valid(good.RootElement));
        Assert.False(compiled.Valid(bad.RootElement));
        Assert.True(new ContractSchema(default(JsonElement)).Valid(bad.RootElement));
    }

    [Theory]
    [InlineData("0.30000000000000000001", "0.3", 1)]
    [InlineData("1e2", "100", 0)]
    [InlineData("-1.50", "-1.5", 0)]
    [InlineData("-2", "-10", 1)]
    [InlineData("0.0", "-0", 0)]
    [InlineData("18446744073709551617", "18446744073709551616", 1)]
    public void ComparesExactDecimals(string left, string right, int expected) =>
        Assert.Equal(expected, Math.Sign(ExactNumber.Parse(left).CompareTo(ExactNumber.Parse(right))));

    [Theory]
    [InlineData("1.15", "0.01", true)]
    [InlineData("1.155", "0.01", false)]
    [InlineData("1e400", "7", false)]
    [InlineData("1e400", "2.5", true)]
    [InlineData("3", "1e-300", true)]
    [InlineData("1e-300", "1e-299", false)]
    public void DecidesMultiples(string number, string divisor, bool expected) =>
        Assert.Equal(expected, ExactNumber.Parse(number).IsMultipleOf(ExactNumber.Parse(divisor)));

    [Fact]
    public void RefusesANumberOutsideTheNumericRange()
    {
        Assert.Throws<ArgumentException>(() => ExactNumber.Parse("1e200000"));
        Assert.Throws<ArgumentException>(() => ExactNumber.Parse("1e-20000"));
    }

    private static JsonElement Fixture() => Repository.Json("protocol/v1/contracts.json");
}
