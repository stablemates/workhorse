package run.workhorse;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.time.Duration;
import java.util.List;
import java.util.function.BiFunction;
import org.junit.jupiter.api.Test;
import run.workhorse.testing.ScratchDataSource;

/**
 * SM-1668 PAR-09 (ADR 0112). With a live subscription, an explicit poll interval is the fallback
 * interval, so the 5,000 ms cap does not apply; without one, the cap applies before the jitter. A
 * registered worker cuts the wait to its registry interval. The maintenance, routine, and registry
 * intervals accept 100 through 2,147,483,647 ms. Building a worker opens no connection.
 */
class WorkerIntervalBoundariesTest {
  private static Worker.Builder builder() {
    return Worker.builder(new ScratchDataSource(true)).queues("default");
  }

  @Test
  void capsAnExplicitPollIntervalOnlyWhileTheWorkerPolls() {
    assertEquals(27_000, Worker.dispatchWaitMillis(true, 4, 30_000, 30_000, 0, 0.9));
    assertEquals(33_000, Worker.dispatchWaitMillis(true, 4, 30_000, 30_000, 0, 1.1));
    assertEquals(4_500, Worker.dispatchWaitMillis(false, 4, 30_000, 30_000, 0, 0.9));
    assertEquals(5_500, Worker.dispatchWaitMillis(false, 4, 30_000, 30_000, 0, 1.1));
  }

  @Test
  void cutsTheJitteredWaitToTheRegistryInterval() {
    assertEquals(5_000, Worker.dispatchWaitMillis(true, 4, 30_000, 30_000, 5_000, 0.9));
    assertEquals(5_000, Worker.dispatchWaitMillis(false, 4, 30_000, 30_000, 5_000, 1.1));
  }

  @Test
  void acceptsAnIntervalFrom100MsThroughTheSqlIntegerLimit() {
    for (Duration accepted :
        List.of(
            Duration.ofMillis(100),
            Duration.ofNanos(99_500_000),
            Duration.ofMillis(Integer.MAX_VALUE))) {
      assertDoesNotThrow(
          () ->
              builder()
                  .maintenanceInterval(accepted)
                  .maintenanceRoutineInterval(accepted)
                  .registryInterval(accepted)
                  .build(),
          accepted::toString);
    }
  }

  @Test
  void refusesAnIntervalOutsideTheRange() {
    List<BiFunction<Worker.Builder, Duration, Worker.Builder>> options =
        List.of(
            Worker.Builder::maintenanceInterval,
            Worker.Builder::maintenanceRoutineInterval,
            Worker.Builder::registryInterval);
    for (BiFunction<Worker.Builder, Duration, Worker.Builder> option : options) {
      for (Duration refused :
          List.of(
              Duration.ZERO,
              Duration.ofMillis(99),
              Duration.ofMillis(Integer.MAX_VALUE + 1L),
              Duration.ofMillis(-100))) {
        assertThrows(
            IllegalArgumentException.class,
            () -> option.apply(builder(), refused),
            refused::toString);
      }
    }
  }
}
