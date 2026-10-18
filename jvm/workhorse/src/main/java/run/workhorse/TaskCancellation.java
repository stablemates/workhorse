package run.workhorse;

import java.time.Duration;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import org.jspecify.annotations.Nullable;

/** The worker's {@link CancellationToken}. Only the worker cancels it. */
final class TaskCancellation implements CancellationToken {
  private static final System.Logger LOGGER = System.getLogger(Worker.class.getName());

  private final AtomicReference<@Nullable CancellationReason> reason = new AtomicReference<>();
  private final CountDownLatch cancelled = new CountDownLatch(1);
  private final List<Callback> callbacks = new CopyOnWriteArrayList<>();

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
  public void await() throws InterruptedException {
    cancelled.await();
  }

  @Override
  public boolean await(Duration timeout) throws InterruptedException {
    long nanos;
    try {
      nanos = timeout.toNanos();
    } catch (ArithmeticException overflow) {
      nanos = Long.MAX_VALUE;
    }
    return cancelled.await(nanos, TimeUnit.NANOSECONDS);
  }

  @Override
  public AutoCloseable onCancel(Runnable callback) {
    Callback entry = new Callback(callback);
    callbacks.add(entry);
    if (reason.get() != null) {
      entry.run();
    }
    return () -> callbacks.remove(entry);
  }

  /** Cancels the token with {@code why}. Returns whether this call set the reason. */
  boolean cancel(CancellationReason why) {
    if (!reason.compareAndSet(null, why)) {
      return false;
    }
    // The snapshot comes before the wake, so a waiter that wakes and closes its callback handle
    // cannot remove the callback before it runs.
    List<Callback> registered = List.copyOf(callbacks);
    cancelled.countDown();
    // The heartbeat thread and the drain cancel tokens, so a callback that blocks must not run on
    // them: it could hold up every lease renewal, or keep the drain from its interrupt.
    if (!registered.isEmpty()) {
      Thread.ofVirtual()
          .name("workhorse-cancellation-callbacks")
          .start(
              () -> {
                for (Callback callback : registered) {
                  callback.run();
                }
              });
    }
    return true;
  }

  /** A callback that runs at most once, whichever of a cancel and a registration runs it. */
  private static final class Callback {
    private final Runnable body;
    private final AtomicBoolean ran = new AtomicBoolean();

    Callback(Runnable body) {
      this.body = body;
    }

    void run() {
      if (!ran.compareAndSet(false, true)) {
        return;
      }
      try {
        body.run();
      } catch (RuntimeException error) {
        LOGGER.log(System.Logger.Level.WARNING, "Cancellation callback failed", error);
      }
    }
  }
}
