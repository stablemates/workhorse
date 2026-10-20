package run.workhorse.spring;

import java.time.Duration;
import java.util.Objects;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Consumer;
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
 *
 * <p>While the worker runs, a watcher thread of this bean waits for the run to end. If the run ends
 * without a stop, the watcher collects its error at once, logs it, and sets the state to {@link
 * State#FAILED}. In an application that serves no web requests, the starter then exits the process
 * with a non-zero status, as {@code WorkerProcess} does. A web application keeps running, and its
 * health indicator reports the worker as down.
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

  /** The longest time the watcher waits before it checks the worker again. */
  private static final Duration WATCH_INTERVAL = Duration.ofMillis(100);

  private final Worker worker;
  private final @Nullable Consumer<Throwable> onFailure;
  private final ReentrantLock lock = new ReentrantLock();
  private volatile State state = State.NEW;
  private volatile @Nullable Throwable failure;
  private @Nullable CountDownLatch drained;

  /** Released when a stop begins, so the watcher of the current run ends at once. */
  private @Nullable CountDownLatch watching;

  private @Nullable Thread watcher;

  /** A lifecycle for {@code worker}. A run that ends without a stop does not end the process. */
  public WorkerLifecycle(Worker worker) {
    this(worker, null);
  }

  /**
   * A lifecycle that calls {@code onFailure} on the watcher thread after a run ended without a
   * stop, and after the error is logged. The auto-configuration passes the process exit of an
   * application that serves no web requests.
   */
  WorkerLifecycle(Worker worker, @Nullable Consumer<Throwable> onFailure) {
    this.worker = Objects.requireNonNull(worker, "worker");
    this.onFailure = onFailure;
  }

  /** The worker this bean runs. */
  public Worker worker() {
    return worker;
  }

  /**
   * The state of the current or the last run. A run that ended without a stop reports {@link
   * State#FAILED}. Its error is known through {@link #failure} once the watcher collected it.
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
      CountDownLatch wake = new CountDownLatch(1);
      watching = wake;
      // A platform thread that is not a daemon: in an application with no other such thread, it
      // keeps the JVM alive until it has reported a failed run and exited the process.
      watcher =
          Thread.ofPlatform()
              .daemon(false)
              .name("workhorse-worker-watch-" + worker.workerId())
              .start(() -> watch(wake));
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
      wakeWatcher();
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

  /** Releases the watcher of the current run. It never waits for the watcher thread. */
  private void wakeWatcher() {
    CountDownLatch wake = watching;
    if (wake != null) {
      wake.countDown();
    }
  }

  /**
   * Waits until the run ends or a stop releases {@code wake}. A run that ended without a stop is
   * drained, logged, and reported to {@link #onFailure}.
   */
  private void watch(CountDownLatch wake) {
    try {
      while (worker.isRunning()) {
        if (wake.await(WATCH_INTERVAL.toMillis(), TimeUnit.MILLISECONDS)) {
          return;
        }
      }
    } catch (InterruptedException error) {
      return;
    }
    CountDownLatch latch;
    lock.lock();
    try {
      if (state != State.RUNNING || !Objects.equals(watching, wake)) {
        // A stop began, and it reports the outcome of the run.
        return;
      }
      state = State.STOPPING;
      latch = new CountDownLatch(1);
      drained = latch;
    } finally {
      lock.unlock();
    }
    drain(latch);
    if (state == State.STOPPED) {
      // The run ended without a stop and without an error.
      state = State.FAILED;
      LOG.error("Workhorse worker " + worker.workerId() + " stopped without a stop request");
    }
    Throwable error = failure;
    if (onFailure != null) {
      onFailure.accept(
          error != null ? error : new IllegalStateException("the worker run ended without a stop"));
    }
  }

  /** The watcher thread of the last start, or {@code null} before the first start. */
  @Nullable Thread watcher() {
    return watcher;
  }

  /** Whether a run that ends without a stop calls an exit action. */
  boolean exitsOnFailure() {
    return onFailure != null;
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
   * Whether the context started the worker and has not stopped it. A run that ends without a stop
   * stays {@code true} only until the watcher has drained it and set {@link State#FAILED}.
   */
  @Override
  public boolean isRunning() {
    State current = state;
    return current == State.RUNNING || current == State.STOPPING;
  }

  /**
   * {@link SmartLifecycle#DEFAULT_PHASE}, the highest phase. The worker starts after every
   * lifecycle bean of a lower phase and stops before them, for example before the web server stops.
   * Spring gives no order to beans of the same phase, so a lifecycle bean of the default phase can
   * stop while the worker drains. Spring destroys the {@code DataSource} only after every phase
   * stops.
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
