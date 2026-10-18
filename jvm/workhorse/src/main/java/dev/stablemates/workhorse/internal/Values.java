package dev.stablemates.workhorse.internal;

import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;

/** Encodes the times and durations that cross the protocol. Internal to the SDK. */
public final class Values {
  private static final DateTimeFormatter TIMESTAMP =
      DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);

  private Values() {}

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
