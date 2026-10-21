package run.workhorse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;
import java.util.function.IntConsumer;
import javax.sql.DataSource;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import org.postgresql.PGConnection;
import run.workhorse.internal.Sql;
import run.workhorse.internal.SqlCatalogue;
import run.workhorse.testing.ScratchDataSource;
import run.workhorse.testing.ScratchDatabase;

/**
 * SM-1569: while the heartbeat of a worker's {@code DataSource} holds no connection, the worker
 * claims no task, ordinary or fused. A fused completion still settles its task, with a claim limit
 * of 0. When the replacement connection arrives, the dispatch loop wakes at once. SM-1580: each
 * claim and each fused completion reads the claim gate of the run that started it, never the gate
 * of a later run.
 */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class WorkerHeartbeatGateDatabaseTest {
  private static final Duration WAIT = Duration.ofSeconds(20);

  /**
   * A source over the scratch database for the tests of the claim gate.
   *
   * <ul>
   *   <li>It records the backend of each heartbeat checkout. Once {@link #hold} is true, a
   *       heartbeat checkout waits until {@link #open} counts down. The heartbeat checks out on
   *       threads named {@code workhorse-heartbeat-checkout}.
   *   <li>Once {@link #holdBorrowIn} names a method of the worker, the next borrow from that method
   *       waits until {@link #borrowOpen} counts down. If {@link #failBorrow} is then true, that
   *       borrow fails.
   *   <li>It counts the claim statements that reach PostgreSQL ({@link #claimSends}). Before each
   *       one goes out, it gives the number of that statement to {@link #beforeClaimSend}.
   *   <li>Once {@link #deadlock} holds a hook, the next claim statement runs the hook and then
   *       fails as a deadlock victim, so the worker sends it again.
   *   <li>Once {@link #holdClaim} is true, the next claim statement counts down {@link #claimHeld},
   *       and then waits until {@link #claimOpen} counts down before it goes out.
   *   <li>The close of a heartbeat connection counts down {@link #heartbeatReturned}.
   * </ul>
   */
  private static final class HeartbeatGate {
    final ScratchDataSource source = new ScratchDataSource(true);
    final List<Integer> heartbeatBackends = new CopyOnWriteArrayList<>();
    final AtomicBoolean hold = new AtomicBoolean();
    final CountDownLatch open = new CountDownLatch(1);
    final AtomicReference<@Nullable String> holdBorrowIn = new AtomicReference<>();
    final AtomicInteger borrowWaiting = new AtomicInteger();
    final CountDownLatch borrowOpen = new CountDownLatch(1);
    final AtomicBoolean failBorrow = new AtomicBoolean();
    final AtomicInteger claimSends = new AtomicInteger();
    final AtomicReference<@Nullable Runnable> deadlock = new AtomicReference<>();
    final AtomicReference<@Nullable IntConsumer> beforeClaimSend = new AtomicReference<>();
    final AtomicBoolean holdClaim = new AtomicBoolean();
    final CountDownLatch claimHeld = new CountDownLatch(1);
    final CountDownLatch claimOpen = new CountDownLatch(1);
    final CountDownLatch heartbeatReturned = new CountDownLatch(1);

    DataSource dataSource() {
      return (DataSource)
          Proxy.newProxyInstance(
              DataSource.class.getClassLoader(),
              new Class<?>[] {DataSource.class},
              (proxy, method, arguments) -> {
                boolean checkout = method.getName().equals("getConnection");
                boolean heartbeat =
                    checkout
                        && Thread.currentThread().getName().equals("workhorse-heartbeat-checkout");
                if (heartbeat && hold.get()) {
                  open.await(60, TimeUnit.SECONDS);
                }
                String borrower = holdBorrowIn.get();
                if (checkout
                    && !heartbeat
                    && borrower != null
                    && calledFrom(borrower)
                    && holdBorrowIn.compareAndSet(borrower, null)) {
                  borrowWaiting.incrementAndGet();
                  try {
                    borrowOpen.await(60, TimeUnit.SECONDS);
                  } finally {
                    borrowWaiting.decrementAndGet();
                  }
                  if (failBorrow.get()) {
                    throw new SQLException("injected borrow failure");
                  }
                }
                Object result = invoke(method, source, arguments);
                if (!checkout) {
                  return result;
                }
                Connection connection = (Connection) result;
                if (heartbeat) {
                  heartbeatBackends.add(connection.unwrap(PGConnection.class).getBackendPID());
                }
                return watched(connection, heartbeat);
              });
    }

    /** Whether a method of the worker named {@code name} is on the stack of this thread. */
    private static boolean calledFrom(String name) {
      return StackWalker.getInstance()
          .walk(
              frames ->
                  frames.anyMatch(
                      frame ->
                          frame.getClassName().equals(Worker.class.getName())
                              && frame.getMethodName().equals(name)));
    }

    private Connection watched(Connection connection, boolean heartbeat) {
      return (Connection)
          Proxy.newProxyInstance(
              Connection.class.getClassLoader(),
              new Class<?>[] {Connection.class},
              (proxy, method, arguments) -> {
                Object result = invoke(method, connection, arguments);
                if (heartbeat && method.getName().equals("close")) {
                  heartbeatReturned.countDown();
                }
                if (!method.getName().equals("prepareStatement")) {
                  return result;
                }
                String sql = String.valueOf(arguments[0]);
                boolean claim =
                    sql.contains("complete_many_and_claim_v1") || sql.contains("claim_many_v1");
                return claim ? claimStatement((PreparedStatement) result) : result;
              });
    }

    private PreparedStatement claimStatement(PreparedStatement statement) {
      return (PreparedStatement)
          Proxy.newProxyInstance(
              PreparedStatement.class.getClassLoader(),
              new Class<?>[] {PreparedStatement.class},
              (proxy, method, arguments) -> {
                if (method.getName().equals("execute") && holdClaim.compareAndSet(true, false)) {
                  claimHeld.countDown();
                  claimOpen.await(60, TimeUnit.SECONDS);
                }
                if (method.getName().equals("execute")) {
                  Runnable hook = deadlock.getAndSet(null);
                  if (hook != null) {
                    hook.run();
                    throw new SQLException("injected deadlock", "40P01");
                  }
                  int send = claimSends.incrementAndGet();
                  IntConsumer before = beforeClaimSend.get();
                  if (before != null) {
                    before.accept(send);
                  }
                }
                return invoke(method, statement, arguments);
              });
    }

    private static @Nullable Object invoke(
        java.lang.reflect.Method method, Object target, @Nullable Object[] arguments)
        throws Throwable {
      try {
        return method.invoke(target, arguments);
      } catch (InvocationTargetException error) {
        throw error.getCause();
      }
    }
  }

  /** Terminates the backend of the heartbeat connection, so the next round fails. */
  private static void terminate(int backend) throws SQLException {
    try (Connection admin = ScratchDatabase.connect();
        PreparedStatement terminate = admin.prepareStatement("SELECT pg_terminate_backend(?)")) {
      terminate.setInt(1, backend);
      terminate.execute();
    }
  }

  /** The state of {@code taskId} on the full tier: its runtime state or its outcome. */
  private static @Nullable String fullState(UUID taskId) {
    try (Connection connection = ScratchDatabase.connect();
        PreparedStatement statement =
            connection.prepareStatement(
                "SELECT COALESCE(o.state, r.state) FROM workhorse.task t"
                    + " LEFT JOIN workhorse.task_runtime r ON r.task_id = t.id"
                    + " LEFT JOIN workhorse.task_outcome o ON o.task_id = t.id"
                    + " WHERE t.id = ?::uuid")) {
      statement.setString(1, taskId.toString());
      try (ResultSet result = statement.executeQuery()) {
        return result.next() ? result.getString(1) : null;
      }
    } catch (SQLException error) {
      throw new AssertionError(error);
    }
  }

  private static void makeFast(String queueName) throws SQLException {
    try (Connection connection = ScratchDatabase.connect()) {
      Sql.rows(connection, SqlCatalogue.SET_QUEUE_TIER_V1, queueName, "fast", "jvm-test", "test");
    }
  }

  /** A worker for the gate tests, with a lease of 8 s and a heartbeat of 1 s. */
  private static Worker.Builder gateWorker(
      HeartbeatGate gate,
      String queueName,
      Duration poll,
      Map<String, CountDownLatch> holds,
      int concurrency) {
    Worker.Builder builder =
        Worker.builder(gate.dataSource())
            .queues(queueName)
            .workerId("jvm-gate")
            .pollingOnly(true)
            .pollInterval(poll)
            .disableRegistry(true)
            .concurrency(concurrency)
            .lease(Duration.ofSeconds(8))
            .heartbeat(Duration.ofSeconds(1))
            .handle("quick", Object.class, (ctx, payload) -> Map.of());
    for (Map.Entry<String, CountDownLatch> hold : holds.entrySet()) {
      builder.handle(
          hold.getKey(),
          Object.class,
          (ctx, payload) -> {
            hold.getValue().await(60, TimeUnit.SECONDS);
            return Map.of();
          });
    }
    return builder;
  }

  private static void waitUntil(String what, BooleanSupplier condition) {
    long deadline = System.nanoTime() + WAIT.toNanos();
    while (!condition.getAsBoolean()) {
      if (System.nanoTime() > deadline) {
        throw new AssertionError("timed out waiting until " + what);
      }
      try {
        Thread.sleep(10);
      } catch (InterruptedException interrupted) {
        Thread.currentThread().interrupt();
        throw new AssertionError("interrupted waiting until " + what, interrupted);
      }
    }
  }

  /**
   * Waits for {@code latch} across interrupts, such as the interrupt of a drain, and restores the
   * interrupt flag after the wait.
   */
  private static void awaitAcrossInterrupts(CountDownLatch latch) {
    boolean interrupted = false;
    try {
      while (true) {
        try {
          if (!latch.await(60, TimeUnit.SECONDS)) {
            throw new AssertionError("the test did not release the handler");
          }
          return;
        } catch (InterruptedException interrupt) {
          interrupted = true;
        }
      }
    } finally {
      if (interrupted) {
        Thread.currentThread().interrupt();
      }
    }
  }

  /** The state of {@code taskId} on the fast tier: its runtime state or its outcome. */
  private static @Nullable String fastState(UUID taskId) {
    try (Connection connection = ScratchDatabase.connect();
        PreparedStatement statement =
            connection.prepareStatement(
                "SELECT COALESCE(o.state, r.state) FROM workhorse.task t"
                    + " LEFT JOIN workhorse.fast_task_runtime r ON r.task_id = t.id"
                    + " LEFT JOIN workhorse.fast_task_outcome o ON o.task_id = t.id"
                    + " WHERE t.id = ?::uuid")) {
      statement.setString(1, taskId.toString());
      try (ResultSet result = statement.executeQuery()) {
        return result.next() ? result.getString(1) : null;
      }
    } catch (SQLException error) {
      throw new AssertionError(error);
    }
  }

  @Test
  void claimsNothingWithoutAHeartbeatConnectionAndWakesWhenItReturns() throws Exception {
    String queueName = "jvm-gate-" + UUID.randomUUID();
    try (Connection connection = ScratchDatabase.connect()) {
      Sql.rows(connection, SqlCatalogue.SET_QUEUE_TIER_V1, queueName, "fast", "jvm-test", "test");
    }
    Queue queue = new Queue(ConnectionSource.of(new ScratchDataSource(true)));
    UUID held =
        queue.enqueue("hold", Map.of(), EnqueueOptions.builder().queue(queueName).build()).taskId();
    HeartbeatGate gate = new HeartbeatGate();
    CountDownLatch holding = new CountDownLatch(1);
    CountDownLatch release = new CountDownLatch(1);
    // A poll interval of 5 s: without the wake, the next claim would wait for it.
    Worker worker =
        Worker.builder(gate.dataSource())
            .queues(queueName)
            .workerId("jvm-gate")
            .pollingOnly(true)
            .pollInterval(Duration.ofSeconds(5))
            .disableRegistry(true)
            .concurrency(2)
            .lease(Duration.ofSeconds(8))
            .heartbeat(Duration.ofSeconds(1))
            .handle(
                "hold",
                Object.class,
                (ctx, payload) -> {
                  holding.countDown();
                  release.await(60, TimeUnit.SECONDS);
                  return Map.of();
                })
            .handle("quick", Object.class, (ctx, payload) -> Map.of())
            .build();
    List<Worker.FusedStatement> statements = new CopyOnWriteArrayList<>();
    worker.fusedStatementHook = statements::add;
    worker.start();
    try {
      assertTrue(holding.await(20, TimeUnit.SECONDS), "the held task runs");
      waitUntil("the heartbeat holds a connection", () -> !gate.heartbeatBackends.isEmpty());

      // The heartbeat loses its connection, and its replacement checkout waits.
      gate.hold.set(true);
      try (Connection admin = ScratchDatabase.connect();
          PreparedStatement terminate = admin.prepareStatement("SELECT pg_terminate_backend(?)")) {
        terminate.setInt(1, gate.heartbeatBackends.get(0));
        terminate.execute();
      }
      waitUntil("the claim gate closes", () -> !worker.heartbeatConnected());

      statements.clear();
      UUID quick =
          queue
              .enqueue("quick", Map.of(), EnqueueOptions.builder().queue(queueName).build())
              .taskId();
      release.countDown();
      waitUntil("the held task completes", () -> "succeeded".equals(fastState(held)));
      // A completion checkpoint: the fused statement of the held task reported, and no claim is in
      // flight. The closed gate starts no new claim, so nothing can send after this point.
      waitUntil(
          "the fused completion reported and no claim is in flight",
          () ->
              statements.stream().anyMatch(statement -> statement.completions() == 1)
                  && worker.completionsWaiting() == 0
                  && worker.claimsInFlight() == 0);
      assertEquals("ready", fastState(quick), "no claim of any kind runs while the gate is closed");
      assertFalse(worker.heartbeatConnected(), "the replacement still waits");
      List<Worker.FusedStatement> gated = List.copyOf(statements);
      assertTrue(
          gated.stream().anyMatch(statement -> statement.completions() == 1),
          "the held task completes through the fused statement: " + gated);
      assertTrue(
          gated.stream().allMatch(s -> s.claimLimit() == 0 && s.claimed() == 0),
          "a fused completion claims nothing while the gate is closed: " + gated);

      long openAt = System.nanoTime();
      gate.open.countDown();
      waitUntil(
          "the task after the reconnect succeeds", () -> "succeeded".equals(fastState(quick)));
      double claimMs = (System.nanoTime() - openAt) / 1e6;
      assertTrue(claimMs < 2_000, "the claim came " + claimMs + " ms after the reconnect");
    } finally {
      release.countDown();
      gate.open.countDown();
      worker.close();
    }
  }

  /**
   * P1: an ordinary claim waits for its borrow, and the heartbeat loses its connection meanwhile.
   * The claim reads the gate on the borrowed connection, so it sends no statement.
   */
  @Test
  void sendsNoClaimWhenTheHeartbeatLosesItsConnectionWhileTheClaimWaitsForItsBorrow()
      throws Exception {
    String queueName = "jvm-gate-borrow-" + UUID.randomUUID();
    Queue queue = new Queue(ConnectionSource.of(new ScratchDataSource(true)));
    CountDownLatch release = new CountDownLatch(1);
    UUID held =
        queue.enqueue("hold", Map.of(), EnqueueOptions.builder().queue(queueName).build()).taskId();
    HeartbeatGate gate = new HeartbeatGate();
    Worker worker =
        gateWorker(gate, queueName, Duration.ofMillis(100), Map.of("hold", release), 2).build();
    worker.start();
    try {
      waitUntil("the heartbeat holds a connection", () -> !gate.heartbeatBackends.isEmpty());
      // The held task keeps one attempt registered, so heartbeat rounds run and notice the loss.
      waitUntil("the held task runs", () -> "active".equals(fullState(held)));
      gate.holdBorrowIn.set("claim");
      waitUntil("a claim waits for its borrow", () -> gate.borrowWaiting.get() == 1);
      UUID quick =
          queue
              .enqueue("quick", Map.of(), EnqueueOptions.builder().queue(queueName).build())
              .taskId();
      gate.hold.set(true);
      terminate(gate.heartbeatBackends.get(0));
      waitUntil("the claim gate closes", () -> !worker.heartbeatConnected());
      int sends = gate.claimSends.get();

      gate.borrowOpen.countDown();
      // A completion checkpoint: the held claim counts as in flight until it returns, and the
      // closed gate starts no new claim. The replacement stays blocked meanwhile.
      waitUntil("the held claim returned", () -> worker.claimsInFlight() == 0);
      assertFalse(worker.heartbeatConnected(), "the replacement still waits");
      assertEquals(sends, gate.claimSends.get(), "no claim statement reached PostgreSQL");
      assertEquals("ready", fullState(quick), "the task stays ready while the gate is closed");

      gate.open.countDown();
      waitUntil("the task runs after the reconnect", () -> "succeeded".equals(fullState(quick)));
    } finally {
      release.countDown();
      gate.open.countDown();
      gate.borrowOpen.countDown();
      worker.close();
    }
  }

  /**
   * P1: a fast-tier completion waits behind another batch, whose borrow waits for the pool. The
   * heartbeat loses its connection meanwhile. Both statements settle their tasks with a claim limit
   * of 0, and the ready task stays ready.
   */
  @Test
  void sendsAQueuedCompletionWithAClaimLimitOfZeroAfterTheHeartbeatLosesItsConnection()
      throws Exception {
    String queueName = "jvm-gate-batch-" + UUID.randomUUID();
    makeFast(queueName);
    Queue queue = new Queue(ConnectionSource.of(new ScratchDataSource(true)));
    CountDownLatch releaseFirst = new CountDownLatch(1);
    CountDownLatch releaseSecond = new CountDownLatch(1);
    CountDownLatch releaseAnchor = new CountDownLatch(1);
    // The anchor keeps one attempt registered, so heartbeat rounds run and notice the loss.
    UUID anchor =
        queue
            .enqueue("anchor", Map.of(), EnqueueOptions.builder().queue(queueName).build())
            .taskId();
    UUID first =
        queue
            .enqueue("first", Map.of(), EnqueueOptions.builder().queue(queueName).build())
            .taskId();
    UUID second =
        queue
            .enqueue("second", Map.of(), EnqueueOptions.builder().queue(queueName).build())
            .taskId();
    HeartbeatGate gate = new HeartbeatGate();
    Worker worker =
        gateWorker(
                gate,
                queueName,
                Duration.ofMillis(100),
                Map.of("first", releaseFirst, "second", releaseSecond, "anchor", releaseAnchor),
                3)
            .build();
    List<Worker.FusedStatement> statements = new CopyOnWriteArrayList<>();
    worker.fusedStatementHook = statements::add;
    worker.start();
    try {
      waitUntil("the heartbeat holds a connection", () -> !gate.heartbeatBackends.isEmpty());
      waitUntil(
          "the three tasks run",
          () ->
              "active".equals(fastState(first))
                  && "active".equals(fastState(second))
                  && "active".equals(fastState(anchor)));
      gate.holdBorrowIn.set("sendCompletionChunk");
      releaseFirst.countDown();
      waitUntil("the first completion waits for its borrow", () -> gate.borrowWaiting.get() == 1);
      releaseSecond.countDown();
      waitUntil(
          "the second completion waits behind the first batch",
          () -> worker.completionsWaiting() == 1);
      UUID quick =
          queue
              .enqueue("quick", Map.of(), EnqueueOptions.builder().queue(queueName).build())
              .taskId();
      gate.hold.set(true);
      terminate(gate.heartbeatBackends.get(0));
      waitUntil("the claim gate closes", () -> !worker.heartbeatConnected());

      statements.clear();
      gate.borrowOpen.countDown();
      waitUntil(
          "both completions settle",
          () -> "succeeded".equals(fastState(first)) && "succeeded".equals(fastState(second)));
      // A completion checkpoint: both fused statements reported, no completion waits, and no claim
      // is in flight. The replacement stays blocked meanwhile.
      waitUntil(
          "both fused statements reported and no claim is in flight",
          () ->
              statements.stream().mapToInt(Worker.FusedStatement::completions).sum() == 2
                  && worker.completionsWaiting() == 0
                  && worker.claimsInFlight() == 0);
      assertFalse(worker.heartbeatConnected(), "the replacement still waits");
      List<Worker.FusedStatement> sent = List.copyOf(statements);
      assertEquals(
          2,
          sent.stream().mapToInt(Worker.FusedStatement::completions).sum(),
          "both completions went out: " + sent);
      assertTrue(
          sent.stream()
              .allMatch(statement -> statement.claimLimit() == 0 && statement.claimed() == 0),
          "each fused statement claimed nothing: " + sent);
      assertEquals("ready", fastState(quick), "the task stays ready while the gate is closed");

      gate.open.countDown();
      waitUntil("the task runs after the reconnect", () -> "succeeded".equals(fastState(quick)));
    } finally {
      releaseFirst.countDown();
      releaseSecond.countDown();
      releaseAnchor.countDown();
      gate.open.countDown();
      gate.borrowOpen.countDown();
      worker.close();
    }
  }

  /**
   * P1: a fast-tier claim is chosen as a deadlock victim, and the heartbeat loses its connection
   * before the resend. The resend reads the gate, so it does not go out.
   */
  @Test
  void sendsNoDeadlockRetryAfterTheHeartbeatLosesItsConnection() throws Exception {
    String queueName = "jvm-gate-deadlock-" + UUID.randomUUID();
    makeFast(queueName);
    Queue queue = new Queue(ConnectionSource.of(new ScratchDataSource(true)));
    CountDownLatch release = new CountDownLatch(1);
    UUID held =
        queue.enqueue("hold", Map.of(), EnqueueOptions.builder().queue(queueName).build()).taskId();
    HeartbeatGate gate = new HeartbeatGate();
    Worker worker =
        gateWorker(gate, queueName, Duration.ofMillis(100), Map.of("hold", release), 2).build();
    AtomicReference<@Nullable UUID> quick = new AtomicReference<>();
    AtomicInteger sendsAtDeadlock = new AtomicInteger(-1);
    worker.start();
    try {
      waitUntil("the heartbeat holds a connection", () -> !gate.heartbeatBackends.isEmpty());
      // The held task keeps one attempt registered, so heartbeat rounds run and notice the loss.
      waitUntil("the held task runs", () -> "active".equals(fastState(held)));
      // The hook runs in the claim, after its first attempt went out and before the deadlock.
      gate.deadlock.set(
          () -> {
            gate.hold.set(true);
            try {
              terminate(gate.heartbeatBackends.get(0));
            } catch (SQLException error) {
              throw new AssertionError(error);
            }
            waitUntil("the claim gate closes", () -> !worker.heartbeatConnected());
            quick.set(
                queue
                    .enqueue("quick", Map.of(), EnqueueOptions.builder().queue(queueName).build())
                    .taskId());
            sendsAtDeadlock.set(gate.claimSends.get());
          });
      waitUntil("a claim met the deadlock", () -> sendsAtDeadlock.get() >= 0);
      // A completion checkpoint: the claim that met the deadlock returns only after its retry path
      // ends, and the closed gate starts no new claim. The replacement stays blocked meanwhile.
      waitUntil("the claim and its retry path ended", () -> worker.claimsInFlight() == 0);
      assertFalse(worker.heartbeatConnected(), "the replacement still waits");
      assertEquals(
          sendsAtDeadlock.get(), gate.claimSends.get(), "the claim did not send its attempt again");
      UUID task = Objects.requireNonNull(quick.get());
      assertEquals("ready", fastState(task), "the task stays ready while the gate is closed");

      gate.open.countDown();
      waitUntil("the task runs after the reconnect", () -> "succeeded".equals(fastState(task)));
    } finally {
      release.countDown();
      gate.open.countDown();
      worker.close();
    }
  }

  /**
   * SM-1580: a claim of run A waits for its borrow, and A stops after its shutdown deadline. Run B
   * starts on the same worker, paused, and holds its own heartbeat reservation. A's claim then gets
   * its connection. It reads the claim gate of run A, which is closed, so it sends nothing.
   */
  @Test
  void sendsNoClaimOfAnEndedRunWithTheReservationOfALaterRun() throws Exception {
    String queueName = "jvm-gate-runs-" + UUID.randomUUID();
    Queue queue = new Queue(ConnectionSource.of(new ScratchDataSource(true)));
    HeartbeatGate gate = new HeartbeatGate();
    Worker worker =
        gateWorker(gate, queueName, Duration.ofMillis(100), Map.of(), 1)
            .shutdownGrace(Duration.ZERO)
            .build();
    gate.holdBorrowIn.set("claim");
    worker.start();
    try {
      waitUntil("a claim of run A waits for its borrow", () -> gate.borrowWaiting.get() == 1);
      worker.close();
      assertEquals(1, worker.claimsInFlight(), "run A ended and abandoned its claim");
      UUID quick =
          queue
              .enqueue("quick", Map.of(), EnqueueOptions.builder().queue(queueName).build())
              .taskId();
      // Run B claims nothing while it is paused, so only the claim of run A could take the task.
      worker.pause();
      worker.start();
      waitUntil("run B holds its heartbeat reservation", worker::heartbeatConnected);

      gate.borrowOpen.countDown();
      // A completion checkpoint: the claim of run A counts as in flight until it returns, and the
      // paused run B starts no claim.
      waitUntil("the claim of run A returned", () -> worker.claimsInFlight() == 0);
      assertEquals(0, gate.claimSends.get(), "the claim of run A sent no statement");
      assertEquals("ready", fullState(quick), "the task stays ready for run B");

      worker.resume();
      waitUntil("run B runs the task", () -> "succeeded".equals(fullState(quick)));
    } finally {
      gate.borrowOpen.countDown();
      worker.close();
    }
  }

  /**
   * SM-1580: a fast-tier completion of run A reserves its fused claim and waits for its borrow. A
   * stops with the completion still out, and run B starts on the same worker, paused, with its own
   * heartbeat reservation. The completion then settles its task with a claim limit of 0, because
   * the claim gate of run A is closed.
   */
  @Test
  void sendsTheCompletionOfAnEndedRunWithAClaimLimitOfZero() throws Exception {
    String queueName = "jvm-gate-runs-fast-" + UUID.randomUUID();
    makeFast(queueName);
    Queue queue = new Queue(ConnectionSource.of(new ScratchDataSource(true)));
    CountDownLatch release = new CountDownLatch(1);
    UUID held =
        queue.enqueue("hold", Map.of(), EnqueueOptions.builder().queue(queueName).build()).taskId();
    HeartbeatGate gate = new HeartbeatGate();
    // One slot: the held task fills it, so run A makes no empty claim, and the completion
    // reserves a fused claim for the slot that it leaves.
    Worker worker =
        gateWorker(gate, queueName, Duration.ofMillis(100), Map.of("hold", release), 1)
            .shutdownGrace(Duration.ZERO)
            .build();
    List<Worker.FusedStatement> statements = new CopyOnWriteArrayList<>();
    worker.fusedStatementHook = statements::add;
    worker.start();
    try {
      waitUntil("the held task runs", () -> "active".equals(fastState(held)));
      gate.holdBorrowIn.set("sendCompletionChunk");
      release.countDown();
      waitUntil("the completion waits for its borrow", () -> gate.borrowWaiting.get() == 1);
      assertThrows(ShutdownIncompleteException.class, worker::close, "run A left its attempt");
      UUID quick =
          queue
              .enqueue("quick", Map.of(), EnqueueOptions.builder().queue(queueName).build())
              .taskId();
      // Run B claims nothing while it is paused, so only the completion of run A could take the
      // task.
      worker.pause();
      worker.start();
      waitUntil("run B holds its heartbeat reservation", worker::heartbeatConnected);

      statements.clear();
      gate.borrowOpen.countDown();
      // A completion checkpoint: the held task settled, and its fused statement reported.
      waitUntil(
          "the completion of run A settled and reported",
          () ->
              "succeeded".equals(fastState(held))
                  && statements.stream().anyMatch(statement -> statement.completions() == 1));
      List<Worker.FusedStatement> sent = List.copyOf(statements);
      assertTrue(
          sent.stream()
              .allMatch(statement -> statement.claimLimit() == 0 && statement.claimed() == 0),
          "the completion of run A claimed nothing: " + sent);
      assertEquals("ready", fastState(quick), "the task stays ready for run B");

      worker.resume();
      waitUntil("run B runs the task", () -> "succeeded".equals(fastState(quick)));
    } finally {
      release.countDown();
      gate.borrowOpen.countDown();
      worker.close();
    }
  }

  /**
   * SM-1580: a claim passes the claim gate, and its statement is in flight. The worker stops with a
   * grace of 0, so the stop abandons the claim and the run ends. The run's heartbeat reservation
   * stays held until the statement settles, and only then does the heartbeat give its connection
   * back to the pool.
   */
  @Test
  void keepsTheReservationOfAnEndedRunUntilItsClaimStatementSettles() throws Exception {
    String queueName = "jvm-gate-permit-" + UUID.randomUUID();
    makeFast(queueName);
    HeartbeatGate gate = new HeartbeatGate();
    Worker worker =
        gateWorker(gate, queueName, Duration.ofMillis(100), Map.of(), 1)
            .shutdownGrace(Duration.ZERO)
            .build();
    // The run end decides at once whether a claim keeps its reservation: a release returns the
    // heartbeat connection, and a kept reservation runs onReservationKeptForClaims.
    CountDownLatch decided = new CountDownLatch(1);
    worker.onReservationKeptForClaims = decided::countDown;
    gate.holdClaim.set(true);
    worker.start();
    try {
      assertTrue(
          gate.claimHeld.await(20, TimeUnit.SECONDS), "a claim passed the gate and is in flight");
      assertEquals(1, gate.heartbeatBackends.size(), "the heartbeat holds one connection");
      worker.close();
      assertEquals(1, worker.claimsInFlight(), "the run ended and abandoned its claim");
      Thread watcher =
          Thread.ofVirtual()
              .start(
                  () -> {
                    try {
                      gate.heartbeatReturned.await(60, TimeUnit.SECONDS);
                    } catch (InterruptedException interrupted) {
                      return;
                    }
                    decided.countDown();
                  });
      try {
        assertTrue(decided.await(20, TimeUnit.SECONDS), "the run end decided");
        assertEquals(
            1,
            gate.heartbeatReturned.getCount(),
            "the heartbeat keeps its connection while the claim statement runs");
      } finally {
        watcher.interrupt();
      }

      gate.claimOpen.countDown();
      waitUntil("the claim settled", () -> worker.claimsInFlight() == 0);
      assertTrue(
          gate.heartbeatReturned.await(20, TimeUnit.SECONDS),
          "the settled claim releases the reservation, and the connection goes back");
    } finally {
      gate.claimOpen.countDown();
      worker.close();
    }
  }

  /**
   * SM-1580: a fast-tier completion of run A waits for its borrow. A stops and abandons the
   * attempt, and run B starts on the same worker. The borrow then fails, so the attempt of run A
   * fails. That failure ends run A only: it does not stop run B.
   */
  @Test
  void aLateFailureOfAnEndedRunDoesNotStopALaterRun() throws Exception {
    String queueName = "jvm-gate-late-failure-" + UUID.randomUUID();
    makeFast(queueName);
    Queue queue = new Queue(ConnectionSource.of(new ScratchDataSource(true)));
    CountDownLatch release = new CountDownLatch(1);
    UUID held =
        queue.enqueue("hold", Map.of(), EnqueueOptions.builder().queue(queueName).build()).taskId();
    HeartbeatGate gate = new HeartbeatGate();
    Worker worker =
        gateWorker(gate, queueName, Duration.ofMillis(100), Map.of("hold", release), 1)
            .shutdownGrace(Duration.ZERO)
            .build();
    worker.start();
    try {
      waitUntil("the held task runs", () -> "active".equals(fastState(held)));
      gate.holdBorrowIn.set("sendCompletionChunk");
      release.countDown();
      waitUntil("the completion waits for its borrow", () -> gate.borrowWaiting.get() == 1);
      assertThrows(ShutdownIncompleteException.class, worker::close, "run A left its attempt");

      gate.failBorrow.set(true);
      worker.start();
      // Run B takes its stop version when it starts.
      long runB = worker.stopVersion();
      waitUntil("run B holds its heartbeat reservation", worker::heartbeatConnected);
      gate.borrowOpen.countDown();
      // A completion checkpoint: the attempt of run A leaves the active set only after its failure
      // was handled.
      waitUntil("the attempt of run A ended", () -> worker.activeAttempts() == 0);
      assertEquals(runB, worker.stopVersion(), "the failure of run A does not stop run B");

      UUID quick =
          queue
              .enqueue("quick", Map.of(), EnqueueOptions.builder().queue(queueName).build())
              .taskId();
      waitUntil("run B runs the task", () -> "succeeded".equals(fastState(quick)));
    } finally {
      release.countDown();
      gate.borrowOpen.countDown();
      worker.close();
    }
  }

  /**
   * SM-1580: the fused claim of a completion of run A passes the claim gate, and its statement
   * stalls. A stops and ends, and run B starts on the same worker, paused. The statement then
   * returns a claimed task. The claims of run A ended, so the task does not run: no handler starts
   * after the drain of run A.
   */
  @Test
  void startsNoHandlerForAFusedClaimThatReturnsAfterItsRunEnded() throws Exception {
    String queueName = "jvm-gate-late-fused-" + UUID.randomUUID();
    makeFast(queueName);
    Queue queue = new Queue(ConnectionSource.of(new ScratchDataSource(true)));
    CountDownLatch release = new CountDownLatch(1);
    CountDownLatch lateStarted = new CountDownLatch(1);
    UUID held =
        queue.enqueue("hold", Map.of(), EnqueueOptions.builder().queue(queueName).build()).taskId();
    HeartbeatGate gate = new HeartbeatGate();
    // One slot: the held task fills it, and its completion reserves a fused claim for that slot.
    Worker worker =
        gateWorker(gate, queueName, Duration.ofMillis(100), Map.of("hold", release), 1)
            .handle(
                "late",
                Object.class,
                (ctx, payload) -> {
                  lateStarted.countDown();
                  return Map.of();
                })
            .shutdownGrace(Duration.ZERO)
            .build();
    worker.start();
    try {
      waitUntil("the held task runs", () -> "active".equals(fastState(held)));
      UUID late =
          queue
              .enqueue("late", Map.of(), EnqueueOptions.builder().queue(queueName).build())
              .taskId();
      gate.holdClaim.set(true);
      release.countDown();
      assertTrue(
          gate.claimHeld.await(20, TimeUnit.SECONDS),
          "the fused claim passed the gate and its statement stalls");
      assertThrows(ShutdownIncompleteException.class, worker::close, "run A left its attempt");

      // Run B claims nothing while it is paused, so only the fused claim of run A could take the
      // task.
      worker.pause();
      worker.start();
      waitUntil("run B holds its heartbeat reservation", worker::heartbeatConnected);
      gate.claimOpen.countDown();
      // A completion checkpoint: the attempt of run A settles its fused result before it leaves
      // the active set, and an admitted task stays in that set until its handler ends.
      waitUntil("the held task settled", () -> "succeeded".equals(fastState(held)));
      waitUntil("no attempt is active", () -> worker.activeAttempts() == 0);
      assertEquals(1, lateStarted.getCount(), "no handler of run A starts after its drain");
      assertFalse("succeeded".equals(fastState(late)), "the late task did not run");
    } finally {
      release.countDown();
      gate.claimOpen.countDown();
      worker.close();
    }
  }

  /**
   * SM-1580: run A is a {@code runOnce} pass. It runs one task, and its next claim finds the queue
   * empty, so the pass ends. A drains, abandons the attempt, and ends without a {@link
   * Worker#stop}. The handler waits across the drain's interrupt until the test releases it, so its
   * completion then waits for its borrow, whatever the timing of the drain. Run B starts with the
   * same stop version. The borrow then fails, so the attempt of run A fails. That failure belongs
   * to run A, which ended, so run B keeps running.
   */
  @Test
  void aLateFailureOfARunThatEndedWithoutAStopDoesNotStopALaterRun() throws Exception {
    String queueName = "jvm-gate-late-failure-once-" + UUID.randomUUID();
    makeFast(queueName);
    Queue queue = new Queue(ConnectionSource.of(new ScratchDataSource(true)));
    CountDownLatch release = new CountDownLatch(1);
    CountDownLatch handlerStarted = new CountDownLatch(1);
    queue.enqueue("hold", Map.of(), EnqueueOptions.builder().queue(queueName).build());
    HeartbeatGate gate = new HeartbeatGate();
    // The second claim statement is the empty claim that ends the pass. It waits until the handler
    // runs, so the drain cannot start before the handler does.
    gate.beforeClaimSend.set(
        send -> {
          if (send == 2) {
            awaitAcrossInterrupts(handlerStarted);
          }
        });
    Worker worker =
        gateWorker(gate, queueName, Duration.ofMillis(100), Map.of(), 2)
            .handle(
                "hold",
                Object.class,
                (ctx, payload) -> {
                  handlerStarted.countDown();
                  awaitAcrossInterrupts(release);
                  return Map.of();
                })
            .shutdownGrace(Duration.ZERO)
            .build();
    long version = worker.stopVersion();
    CompletableFuture<Boolean> runA = CompletableFuture.supplyAsync(worker::runOnce);
    try {
      // A checkpoint: the claim that took the task and the empty claim both returned, so the pass
      // ended and the dispatch loop of run A stopped. The completion then reserves no fused claim.
      waitUntil(
          "run A made its empty claim",
          () -> gate.claimSends.get() == 2 && worker.claimsInFlight() == 0);
      // The handler still waits, also if the drain already interrupted it, so the order of the
      // drain and the release does not matter.
      gate.holdBorrowIn.set("sendCompletionChunk");
      release.countDown();
      waitUntil(
          "the completion of run A waits for its borrow", () -> gate.borrowWaiting.get() == 1);
      ExecutionException ended =
          assertThrows(ExecutionException.class, () -> runA.get(20, TimeUnit.SECONDS));
      assertTrue(
          ended.getCause() instanceof ShutdownIncompleteException,
          "run A left its attempt: " + ended.getCause());
      assertEquals(version, worker.stopVersion(), "run A ended without a stop");

      gate.failBorrow.set(true);
      worker.start();
      waitUntil("run B holds its heartbeat reservation", worker::heartbeatConnected);
      gate.borrowOpen.countDown();
      // A completion checkpoint: the attempt of run A leaves the active set only after its failure
      // was handled.
      waitUntil("the attempt of run A ended", () -> worker.activeAttempts() == 0);
      assertEquals(version, worker.stopVersion(), "the failure of run A does not stop run B");
      assertTrue(worker.isRunning(), "run B still runs");

      UUID quick =
          queue
              .enqueue("quick", Map.of(), EnqueueOptions.builder().queue(queueName).build())
              .taskId();
      waitUntil("run B runs the task", () -> "succeeded".equals(fastState(quick)));
      assertTrue(worker.isRunning(), "run B still runs after the task");
    } finally {
      release.countDown();
      gate.borrowOpen.countDown();
      worker.close();
    }
  }
}
