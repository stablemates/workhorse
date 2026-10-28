package run.workhorse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Test;

/**
 * SM-1869: the worker converts the expiry to a monotonic due time once. A step of the wall clock
 * does not move the first expiry request.
 */
class WorkerExpirationClockTest {
  @Test
  void aWallClockThatStepsBackDuringALeaseWaitDoesNotDelayTheFirstRequest() throws Exception {
    long expirationNanos = TimeUnit.MILLISECONDS.toNanos(1_500);
    SteppingWallClock wallClock = new SteppingWallClock(Duration.ofMinutes(-10));
    // Each lease wait is shorter than the expiry, so the watch waits on the lease first. The lease
    // is 25 renewals long, so a slow host does not end it.
    Worker.Ownership ownership =
        new Worker.Ownership(System.nanoTime(), TimeUnit.MILLISECONDS.toNanos(500));
    Thread renewer =
        Thread.ofVirtual()
            .start(
                () -> {
                  try {
                    while (!ownership.stop.await(20, TimeUnit.MILLISECONDS)) {
                      ownership.renew(System.nanoTime());
                    }
                  } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                  }
                });
    AtomicLong dueAt = new AtomicLong();
    AtomicLong askedAt = new AtomicLong();
    AtomicInteger lostLeases = new AtomicInteger();
    Thread watch =
        Thread.ofVirtual()
            .start(
                () -> {
                  // The watch reads the expiry at once, so the whole expiry is still ahead of it.
                  dueAt.set(System.nanoTime() + expirationNanos);
                  Instant expirationAt = Instant.now().plusNanos(expirationNanos);
                  try {
                    Worker.watchExpiration(
                        expirationAt,
                        wallClock,
                        ownership,
                        () -> {
                          askedAt.compareAndSet(0, System.nanoTime());
                          return "deadline_exceeded";
                        },
                        lostLeases::incrementAndGet);
                  } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                  }
                });

    watch.join(Duration.ofNanos(expirationNanos).plusSeconds(5));
    ownership.abandon();
    watch.join();
    renewer.join();

    assertEquals(0, lostLeases.get(), "the lease window ended");
    // A wait on the wall clock would put the first request 10 minutes late.
    assertTrue(askedAt.get() != 0, "the watch made no expiry request");
    long lateNanos = askedAt.get() - dueAt.get();
    assertTrue(
        lateNanos >= -TimeUnit.MILLISECONDS.toNanos(50) && lateNanos < TimeUnit.SECONDS.toNanos(2),
        "the first request came " + Duration.ofNanos(lateNanos) + " after the due time");
  }

  @Test
  void anExpiryFarInThePastIsDueAtOnce() throws Exception {
    // The span from 2026 to 2400 overflows the nanosecond count. The watch must not read it as a
    // future due time.
    Instant expirationAt = Instant.parse("2026-10-24T00:00:00Z");
    Clock wallClock = Clock.fixed(Instant.parse("2400-01-01T00:00:00Z"), ZoneOffset.UTC);
    Worker.Ownership ownership =
        new Worker.Ownership(System.nanoTime(), TimeUnit.SECONDS.toNanos(30));
    AtomicInteger asks = new AtomicInteger();
    Thread watch =
        Thread.ofVirtual()
            .start(
                () -> {
                  try {
                    Worker.watchExpiration(
                        expirationAt,
                        wallClock,
                        ownership,
                        () -> {
                          asks.incrementAndGet();
                          return "deadline_exceeded";
                        },
                        () -> {});
                  } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                  }
                });

    watch.join(Duration.ofSeconds(5));
    ownership.abandon();
    watch.join();

    assertEquals(1, asks.get(), "the watch did not ask at once");
  }

  /** A wall clock that reads {@code step} away from the real time after its first read. */
  private static final class SteppingWallClock extends Clock {
    private final Duration step;
    private final AtomicInteger reads = new AtomicInteger();

    SteppingWallClock(Duration step) {
      this.step = step;
    }

    @Override
    public Instant instant() {
      Instant now = Instant.now();
      return reads.getAndIncrement() == 0 ? now : now.plus(step);
    }

    @Override
    public ZoneId getZone() {
      return ZoneOffset.UTC;
    }

    @Override
    public Clock withZone(ZoneId zone) {
      throw new UnsupportedOperationException();
    }
  }
}
