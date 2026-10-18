package run.workhorse.spring;

import java.util.Objects;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.locks.ReentrantLock;
import org.apache.commons.logging.Log;
import org.apache.commons.logging.LogFactory;
import org.jspecify.annotations.Nullable;
import org.springframework.context.SmartLifecycle;
import run.workhorse.Worker;

/**
 * Runs the starter's {@link Worker} for the life of the application context (ADR 0103, "Spring Boot
 * starter").
 *
 * <p>The bean calls {@link Worker#start} after the context refreshes. When the context closes,
 * Spring stops this bean before it destroys the {@code DataSource}. The bean calls {@link
 * Worker#stop}, and then {@link Worker#close} on a separate thread, which waits while the worker
 * drains its handlers within {@code shutdownGrace} and the unwind window. Keep {@code
 * spring.lifecycle.timeout-per-shutdown-phase} above that time.
 */
public final class WorkerLifecycle implements SmartLifecycle {
  private static final Log LOG = LogFactory.getLog(WorkerLifecycle.class);

  /** The state of the worker run that this bean owns. */
  public enum State {
    /** The context has not started the worker. */
    NEW,
    /** The worker claims and runs tasks. */
    RUNNING,
    /** The context stopped the worker, and the worker drains its handlers. */
    STOPPING,
    /** The worker drained its handlers and stopped. */
    STOPPED,
    /**
     * The worker run ended without a stop, or a handler still ran after the drain, so the worker
     * abandoned it.
     */
    FAILED
  }

  private final Worker worker;
  private final ReentrantLock lock = new ReentrantLock();
  private volatile State state = State.NEW;
  private volatile @Nullable Throwable failure;
  private @Nullable CountDownLatch drained;

  /** A lifecycle for {@code worker}. */
  public WorkerLifecycle(Worker worker) {
    this.worker = Objects.requireNonNull(worker, "worker");
  }

  /** The worker this bean runs. */
  public Worker worker() {
    return worker;
  }

  /**
   * The state of the current or the last run. A run that ended without a stop reports {@link
   * State#FAILED}. Its error is known only after the stop, through {@link #failure}.
   */
  public State state() {
    State current = state;
    if (current == State.RUNNING && !worker.isRunning()) {
      return State.FAILED;
    }
    return current;
  }

  /** The error that ended the last run, or {@code null} when none is known. */
  public @Nullable Throwable failure() {
    return failure;
  }

  @Override
  public void start() {
    lock.lock();
    try {
      if (state == State.RUNNING || state == State.STOPPING) {
        return;
      }
      failure = null;
      // Worker.start reads the stop state on this thread, so a stop that follows at once is not
      // lost.
      worker.start();
      state = State.RUNNING;
    } finally {
      lock.unlock();
    }
  }

  @Override
  public void stop() {
    CountDownLatch latch = beginStop();
    if (latch != null) {
      awaitUninterruptibly(latch);
    }
  }

  @Override
  public void stop(Runnable callback) {
    CountDownLatch latch = beginStop();
    if (latch == null) {
      callback.run();
      return;
    }
    // Spring waits for the callback up to its shutdown phase timeout, so the drain does not block
    // the thread that stops the other beans of this phase.
    Thread.ofVirtual()
        .name("workhorse-worker-stop-" + worker.workerId())
        .start(
            () -> {
              awaitUninterruptibly(latch);
              callback.run();
            });
  }

  /**
   * Ends claiming at once, and starts the drain on its own thread. Returns the latch of the drain,
   * or {@code null} when no run is in progress.
   */
  private @Nullable CountDownLatch beginStop() {
    lock.lock();
    try {
      if (state == State.STOPPING) {
        return drained;
      }
      if (state != State.RUNNING) {
        return null;
      }
      state = State.STOPPING;
      worker.stop();
      CountDownLatch latch = new CountDownLatch(1);
      drained = latch;
      Thread.ofPlatform()
          .name("workhorse-worker-drain-" + worker.workerId())
          .start(() -> drain(latch));
      return latch;
    } finally {
      lock.unlock();
    }
  }

  private void drain(CountDownLatch latch) {
    try {
      // Waits for the drain, and throws the error that ended the run.
      worker.close();
      state = State.STOPPED;
    } catch (Throwable error) {
      failure = error;
      state = State.FAILED;
      LOG.error("Workhorse worker " + worker.workerId() + " stopped with an error", error);
    } finally {
      latch.countDown();
    }
  }

  /**
   * Whether the context started the worker and has not stopped it. It stays {@code true} after a
   * run that ended without a stop, so that the context still calls {@link #stop}, which reports the
   * error of that run.
   */
  @Override
  public boolean isRunning() {
    State current = state;
    return current == State.RUNNING || current == State.STOPPING;
  }

  /**
   * The highest phase: the worker starts after every other lifecycle bean and stops before them.
   * Spring destroys the {@code DataSource} only after every phase stops.
   */
  @Override
  public int getPhase() {
    return SmartLifecycle.DEFAULT_PHASE;
  }

  private static void awaitUninterruptibly(CountDownLatch latch) {
    boolean interrupted = false;
    while (true) {
      try {
        latch.await();
        break;
      } catch (InterruptedException error) {
        interrupted = true;
      }
    }
    if (interrupted) {
      Thread.currentThread().interrupt();
    }
  }
}
