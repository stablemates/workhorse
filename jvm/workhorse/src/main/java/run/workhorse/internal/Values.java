package run.workhorse.internal;

import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/** Encodes the times and durations that cross the protocol. Internal to the SDK. */
public final class Values {
  private static final DateTimeFormatter TIMESTAMP =
      DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);

  private Values() {}

  /**
   * An unmodifiable copy of {@code map}, in its iteration order. A nested map or list is copied the
   * same way, so a later change to the caller's value changes no copy. A {@code null} value stays.
   */
  public static <K, V> @Nullable Map<K, V> deepCopy(@Nullable Map<K, V> map) {
    @SuppressWarnings("unchecked")
    Map<K, V> copy = map == null ? null : (Map<K, V>) copyValue(map);
    return copy;
  }

  private static @Nullable Object copyValue(@Nullable Object value) {
    if (value instanceof Map<?, ?> map) {
      Map<Object, @Nullable Object> copy = new LinkedHashMap<>();
      for (Map.Entry<?, ?> entry : map.entrySet()) {
        copy.put(entry.getKey(), copyValue(entry.getValue()));
      }
      return Collections.unmodifiableMap(copy);
    }
    if (value instanceof List<?> list) {
      List<@Nullable Object> copy = new ArrayList<>(list.size());
      for (Object item : list) {
        copy.add(copyValue(item));
      }
      return Collections.unmodifiableList(copy);
    }
    return value;
  }

  /** The protocol's timestamp text for an instant, in UTC with milliseconds. */
  public static String timestamp(Instant instant) {
    return TIMESTAMP.format(instant.truncatedTo(ChronoUnit.MILLIS));
  }

  /**
   * Whole milliseconds of a duration, rounded half up, within {@code minimum} and {@code maximum}
   * milliseconds.
   *
   * @throws IllegalArgumentException if the duration is outside the range
   */
  public static long milliseconds(Duration duration, String label, long minimum, long maximum) {
    long milliseconds;
    try {
      milliseconds = duration.plusNanos(500_000).truncatedTo(ChronoUnit.MILLIS).toMillis();
    } catch (ArithmeticException overflow) {
      milliseconds = Long.MAX_VALUE;
    }
    if (duration.isNegative() || milliseconds < minimum || milliseconds > maximum) {
      throw new IllegalArgumentException(
          label
              + " must be a Duration between "
              + seconds(minimum)
              + " and "
              + seconds(maximum)
              + " seconds");
    }
    return milliseconds;
  }

  /** A duration of whole milliseconds. */
  public static Duration duration(long milliseconds) {
    return Duration.ofMillis(milliseconds);
  }

  private static String seconds(long milliseconds) {
    return java.math.BigDecimal.valueOf(milliseconds, 3).stripTrailingZeros().toPlainString();
  }
}
