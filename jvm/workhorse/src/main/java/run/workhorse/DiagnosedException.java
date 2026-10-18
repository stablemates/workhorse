package run.workhorse;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/**
 * The base of PostgreSQL's diagnosed refusals. {@link #details} is PostgreSQL's JSON detail,
 * decoded into a map with the JSON types of the default codec.
 */
public class DiagnosedException extends WorkhorseException {
  private static final long serialVersionUID = 1L;

  @SuppressWarnings("serial")
  private final Map<String, @Nullable Object> details;

  /** An exception with PostgreSQL's details and a message. */
  protected DiagnosedException(Map<String, @Nullable Object> details, String message) {
    super(message);
    this.details = Collections.unmodifiableMap(new LinkedHashMap<>(details));
  }

  /** PostgreSQL's JSON detail, as a map. */
  public Map<String, @Nullable Object> details() {
    return details;
  }

  /** The detail named {@code key} as text, or {@code fallback}. */
  static String text(Map<String, @Nullable Object> details, String key, String fallback) {
    Object value = details.get(key);
    return value == null ? fallback : value.toString();
  }

  /** The detail named {@code key} as a UUID, or {@code null}. */
  static @Nullable UUID uuid(Map<String, @Nullable Object> details, String key) {
    if (details.get(key) instanceof String text) {
      try {
        return UUID.fromString(text);
      } catch (IllegalArgumentException error) {
        return null;
      }
    }
    return null;
  }

  /** The detail named {@code key} as a whole number, or {@code null}. */
  static @Nullable Long number(Map<String, @Nullable Object> details, String key) {
    return details.get(key) instanceof Long value ? value : null;
  }
}
