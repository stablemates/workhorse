package dev.stablemates.workhorse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.Test;

/** The worker's {@link CancellationToken}. */
class CancellationTokenTest {
  @Test
  void keepsOnlyTheFirstReason() throws InterruptedException {
    TaskCancellation token = new TaskCancellation();
    assertFalse(token.isCancelled());
    assertNull(token.reason());
    token.throwIfCancelled();
    assertFalse(token.await(Duration.ofMillis(1)));

    assertTrue(token.cancel(CancellationReason.REQUESTED));
    assertFalse(token.cancel(CancellationReason.SHUTDOWN));

    assertTrue(token.isCancelled());
    assertEquals(CancellationReason.REQUESTED, token.reason());
    assertTrue(token.await(Duration.ZERO));
    token.await();
    CancelledException error = assertThrows(CancelledException.class, token::throwIfCancelled);
    assertEquals(CancellationReason.REQUESTED, error.reason());
  }

  @Test
  void runsEachCallbackOnceAndNotAfterItsHandleCloses() throws Exception {
    Thread caller = Thread.currentThread();
    AtomicReference<@Nullable Thread> ranOn = new AtomicReference<>();
    TaskCancellation token = new TaskCancellation();
    AtomicInteger kept = new AtomicInteger();
    AtomicInteger removed = new AtomicInteger();
    token.onCancel(
        () -> {
          ranOn.set(Thread.currentThread());
          kept.incrementAndGet();
        });
    token.onCancel(removed::incrementAndGet).close();
    token.onCancel(
        () -> {
          throw new IllegalStateException("a failing callback does not stop the others");
        });

    CountDownLatch delivered = new CountDownLatch(1);
    token.onCancel(delivered::countDown);
    token.cancel(CancellationReason.LEASE_LOST);
    token.cancel(CancellationReason.LEASE_LOST);

    // Callbacks run in registration order on one virtual thread, so the last one marks the end.
    assertTrue(delivered.await(10, TimeUnit.SECONDS));
    assertEquals(1, kept.get());
    assertEquals(0, removed.get());
    Thread thread = ranOn.get();
    assertTrue(
        thread != null && !thread.equals(caller), "the callback runs off the cancelling thread");
    assertTrue(thread.isVirtual());
  }

  @Test
  void runsACallbackAtOnceWhenTheTokenIsAlreadyCancelled() {
    TaskCancellation token = new TaskCancellation();
    token.cancel(CancellationReason.SHUTDOWN);
    AtomicInteger calls = new AtomicInteger();
    token.onCancel(calls::incrementAndGet);
    assertEquals(1, calls.get());
  }

  @Test
  void theContextDelegatesToTheToken() {
    TaskCancellation token = new TaskCancellation();
    Worker worker =
        Worker.builder(new dev.stablemates.workhorse.testing.ScratchDataSource(true))
            .queues("default")
            .build();
    HandlerContext context =
        new TaskContext(worker, sampleTask(), token, new Worker.Arbiter(), () -> false);
    assertFalse(context.isCancelled());
    token.cancel(CancellationReason.DEADLINE_EXCEEDED);
    assertTrue(context.isCancelled());
    assertEquals(CancellationReason.DEADLINE_EXCEEDED, context.cancellation().reason());
  }

  private static ClaimedTask sampleTask() {
    return new ClaimedTask(
        java.util.UUID.randomUUID(),
        "default",
        "sample",
        0,
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
  }
}
