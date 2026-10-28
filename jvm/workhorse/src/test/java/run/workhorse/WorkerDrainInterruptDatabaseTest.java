package run.workhorse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.PrintWriter;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.SQLFeatureNotSupportedException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.LockSupport;
import java.util.function.BooleanSupplier;
import java.util.logging.Logger;
import javax.sql.DataSource;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.testing.ScratchDataSource;
import run.workhorse.testing.ScratchDatabase;

/**
 * The drain's interrupt against the worker's own writes in the handler region. The worker defers
 * the interrupt while it writes, because an interrupt closes a virtual thread's socket, and it
 * delivers the interrupt before control returns to handler code. Every wait is bounded.
 */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class WorkerDrainInterruptDatabaseTest {
  private static final Duration WAIT = Duration.ofSeconds(20);

  private final ScratchDataSource scratch = new ScratchDataSource(true);
  private final Queue queue = new Queue(ConnectionSource.of(scratch));
  private String queueName = "";

  @BeforeEach
  void name() {
    queueName = "jvm-drain-interrupt-" + UUID.randomUUID();
  }

  /**
   * A source that holds the first statement whose SQL contains {@code marker}. The held statement
   * waits on its own thread until the drain's interrupt reaches the attempt, and then runs. The
   * interrupt either waits for the write or interrupts the thread.
   */
  private static final class HeldWrite implements DataSource {
    final ScratchDataSource source;
    final String marker;
    final CountDownLatch holding = new CountDownLatch(1);
    final List<Boolean> interruptedDuringWrite = new CopyOnWriteArrayList<>();
    final List<Boolean> deferredDuringWrite = new CopyOnWriteArrayList<>();

    HeldWrite(ScratchDataSource source, String marker) {
      this.source = source;
      this.marker = marker;
    }

    @Override
    public Connection getConnection() throws SQLException {
      Connection connection = source.getConnection();
      return (Connection)
          Proxy.newProxyInstance(
              Connection.class.getClassLoader(),
              new Class<?>[] {Connection.class},
              (proxy, method, arguments) -> {
                if (method.getName().equals("prepareStatement")
                    && arguments != null
                    && arguments[0] instanceof String sql
                    && sql.contains(marker)
                    && holding.getCount() > 0) {
                  holding.countDown();
                  hold();
                }
                try {
                  return method.invoke(connection, arguments);
                } catch (InvocationTargetException error) {
                  throw error.getCause();
                }
              });
    }

    private void hold() {
      Worker.@Nullable Active task = Worker.handlerTask();
      long limit = System.nanoTime() + WAIT.toNanos();
      while (!Thread.currentThread().isInterrupted()
          && (task == null || !task.interruptDeferred())
          && System.nanoTime() < limit) {
        LockSupport.parkNanos(TimeUnit.MILLISECONDS.toNanos(1));
      }
      interruptedDuringWrite.add(Thread.currentThread().isInterrupted());
      deferredDuringWrite.add(task != null && task.interruptDeferred());
    }

    @Override
    public Connection getConnection(String username, String password) throws SQLException {
      throw new SQLFeatureNotSupportedException();
    }

    @Override
    public @Nullable PrintWriter getLogWriter() {
      return null;
    }

    @Override
    public void setLogWriter(@Nullable PrintWriter out) {}

    @Override
    public void setLoginTimeout(int seconds) {}

    @Override
    public int getLoginTimeout() {
      return 0;
    }

    @Override
    public Logger getParentLogger() throws SQLFeatureNotSupportedException {
      throw new SQLFeatureNotSupportedException();
    }

    @Override
    public <T> T unwrap(Class<T> type) throws SQLException {
      throw new SQLException("not a wrapper");
    }

    @Override
    public boolean isWrapperFor(Class<?> type) {
      return false;
    }
  }

  private Worker.Builder worker(DataSource source) {
    return Worker.builder(source)
        .queues(queueName)
        .pollingOnly(true)
        .pollInterval(Duration.ofMillis(10))
        .disableRegistry(true)
        .shutdownGrace(Duration.ZERO);
  }

  private UUID enqueue(String taskType) {
    return queue
        .enqueue(
            taskType, Map.of(), EnqueueOptions.builder().queue(queueName).maxAttempts(1).build())
        .taskId();
  }

  /**
   * Starts the worker, waits until it holds the write, and stops it while the write is held.
   *
   * <p>With no shutdown grace, the attempt has one unwind window after the interrupt to end its
   * held write, its handler, and its settlement. Under load, that can take longer, and {@code
   * close} throws {@link ShutdownIncompleteException} while the attempt still ends (SM-1534). The
   * duration of the drain is not what these tests check, so each test waits for its own effects.
   */
  private static void drainDuringWrite(Worker worker, HeldWrite held) throws InterruptedException {
    worker.start();
    try {
      assertTrue(held.holding.await(WAIT.toSeconds(), TimeUnit.SECONDS), "the write started");
    } finally {
      try {
        worker.close();
      } catch (ShutdownIncompleteException slow) {
        // The abandoned attempt keeps running on its own thread; the effects below are bounded.
      }
    }
  }

  private static void waitFor(String what, BooleanSupplier condition) {
    long limit = System.nanoTime() + WAIT.toNanos();
    while (!condition.getAsBoolean()) {
      assertTrue(System.nanoTime() < limit, "timed out waiting until " + what);
      LockSupport.parkNanos(TimeUnit.MILLISECONDS.toNanos(5));
    }
  }

  private static void waitForCount(String what, long expected, SqlCount count) {
    waitFor(
        what,
        () -> {
          try {
            return count.get() == expected;
          } catch (SQLException error) {
            throw new AssertionError(error);
          }
        });
  }

  private interface SqlCount {
    long get() throws SQLException;
  }

  private static long count(String sql, List<UUID> taskIds) throws SQLException {
    try (Connection connection = ScratchDatabase.connect();
        PreparedStatement statement = connection.prepareStatement(sql)) {
      statement.setArray(
          1,
          connection.createArrayOf(
              "text", taskIds.stream().map(UUID::toString).toArray(String[]::new)));
      try (ResultSet result = statement.executeQuery()) {
        result.next();
        return result.getLong(1);
      }
    }
  }

  private static long events(String eventType, List<UUID> taskIds) throws SQLException {
    return count(
        "SELECT count(*) FROM workhorse.task_event WHERE event_type = '"
            + eventType
            + "' AND task_id = ANY(?::uuid[])",
        taskIds);
  }

  @Test
  void writesTheBatchDispatchEvidenceThroughTheDrainInterruptAndThenDeliversIt() throws Exception {
    List<UUID> taskIds = List.of(enqueue("evidence"), enqueue("evidence"));
    HeldWrite held = new HeldWrite(scratch, "record_batch_dispatch_v1");
    List<Boolean> handlerInterrupted = new CopyOnWriteArrayList<>();
    Worker worker =
        worker(held)
            .concurrency(2)
            .handleBatch(
                "evidence",
                Object.class,
                new BatchOptions(2, Duration.ofSeconds(5)),
                items -> {
                  handlerInterrupted.add(Thread.interrupted());
                  return items.stream()
                      .<BatchHandlerOutcome>map(item -> new BatchSucceeded("done"))
                      .toList();
                })
            .build();

    drainDuringWrite(worker, held);
    waitFor("the handler ran", () -> !handlerInterrupted.isEmpty());

    assertEquals(List.of(false), held.interruptedDuringWrite, "the write ran without an interrupt");
    assertEquals(List.of(true), held.deferredDuringWrite, "the drain interrupted during the write");
    assertEquals(2, events("batch_dispatched", taskIds), "each member has its evidence row");
    assertEquals(List.of(true), handlerInterrupted, "the handler received the drain interrupt");
  }

  @Test
  void writesTheBatchFailureEvidenceThroughTheDrainInterrupt() throws Exception {
    List<UUID> taskIds = List.of(enqueue("failure"), enqueue("failure"));
    HeldWrite held = new HeldWrite(scratch, "record_batch_failure_v1");
    Worker worker =
        worker(held)
            .concurrency(2)
            .handleBatch(
                "failure",
                Object.class,
                new BatchOptions(2, Duration.ofSeconds(5)),
                items -> {
                  throw new IllegalStateException("the batch failed");
                })
            .build();

    drainDuringWrite(worker, held);
    waitForCount(
        "each member has its failure evidence row", 2, () -> events("batch_failed", taskIds));

    assertEquals(List.of(false), held.interruptedDuringWrite, "the write ran without an interrupt");
    assertEquals(List.of(true), held.deferredDuringWrite, "the drain interrupted during the write");
  }

  @Test
  void writesACheckpointThroughTheDrainInterruptAndThenDeliversIt() throws Exception {
    UUID taskId = enqueue("checkpointed");
    HeldWrite held = new HeldWrite(scratch, "save_checkpoint_v");
    List<Boolean> handlerInterrupted = new CopyOnWriteArrayList<>();
    Worker worker =
        worker(held)
            .handle(
                "checkpointed",
                Object.class,
                (context, payload) -> {
                  Object charge = context.checkpoint("charge", Object.class, () -> 7);
                  handlerInterrupted.add(Thread.interrupted());
                  return charge;
                })
            .build();

    drainDuringWrite(worker, held);
    waitFor("the handler ran", () -> !handlerInterrupted.isEmpty());

    assertEquals(List.of(false), held.interruptedDuringWrite, "the write ran without an interrupt");
    assertEquals(List.of(true), held.deferredDuringWrite, "the drain interrupted during the write");
    assertEquals(
        1,
        count(
            "SELECT count(*) FROM workhorse.task_checkpoint WHERE task_id = ANY(?::uuid[])",
            List.of(taskId)),
        "the checkpoint row is written");
    assertEquals(List.of(true), handlerInterrupted, "the handler received the drain interrupt");
  }

  @Test
  void writesProgressThroughTheDrainInterruptAndThenDeliversIt() throws Exception {
    UUID taskId = enqueue("progressed");
    HeldWrite held = new HeldWrite(scratch, "update_progress_v1");
    List<Boolean> handlerInterrupted = new CopyOnWriteArrayList<>();
    Worker worker =
        worker(held)
            .handle(
                "progressed",
                Object.class,
                (context, payload) -> {
                  context.setProgress(Map.of("step", 1));
                  handlerInterrupted.add(Thread.interrupted());
                  return null;
                })
            .build();

    drainDuringWrite(worker, held);
    waitFor("the handler ran", () -> !handlerInterrupted.isEmpty());

    assertEquals(List.of(false), held.interruptedDuringWrite, "the write ran without an interrupt");
    assertEquals(List.of(true), held.deferredDuringWrite, "the drain interrupted during the write");
    assertEquals(
        1,
        count(
            "SELECT count(*) FROM workhorse.task_progress WHERE task_id = ANY(?::uuid[])",
            List.of(taskId)),
        "the progress row is written");
    assertEquals(List.of(true), handlerInterrupted, "the handler received the drain interrupt");
  }

  @Test
  void stillInterruptsACodecThatTheWorkerCallsWhileItPreparesAChild() throws Exception {
    enqueue("parent");
    CountDownLatch encoding = new CountDownLatch(1);
    CountDownLatch never = new CountDownLatch(1);
    List<Boolean> codecInterrupted = new CopyOnWriteArrayList<>();
    JsonCodec standard = JsonCodec.standard();
    // The codec blocks while it encodes the child payload, until the drain interrupts it.
    JsonCodec codec =
        new JsonCodec() {
          @Override
          public String encode(@Nullable Object value) {
            if (value instanceof Map<?, ?> map && map.containsKey("block")) {
              encoding.countDown();
              try {
                never.await();
              } catch (InterruptedException drained) {
                codecInterrupted.add(true);
                throw new IllegalStateException("the drain stopped the codec", drained);
              }
            }
            return standard.encode(value);
          }

          // JsonCodec fixes this signature: the type argument comes from the call site.
          @SuppressWarnings("TypeParameterUnusedInFormals")
          @Override
          public <T extends @Nullable Object> T decode(String json, java.lang.reflect.Type type) {
            return standard.decode(json, type);
          }
        };
    Worker worker =
        worker(scratch)
            .codec(codec)
            .handle(
                "parent",
                Object.class,
                (context, payload) ->
                    context.runChild(
                        "child",
                        "child",
                        Map.of("block", true),
                        EnqueueOptions.defaults(),
                        Object.class))
            .build();
    worker.start();
    try {
      assertTrue(encoding.await(WAIT.toSeconds(), TimeUnit.SECONDS), "the codec started");
    } finally {
      worker.close();
    }

    assertEquals(List.of(true), codecInterrupted, "the codec received the drain interrupt");
  }

  @Test
  void keepsAnInterruptThatIsPendingBeforeTheWriteForTheHandler() throws Exception {
    UUID taskId = enqueue("pending");
    List<Boolean> handlerInterrupted = new ArrayList<>();
    Worker worker =
        worker(scratch)
            .handle(
                "pending",
                Object.class,
                (context, payload) -> {
                  Thread.currentThread().interrupt();
                  Object charge = context.checkpoint("charge", Object.class, () -> 7);
                  handlerInterrupted.add(Thread.interrupted());
                  return charge;
                })
            .build();

    assertTrue(worker.runOnce());

    assertEquals(List.of(true), handlerInterrupted, "the handler keeps its own interrupt");
    assertEquals(
        1,
        count(
            "SELECT count(*) FROM workhorse.task_checkpoint WHERE task_id = ANY(?::uuid[])",
            List.of(taskId)),
        "the checkpoint row is written");
    assertFalse(Thread.currentThread().isInterrupted());
  }

  /**
   * SM-1889: the drain's interrupt closes the socket of the handler's own query. The driver then
   * throws an {@link SQLException} whose causes hold no {@link InterruptedException}. The handler
   * stopped because of the shutdown, so the task goes back to its queue without an attempt.
   */
  @Test
  void releasesAHandlerWhoseOwnQueryTheDrainInterruptStops() throws Exception {
    UUID taskId = enqueue("own-query");
    CountDownLatch started = new CountDownLatch(1);
    List<String> handlerErrors = new CopyOnWriteArrayList<>();
    Worker worker =
        worker(scratch)
            .handle(
                "own-query",
                Object.class,
                (context, payload) -> {
                  started.countDown();
                  long limit = System.nanoTime() + WAIT.toNanos();
                  while (!Thread.currentThread().isInterrupted() && System.nanoTime() < limit) {
                    LockSupport.parkNanos(TimeUnit.MILLISECONDS.toNanos(1));
                  }
                  try (Connection connection = ScratchDatabase.connect();
                      PreparedStatement statement = connection.prepareStatement("SELECT 1")) {
                    statement.execute();
                  } catch (SQLException error) {
                    handlerErrors.add(error.getClass().getName());
                    throw error;
                  }
                  return null;
                })
            .build();
    worker.start();
    try {
      assertTrue(started.await(WAIT.toSeconds(), TimeUnit.SECONDS), "the handler started");
    } finally {
      try {
        worker.close();
      } catch (ShutdownIncompleteException slow) {
        // The attempt still ends on its own thread; the wait below covers it.
      }
    }
    waitForCount("the task goes back to its queue", 1, () -> events("released", List.of(taskId)));

    assertEquals(
        List.of("org.postgresql.util.PSQLException"),
        handlerErrors,
        "the interrupt stopped the handler's query");
    assertEquals(
        1,
        count(
            "SELECT count(*) FROM workhorse.task_runtime WHERE state = 'ready' AND current_attempt = 1"
                + " AND task_id = ANY(?::uuid[])",
            List.of(taskId)),
        "the task waits in its queue and did not use its attempt");
  }

  // SM-1525 (m2): a child request reads its payload contract through the drain's interrupt. Without
  // the deferral, the interrupt closes the socket of the read, and the worker fails the parent
  // instead of giving it back to its queue.
  @Test
  void readsAChildContractThroughTheDrainInterruptAndThenDeliversIt() throws Exception {
    UUID parentId = enqueue("contracted-parent");
    HeldWrite held = new HeldWrite(scratch, "get_contract_definition_v1");
    Worker worker =
        worker(held)
            .handle(
                "contracted-parent",
                Object.class,
                (context, payload) ->
                    context.runChild(
                        "child",
                        "contracted-child",
                        Map.of(),
                        EnqueueOptions.defaults(),
                        Object.class))
            .build();

    drainDuringWrite(worker, held);
    // The read ends, and the child request then stops for the shutdown, so the parent goes back
    // to its queue without an attempt.
    waitForCount(
        "the parent goes back to its queue", 1, () -> events("released", List.of(parentId)));

    assertEquals(List.of(false), held.interruptedDuringWrite, "the read ran without an interrupt");
    assertEquals(List.of(true), held.deferredDuringWrite, "the drain interrupted during the read");
    assertEquals(
        1,
        count(
            "SELECT count(*) FROM workhorse.task_runtime WHERE state = 'ready'"
                + " AND task_id = ANY(?::uuid[])",
            List.of(parentId)),
        "the parent waits in its queue and did not fail");
  }
}
