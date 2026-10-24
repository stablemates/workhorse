package run.workhorse;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.time.Duration;
import java.util.List;
import org.junit.jupiter.api.Test;
import run.workhorse.testing.ScratchDataSource;

/**
 * SM-1668 PAR-09: the JVM accepts a shutdown grace from 0 through 1 day after half-up rounding. A
 * zero grace waits for no handler, and the whole stop ends within the 250 ms unwind window.
 * Building a worker opens no connection.
 */
class WorkerShutdownGraceTest {
  private static Worker.Builder builder() {
    return Worker.builder(new ScratchDataSource(true)).queues("default");
  }

  @Test
  void acceptsZeroAndOneDay() {
    for (Duration accepted :
        List.of(
            Duration.ZERO, Duration.ofNanos(499_999), Duration.ofMillis(1), Duration.ofDays(1))) {
      assertDoesNotThrow(() -> builder().shutdownGrace(accepted).build(), accepted::toString);
    }
  }

  @Test
  void refusesANegativeGraceAndOneAboveOneDay() {
    for (Duration refused :
        List.of(Duration.ofMillis(-1), Duration.ofNanos(-1), Duration.ofDays(1).plusMillis(1))) {
      assertThrows(
          IllegalArgumentException.class,
          () -> builder().shutdownGrace(refused),
          refused::toString);
    }
  }
}
