using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Workhorse.AspNetCore.Internal;

namespace Workhorse.AspNetCore.Tests;

/// <summary>The ECMA-262 pattern policy of ADR 0107 on the <c>dashboard/v1</c> input schemas.</summary>
public sealed class EcmaPatternTests
{
    private const string Instant =
        @"^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29"
        + @"|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)"
        + @"|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d";

    /// <summary>
    /// For each schema pattern: a value that it accepts, a value that it refuses, and the accepted
    /// value with one ASCII digit changed to an Arabic-Indic digit, or <c>null</c> when it has none
    /// that <c>\d</c> matches.
    /// </summary>
    private static readonly Dictionary<string, (string Accepted, string Refused, string? NonAsciiDigit)> Vectors = new(StringComparer.Ordinal)
    {
        [Instant + @"(?:\.\d+)?(?:Z))$"] = ("2024-02-29T23:59:59.5Z", "2023-02-29T00:00:00Z", "2024-02-29T23:59:59.\u0665Z"),
        [Instant + @"\.\d{6}(?:Z))$"] = ("2026-10-17T08:30:00.123456Z", "2026-10-17T08:30:00.123Z", "2026-10-17T08:30:00.12345\u0666Z"),
        [@"^(?:[01]\d|2[0-3]):[0-5]\d$"] = ("23:59", "24:00", "23:5\u0669"),
        ["^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}"
            + "|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"] =
            ("018f0000-0000-7000-8000-000000000001", "018f0000-0000-9000-8000-000000000001", null),
        ["^(event|attempt):[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"] =
            ("attempt:018f0000-0000-7000-8000-000000000001", "task:018f0000-0000-7000-8000-0", null),
    };

    [Fact]
    public void CompilesEveryPatternInTheInputSchemasWithEcmaSemantics()
    {
        var patterns = new SortedSet<string>(StringComparer.Ordinal);
        Collect(Validator.All, patterns);
        Assert.NotEmpty(patterns);
        Assert.Equal(new SortedSet<string>(Vectors.Keys, StringComparer.Ordinal), patterns);
        foreach (var source in patterns)
        {
            var pattern = EcmaPattern.Compile(source);
            var (accepted, refused, nonAsciiDigit) = Vectors[source];
            Assert.True(pattern.IsMatch(accepted), $"{source} accepts {accepted}");
            Assert.False(pattern.IsMatch(refused), $"{source} refuses {refused}");
            foreach (var terminator in new[] { "\n", "\r\n", "\r", "\u2028" })
            {
                Assert.False(pattern.IsMatch(accepted + terminator), $"{source} refuses a final line terminator");
            }

            // Without the translation, .NET accepts the value before a final \n.
            Assert.Matches(new Regex(source, RegexOptions.CultureInvariant), accepted + "\n");
            if (nonAsciiDigit is not null)
            {
                Assert.False(pattern.IsMatch(nonAsciiDigit), $"{source} refuses a non-ASCII digit");

                // Without the translation, .NET's \d accepts it.
                Assert.Matches(new Regex(source, RegexOptions.CultureInvariant), nonAsciiDigit);
            }
        }
    }

    [Fact]
    public void RewritesAnchorsAndDigitsOnlyAsTheSubsetAllows()
    {
        Assert.Equal(@"\A[\^$a-z]+\z", EcmaPattern.Translate(@"^[\^$a-z]+$"));
        Assert.Equal("(?:a|b){2,3}?", EcmaPattern.Translate("(?:a|b){2,3}?"));
        Assert.Equal(@"[\[&x]", EcmaPattern.Translate("[[&x]"));
        Assert.Equal("[0-9]{2}[a0-9]", EcmaPattern.Translate(@"\d{2}[a\d]"));
    }

    [Theory]
    [InlineData("(?=a)")]
    [InlineData("(?!a)")]
    [InlineData("(?<=a)")]
    [InlineData("(?<name>a)")]
    [InlineData(@"(a)\1")]
    [InlineData(@"\s")]
    [InlineData(@"\b")]
    [InlineData(@"\w")]
    [InlineData(@"\p{L}")]
    [InlineData(@"\u0041")]
    [InlineData("a.b")]
    [InlineData("(?i)a")]
    [InlineData("a{,2}")]
    [InlineData("*a")]
    [InlineData("a]")]
    [InlineData("[]")]
    [InlineData("(a")]
    [InlineData("a)")]
    [InlineData(@"a\")]
    [InlineData(@"[\d-a]")]
    [InlineData(@"[a-\d]")]
    [InlineData("a b")]
    public void RefusesEveryConstructOutsideTheSubset(string source) =>
        Assert.Throws<ArgumentException>(() => EcmaPattern.Translate(source));

    [Fact]
    public void ValidatesInputAgainstATranslatedPattern()
    {
        const string Id = "018f0000-0000-7000-8000-000000000001";
        Validator.Validate("taskDetail", new JsonObject { ["id"] = Id });
        Assert.Throws<InputValidationException>(() => Validator.Validate("taskDetail", new JsonObject { ["id"] = Id + "\n" }));
        Assert.Throws<InputValidationException>(() =>
            Validator.Validate("overrideMaintenancePolicy", new JsonObject
            {
                ["definition"] = new JsonObject { ["historyRetentionLocalTime"] = "0\u0663:00" },
                ["audit"] = new JsonObject { ["actor"] = "a", ["reason"] = "r", ["requestId"] = "q" },
            }));
    }

    private static void Collect(JsonNode? value, SortedSet<string> patterns)
    {
        switch (value)
        {
            case JsonObject document:
                if (document["pattern"] is JsonValue pattern && pattern.TryGetValue<string>(out var text))
                {
                    patterns.Add(text);
                }

                foreach (var (_, child) in document)
                {
                    Collect(child, patterns);
                }

                break;
            case JsonArray items:
                foreach (var item in items)
                {
                    Collect(item, patterns);
                }

                break;
            default:
                break;
        }
    }
}
