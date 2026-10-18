package run.workhorse.internal;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import run.workhorse.WorkhorseException;

/**
 * One result row, read by column label. A {@code timestamptz} column holds an {@link Instant}, a
 * {@code text[]} column holds a {@code List<String>}, and every other column holds its text.
 */
public final class Row {
  private final Map<String, @Nullable Object> values;

  Row(Map<String, @Nullable Object> values) {
    this.values = values;
  }

  /** The text of a column, or {@code null}. */
  public @Nullable String text(String column) {
    Object value = value(column);
    return value == null ? null : value.toString();
  }

  /** The text of a column that must not be {@code null}. */
  public String requiredText(String column) {
    String value = text(column);
    if (value == null) {
      throw invalid(column);
    }
    return value;
  }

  /** A whole number column, or {@code null}. */
  public @Nullable Long longValue(String column) {
    String value = text(column);
    try {
      return value == null ? null : Long.valueOf(value);
    } catch (NumberFormatException error) {
      throw invalid(column);
    }
  }

  /** A whole number column that must not be {@code null}. */
  public long requiredLong(String column) {
    Long value = longValue(column);
    if (value == null) {
      throw invalid(column);
    }
    return value;
  }

  /** An {@code integer} column, or {@code null}. */
  public @Nullable Integer integer(String column) {
    Long value = longValue(column);
    if (value == null) {
      return null;
    }
    if (value < Integer.MIN_VALUE || value > Integer.MAX_VALUE) {
      throw invalid(column);
    }
    return value.intValue();
  }

  /** An {@code integer} column that must not be {@code null}. */
  public int requiredInteger(String column) {
    Integer value = integer(column);
    if (value == null) {
      throw invalid(column);
    }
    return value;
  }

  /** A {@code timestamptz} column, or {@code null}. */
  public @Nullable Instant instant(String column) {
    Object value = value(column);
    if (value == null || value instanceof Instant) {
      return (Instant) value;
    }
    throw invalid(column);
  }

  /** A {@code timestamptz} column that must not be {@code null}. */
  public Instant requiredInstant(String column) {
    Instant value = instant(column);
    if (value == null) {
      throw invalid(column);
    }
    return value;
  }

  /** A {@code uuid} column, or {@code null}. */
  public @Nullable UUID uuid(String column) {
    String value = text(column);
    try {
      return value == null ? null : UUID.fromString(value);
    } catch (IllegalArgumentException error) {
      throw invalid(column);
    }
  }

  /** A {@code uuid} column that must not be {@code null}. */
  public UUID requiredUuid(String column) {
    UUID value = uuid(column);
    if (value == null) {
      throw invalid(column);
    }
    return value;
  }

  /** A {@code text[]} column, or {@code null}. */
  @SuppressWarnings("unchecked")
  public @Nullable List<String> textList(String column) {
    Object value = value(column);
    if (value == null || value instanceof List<?>) {
      return (List<String>) value;
    }
    throw invalid(column);
  }

  /** A {@code jsonb} column, parsed into the core's tree, or {@code null} for SQL {@code NULL}. */
  public @Nullable Object json(String column) {
    String value = text(column);
    return value == null ? null : Json.parse(value);
  }

  private @Nullable Object value(String column) {
    if (!values.containsKey(column)) {
      throw new WorkhorseException("PostgreSQL returned no column " + column);
    }
    return values.get(column);
  }

  private static WorkhorseException invalid(String column) {
    return new WorkhorseException("PostgreSQL returned an invalid " + column + " column");
  }
}
