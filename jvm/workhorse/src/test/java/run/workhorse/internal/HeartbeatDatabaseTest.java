package run.workhorse.internal;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.BooleanSupplier;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.ConnectionSource;
import run.workhorse.EnqueueOptions;
import run.workhorse.Queue;
import run.workhorse.Worker;
import run.workhorse.testing.ScratchDataSource;
import run.workhorse.testing.ScratchDatabase;

/** The dedicated heartbeat against PostgreSQL, through its bounded transaction. */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 60, unit = TimeUnit.SECONDS)
class HeartbeatDatabaseTest {
  private static final String LEASE =
      "SELECT worker_id, fence_token, expires_at FROM workhorse.task_runtime"
          + " WHERE task_id = ?::uuid";

  private final ScratchDataSource dataSource = new ScratchDataSource(true);

  private record Lease(String workerId, long fenceToken, Instant expiresAt) {}

  private static Lease lease(UUID taskId) throws SQLException {
    try (Connection connection = ScratchDatabase.connect();
        PreparedStatement statement = connection.prepareStatement(LEASE)) {
      statement.setString(1, taskId.toString());
      try (ResultSet result = statement.executeQuery()) {
        assertTrue(result.next(), "the task holds a lease");
        return new Lease(
            result.getString("worker_id"),
            result.getLong("fence_token"),
            result.getTimestamp("expires_at").toInstant());
      }
    }
  }

  private static void waitUntil(String what, BooleanSupplier condition)
      throws InterruptedException {
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
    while (!condition.getAsBoolean()) {
      if (System.nanoTime() - deadline > 0) {
        throw new AssertionError("timed out waiting until " + what);
      }
      TimeUnit.MILLISECONDS.sleep(5);
    }
  }

  /** One attempt that the test registers by hand. It records each status and when it came. */
  private static final class Recorded implements Heartbeat.Member {
    private final Lease lease;
    private final UUID taskId;
    final List<String> statuses = new CopyOnWriteArrayList<>();
    final List<Long> statusAt = new CopyOnWriteArrayList<>();
    final AtomicInteger renewals = new AtomicInteger();
    final AtomicLong renewedAt = new AtomicLong();

    Recorded(UUID taskId, Lease lease) {
      this.taskId = taskId;
      this.lease = lease;
    }

    @Override
    public String workerId() {
      return lease.workerId();
    }

    @Override
    public UUID taskId() {
      return taskId;
    }

    @Override
    public long fenceToken() {
      return lease.fenceToken();
    }

    @Override
    public long leaseMs() {
      return 30_000;
    }

    @Override
    public long intervalNanos() {
      return TimeUnit.SECONDS.toNanos(1);
    }

    @Override
    public long leaseEndsAt() {
      return System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
    }

    @Override
    public void renew(long sentAt) {
      renewedAt.compareAndSet(0, System.nanoTime());
      renewals.incrementAndGet();
    }

    @Override
    public void settle(String status) {
      statusAt.add(System.nanoTime());
      statuses.add(status);
    }

    @Override
    public void fail(Exception error) {
      throw new AssertionError(error);
    }
  }

  /**
   * SM-1443: a round does not wait on a task row that another transaction holds. It reports the
   * lease busy at once, renews nothing, and the round after the commit renews the lease.
   */
  @Test
  void reportsALeaseBusyAtOnceWhileAnotherTransactionHoldsItsRow() throws Exception {
    String queueName = "jvm-heartbeat-busy-" + UUID.randomUUID();
    UUID taskId =
        new Queue(ConnectionSource.of(dataSource))
            .enqueue("held", Map.of(), EnqueueOptions.builder().queue(queueName).build())
            .taskId();
    CountDownLatch started = new CountDownLatch(1);
    CountDownLatch release = new CountDownLatch(1);
    // The worker's own heartbeat is far away, so only the test's heartbeat renews in the test.
    Worker worker =
        Worker.builder(dataSource)
            .queues(queueName)
            .workerId("jvm-heartbeat-busy")
            .pollingOnly(true)
            .pollInterval(Duration.ofMillis(10))
            .disableRegistry(true)
            .lease(Duration.ofSeconds(30))
            .heartbeat(Duration.ofSeconds(10))
            .handle(
                "held",
                Object.class,
                (ctx, payload) -> {
                  started.countDown();
                  release.await(30, TimeUnit.SECONDS);
                  return Map.of();
                })
            .build();
    ExecutorService runner = Executors.newSingleThreadExecutor();
    Heartbeat heartbeat = new Heartbeat(dataSource, true);
    Runnable unregister = () -> {};
    try (Connection blocker = ScratchDatabase.connect()) {
      Future<Boolean> run = runner.submit(worker::runOnce);
      assertTrue(started.await(20, TimeUnit.SECONDS), "the handler started");
      Lease claimed = lease(taskId);
      blocker.setAutoCommit(false);
      try (PreparedStatement lock =
          blocker.prepareStatement(
              "SELECT FROM workhorse.task_runtime WHERE task_id = ?::uuid FOR UPDATE")) {
        lock.setString(1, taskId.toString());
        lock.execute();
      }
      Recorded member = new Recorded(taskId, claimed);
      long registeredAt = System.nanoTime();
      unregister = heartbeat.register(member);
      waitUntil("a round reported the lease busy", () -> !member.statuses.isEmpty());
      // The first round falls due one interval of 1 s after the registration. Its bound is 750 ms,
      // and a busy answer comes long before it.
      double answeredMs =
          (member.statusAt.get(0) - registeredAt - TimeUnit.SECONDS.toNanos(1)) / 1e6;
      assertTrue(answeredMs < 300, "the busy answer came " + answeredMs + " ms after the slot");
      assertEquals("busy", member.statuses.get(0));
      assertEquals(0, member.renewals.get(), "a busy round renews nothing");
      assertEquals(claimed.expiresAt(), lease(taskId).expiresAt(), "the lease did not change");
      blocker.commit();
      waitUntil("a round renewed the lease", () -> member.renewals.get() > 0);
      // A busy retry renews the lease before the next regular slot at 2 s.
      double renewedMs = (member.renewedAt.get() - registeredAt) / 1e6;
      assertTrue(renewedMs < 1_900, "the lease was renewed " + renewedMs + " ms after the start");
      assertTrue(lease(taskId).expiresAt().isAfter(claimed.expiresAt()), "the lease was renewed");
      assertTrue(
          member.statuses.stream().allMatch("busy"::equals),
          "only busy statuses: " + member.statuses);
      unregister.run();
      release.countDown();
      assertTrue(run.get(20, TimeUnit.SECONDS), "the worker ran the task");
    } finally {
      unregister.run();
      release.countDown();
      runner.shutdownNow();
    }
  }
}
