package run.workhorse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.util.Collections;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

/**
 * SM-1639: PostgreSQL bounds a signal payload and a human wait value with {@code
 * octet_length(value::jsonb::text)}. That text puts a space after each {@code ,}, so it can be
 * longer than the compact JSON. The SDK must refuse the value with its own exception before a
 * statement runs, not let PostgreSQL refuse it.
 */
class ExternalWaitValueSizeTest {
  // Compact JSON writes 30,000 zeros in 60,001 bytes. The jsonb text writes them in 90,000 bytes.
  private static final List<Integer> ZEROS = Collections.nCopies(30_000, 0);
  private static final UUID TASK_ID = UUID.fromString("00000000-0000-4000-8000-000000000001");

  private final AtomicInteger statements = new AtomicInteger();

  /** A connection in autocommit that refuses every other call, so no statement can run. */
  private final Connection connection =
      (Connection)
          Proxy.newProxyInstance(
              Connection.class.getClassLoader(),
              new Class<?>[] {Connection.class},
              (proxy, method, arguments) -> {
                if (method.getName().equals("getAutoCommit")) {
                  return true;
                }
                statements.incrementAndGet();
                throw new AssertionError("the size check must refuse the value before " + method);
              });

  private final Queue queue =
      new Queue(
          new ConnectionSource() {
            @Override
            public Connection acquire() {
              throw new AssertionError("the test passes its own connection");
            }

            @Override
            public void release(Connection released, boolean transactional) {}
          });

  @Test
  void theValueIsBelowTheLimitAsCompactJson() {
    String compact = ZEROS.toString().replace(" ", "");
    assertTrue(compact.getBytes(StandardCharsets.UTF_8).length < 65_536);
  }

  @Test
  void refusesASignalPayloadWhoseJsonbTextExceedsTheLimit() {
    IllegalArgumentException error =
        assertThrows(
            IllegalArgumentException.class,
            () ->
                queue.sendSignal(
                    connection, TASK_ID, "approval", ZEROS, "oversized", "approval-service"));
    assertEquals("signal payload must be at most 65536 bytes of JSON", error.getMessage());
    assertEquals(0, statements.get());
  }

  @Test
  void refusesAHumanWaitResultWhoseJsonbTextExceedsTheLimit() {
    IllegalArgumentException error =
        assertThrows(
            IllegalArgumentException.class,
            () ->
                queue.completeHumanWait(
                    connection, TASK_ID, "review", ZEROS, "oversized-result", "operator"));
    assertEquals("human wait result must be at most 65536 bytes of JSON", error.getMessage());
    assertEquals(0, statements.get());
  }

  @Test
  void refusesAHumanWaitContextWhoseJsonbTextExceedsTheLimitBeforeTheTierLookup() {
    Worker worker =
        Worker.builder(new run.workhorse.testing.ScratchDataSource(true)).queues("default").build();
    // The tier lookup can read PostgreSQL, so the size check must run before it.
    HandlerContext context =
        new TaskContext(
            worker,
            sampleTask(),
            new TaskCancellation(),
            new Worker.Arbiter(),
            () -> {
              throw new AssertionError("the tier lookup must not run");
            });
    IllegalArgumentException error =
        assertThrows(
            IllegalArgumentException.class,
            () -> context.waitForHuman("review", ZEROS, Object.class, null));
    assertEquals("human wait context must be at most 65536 bytes of JSON", error.getMessage());
  }

  private static ClaimedTask sampleTask() {
    return new ClaimedTask(
        TASK_ID, "default", "sample", 0, null, null, null, false, null, 1, 1, null, null, null,
        null, 1, null);
  }
}
