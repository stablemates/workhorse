package dev.stablemates.workhorse;

import java.util.Objects;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Runs a worker as the whole process (ADR 0103, "A worker process without Spring"). The counterpart
 * of Ruby's {@code Stablemates::Workhorse.run_worker_process}.
 */
public final class WorkerProcess {
  private WorkerProcess() {}

  /**
   * Runs {@code worker} on the calling thread, and ends the process when the run ends.
   *
   * <p>The method registers one JVM shutdown hook, and only when it is called. On {@code SIGINT} or
   * {@code SIGTERM} the hook stops the worker and waits until the run ends. The worker drains
   * within its shutdown grace and the unwind window, and the process then ends with the JVM's
   * status for the signal.
   *
   * <p>If the run returns without a signal, the process exits 0. If the run throws without a
   * signal, the method writes the error to standard error, and the process exits 1.
   *
   * <p>The JVM runs shutdown hooks concurrently, in no fixed order. So the caller must not close
   * the worker's {@code DataSource} in another shutdown hook. A caller that must close resources
   * after the drain calls {@link Worker#run} and {@link Worker#stop} itself.
   */
  public static void runWorkerProcess(Worker worker) {
    Objects.requireNonNull(worker, "worker");
    // Read before the hook exists, so a signal that arrives before the loop starts still stops it.
    long version = worker.stopVersion();
    AtomicBoolean shutdown = new AtomicBoolean();
    CountDownLatch finished = new CountDownLatch(1);
    Thread hook =
        new Thread(
            () -> {
              shutdown.set(true);
              worker.stop();
              awaitQuietly(finished);
            },
            "workhorse-shutdown");
    Runtime.getRuntime().addShutdownHook(hook);
    Throwable failure = null;
    try {
      worker.runFrom(version);
    } catch (Throwable error) {
      failure = error;
    } finally {
      // Released before any exit call: System.exit blocks until the JVM ends, and the hook waits
      // for this latch, so the hook never joins this thread.
      finished.countDown();
    }
    if (failure != null) {
      failure.printStackTrace();
    }
    if (shutdown.get()) {
      // The shutdown sequence ends the JVM. This thread only waits for it.
      while (true) {
        awaitQuietly(new CountDownLatch(1));
      }
    }
    System.exit(failure == null ? 0 : 1);
  }

  private static void awaitQuietly(CountDownLatch latch) {
    while (true) {
      try {
        latch.await();
        return;
      } catch (InterruptedException ignored) {
        // Only the latch ends the wait.
      }
    }
  }
}
