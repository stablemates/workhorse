using System.Globalization;
using System.Numerics;
using System.Text;
using System.Text.RegularExpressions;
using Npgsql;

namespace Workhorse.Tests.Conformance;

/// <summary>
/// The translation between fixture JSON and PostgreSQL values. The counterpart of the JVM
/// <c>Database</c>.
/// </summary>
/// <remarks>
/// A scenario step is SQL with <c>$n</c> parameters, as libpq takes it. The runner sends the step
/// through <c>PREPARE</c>, reads the parameter types that PostgreSQL inferred from
/// <c>pg_prepared_statements</c>, and binds each value as a text literal in <c>EXECUTE</c>. A literal
/// of unknown type takes the parameter's type, as a text-format parameter does in libpq. Every value
/// travels in text form: each command sets <see cref="NpgsqlCommand.AllResultTypesAreUnknown"/>, so
/// Npgsql reads every column as PostgreSQL's text output.
/// </remarks>
internal static partial class Database
{
    private const string Step = "conformance_step";

    private static readonly Dictionary<string, (BigInteger Minimum, BigInteger Maximum)> IntegerRanges = new(StringComparer.Ordinal)
    {
        ["smallint"] = Range(15),
        ["integer"] = Range(31),
        ["bigint"] = Range(63),
    };

    private static readonly HashSet<string> Textual = new(
        ["text", "character varying", "name", "character", "unknown", "uuid", "timestamp with time zone", "time without time zone"],
        StringComparer.Ordinal);

    /// <summary>A statement's rows, or the PostgreSQL error it raised.</summary>
    internal sealed record Result(List<object?>? Rows, PostgresException? Error);

    /// <summary>
    /// Prepares and runs one scenario step. Preparing is part of the statement: a fixture may expect
    /// PostgreSQL to reject it.
    /// </summary>
    internal static Result Execute(NpgsqlConnection connection, string sql, List<object?> values, string location)
    {
        try
        {
            Run(connection, $"PREPARE {Step} AS {sql}");
        }
        catch (PostgresException error)
        {
            return new Result(null, error);
        }

        try
        {
            var types = Rows(connection, $"SELECT unnest(parameter_types)::text AS type FROM pg_prepared_statements WHERE name = '{Step}'")
                .Select(row => (string)Json.Object(row)!["type"]!)
                .ToList();
            if (types.Count != values.Count)
            {
                throw new Failure($"{location}: statement takes {types.Count} parameters, fixture gives {values.Count}");
            }

            var call = new StringBuilder($"EXECUTE {Step}");
            for (var index = 0; index < types.Count; index++)
            {
                string? text;
                try
                {
                    text = Parameter(values[index], types[index]);
                }
                catch (Failure failure)
                {
                    throw new Failure($"{location}: {failure.Message}");
                }

                call.Append(index == 0 ? "(" : ", ").Append(text is null ? "NULL" : Literal(text));
            }

            if (types.Count > 0)
            {
                call.Append(')');
            }

            try
            {
                return new Result(Rows(connection, call.ToString(), location), null);
            }
            catch (PostgresException error)
            {
                return new Result(null, error);
            }
        }
        finally
        {
            Run(connection, $"DEALLOCATE {Step}");
        }
    }

    /// <summary>A driver error with the database's own message when PostgreSQL produced it.</summary>
    internal static string Describe(Exception error) =>
        (error as PostgresException ?? error.InnerException as PostgresException) is { } postgres
            ? $"{postgres.MessageText} ({postgres.SqlState})"
            : error.Message.Trim();

    /// <summary>The error shape that the fixtures compare: SQLSTATE, primary message, JSON detail, and raw hint.</summary>
    internal static OrderedDictionary<string, object?> DatabaseError(PostgresException error)
    {
        var actual = Json.Members(("code", error.SqlState), ("message", error.MessageText));
        if (error.Detail is { } detail)
        {
            try
            {
                actual["detail"] = Json.Parse(detail);
            }
            catch (System.Text.Json.JsonException parse)
            {
                throw new Failure($"error detail is not JSON ({parse.Message}): {detail}");
            }
        }

        if (error.Hint is { } hint)
        {
            actual["hint"] = hint;
        }

        return actual;
    }

    /// <summary>The text form of one parameter, or <c>null</c> for SQL <c>NULL</c>.</summary>
    internal static string? Parameter(object? value, string type)
    {
        var mismatch = new Failure($"cannot bind {Matcher.Render(value)} as type {type}");
        if (type is "json" or "jsonb")
        {
            // A string bound to JSON is JSON text, as psycopg and pgx send it.
            if (value is string text)
            {
                try
                {
                    Json.Parse(text);
                }
                catch (System.Text.Json.JsonException)
                {
                    throw mismatch;
                }

                return text;
            }

            return value is null ? null : Json.Write(value);
        }

        if (value is null)
        {
            return null;
        }

        if (IntegerRanges.TryGetValue(type, out var range))
        {
            BigInteger integer = value switch
            {
                long number => number,
                BigInteger number => number,
                _ => throw mismatch,
            };
            return integer < range.Minimum || integer > range.Maximum ? throw mismatch : integer.ToString(CultureInfo.InvariantCulture);
        }

        switch (type)
        {
            case "boolean":
                return value is bool flag ? (flag ? "t" : "f") : throw mismatch;
            case "double precision":
                return value switch
                {
                    long number => number.ToString(CultureInfo.InvariantCulture),
                    BigInteger number => ((double)number).ToString("R", CultureInfo.InvariantCulture),
                    double number => number.ToString("R", CultureInfo.InvariantCulture),
                    _ => throw mismatch,
                };
            case "text[]":
                if (value is not List<object?> list || !list.All(item => item is string))
                {
                    throw mismatch;
                }

                return "{" + string.Join(',', list.Select(item => "\"" + ((string)item!).Replace("\\", "\\\\", StringComparison.Ordinal).Replace("\"", "\\\"", StringComparison.Ordinal) + "\"")) + "}";
            default:
                if (!Textual.Contains(type))
                {
                    throw new Failure($"the .NET runner cannot bind parameters of type {type}");
                }

                return value as string ?? throw mismatch;
        }
    }

    /// <summary>Every row of <paramref name="sql"/>, as the normalized JSON the fixtures compare.</summary>
    internal static List<object?> Rows(NpgsqlConnection connection, string sql, string? location = null)
    {
        using var command = new NpgsqlCommand(sql, connection) { AllResultTypesAreUnknown = true };
        using var reader = command.ExecuteReader();
        var rows = new List<object?>();
        while (reader.Read())
        {
            var row = new OrderedDictionary<string, object?>(StringComparer.Ordinal);
            for (var column = 0; column < reader.FieldCount; column++)
            {
                try
                {
                    row[reader.GetName(column)] = Cell(reader.IsDBNull(column) ? null : reader.GetString(column), reader.GetPostgresType(column).InternalName);
                }
                catch (Failure failure) when (location is not null)
                {
                    throw new Failure($"{location}: {failure.Message}");
                }
            }

            rows.Add(row);
        }

        return rows;
    }

    /// <summary>Runs one statement whose rows the runner does not read.</summary>
    internal static void Run(NpgsqlConnection connection, string sql)
    {
        using var command = new NpgsqlCommand(sql, connection);
        command.ExecuteNonQuery();
    }

    /// <summary>One cell, by the internal type name that PostgreSQL reports.</summary>
    internal static object? Cell(string? text, string type)
    {
        // The fixtures record a void result as an empty string, which is how psycopg reads one.
        if (type == "void")
        {
            return "";
        }

        if (text is null)
        {
            return null;
        }

        switch (type)
        {
            case "bool":
                return text is "t" or "true";
            case "int2" or "int4" or "int8":
                return long.Parse(text, CultureInfo.InvariantCulture);
            case "float4" or "float8":
                var value = double.Parse(text, CultureInfo.InvariantCulture);

                // A non-finite float has no JSON form, so it decodes as null.
                return double.IsFinite(value) ? value : null;
            case "numeric":
                return Numeric(text);
            case "text" or "varchar" or "name" or "bpchar":
                return text;
            case "uuid":
                return text.ToLowerInvariant();
            case "timestamptz":
                return Matcher.NormalizeTimestamp(Instant(text));
            case "timestamp":
                var local = LocalPattern().Match(text);
                if (!local.Success)
                {
                    throw new Failure($"cannot decode timestamp {text}");
                }

                var normalized = Matcher.NormalizeTimestamp(Instant($"{local.Groups[1].Value} {local.Groups[2].Value}+00"));
                return normalized[..^1];
            case "json" or "jsonb":
                return Json.Parse(text);
            case "_int4" or "_int8" or "_text" or "_uuid" or "_jsonb":
                return Array(text).Select(item => Cell(item, type[1..])).ToList();
            default:
                throw new Failure($"the .NET runner cannot decode column type {type}");
        }
    }

    /// <summary>A <c>timestamptz</c> in PostgreSQL's ISO text output.</summary>
    internal static DateTimeOffset Instant(string text)
    {
        var match = OffsetPattern().Match(text);
        if (!match.Success)
        {
            throw new Failure($"cannot decode timestamptz {text}");
        }

        // PostgreSQL writes an offset as hours, then minutes and seconds only when they are not zero.
        var minutes = match.Groups[4].Success ? match.Groups[4].Value : "00";
        var fraction = match.Groups[2].Value.Contains('.', StringComparison.Ordinal) ? match.Groups[2].Value : match.Groups[2].Value + ".0";
        var whole = fraction[..(fraction.IndexOf('.', StringComparison.Ordinal) + 1)] + fraction[(fraction.IndexOf('.', StringComparison.Ordinal) + 1)..].PadRight(7, '0')[..7];
        var instant = DateTimeOffset.ParseExact(
            $"{match.Groups[1].Value}T{whole}{match.Groups[3].Value}:{minutes}",
            "yyyy-MM-dd'T'HH:mm:ss.fffffffzzz",
            CultureInfo.InvariantCulture);
        return match.Groups[5].Success
            ? instant.AddSeconds(-Math.Sign(int.Parse(match.Groups[3].Value, CultureInfo.InvariantCulture)) * int.Parse(match.Groups[5].Value, CultureInfo.InvariantCulture))
            : instant;
    }

    /// <summary>The microseconds since the epoch of an instant.</summary>
    internal static long Microseconds(DateTimeOffset instant) => (instant.UtcTicks - DateTimeOffset.UnixEpoch.UtcTicks) / 10;

    private static object Numeric(string text)
    {
        if (text == "NaN")
        {
            throw new Failure("NaN numeric has no JSON form");
        }

        var point = text.IndexOf('.', StringComparison.Ordinal);
        if (point < 0 || text[(point + 1)..].All(character => character == '0'))
        {
            return Json.Number(point < 0 ? text : text[..point]);
        }

        return double.Parse(text, CultureInfo.InvariantCulture);
    }

    /// <summary>The elements of a one-dimensional array in PostgreSQL's text output.</summary>
    private static List<string?> Array(string text)
    {
        if (!text.StartsWith('{') || !text.EndsWith('}'))
        {
            throw new Failure($"cannot decode array {text}");
        }

        var items = new List<string?>();
        var body = text[1..^1];
        if (body.Length == 0)
        {
            return items;
        }

        var current = new StringBuilder();
        var quoted = false;
        var wasQuoted = false;
        for (var index = 0; index < body.Length; index++)
        {
            var character = body[index];
            if (quoted)
            {
                if (character == '\\')
                {
                    current.Append(body[++index]);
                }
                else if (character == '"')
                {
                    quoted = false;
                }
                else
                {
                    current.Append(character);
                }
            }
            else if (character == '"')
            {
                quoted = true;
                wasQuoted = true;
            }
            else if (character == ',')
            {
                items.Add(Element(current.ToString(), wasQuoted));
                current.Clear();
                wasQuoted = false;
            }
            else
            {
                current.Append(character);
            }
        }

        items.Add(Element(current.ToString(), wasQuoted));
        return items;
    }

    private static string? Element(string text, bool quoted) => !quoted && text == "NULL" ? null : text;

    private static string Literal(string text) => "'" + text.Replace("'", "''", StringComparison.Ordinal) + "'";

    private static (BigInteger Minimum, BigInteger Maximum) Range(int bits)
    {
        var limit = BigInteger.Pow(2, bits);
        return (-limit, limit - 1);
    }

    [GeneratedRegex(@"^(\d{4,}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2})(?::(\d{2}))?(?::(\d{2}))?$")]
    private static partial Regex OffsetPattern();

    [GeneratedRegex(@"^(\d{4,}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$")]
    private static partial Regex LocalPattern();
}
