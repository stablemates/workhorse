package dev.stablemates.workhorse.internal;

import dev.stablemates.workhorse.DatabaseException;
import dev.stablemates.workhorse.DependencyCycleException;
import dev.stablemates.workhorse.DependencyLimitExceededException;
import dev.stablemates.workhorse.EnqueueIdempotencyConflictException;
import dev.stablemates.workhorse.FastTierUnsupportedException;
import dev.stablemates.workhorse.IsolationLevelException;
import dev.stablemates.workhorse.PurgeIdempotencyConflictException;
import dev.stablemates.workhorse.RedriveIdempotencyConflictException;
import dev.stablemates.workhorse.TaskGroupClosedException;
import dev.stablemates.workhorse.TaskGroupLimitExceededException;
import dev.stablemates.workhorse.TaskGroupMembershipConflictException;
import dev.stablemates.workhorse.WorkhorseException;
import java.sql.Array;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Types;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;
import org.postgresql.util.PSQLException;
import org.postgresql.util.ServerErrorMessage;

/**
 * Runs catalogue statements on a connection. Internal to the SDK; the counterpart of Ruby's {@code
 * Executor}.
 *
 * <p>Each parameter is a {@code String}, a {@code String[]} for a {@code text[]} parameter, or
 * {@code null}. The statement's SQL casts each parameter to its protocol type. The runner changes
 * no session state, and it never begins, commits, or rolls back a transaction.
 */
public final class Sql {
  private static final int FENCED_WRITE_DEADLOCK_ATTEMPTS = 3;
  private static final Pattern ISOLATION =
      Pattern.compile("^Workhorse claims require read committed isolation, not (.+)$");

  private Sql() {}

  /** The rows a statement returns. */
  public static List<Row> rows(
      Connection connection, SqlCatalogue.Statement statement, @Nullable Object... parameters) {
    if (parameters.length != statement.arity()) {
      throw new IllegalStateException(
          statement.name() + " takes " + statement.arity() + " parameters");
    }
    try (PreparedStatement prepared = connection.prepareStatement(statement.sql())) {
      for (int placeholder = 1; placeholder <= statement.placeholderCount(); placeholder++) {
        bind(
            connection,
            prepared,
            placeholder,
            parameters[statement.protocolParameter(placeholder) - 1]);
      }
      boolean results = prepared.execute();
      if (!results) {
        return List.of();
      }
      try (ResultSet resultSet = prepared.getResultSet()) {
        return read(resultSet);
      }
    } catch (SQLException error) {
      throw translate(error);
    }
  }

  /**
   * Sends a fenced write, and sends it again when PostgreSQL chose it as a deadlock victim.
   *
   * <p>PostgreSQL rolls back the whole statement, and a resend writes the same complete desired
   * set. A deadlock aborts a caller-owned transaction, so a resend there fails with {@code 25P02},
   * and the caller gets the original deadlock instead.
   */
  public static List<Row> fencedRows(
      Connection connection, SqlCatalogue.Statement statement, @Nullable Object... parameters) {
    DatabaseException deadlock = null;
    for (int attempt = 1; ; attempt++) {
      try {
        return rows(connection, statement, parameters);
      } catch (DatabaseException error) {
        if (deadlock != null && "25P02".equals(error.sqlState())) {
          throw deadlock;
        }
        if (attempt >= FENCED_WRITE_DEADLOCK_ATTEMPTS || !"40P01".equals(error.sqlState())) {
          throw error;
        }
        deadlock = error;
      }
    }
  }

  private static void bind(
      Connection connection, PreparedStatement prepared, int index, @Nullable Object value)
      throws SQLException {
    switch (value) {
      case null -> prepared.setNull(index, Types.VARCHAR);
      case String text -> prepared.setString(index, text);
      case String[] texts -> prepared.setArray(index, connection.createArrayOf("text", texts));
      default -> throw new IllegalStateException("cannot bind " + value.getClass().getName());
    }
  }

  private static List<Row> read(ResultSet resultSet) throws SQLException {
    ResultSetMetaData metadata = resultSet.getMetaData();
    int count = metadata.getColumnCount();
    List<Row> rows = new ArrayList<>();
    while (resultSet.next()) {
      Map<String, @Nullable Object> values = new LinkedHashMap<>();
      for (int column = 1; column <= count; column++) {
        values.put(metadata.getColumnLabel(column), value(resultSet, metadata, column));
      }
      rows.add(new Row(values));
    }
    return rows;
  }

  private static @Nullable Object value(ResultSet resultSet, ResultSetMetaData metadata, int column)
      throws SQLException {
    switch (metadata.getColumnTypeName(column)) {
      case "timestamptz" -> {
        OffsetDateTime time = resultSet.getObject(column, OffsetDateTime.class);
        return time == null ? null : time.toInstant();
      }
      case "_text" -> {
        Array array = resultSet.getArray(column);
        if (array == null) {
          return null;
        }
        try {
          Object[] items = (Object[]) array.getArray();
          List<String> texts = new ArrayList<>(items.length);
          for (Object item : items) {
            texts.add(String.valueOf(item));
          }
          return List.copyOf(texts);
        } finally {
          array.free();
        }
      }
      default -> {
        return resultSet.getString(column);
      }
    }
  }

  /** Maps an {@link SQLException} to the SDK's exception for its SQLSTATE. */
  public static WorkhorseException translate(SQLException error) {
    String sqlState = error.getSQLState();
    String message = error.getMessage() == null ? "database error" : error.getMessage();
    if (sqlState == null) {
      return new DatabaseException(message, null, error);
    }
    return switch (sqlState) {
      case "P1001" -> new EnqueueIdempotencyConflictException(details(error));
      case "P1002" -> new RedriveIdempotencyConflictException(details(error));
      case "P1003" -> new DependencyCycleException(details(error));
      case "P1005" -> new DependencyLimitExceededException(details(error));
      case "P1006" -> new PurgeIdempotencyConflictException(details(error));
      case "P1007" -> {
        Map<String, @Nullable Object> fields = details(error);
        yield new FastTierUnsupportedException(
            String.valueOf(fields.getOrDefault("queue", "unknown")),
            String.valueOf(fields.getOrDefault("feature", "unknown")),
            fields.get("ordinal") instanceof Long ordinal ? ordinal : null);
      }
      case "P1008" -> new TaskGroupClosedException(details(error));
      case "P1009" -> new TaskGroupLimitExceededException(details(error));
      case "P1010" -> new TaskGroupMembershipConflictException(details(error));
      case "0A000" -> {
        Matcher matcher = ISOLATION.matcher(serverMessage(error, message));
        yield matcher.matches()
            ? new IsolationLevelException(matcher.group(1), message, error)
            : new DatabaseException(message, sqlState, error);
      }
      default -> new DatabaseException(message, sqlState, error);
    };
  }

  private static String serverMessage(SQLException error, String fallback) {
    if (error instanceof PSQLException psql) {
      ServerErrorMessage server = psql.getServerErrorMessage();
      if (server != null && server.getMessage() != null) {
        return server.getMessage();
      }
    }
    return fallback;
  }

  private static Map<String, @Nullable Object> details(SQLException error) {
    String detail = null;
    if (error instanceof PSQLException psql && psql.getServerErrorMessage() != null) {
      detail = psql.getServerErrorMessage().getDetail();
    }
    if (detail == null) {
      return Map.of();
    }
    try {
      Map<String, @Nullable Object> object = Json.object(Json.parse(detail));
      return object == null ? Map.of() : object;
    } catch (IllegalArgumentException invalid) {
      return Map.of();
    }
  }

  /** The text array parameter for {@code values}. */
  public static String[] textArray(List<String> values) {
    return values.toArray(String[]::new);
  }
}
