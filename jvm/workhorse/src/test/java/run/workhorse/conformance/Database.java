package run.workhorse.conformance;

import java.math.BigInteger;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;
import org.postgresql.PGConnection;
import org.postgresql.util.PSQLException;
import org.postgresql.util.ServerErrorMessage;
import run.workhorse.internal.Json;

/**
 * The translation between fixture JSON and PostgreSQL values. The counterpart of Ruby's {@code
 * Conformance::Database}.
 *
 * <p>A scenario step is SQL with {@code $n} parameters, as libpq takes it. PgJDBC takes {@code ?}
 * parameters, so the runner sends the step through {@code PREPARE}, reads the parameter types that
 * PostgreSQL inferred from {@code pg_prepared_statements}, and binds each value as a text literal
 * in {@code EXECUTE}. A literal of unknown type takes the parameter's type, as a text-format
 * parameter does in libpq. Every value travels in text form.
 */
final class Database {
  private static final String STEP = "conformance_step";
  private static final Pattern OFFSET =
      Pattern.compile(
          "^(\\d{4,}-\\d{2}-\\d{2}) (\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?)([+-]\\d{2})(?::(\\d{2}))?(?::(\\d{2}))?$");
  private static final Pattern LOCAL =
      Pattern.compile("^(\\d{4,}-\\d{2}-\\d{2}) (\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?)$");
  private static final Map<String, BigInteger[]> INTEGER_RANGES =
      Map.of("smallint", range(15), "integer", range(31), "bigint", range(63));
  private static final List<String> TEXTUAL =
      List.of(
          "text",
          "character varying",
          "name",
          "character",
          "unknown",
          "uuid",
          "timestamp with time zone",
          "time without time zone");

  private Database() {}

  /** A statement's rows, or the PostgreSQL error it raised. */
  record Result(
      @Nullable List<Map<String, @Nullable Object>> rows, @Nullable PSQLException error) {}

  /** Makes PgJDBC keep every result in text form on {@code connection}. */
  static void textResults(Connection connection) throws SQLException {
    connection.unwrap(PGConnection.class).setPrepareThreshold(0);
  }

  /**
   * Prepares and runs one scenario step. Preparing is part of the statement: a fixture may expect
   * PostgreSQL to reject it.
   */
  static Result execute(Connection connection, String sql, List<?> values, String location)
      throws SQLException {
    try (Statement statement = connection.createStatement()) {
      try {
        statement.execute("PREPARE " + STEP + " AS " + sql);
      } catch (PSQLException error) {
        return new Result(null, error);
      }
      try {
        List<String> types = new ArrayList<>();
        try (ResultSet described =
            statement.executeQuery(
                "SELECT unnest(parameter_types)::text FROM pg_prepared_statements"
                    + " WHERE name = '"
                    + STEP
                    + "'")) {
          while (described.next()) {
            types.add(described.getString(1));
          }
        }
        if (types.size() != values.size()) {
          throw new Failure(
              location
                  + ": statement takes "
                  + types.size()
                  + " parameters, fixture gives "
                  + values.size());
        }
        StringBuilder call = new StringBuilder("EXECUTE " + STEP);
        for (int index = 0; index < types.size(); index++) {
          String text;
          try {
            text = parameter(values.get(index), types.get(index));
          } catch (Failure failure) {
            throw new Failure(location + ": " + failure.getMessage());
          }
          call.append(index == 0 ? "(" : ", ").append(text == null ? "NULL" : literal(text));
        }
        if (!types.isEmpty()) {
          call.append(')');
        }
        try {
          if (!statement.execute(call.toString())) {
            return new Result(List.of(), null);
          }
        } catch (PSQLException error) {
          return new Result(null, error);
        }
        try (ResultSet resultSet = statement.getResultSet()) {
          try {
            return new Result(rows(resultSet), null);
          } catch (Failure failure) {
            throw new Failure(location + ": " + failure.getMessage());
          }
        }
      } finally {
        statement.execute("DEALLOCATE " + STEP);
      }
    }
  }

  /** A driver error with the database's own message when PostgreSQL produced it. */
  static String describe(SQLException error) {
    ServerErrorMessage server =
        error instanceof PSQLException postgres ? postgres.getServerErrorMessage() : null;
    if (server == null || server.getSQLState() == null) {
      return String.valueOf(error.getMessage()).strip();
    }
    return server.getMessage() + " (" + server.getSQLState() + ")";
  }

  /** The error shape the fixtures compare: SQLSTATE, primary message, JSON detail, and raw hint. */
  static Map<String, @Nullable Object> databaseError(PSQLException error) {
    ServerErrorMessage server = error.getServerErrorMessage();
    if (server == null || server.getSQLState() == null) {
      throw new Failure("expected a database error, received " + describe(error));
    }
    Map<String, @Nullable Object> actual = new LinkedHashMap<>();
    actual.put("code", server.getSQLState());
    actual.put("message", server.getMessage());
    String detail = server.getDetail();
    if (detail != null) {
      try {
        actual.put("detail", Json.parse(detail));
      } catch (IllegalArgumentException parse) {
        throw new Failure("error detail is not JSON (" + parse.getMessage() + "): " + detail);
      }
    }
    String hint = server.getHint();
    if (hint != null) {
      actual.put("hint", hint);
    }
    return actual;
  }

  /** The text form of one parameter, or {@code null} for SQL {@code NULL}. */
  static @Nullable String parameter(@Nullable Object value, String type) {
    Failure mismatch = new Failure("cannot bind " + Matcher.render(value) + " as type " + type);
    if (type.equals("json") || type.equals("jsonb")) {
      // A string bound to JSON is JSON text, as psycopg and pgx send it.
      if (value instanceof String text) {
        try {
          Json.parse(text);
        } catch (IllegalArgumentException error) {
          throw mismatch;
        }
        return text;
      }
      return value == null ? null : Json.write(value);
    }
    if (value == null) {
      return null;
    }
    BigInteger[] range = INTEGER_RANGES.get(type);
    if (range != null) {
      BigInteger integer =
          switch (value) {
            case Long number -> BigInteger.valueOf(number);
            case BigInteger number -> number;
            default -> throw mismatch;
          };
      if (integer.compareTo(range[0]) < 0 || integer.compareTo(range[1]) > 0) {
        throw mismatch;
      }
      return integer.toString();
    }
    return switch (type) {
      case "boolean" -> {
        if (!(value instanceof Boolean flag)) {
          throw mismatch;
        }
        yield flag ? "t" : "f";
      }
      case "double precision" -> {
        if (!(value instanceof Number number)) {
          throw mismatch;
        }
        yield Double.toString(number.doubleValue());
      }
      case "text[]" -> {
        if (!(value instanceof List<?> list) || !list.stream().allMatch(String.class::isInstance)) {
          throw mismatch;
        }
        StringBuilder array = new StringBuilder("{");
        for (Object item : list) {
          if (array.length() > 1) {
            array.append(',');
          }
          array
              .append('"')
              .append(((String) item).replace("\\", "\\\\").replace("\"", "\\\""))
              .append('"');
        }
        yield array.append('}').toString();
      }
      default -> {
        if (!TEXTUAL.contains(type)) {
          throw new Failure("the JVM runner cannot bind parameters of type " + type);
        }
        if (!(value instanceof String text)) {
          throw mismatch;
        }
        yield text;
      }
    };
  }

  /** Every row as the normalized JSON the fixtures compare. */
  static List<Map<String, @Nullable Object>> rows(ResultSet resultSet) throws SQLException {
    ResultSetMetaData meta = resultSet.getMetaData();
    List<Map<String, @Nullable Object>> rows = new ArrayList<>();
    while (resultSet.next()) {
      Map<String, @Nullable Object> row = new LinkedHashMap<>();
      for (int column = 1; column <= meta.getColumnCount(); column++) {
        row.put(
            meta.getColumnLabel(column),
            cell(resultSet.getString(column), meta.getColumnTypeName(column)));
      }
      rows.add(row);
    }
    return rows;
  }

  /** One cell, by the type name PgJDBC reports. */
  static @Nullable Object cell(@Nullable String text, String type) {
    // The fixtures record a void result as an empty string, which is how psycopg reads one.
    if (type.equals("void")) {
      return "";
    }
    if (text == null) {
      return null;
    }
    return switch (type) {
      case "bool" -> text.equals("t") || text.equals("true");
      case "int2", "int4", "int8" -> Long.parseLong(text);
      case "float4", "float8" -> {
        double value = Double.parseDouble(text);
        // A non-finite float has no JSON form, so it decodes as null.
        yield Double.isFinite(value) ? value : null;
      }
      case "numeric" -> numeric(text);
      case "text", "varchar", "name", "bpchar" -> text;
      case "uuid" -> text.toLowerCase(java.util.Locale.ROOT);
      case "timestamptz" -> Matcher.normalizeTimestamp(instant(text));
      case "timestamp" -> {
        java.util.regex.Matcher match = LOCAL.matcher(text);
        if (!match.matches()) {
          throw new Failure("cannot decode timestamp " + text);
        }
        String normalized =
            Matcher.normalizeTimestamp(
                OffsetDateTime.parse(match.group(1) + "T" + match.group(2) + "Z").toInstant());
        yield normalized.substring(0, normalized.length() - 1);
      }
      case "json", "jsonb" -> Json.parse(text);
      case "_int4", "_int8", "_text", "_uuid", "_jsonb" -> {
        String element = type.substring(1);
        List<@Nullable Object> items = new ArrayList<>();
        for (String item : array(text)) {
          items.add(cell(item, element));
        }
        yield items;
      }
      default -> throw new Failure("the JVM runner cannot decode column type " + type);
    };
  }

  /** A {@code timestamptz} in PostgreSQL's ISO text output. */
  static Instant instant(String text) {
    java.util.regex.Matcher match = OFFSET.matcher(text);
    if (!match.matches()) {
      throw new Failure("cannot decode timestamptz " + text);
    }
    // PostgreSQL writes an offset as hours, then minutes and seconds only when they are not zero.
    String minutes = match.group(4) == null ? "00" : match.group(4);
    String seconds = match.group(5) == null ? "" : ":" + match.group(5);
    return OffsetDateTime.parse(
            match.group(1) + "T" + match.group(2) + match.group(3) + ":" + minutes + seconds)
        .toInstant();
  }

  /** The microseconds since the epoch of an instant, rounded down. */
  static long microseconds(Instant instant) {
    return Math.floorDiv(instant.getEpochSecond() * 1_000_000_000L + instant.getNano(), 1_000L);
  }

  private static Object numeric(String text) {
    if (text.equals("NaN")) {
      throw new Failure("NaN numeric has no JSON form");
    }
    int point = text.indexOf('.');
    if (point < 0 || text.substring(point + 1).matches("0*")) {
      String whole = point < 0 ? text : text.substring(0, point);
      BigInteger value = new BigInteger(whole);
      return value.bitLength() < 64 ? (Object) value.longValue() : value;
    }
    return Double.parseDouble(text);
  }

  /** The elements of a one-dimensional array in PostgreSQL's text output. */
  private static List<@Nullable String> array(String text) {
    if (!text.startsWith("{") || !text.endsWith("}")) {
      throw new Failure("cannot decode array " + text);
    }
    List<@Nullable String> items = new ArrayList<>();
    String body = text.substring(1, text.length() - 1);
    if (body.isEmpty()) {
      return items;
    }
    StringBuilder current = new StringBuilder();
    boolean quoted = false;
    boolean wasQuoted = false;
    for (int index = 0; index < body.length(); index++) {
      char character = body.charAt(index);
      if (quoted) {
        if (character == '\\') {
          current.append(body.charAt(++index));
        } else if (character == '"') {
          quoted = false;
        } else {
          current.append(character);
        }
      } else if (character == '"') {
        quoted = true;
        wasQuoted = true;
      } else if (character == ',') {
        items.add(element(current.toString(), wasQuoted));
        current.setLength(0);
        wasQuoted = false;
      } else {
        current.append(character);
      }
    }
    items.add(element(current.toString(), wasQuoted));
    return items;
  }

  private static @Nullable String element(String text, boolean quoted) {
    return !quoted && text.equals("NULL") ? null : text;
  }

  private static String literal(String text) {
    return "'" + text.replace("'", "''") + "'";
  }

  private static BigInteger[] range(int bits) {
    BigInteger limit = BigInteger.TWO.pow(bits);
    return new BigInteger[] {limit.negate(), limit.subtract(BigInteger.ONE)};
  }
}
