using Npgsql;
using Workhorse.Internal.Json;
using Workhorse.Tests.Testing;

namespace Workhorse.Tests.Internal.Json;

/// <summary><see cref="JsonbSize"/> against the length of the <c>jsonb</c> text of PostgreSQL.</summary>
public sealed class JsonbSizeTests(ScratchDatabase database)
{
    public static TheoryData<string> Documents() =>
    [
        "null", "true", "false", "0", "-0", "-0.0", "12", "-12", "1.50", "1e2", "1E-2", "1.5e1", "0.000",
        "123.456e-1", "\"plain\"", "\"quote \\\" and backslash \\\\\"", "\"tab\\t newline\\n bell\\u0007\"",
        "\"café \\u00e9 \\ud83d\\ude00 中\"", "\"\\/slash\"", "[]", "{}", "[1, 2, [3, {}]]",
        "{\"b\": 1, \"a\": [true, null]}", "{\"k\": 1, \"k\": \"last wins\"}", " { \"spaced\" : [ 1 , 2 ] } ",
        "{\"orderId\":7,\"note\":\"\\u00e9t\\u00e9\"}", "1.2345678901234567890123e5",
    ];

    [Theory]
    [MemberData(nameof(Documents))]
    public async Task MeasuresWhatPostgreSqlStores(string document)
    {
        await using var command = database.DataSource.CreateCommand("SELECT octet_length(($1::jsonb)::text)");
        command.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlTypes.NpgsqlDbType.Text, Value = document });
        var expected = (int)(await command.ExecuteScalarAsync(TestContext.Current.CancellationToken))!;
        Assert.Equal(expected, JsonbSize.Of(document));
    }

    [Theory]
    [InlineData("{\"a\":1,\"b\":[1,2]}", 21)]
    [InlineData("\"é\"", 4)]
    [InlineData("-0.0", 3)]
    public void MeasuresWithoutADatabase(string document, long expected) =>
        Assert.Equal(expected, JsonbSize.Of(document));

    [Theory]
    [InlineData("[1, 2")]
    [InlineData("1 2")]
    public void RefusesTextThatIsNotOneJsonValue(string document) =>
        Assert.Throws<ArgumentException>(() => JsonbSize.Of(document));
}
