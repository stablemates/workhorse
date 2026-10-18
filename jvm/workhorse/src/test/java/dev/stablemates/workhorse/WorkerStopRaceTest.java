package dev.stablemates.workhorse;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.stablemates.workhorse.testing.ScratchDataSource;
import dev.stablemates.workhorse.testing.ScratchDatabase;
import java.io.PrintWriter;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.SQLFeatureNotSupportedException;
import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.logging.Logger;
import javax.sql.DataSource;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;

/**
 * A stop that races the start of a run still ends the run within one shutdown grace (SM-1386 review
 * round 3, finding A).
 *
 * <p>The run checks for a stop, and then resets the stop deadline. A stop between the two leaves no
 * deadline. If a step before the claims then stalls, only a deadline that the run sets itself ends
 * the wait. A run also resets the deadline when it ends, so a later run never uses the expired
 * deadline of an earlier stop (review round 4).
 */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 60, unit = TimeUnit.SECONDS)
class WorkerStopRaceTest {
  private static final Duration GRACE = Duration.ofMillis(300);
  private static final Duration BOUND = Duration.ofSeconds(10);

  /** A data source whose next connection, once armed, waits until the test releases it. */
  private static final class Stalling implements DataSource {
    private final ScratchDataSource delegate = new ScratchDataSource(true);
    final AtomicBoolean armed;
    final CountDownLatch release = new CountDownLatch(1);
    final CountDownLatch stalled = new CountDownLatch(1);

    Stalling(boolean armed) {
      this.armed = new AtomicBoolean(armed);
    }

    @Override
    public Connection getConnection() throws SQLException {
      if (armed.compareAndSet(true, false)) {
        stalled.countDown();
        try {
          if (!release.await(BOUND.toSeconds() * 6, TimeUnit.SECONDS)) {
            throw new SQLException("the test did not release the stalled connection");
          }
        } catch (InterruptedException interrupted) {
          Thread.currentThread().interrupt();
          throw new SQLException("interrupted", interrupted);
        }
      }
      return delegate.getConnection();
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

  @Test
  void aStopBetweenTheStopCheckAndTheDeadlineResetEndsTheRunWithinOneGrace() throws Exception {
    Stalling dataSource = new Stalling(true);
    Worker worker =
        Worker.builder(dataSource)
            .queues("jvm-stop-race")
            .pollingOnly(true)
            .disableRegistry(true)
            .shutdownGrace(GRACE)
            .build();
    CountDownLatch held = new CountDownLatch(1);
    CountDownLatch resume = new CountDownLatch(1);
    worker.beforeDeadlineReset =
        () -> {
          held.countDown();
          try {
            assertTrue(resume.await(BOUND.toSeconds(), TimeUnit.SECONDS));
          } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
          }
        };
    Thread run = Thread.ofPlatform().name("stop-race-run").start(worker::run);
    try {
      assertTrue(held.await(BOUND.toSeconds(), TimeUnit.SECONDS), "the run reaches the hook");
      // The stop sets its deadline, and the reset that follows erases it.
      worker.stop();
      resume.countDown();
      assertTrue(
          dataSource.stalled.await(BOUND.toSeconds(), TimeUnit.SECONDS),
          "the compatibility check stalls on its connection");
      long released = System.nanoTime();

      run.join(BOUND);

      assertFalse(run.isAlive(), "the stalled run ended within the bound");
      Duration took = Duration.ofNanos(System.nanoTime() - released);
      assertTrue(
          took.compareTo(GRACE.plusSeconds(5)) < 0,
          "the run ended about one grace after it saw the stop: " + took);
    } finally {
      dataSource.release.countDown();
      run.join(BOUND);
    }
  }

  @Test
  void aLaterRunGetsANewGraceInsteadOfTheExpiredDeadlineOfAnEarlierStop() throws Exception {
    Duration grace = Duration.ofSeconds(1);
    Stalling dataSource = new Stalling(false);
    Worker worker =
        Worker.builder(dataSource)
            .queues("jvm-stop-race-later")
            .pollingOnly(true)
            .registryInterval(Duration.ofSeconds(60))
            .shutdownGrace(grace)
            .build();

    // Run 1 stops and ends. Its stop set a deadline one grace after the stop.
    worker.start();
    worker.close();
    // The deadline of that stop passes.
    Thread.sleep(grace.plusMillis(200).toMillis());

    // Run 2 reads its version, and a second stop arrives before its stop check. This is the order
    // of WorkerProcess: read the version, then a signal stops the worker, then the run starts.
    long version = worker.stopVersion();
    worker.stop();
    // The initial registration of run 2 stalls on its connection. Only the stop deadline ends it.
    dataSource.armed.set(true);
    long started = System.nanoTime();
    Thread run =
        Thread.ofPlatform().name("stop-race-later-run").start(() -> worker.runFrom(version));
    try {
      assertTrue(
          dataSource.stalled.await(BOUND.toSeconds(), TimeUnit.SECONDS),
          "the initial registration of run 2 stalls on its connection");

      run.join(BOUND);

      assertFalse(run.isAlive(), "run 2 ended within the bound");
      Duration took = Duration.ofNanos(System.nanoTime() - started);
      // With the expired deadline of run 1, the stalled step would end at once.
      assertTrue(
          took.compareTo(grace.minusMillis(100)) >= 0,
          "run 2 waited a new grace for its stalled step, not the expired one: " + took);
      assertTrue(took.compareTo(grace.plusSeconds(5)) < 0, "run 2 ended about one grace: " + took);
    } finally {
      dataSource.release.countDown();
      run.join(BOUND);
    }
  }
}
