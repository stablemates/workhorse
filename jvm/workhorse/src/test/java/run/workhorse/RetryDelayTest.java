package run.workhorse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.time.Duration;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * SM-1668 PAR-06: {@code fail_v1} takes an integer, so a retry delay override ends at 2,147,483,647
 * ms. The worker rounds half up and refuses a value outside the range (ADR 0111).
 */
class RetryDelayTest {
  private static final Duration LIMIT = Duration.ofMillis(Integer.MAX_VALUE);

  @Test
  void sendsTheLimitZeroAndAFractionRoundedHalfUp() {
    assertEquals(Integer.MAX_VALUE, Worker.retryDelayMilliseconds(LIMIT));
    assertEquals(Integer.MAX_VALUE, Worker.retryDelayMilliseconds(LIMIT.plusNanos(499_999)));
    assertEquals(0, Worker.retryDelayMilliseconds(Duration.ZERO));
    assertEquals(1, Worker.retryDelayMilliseconds(Duration.ofNanos(1_400_000)));
    assertEquals(2, Worker.retryDelayMilliseconds(Duration.ofNanos(1_500_000)));
  }

  @Test
  void refusesOneAboveTheLimitAndEveryNegativeDelay() {
    for (Duration refused :
        List.of(
            Duration.ofMillis(Integer.MAX_VALUE + 1L),
            LIMIT.plusNanos(500_000),
            Duration.ofMillis(-1),
            Duration.ofNanos(-1),
            Duration.ofSeconds(Long.MAX_VALUE))) {
      assertThrows(
          IllegalArgumentException.class,
          () -> Worker.retryDelayMilliseconds(refused),
          refused::toString);
    }
  }
}
