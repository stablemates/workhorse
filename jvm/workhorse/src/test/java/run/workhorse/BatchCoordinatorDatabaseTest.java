package run.workhorse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Proxy;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.Test;
import run.workhorse.testing.ScratchDataSource;

/**
 * The batch coordinator with members whose cancellation callback has not run yet (SM-1709).
 *
 * <p>A cancellation callback runs on a virtual thread, so it can come after the cancellation is
 * visible. A selection must still never take a member whose token is cancelled. The tasks of the
 * members have no rows, so the evidence writes only log.
 */
class BatchCoordinatorDatabaseTest {
  private static final long WAIT_SECONDS = 20;

  private final ScratchDataSource dataSource = new ScratchDataSource(true);

  /** A token whose callbacks never run, as a callback that the virtual thread has not run yet. */
  private static final class LateToken implements CancellationToken {
    final AtomicReference<@Nullable CancellationReason> reason = new AtomicReference<>();
    final CountDownLatch registered = new CountDownLatch(1);

    @Override
    public boolean isCancelled() {
      return reason.get() != null;
    }

    @Override
    public @Nullable CancellationReason reason() {
      return reason.get();
    }

    @Override
    public void throwIfCancelled() {
      CancellationReason current = reason.get();
      if (current != null) {
        throw new CancelledException(current);
      }
    }

    @Override
    public void await() {
      throw new UnsupportedOperationException();
    }

    @Override
    public boolean await(Duration timeout) {
      throw new UnsupportedOperationException();
    }

    @Override
    public AutoCloseable onCancel(Runnable callback) {
      registered.countDown();
      return () -> {};
    }
  }

  /** One member that runs the coordinator on its own thread. */
  private static final class Member {
    final String name;
    final LateToken token = new LateToken();
    final Worker.Active active;
    final HandlerContext context;
    final AtomicReference<@Nullable Object> result = new AtomicReference<>();
    final AtomicReference<@Nullable Exception> error = new AtomicReference<>();
    @Nullable Thread thread;

    Member(String name, int priority, long order) throws ReflectiveOperationException {
      this.name = name;
      ClaimedTask task =
          new ClaimedTask(
              UUID.randomUUID(),
              "default",
              "batch",
              priority,
              null,
              null,
              null,
              false,
              null,
              1,
              1,
              null,
              null,
              null,
              null,
              1,
              null);
      Constructor<?> constructor = Worker.Active.class.getDeclaredConstructors()[0];
      constructor.setAccessible(true);
      this.active =
          (Worker.Active)
              constructor.newInstance(
                  new Worker.Claimed(task, "{}", 0L, () -> false, false), null, 0, order);
      this.context =
          (HandlerContext)
              Proxy.newProxyInstance(
                  HandlerContext.class.getClassLoader(),
                  new Class<?>[] {HandlerContext.class},
                  (proxy, method, arguments) ->
                      switch (method.getName()) {
                        case "task" -> task;
                        case "cancellation" -> token;
                        case "isCancelled" -> token.isCancelled();
                        default -> throw new UnsupportedOperationException(method.getName());
                      });
    }

    void start(BatchCoordinator coordinator) {
      thread =
          Thread.ofVirtual()
              .start(
                  () -> {
                    try {
                      result.set(coordinator.run(active, name, context));
                    } catch (Exception failure) {
                      error.set(failure);
                    }
                  });
    }

    void join() throws InterruptedException {
      Thread running = thread;
      assertTrue(
          running != null && running.join(Duration.ofSeconds(WAIT_SECONDS)), name + " ended");
    }
  }

  @Test
  void neverSelectsACanceledMemberWhoseCallbackHasNotRun() throws Exception {
    List<List<@Nullable Object>> batches = new CopyOnWriteArrayList<>();
    Worker worker =
        Worker.builder(dataSource)
            .queues("default")
            .pollingOnly(true)
            .disableRegistry(true)
            .concurrency(2)
            .handleBatch(
                "batch",
                Object.class,
                new BatchOptions(2, Duration.ofSeconds(30)),
                items -> {
                  List<@Nullable Object> names =
                      items.stream().<@Nullable Object>map(BatchHandlerItem::payload).toList();
                  batches.add(names);
                  return names.stream().<BatchHandlerOutcome>map(BatchSucceeded::new).toList();
                })
            .build();
    try {
      Field field = Worker.class.getDeclaredField("coordinators");
      field.setAccessible(true);
      @SuppressWarnings("unchecked")
      BatchCoordinator coordinator =
          ((Map<String, BatchCoordinator>) field.get(worker)).get("batch");

      Member canceled = new Member("canceled", 3, 1);
      canceled.start(coordinator);
      // The coordinator registers the callback after the member joins its waiting list.
      assertTrue(canceled.token.registered.await(WAIT_SECONDS, TimeUnit.SECONDS));
      canceled.token.reason.set(CancellationReason.REQUESTED);

      // Two later members fill a batch. The selection must not take the canceled member.
      Member first = new Member("first", 2, 2);
      Member last = new Member("last", 1, 3);
      first.start(coordinator);
      last.start(coordinator);
      for (Member member : List.of(canceled, first, last)) {
        member.join();
      }

      CancelledException stopped = assertInstanceOf(CancelledException.class, canceled.error.get());
      assertEquals(CancellationReason.REQUESTED, stopped.reason());
      assertEquals(List.of(List.of("first", "last")), batches);
      assertEquals("first", first.result.get());
      assertEquals("last", last.result.get());
      assertFalse(batches.stream().anyMatch(batch -> batch.contains("canceled")));
    } finally {
      worker.close();
    }
  }
}
