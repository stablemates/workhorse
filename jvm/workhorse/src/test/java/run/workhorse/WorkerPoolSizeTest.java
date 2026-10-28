package run.workhorse;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import run.workhorse.testing.ScratchDataSource;

/**
 * SM-1902: a worker needs a pool of at least 3 connections: the listener, the heartbeat connection,
 * and one statement. A {@code DataSource} reports no pool size, so only a declared {@code
 * poolMaxSize} can fail the build. Without a declared size, the readiness check at startup is the
 * guard ({@code WorkerPoolDatabaseTest}). Building a worker opens no connection.
 */
class WorkerPoolSizeTest {
  private static Worker.Builder builder() {
    return Worker.builder(new ScratchDataSource(true)).queues("default");
  }

  @ParameterizedTest
  @ValueSource(ints = {1, 2})
  void refusesADeclaredPoolBelowThree(int size) {
    String expected =
        "Worker needs a pool with a known maximum size of at least 3 connections (found "
            + size
            + "). Give the worker a pool with a maximum size of at least 3.";
    for (boolean pollingOnly : new boolean[] {false, true}) {
      IllegalArgumentException refusal =
          assertThrows(
              IllegalArgumentException.class,
              () -> builder().pollingOnly(pollingOnly).poolMaxSize(size).build());
      assertEquals(expected, refusal.getMessage());
      assertFalse(refusal.getMessage().contains("sharedHeartbeats"), refusal.getMessage());
    }
  }

  @ParameterizedTest
  @ValueSource(ints = {3, 4})
  void buildsOnADeclaredPoolOfThreeOrMore(int size) {
    assertDoesNotThrow(() -> builder().poolMaxSize(size).build());
  }

  @Test
  void buildsWithoutADeclaredSizeAndRefusesASizeBelowOne() {
    assertDoesNotThrow(() -> builder().build());
    assertThrows(IllegalArgumentException.class, () -> builder().poolMaxSize(0));
  }
}
