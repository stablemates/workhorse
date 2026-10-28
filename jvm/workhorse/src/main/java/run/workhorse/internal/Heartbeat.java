package run.workhorse.internal;

import java.io.IOException;
import java.net.SocketException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.sql.SQLNonTransientConnectionException;
import java.sql.SQLTimeoutException;
import java.sql.SQLTransientConnectionException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.BooleanSupplier;
import javax.sql.DataSource;
import org.jspecify.annotations.Nullable;
import run.workhorse.internal.telemetry.Telemetry;
import run.workhorse.internal.telemetry.WorkerTelemetry;

/**
 * Renews the leases of running attempts on a dedicated platform thread. Internal to the SDK; the
 * counterpart of Ruby's {@code Worker::Heartbeat} (ADR 0071).
 *
 * <p>Every worker on one {@link DataSource} object shares one dedicated heartbeat. The key is the
 * object itself, by reference identity, never by {@code equals}. That heartbeat holds one
 * connection while a worker holds a {@link Reservation} or an attempt is registered, so handlers
 * that hold every other connection never delay a lease round.
 *
 * <p>A dedicated heartbeat checks out its connection, and each replacement, on one checkout thread
 * at a time. That thread owns each connection from its checkout until the pool has it back, so a
 * late return always ends before the next checkout starts. A round waits for that checkout only
 * inside its own bound, so the timeout of the pool never delays a renewal past the bound. A round
 * without a connection fails, the checkout goes on with a capped backoff, and the lease watchdog
 * bounds the loss.
 */
public final class Heartbeat {
  /** The most leases one {@code heartbeat_many_v2} call renews. */
  private static final int ROUND_LIMIT = 100;

  /**
   * The first wait before a failed checkout of the held connection runs again. The wait doubles
   * after each failure, up to the shortest interval of the reservations and members.
   */
  private static final long RETRY_NANOS = TimeUnit.MILLISECONDS.toNanos(100);

  /** The longest wait between two checkouts when no reservation or member states an interval. */
  private static final long DEFAULT_RETRY_CAP_NANOS = TimeUnit.SECONDS.toNanos(1);

  /** The longest wait of {@link Reservation#await} before it checks whether its caller stops. */
  private static final long AWAIT_SLICE_NANOS = TimeUnit.MILLISECONDS.toNanos(50);

  /**
   * The shortest deadline of a round, when the interval allows it. A short interval thus still
   * leaves time for the round.
   */
  private static final long MIN_ROUND_TIMEOUT_MS = 50;

  /**
   * A round with less time than this left fails before it sends its heartbeat. At this size every
   * server budget is at least 1 ms, and the budgets still fit in the time left.
   */
  private static final long MIN_REMAINING_NANOS = TimeUnit.MILLISECONDS.toNanos(8);

  /**
   * The longest base delay before a busy retry. The retry waits {@code base × (1 + random)}, with
   * {@code base = min(BUSY_RETRY_BASE_MS, interval / 8)}.
   */
  private static final long BUSY_RETRY_BASE_MS = 100;

  /** The time that a bounded busy retry adds to {@link #MIN_REMAINING_NANOS}. */
  private static final long BUSY_RETRY_MARGIN_NANOS = TimeUnit.MILLISECONDS.toNanos(12);

  /**
   * A bounded busy retry with less time than this before its deadline does not run: the time a
   * round needs at the settings statement, plus a margin for the payload, the wait for the
   * connection, and BEGIN.
   */
  static final long BUSY_RETRY_MIN_NANOS = MIN_REMAINING_NANOS + BUSY_RETRY_MARGIN_NANOS;

  /**
   * Sets both server timeouts for the current transaction only. {@code SET LOCAL} cannot take a
   * bind parameter, and {@code set_config(..., true)} has the same scope.
   */
  private static final String ROUND_TIMEOUTS =
      "SELECT set_config('statement_timeout', ?, true), "
          + "set_config('idle_in_transaction_session_timeout', ?, true)";

  // The workers that use a heartbeat, and its own thread, keep it alive.
  private static final IdentityRegistry<DataSource, Heartbeat> DEDICATED = new IdentityRegistry<>();

  /** One running attempt. */
  public interface Member {
    /** The worker that owns the attempt. */
    String workerId();

    /** The task. */
    UUID taskId();

    /** The attempt's fence token. */
    long fenceToken();

    /** The lease each renewal grants, in milliseconds. */
    long leaseMs();

    /** The interval between renewals, in nanoseconds. */
    long intervalNanos();

    /**
     * The end of the attempt's local lease window, a {@link System#nanoTime} value. A busy retry
     * never runs past it, and does not send a lease whose window has ended.
     */
    long leaseEndsAt();

    /** Records an accepted round that left at {@code sentAt}, a {@link System#nanoTime} value. */
    void renew(long sentAt);

    /**
     * Acts on a status other than {@code accepted}. The status {@code busy} means that another
     * transaction held the task's row: the round renewed nothing and gave no ownership verdict, so
     * the member must keep its lease window and stay registered.
     */
    void settle(String status) throws Exception;

    /** Records an error that {@link #settle} threw. */
    void fail(Exception error);

    /**
     * The telemetry of the worker, which counts a round of this member that failed before
     * PostgreSQL returned a status ({@link #roundFailed}).
     */
    default Telemetry telemetry() {
      return Telemetry.NOOP;
    }
  }

  /** The most exceptions that {@link #roundFailureReason} reads in one failure. */
  private static final int FAILURE_CHAIN_LIMIT = 16;

  /**
   * How much earlier than the round deadline the network timeout of a dedicated round can end.
   * {@code boundUntil} rounds the time left down to whole milliseconds, so the read can time out up
   * to 1 ms before the deadline.
   */
  private static final long NETWORK_TIMEOUT_SLACK_NANOS = TimeUnit.MILLISECONDS.toNanos(1);

  private final DataSource dataSource;
  private final ReentrantLock lock = new ReentrantLock();
  private final Condition changed = lock.newCondition();
  private final Map<List<Object>, Member> members = new LinkedHashMap<>();
  private @Nullable Thread thread;

  /** A round that replaces every connection, for tests of the schedule. */
  private final @Nullable Round fixedRound;

  /** Whether the heartbeat holds a connection across rounds: true without a fixed round. */
  private final boolean holdsConnection;

  /** The open reservations of workers. They change under {@link #lock}. */
  private final List<Reservation> reservations = new ArrayList<>();

  /**
   * The held connection, or {@code null}. The checkout thread installs it. Only the heartbeat
   * thread sends rounds on it, and only the heartbeat thread lets it go, after which the checkout
   * thread gives it back to the pool. It changes under {@link #lock}.
   */
  private @Nullable Held held;

  /** Mirrors {@code held != null}, so a worker reads it without the lock. */
  private volatile boolean connected;

  /**
   * Whether the checkout thread runs. From the checkout until the return of each connection, the
   * thread keeps this true, so no second checkout starts while a connection is still out. It
   * changes under {@link #lock}.
   */
  private boolean checkingOut;

  /**
   * Whether the checkout thread gives a connection back to the pool now. It changes under {@link
   * #lock}.
   */
  private boolean returning;

  /**
   * The failure of a checkout since the latest installed connection, or {@code null}. It changes
   * under {@link #lock}.
   */
  private @Nullable Throwable checkoutFailure;

  /**
   * The connection that the latest round sent on, or {@code null} when it got none. A failed round
   * discards only this connection. Only the heartbeat thread uses it.
   */
  private @Nullable Held sent;

  /**
   * True when the latest round got a new connection only during its bound, and so sent nothing on
   * it. The next round then starts at once, with a full bound. Only the heartbeat thread uses it.
   */
  private boolean freshConnection;

  /**
   * True when the next round must run at once, whatever the intervals of the members are now: the
   * latest round got a new connection during its bound and sent nothing. Only the heartbeat thread
   * uses it.
   */
  private boolean runNow;

  /**
   * Runs when a round starts to wait for a new connection, on the heartbeat thread, or {@code
   * null}. A test sets it to deliver the connection at a known point of that round.
   */
  volatile @Nullable Runnable onAwaitConnection;

  /**
   * Runs when a round that waited for a new connection gets it before the round's deadline, on the
   * heartbeat thread, or {@code null}. A test uses it to see which round got the connection.
   */
  volatile @Nullable Runnable onConnectionInRound;

  /**
   * Runs when a reservation or a member needs a connection while the checkout thread still gives
   * the previous one back, on the caller's thread with {@link #lock} held, or {@code null}. A test
   * uses it to know that the new checkout waits for that return.
   */
  volatile @Nullable Runnable onReturnPending;

  /**
   * The number of rounds that this heartbeat started, regular rounds and busy retries. Only the
   * heartbeat thread changes it. A test reads it to tell one round from the next.
   */
  final AtomicLong roundsStarted = new AtomicLong();

  /**
   * The start of the latest regular round, a {@link System#nanoTime} value. Only the heartbeat
   * thread uses it. A new connection keeps it, so a failed round does not start a new schedule. A
   * busy retry does not move it.
   */
  private long previous;

  /**
   * The members that the latest round reported busy, which a retry renews before the next regular
   * slot, or {@code null}. A round of either kind replaces it. Only the heartbeat thread uses it.
   */
  private @Nullable List<Member> busyRetry;

  /** When the busy retry falls due, a {@link System#nanoTime} value. */
  private long busyRetryAt;

  /**
   * True when the latest {@link #sendBatches} call expired before its heartbeat statement ({@link
   * RoundExpired}). A busy retry that stops this way fails, so it schedules no other retry. Only
   * the heartbeat thread uses it.
   */
  private boolean roundExpired;

  Heartbeat(DataSource dataSource) {
    this(dataSource, null);
  }

  /**
   * A heartbeat whose rounds go through {@code fixedRound} instead of a connection, when it is not
   * {@code null}, for tests. A failed round then acts as a failed round on the held connection.
   */
  Heartbeat(DataSource dataSource, @Nullable Round fixedRound) {
    this.dataSource = dataSource;
    this.fixedRound = fixedRound;
    this.holdsConnection = fixedRound == null;
  }

  /** The heartbeat that every worker on the {@code dataSource} object shares. */
  public static Heartbeat dedicated(DataSource dataSource) {
    return DEDICATED.get(dataSource, Heartbeat::new);
  }

  /**
   * Reserves the held connection for a worker, and returns the reservation. While a reservation is
   * open, a dedicated heartbeat keeps its connection, and replaces a lost one at once, also when no
   * attempt is registered. {@code intervalNanos} is the worker's heartbeat interval, which caps the
   * wait between two failed checkouts. {@code onConnected} runs on the checkout thread each time a
   * new connection is installed. A reservation of a heartbeat with a fixed round is always
   * connected.
   */
  public Reservation reserve(long intervalNanos, Runnable onConnected) {
    Reservation reservation = new Reservation(intervalNanos, onConnected);
    if (!holdsConnection) {
      return reservation;
    }
    lock.lock();
    try {
      reservations.add(reservation);
      startCheckoutLocked();
      startThreadLocked();
      changed.signalAll();
    } finally {
      lock.unlock();
    }
    return reservation;
  }

  /**
   * A worker's hold on the connection of a dedicated heartbeat. {@link #close} gives it up, and
   * closing twice is harmless. When the last hold closes and no attempt is registered, the
   * heartbeat thread gives the connection back to the pool.
   */
  public final class Reservation implements AutoCloseable {
    private final long intervalNanos;
    private final Runnable onConnected;

    /** True once {@link #close} ran. A closed reservation is never connected. */
    private volatile boolean closed;

    private Reservation(long intervalNanos, Runnable onConnected) {
      this.intervalNanos = intervalNanos;
      this.onConnected = onConnected;
    }

    /**
     * Whether the heartbeat holds a usable connection now for this open reservation. A failed
     * renewal on a connection that stays open, and a round that a row lock holds, keep it
     * connected. A lost connection clears it until the replacement arrives. After {@link #close},
     * it is always false, so work that the reservation's run started cannot use the connection of a
     * later reservation.
     */
    public boolean connected() {
      return !closed && (!holdsConnection || connected);
    }

    /**
     * Waits until the heartbeat holds its connection, until {@code deadline}, a {@link
     * System#nanoTime} value, or until {@code stopped} is true. It checks {@code stopped} at least
     * every 50 ms. A checkout that fails runs again after its backoff, so the wait continues until
     * one of the three ends it.
     *
     * @return whether the heartbeat holds its connection
     */
    public boolean await(long deadline, BooleanSupplier stopped) {
      if (!holdsConnection) {
        return true;
      }
      lock.lock();
      try {
        return awaitHeldLocked(deadline, stopped) != null;
      } finally {
        lock.unlock();
      }
    }

    /**
     * The failure of a checkout since the heartbeat last installed a connection, or {@code null}.
     */
    public @Nullable Throwable lastFailure() {
      lock.lock();
      try {
        return checkoutFailure;
      } finally {
        lock.unlock();
      }
    }

    @Override
    public void close() {
      closed = true;
      lock.lock();
      try {
        if (reservations.remove(this)) {
          changed.signalAll();
        }
      } finally {
        lock.unlock();
      }
    }
  }

  /**
   * Adds {@code member}, and returns a handle that removes it. Removing twice is harmless. A member
   * with a shorter interval than every other wakes the thread, which reschedules its next round.
   */
  public Runnable register(Member member) {
    List<Object> key = List.of(member.workerId(), member.taskId());
    lock.lock();
    try {
      members.put(key, member);
      changed.signalAll();
      startThreadLocked();
    } finally {
      lock.unlock();
    }
    return () -> {
      lock.lock();
      try {
        if (member.equals(members.get(key))) {
          members.remove(key);
          changed.signalAll();
        }
      } finally {
        lock.unlock();
      }
    };
  }

  /** Starts the heartbeat thread unless it runs. The caller holds {@link #lock}. */
  private void startThreadLocked() {
    Thread current = thread;
    if (current == null || !current.isAlive()) {
      Thread started = new Thread(this::run, "workhorse-heartbeats");
      started.setDaemon(true);
      thread = started;
      started.start();
    }
  }

  /** Whether a worker or an attempt needs the heartbeat. The caller holds {@link #lock}. */
  private boolean wantedLocked() {
    return !members.isEmpty() || !reservations.isEmpty();
  }

  /**
   * The longest wait between two checkouts: the shortest interval of the reservations and the
   * members. The caller holds {@link #lock}.
   */
  private long retryCapLocked() {
    long cap = Long.MAX_VALUE;
    for (Reservation reservation : reservations) {
      cap = Math.min(cap, reservation.intervalNanos);
    }
    for (Member member : members.values()) {
      cap = Math.min(cap, member.intervalNanos());
    }
    return cap == Long.MAX_VALUE ? DEFAULT_RETRY_CAP_NANOS : Math.max(RETRY_NANOS, cap);
  }

  /**
   * Waits until the heartbeat holds its connection, and starts a checkout when none runs. Returns
   * the connection, or {@code null} at {@code deadline} or when {@code stopped} is true. The caller
   * holds {@link #lock}.
   */
  private @Nullable Held awaitHeldLocked(long deadline, BooleanSupplier stopped) {
    while (held == null) {
      startCheckoutLocked();
      long remaining = deadline - System.nanoTime();
      if (remaining <= 0 || stopped.getAsBoolean()) {
        return null;
      }
      try {
        changed.awaitNanos(Math.min(remaining, AWAIT_SLICE_NANOS));
      } catch (InterruptedException interrupted) {
        Thread.currentThread().interrupt();
        return null;
      }
    }
    return held;
  }

  /**
   * Starts the checkout thread, unless one runs, the heartbeat holds its connection, or nothing
   * needs one. A checkout thread that still gives a connection back checks out the next one when
   * that return ends. The caller holds {@link #lock}.
   */
  private void startCheckoutLocked() {
    if (!holdsConnection || held != null || !wantedLocked()) {
      return;
    }
    if (checkingOut) {
      Runnable hook = onReturnPending;
      if (returning && hook != null) {
        hook.run();
      }
      return;
    }
    checkingOut = true;
    Thread.ofPlatform().daemon().name("workhorse-heartbeat-checkout").start(this::checkOut);
  }

  /**
   * Checks out the held connection on its own thread, so a round or a worker waits for it only
   * until its own deadline. A failed checkout runs again after a backoff that doubles from 100 ms
   * up to {@link #retryCapLocked}.
   *
   * <p>The thread is the one owner of each connection that it gets, from the checkout until the
   * pool has it back. It installs the connection when something needs it, and waits until the
   * heartbeat thread lets it go. It then gives the connection back to the pool, and checks out the
   * next one if something still needs it. A connection that nothing needs when it arrives goes back
   * at once. The thread ends when nothing needs a connection and no return is in progress. So the
   * heartbeat has at most one connection out at a time, however many waits time out, and a new
   * reservation waits for a late return. The installed connection wakes every reservation.
   */
  private void checkOut() {
    long backoff = RETRY_NANOS;
    while (true) {
      Connection connection = null;
      Throwable failure = null;
      try {
        connection = dataSource.getConnection();
      } catch (Throwable error) {
        failure = error;
      }
      Held installed = null;
      if (connection != null) {
        try {
          installed = new Held(connection);
        } catch (SQLException | RuntimeException setup) {
          failure = setup;
        }
      }
      Held extra = null;
      List<Runnable> wake = new ArrayList<>();
      boolean done = false;
      lock.lock();
      try {
        if (installed != null) {
          // Only this thread installs a connection, and it checks out only while none is held.
          if (wantedLocked()) {
            held = installed;
            connected = true;
            checkoutFailure = null;
            for (Reservation reservation : reservations) {
              wake.add(reservation.onConnected);
            }
          } else {
            extra = installed;
            returning = true;
          }
          changed.signalAll();
        } else {
          checkoutFailure = failure;
          changed.signalAll();
          long until = System.nanoTime() + Math.min(backoff, retryCapLocked());
          try {
            while (wantedLocked() && until - System.nanoTime() > 0) {
              changed.awaitNanos(until - System.nanoTime());
            }
            done = !wantedLocked();
          } catch (InterruptedException interrupted) {
            done = true;
          }
          if (done) {
            checkingOut = false;
          }
          backoff = Math.min(backoff * 2, retryCapLocked());
        }
      } finally {
        lock.unlock();
      }
      for (Runnable callback : wake) {
        try {
          callback.run();
        } catch (RuntimeException ignored) {
          // One worker's callback must not keep the others from their wake.
        }
      }
      if (done) {
        return;
      }
      if (installed == null) {
        continue;
      }
      if (extra == null) {
        extra = awaitRelease(installed);
      }
      closeQuietly(extra);
      backoff = RETRY_NANOS;
      lock.lock();
      try {
        returning = false;
        changed.signalAll();
        if (!wantedLocked()) {
          checkingOut = false;
          return;
        }
      } finally {
        lock.unlock();
      }
    }
  }

  /**
   * Waits until the heartbeat thread lets {@code installed} go, and returns it. Only the heartbeat
   * thread sends rounds on the held connection, so it is free once the heartbeat no longer holds
   * it. The checkout thread then owns the return.
   */
  private Held awaitRelease(Held installed) {
    lock.lock();
    try {
      while (held == installed) {
        changed.awaitUninterruptibly();
      }
      returning = true;
      return installed;
    } finally {
      lock.unlock();
    }
  }

  /**
   * Acts on the connection of a failed round. A failed renewal on a connection that stays open
   * keeps the connection, because its rollback ended the round's transaction. Thus a statement
   * error does not close the claim gate of the workers. A closed or aborted connection is
   * discarded: the checkout thread gives it back to the pool, and then starts the replacement
   * checkout at once. A round that got no connection discards nothing, so a connection that a
   * checkout installed after the round's deadline stays.
   */
  private void discard() {
    Held failed = sent;
    sent = null;
    if (failed == null || failed.usable()) {
      return;
    }
    lock.lock();
    try {
      if (held != failed) {
        return;
      }
      held = null;
      connected = false;
      changed.signalAll();
    } finally {
      lock.unlock();
    }
  }

  private static void closeQuietly(@Nullable Held connection) {
    if (connection == null) {
      return;
    }
    try {
      connection.close();
    } catch (SQLException | RuntimeException ignored) {
      // The pool sees a closed connection and replaces it.
    }
  }

  /**
   * Runs rounds while members are registered. Without members, a dedicated heartbeat keeps its
   * connection while a reservation is open, and replaces a discarded one. The thread ends, and lets
   * the connection go, when no member and no reservation is left. The checkout thread then gives
   * the connection back to the pool. A register or a reserve that races the end starts a new
   * thread, whose connection waits for that return.
   *
   * <p>A dedicated round that fails keeps a connection that stays open, and discards a closed or
   * aborted one ({@link #discard}). The replacement checkout then starts at once: rounds waits for
   * the slot itself, and starts one overdue round at once. A round that expires before its
   * heartbeat statement with a clean connection does not throw out of rounds (RoundExpired), so the
   * next round uses the same connection.
   */
  private void run() {
    Round fixed = fixedRound;
    Round round = fixed != null ? fixed : this::sendOnHeld;
    boolean idle = true;
    while (true) {
      boolean exit = false;
      lock.lock();
      try {
        while (members.isEmpty()) {
          idle = true;
          if (reservations.isEmpty()) {
            exit = true;
            exitLocked();
            break;
          }
          // A reservation without members keeps its connection, and recovers a lost one.
          startCheckoutLocked();
          changed.await();
        }
        if (!exit) {
          // A heartbeat without a reservation checks out its connection when its first member
          // arrives, so the checkout runs before the first round's slot.
          startCheckoutLocked();
        }
      } catch (InterruptedException interrupted) {
        exit = true;
        exitLocked();
      } finally {
        lock.unlock();
      }
      if (exit) {
        return;
      }
      if (idle) {
        // The first member after an idle time starts a new schedule, as a new thread did.
        previous = System.nanoTime();
        busyRetry = null;
        idle = false;
      }
      try {
        idle = rounds(round);
      } catch (SQLException | RuntimeException error) {
        // The next round waits for its slot, and runs on a replacement connection.
        if (holdsConnection) {
          discard();
        }
      }
    }
  }

  /**
   * Ends the heartbeat thread, and lets the held connection go. The checkout thread gives it back
   * to the pool, and a new reservation waits until that return ends. The caller holds {@link
   * #lock}.
   */
  private void exitLocked() {
    if (Thread.currentThread().equals(thread)) {
      thread = null;
    }
    held = null;
    connected = false;
    changed.signalAll();
  }

  /**
   * Sends one statement on the held connection. The wait for a checkout counts against the round's
   * bound, so a pool that has no free connection fails the round at its deadline.
   */
  private List<Row> sendOnHeld(
      long timeoutNanos, SqlCatalogue.Statement statement, @Nullable Object... parameters)
      throws SQLException {
    long deadline = System.nanoTime() + timeoutNanos;
    Held connection;
    boolean waited;
    Runnable hook = onAwaitConnection;
    lock.lock();
    try {
      waited = held == null;
      if (waited && hook != null) {
        hook.run();
      }
      connection = awaitHeldLocked(deadline, () -> false);
    } finally {
      lock.unlock();
    }
    sent = connection;
    if (connection == null) {
      throw new RoundDeadline("The heartbeat got no connection before the round's deadline");
    }
    if (waited) {
      Runnable received = onConnectionInRound;
      if (received != null) {
        received.run();
      }
      // The wait for the new connection used part of this round's bound. The round sends nothing,
      // so the connection stays clean, and the next round starts on it at once with a full bound.
      freshConnection = true;
      throw new RoundExpired("The heartbeat got its new connection during the round");
    }
    return connection.round(deadline - System.nanoTime(), statement, parameters);
  }

  /**
   * Runs rounds until no member remains, and returns {@code true} then. A regular round falls due
   * one shortest member interval after the previous regular round started. A round that ends after
   * its next slot starts one overdue round at once, and the interval after it counts from that
   * start, so missed slots are never replayed. A round that fails throws, so the caller can replace
   * the connection.
   *
   * <p>A round has one batch for each worker and each {@link #ROUND_LIMIT} leases ({@link
   * #batches}). On the dedicated connection, the round sends every batch in one transaction with
   * one {@code heartbeat_pool_v1} statement, so the number of round trips does not grow with the
   * number of workers. The deadline of that transaction is the round start plus {@link
   * #roundBoundNanos}.
   *
   * <p>Between two regular slots, a busy retry sends only the members that the latest round
   * reported busy ({@link #takeBusyRetry}). It is a round of this one thread, so it never overlaps
   * another round, and it does not move the regular schedule. Its deadline is {@link
   * #retryDeadline}. A round that throws schedules no retry. A bounded retry with less than {@link
   * #BUSY_RETRY_MIN_NANOS} before its deadline does not run ({@link #busyRetryFits}), and the
   * regular round at the next slot renews its members.
   */
  private boolean rounds(Round round) throws SQLException {
    while (true) {
      List<Member> due;
      boolean retry;
      long interval = Long.MAX_VALUE;
      lock.lock();
      try {
        for (Member member : members.values()) {
          interval = Math.min(interval, member.intervalNanos());
        }
        if (members.isEmpty()) {
          busyRetry = null;
          runNow = false;
          return true;
        }
        long now = System.nanoTime();
        long slot = previous + interval;
        List<Member> selection = null;
        if (!runNow && busyRetry != null && slot - now > 0) {
          if (busyRetryAt - now > 0) {
            changed.awaitNanos(Math.min(busyRetryAt - now, slot - now));
            continue;
          }
          selection = takeBusyRetry(now);
        }
        // At or after the regular slot the retry is dropped, and the regular round takes every
        // member. A retry that has nothing left to send waits for the regular slot.
        busyRetry = null;
        if (selection != null && !selection.isEmpty()) {
          due = selection;
          retry = true;
        } else {
          // A round that must run now does not wait for a slot. The member with the shortest
          // interval can have left while the previous round waited, so no slot of the current
          // members would bring this round forward.
          if (!runNow && slot - now > 0) {
            changed.awaitNanos(slot - now);
            continue;
          }
          runNow = false;
          due = new ArrayList<>(members.values());
          retry = false;
        }
      } catch (InterruptedException interrupted) {
        Thread.currentThread().interrupt();
        return true;
      } finally {
        lock.unlock();
      }
      long start = System.nanoTime();
      long deadline;
      List<Batch> batches;
      if (retry) {
        deadline = retryDeadline(start, interval, previous + interval, due);
        // A retry that cannot finish in time sends nothing. It does not touch the connection, and
        // the loop waits for the regular slot, as after an empty selection.
        if (!busyRetryFits(start, deadline)) {
          continue;
        }
        batches = batches(due);
      } else {
        previous = start;
        // The deadline starts before the payloads are built, so serialization counts against it.
        deadline = start + roundBoundNanos(interval);
        batches = batches(due);
      }
      roundsStarted.incrementAndGet();
      List<Member> busy = sendBatches(batches, deadline, round);
      if (freshConnection) {
        // The round waited for a new connection and sent nothing on it. A regular round runs at
        // once on the replacement, with a full bound. It replays no missed slot, and it starts the
        // schedule from then.
        freshConnection = false;
        runNow = true;
        continue;
      }
      if (!busy.isEmpty() && !(retry && roundExpired)) {
        busyRetry = busy;
        busyRetryAt = System.nanoTime() + busyRetryDelayNanos(interval);
      }
    }
  }

  /**
   * The busy members that a retry can still renew at {@code now}: each is registered as the same
   * member, so a completed, replaced, or removed member is gone, and its local lease window has not
   * ended. The caller holds {@link #lock}.
   */
  private List<Member> takeBusyRetry(long now) {
    List<Member> selection = new ArrayList<>();
    List<Member> pending = busyRetry;
    if (pending == null) {
      return selection;
    }
    for (Member member : pending) {
      if (member.equals(members.get(List.of(member.workerId(), member.taskId())))
          && member.leaseEndsAt() - now > 0) {
        selection.add(member);
      }
    }
    return selection;
  }

  /**
   * The delay before a busy retry for the shortest member interval {@code intervalNanos}: {@code
   * base × (1 + random)}, with {@code base = min(100 ms, interval / 8)}. The jitter keeps two
   * workers from meeting the same lock holder in step.
   */
  static long busyRetryDelayNanos(long intervalNanos) {
    long base = Math.min(TimeUnit.MILLISECONDS.toNanos(BUSY_RETRY_BASE_MS), intervalNanos / 8);
    return base + (long) (base * ThreadLocalRandom.current().nextDouble());
  }

  /**
   * The deadline of a busy retry that starts at {@code start}: the round bound, the next regular
   * slot {@code slot}, and the earliest local lease window end of {@code selection}, whichever
   * comes first. So a retry never renews a lease that the worker has already given up.
   */
  static long retryDeadline(long start, long intervalNanos, long slot, List<Member> selection) {
    long deadline = start + roundBoundNanos(intervalNanos);
    if (slot - deadline < 0) {
      deadline = slot;
    }
    for (Member member : selection) {
      long endsAt = member.leaseEndsAt();
      if (endsAt - deadline < 0) {
        deadline = endsAt;
      }
    }
    return deadline;
  }

  /**
   * Whether a bounded busy retry that starts at {@code start} has time before {@code deadline}: at
   * least {@link #BUSY_RETRY_MIN_NANOS}.
   */
  static boolean busyRetryFits(long start, long deadline) {
    return deadline - start >= BUSY_RETRY_MIN_NANOS;
  }

  /**
   * The leases of one worker, at most {@link #ROUND_LIMIT}: one {@code heartbeat_many_v2} call,
   * either as its own statement or as one item of a {@code heartbeat_pool_v1} statement.
   */
  record Batch(String workerId, List<Member> members) {}

  /** The batches of one round, in member order: one for each worker and each 100 leases. */
  static List<Batch> batches(List<Member> due) {
    Map<String, List<Member>> byWorker = new LinkedHashMap<>();
    for (Member member : due) {
      byWorker.computeIfAbsent(member.workerId(), ignored -> new ArrayList<>()).add(member);
    }
    List<Batch> batches = new ArrayList<>();
    for (Map.Entry<String, List<Member>> entry : byWorker.entrySet()) {
      List<Member> group = entry.getValue();
      for (int start = 0; start < group.size(); start += ROUND_LIMIT) {
        batches.add(
            new Batch(
                entry.getKey(), group.subList(start, Math.min(group.size(), start + ROUND_LIMIT))));
      }
    }
    return batches;
  }

  /**
   * Sends {@code batches}, and returns the registered members that came back {@code busy}.
   *
   * <p>On the dedicated connection, one {@code heartbeat_pool_v1} statement carries every batch, so
   * the round is all or nothing. A round whose {@code deadline} has passed sends nothing. A round
   * that expires before its heartbeat statement ({@link RoundExpired}) returns without a throw, and
   * the caller keeps the connection. A busy retry that ends this way schedules no other retry
   * ({@link #roundExpired}). A round that fails at or after its heartbeat statement throws, and no
   * lease of it counts.
   *
   * <p>A round that fails before PostgreSQL returns its statuses counts once in {@code
   * workhorse.worker.heartbeat.round_failure} ({@link #roundFailed}).
   */
  List<Member> sendBatches(List<Batch> batches, long deadline, Round round) throws SQLException {
    roundExpired = false;
    List<Member> busy = new ArrayList<>();
    if (batches.isEmpty()) {
      return busy;
    }
    if (deadline - System.nanoTime() <= 0) {
      // The round reached its deadline before it sent anything, so its members get no status.
      roundFailed(
          batches,
          new RoundExpired("Heartbeat round reached its deadline before it sent its leases"),
          true);
      return busy;
    }
    long sentAt = System.nanoTime();
    List<Row> rows;
    try {
      String payload = pool(batches);
      rows = round.send(deadline - System.nanoTime(), SqlCatalogue.HEARTBEAT_POOL_V1, payload);
    } catch (RoundExpired expired) {
      roundExpired = true;
      // A round that got a new connection sends nothing and runs again at once on it. It did not
      // fail. Any other expired round reached its deadline before PostgreSQL gave a status.
      if (!freshConnection) {
        roundFailed(batches, expired, true);
      }
      return busy;
    } catch (SQLException | RuntimeException error) {
      // The network timeout of the connection ends the read at the round deadline. A socket
      // timeout before that comes from a driver or pool setting, and is a connection failure.
      boolean deadlineReached = System.nanoTime() - deadline + NETWORK_TIMEOUT_SLACK_NANOS >= 0;
      roundFailed(batches, error, deadlineReached);
      throw error;
    }
    // The statement numbers the batches from 1, in the order of the payload.
    List<Map<String, String>> statuses = new ArrayList<>();
    for (int index = 0; index < batches.size(); index++) {
      statuses.add(new HashMap<>());
    }
    for (Row row : rows) {
      int batch = row.requiredInteger("batch");
      if (batch >= 1 && batch <= batches.size()) {
        statuses.get(batch - 1).put(row.requiredText("task_id"), row.requiredText("status"));
      }
    }
    for (int index = 0; index < batches.size(); index++) {
      settle(batches.get(index).members(), statuses.get(index), sentAt, busy);
    }
    return busy;
  }

  /**
   * Counts one round that failed with {@code error} before PostgreSQL returned a status, once on
   * each distinct telemetry of the members of {@code batches}. A dedicated round carries the leases
   * of every worker on the data source, so workers that share one telemetry count the round once.
   * The round gives no ownership verdict, so {@code workhorse.worker.heartbeat.failure} does not
   * count it. Nothing else changes: the members keep running, and the next round retries. {@code
   * deadlineReached} is true when the round deadline of a dedicated round has passed ({@link
   * #roundFailureReason}).
   */
  private static void roundFailed(List<Batch> batches, Throwable error, boolean deadlineReached) {
    String reason = roundFailureReason(error, deadlineReached);
    Set<Telemetry> targets = Collections.newSetFromMap(new IdentityHashMap<>());
    for (Batch batch : batches) {
      for (Member member : batch.members()) {
        targets.add(member.telemetry());
      }
    }
    for (Telemetry target : targets) {
      WorkerTelemetry.heartbeatRoundFailed(target, reason);
    }
  }

  /**
   * The {@code workhorse.heartbeat.failure_reason} of a round that failed with {@code error}, with
   * the rule of the TypeScript {@code heartbeatRoundFailureReason}. The rule reads {@code error},
   * its causes, its suppressed exceptions, and its {@link SQLException#getNextException} chain,
   * outermost first, each exception once and at most {@value #FAILURE_CHAIN_LIMIT}. The SQLSTATE is
   * the first non-null {@link SQLException#getSQLState} in that order. The first rule that matches
   * gives the value, so a timeout is checked before a connection failure:
   *
   * <ol>
   *   <li>{@code timeout}: the round deadline. The heartbeat throws {@link RoundExpired} and {@link
   *       RoundDeadline} only for its own deadline, so they are {@code timeout} in every case. A
   *       {@link SQLTimeoutException}, {@link SocketTimeoutException}, or {@link TimeoutException}
   *       from a driver or a pool is {@code timeout} only when {@code deadlineReached} is true. A
   *       dedicated round sets the network timeout of its connection to the time left of its bound,
   *       so a socket timeout at its deadline is the round deadline. PgJDBC reports that timeout as
   *       {@code 08006} with a {@link SocketTimeoutException} cause. No round waits on a {@code
   *       Future}, so no {@link TimeoutException} of the heartbeat's own comes from a round.
   *       SQLSTATE {@code 57014} ({@code statement_timeout}) and {@code 25P03} ({@code
   *       idle_in_transaction_session_timeout}) are also {@code timeout}.
   *   <li>{@code connection}: a SQLSTATE that starts with {@code 08}; a server shutdown, {@code
   *       57P01}, {@code 57P02}, or {@code 57P03}; or any {@link IOException} in the chain, which
   *       includes {@link SocketException}, {@code ConnectException}, {@link UnknownHostException},
   *       {@code EOFException}, and a {@link SocketTimeoutException} before the round deadline. An
   *       {@link IOException} is a real socket or I/O failure, so it wins over a SQLSTATE that
   *       names no connection failure, as in the TypeScript rule.
   *   <li>{@code database}: any other SQLSTATE. A SQLSTATE in the chain decides before the type of
   *       a wrapper, so a pool exception around a refused login ({@code 28P01}) is {@code
   *       database}.
   *   <li>{@code connection}, when the chain has no SQLSTATE: a {@link
   *       SQLNonTransientConnectionException} or {@link SQLTransientConnectionException}, which a
   *       pool or a driver uses for a connection that it could not open or that closed; or a driver
   *       or pool timeout before the round deadline. A login timeout of {@code
   *       DataSource.getConnection}, a pool checkout timeout, a driver {@code socketTimeout}, and a
   *       driver {@code connectTimeout} before the round deadline are thus connection failures.
   *   <li>{@code other}: everything else.
   * </ol>
   */
  static String roundFailureReason(Throwable error, boolean deadlineReached) {
    List<Throwable> chain = failureChain(error);
    @Nullable String state = null;
    for (Throwable entry : chain) {
      if (entry instanceof SQLException sql && sql.getSQLState() != null) {
        state = sql.getSQLState();
        break;
      }
    }
    for (Throwable entry : chain) {
      if (entry instanceof RoundExpired
          || entry instanceof RoundDeadline
          || (deadlineReached
              && (entry instanceof SQLTimeoutException
                  || entry instanceof SocketTimeoutException
                  || entry instanceof TimeoutException))) {
        return "timeout";
      }
    }
    if ("57014".equals(state) || "25P03".equals(state)) {
      return "timeout";
    }
    if (state != null
        && (state.startsWith("08")
            || state.equals("57P01")
            || state.equals("57P02")
            || state.equals("57P03"))) {
      return "connection";
    }
    for (Throwable entry : chain) {
      // A real I/O failure wins over any other SQLSTATE. A SocketTimeoutException is an
      // IOException; here it came before the round deadline.
      if (entry instanceof IOException) {
        return "connection";
      }
    }
    if (state != null) {
      // A server SQLSTATE decides before a wrapper type, such as a pool exception around a
      // refused login.
      return "database";
    }
    for (Throwable entry : chain) {
      // Here every driver or pool timeout came before the round deadline.
      if (entry instanceof SQLTimeoutException
          || entry instanceof TimeoutException
          || entry instanceof SQLNonTransientConnectionException
          || entry instanceof SQLTransientConnectionException) {
        return "connection";
      }
    }
    return "other";
  }

  /** {@code error} and the exceptions it links to, outermost first, each one once. */
  private static List<Throwable> failureChain(Throwable error) {
    Set<Throwable> seen = Collections.newSetFromMap(new IdentityHashMap<>());
    ArrayDeque<Throwable> pending = new ArrayDeque<>();
    pending.add(error);
    List<Throwable> chain = new ArrayList<>();
    while (!pending.isEmpty() && chain.size() < FAILURE_CHAIN_LIMIT) {
      Throwable entry = pending.removeFirst();
      if (!seen.add(entry)) {
        continue;
      }
      chain.add(entry);
      Throwable cause = entry.getCause();
      if (cause != null) {
        pending.add(cause);
      }
      Collections.addAll(pending, entry.getSuppressed());
      if (entry instanceof SQLException sql && sql.getNextException() != null) {
        pending.add(sql.getNextException());
      }
    }
    return chain;
  }

  /**
   * The parameter of one {@code heartbeat_pool_v1} statement: a JSON array with one item for each
   * batch, in batch order. Each item holds the worker and its leases.
   */
  static String pool(List<Batch> batches) {
    List<Object> items = new ArrayList<>();
    for (Batch batch : batches) {
      Map<String, @Nullable Object> item = new LinkedHashMap<>();
      item.put("workerId", batch.workerId());
      item.put("leases", leases(batch.members()));
      items.add(item);
    }
    return Json.write(items);
  }

  /**
   * The deadline of one round for the shortest member interval {@code intervalNanos}. It is three
   * quarters of the interval, so that one timed-out round leaves a renewal margin when {@code 2 ×
   * interval + bound < lease}. Below an interval of 200 ms the bound is at least {@code min(50 ms,
   * interval)}. Up to 50 ms the bound thus equals the interval, as before SM-1444, and a timed-out
   * round leaves about no margin. It is at least 1 ms, in whole milliseconds rounded down. Every
   * SDK uses the same formula.
   */
  static long roundBoundNanos(long intervalNanos) {
    long intervalMs = TimeUnit.NANOSECONDS.toMillis(intervalNanos);
    long boundMs =
        Math.max(1, Math.max(intervalMs * 3 / 4, Math.min(MIN_ROUND_TIMEOUT_MS, intervalMs)));
    return TimeUnit.MILLISECONDS.toNanos(boundMs);
  }

  /**
   * The server budget of a dedicated round that has {@code remainingMs} left at its settings
   * statement: one quarter, at least 1 ms, in whole milliseconds rounded down. The round sets it as
   * {@code statement_timeout} and as {@code idle_in_transaction_session_timeout}. So the heartbeat
   * statement and both idle gaps end within three quarters of the time left, and the last quarter
   * is kept for the settings statement and {@code COMMIT}. Every SDK uses the same shares.
   */
  static long serverBudgetMs(long remainingMs) {
    return Math.max(1, remainingMs / 4);
  }

  /** The lease objects of one batch, in member order. */
  private static List<Object> leases(List<Member> chunk) {
    List<Object> leases = new ArrayList<>();
    for (Member member : chunk) {
      Map<String, @Nullable Object> lease = new LinkedHashMap<>();
      lease.put("taskId", member.taskId().toString());
      lease.put("fenceToken", Long.toString(member.fenceToken()));
      lease.put("leaseMs", member.leaseMs());
      leases.add(lease);
    }
    return leases;
  }

  /**
   * Hands each status to its member. A result counts only for the member that the round sent, so a
   * member that left or was replaced while the round ran gets nothing from it. Only {@code
   * accepted} renews; a {@code busy} member is added to {@code busy}.
   */
  private void settle(
      List<Member> chunk, Map<String, String> statuses, long sentAt, List<Member> busy) {
    for (Member member : chunk) {
      if (!registered(member)) {
        continue;
      }
      String status = statuses.getOrDefault(member.taskId().toString(), "stale");
      if (status.equals("busy")) {
        busy.add(member);
      }
      try {
        if (status.equals("accepted")) {
          member.renew(sentAt);
        } else {
          member.settle(status);
        }
      } catch (Exception error) {
        member.fail(error);
      }
    }
  }

  private boolean registered(Member member) {
    lock.lock();
    try {
      return member.equals(members.get(List.of(member.workerId(), member.taskId())));
    } finally {
      lock.unlock();
    }
  }

  /**
   * A round that reached its deadline before its heartbeat statement, and left the connection
   * clean: it sent nothing, or its {@code ROLLBACK} finished before the deadline. It is not a
   * {@link SQLTimeoutException}, so it cannot be confused with a deadline that passed while a
   * statement was in flight.
   */
  static final class RoundExpired extends SQLException {
    private static final long serialVersionUID = 1L;

    RoundExpired(String message) {
      super(message);
    }
  }

  /**
   * A round that its own deadline ended with a statement in flight or without a connection, or
   * whose {@code ROLLBACK} after {@link RoundExpired} did not end cleanly in its bound. Only the
   * heartbeat throws it, so {@link #roundFailureReason} names it {@code timeout} in every case. A
   * {@link SQLTimeoutException} from a driver or a pool is the round deadline only when the
   * deadline has passed.
   */
  static final class RoundDeadline extends SQLTimeoutException {
    private static final long serialVersionUID = 1L;

    RoundDeadline(@Nullable String message) {
      super(message);
    }

    RoundDeadline(@Nullable String message, Throwable cause) {
      super(message, cause);
    }
  }

  interface Round {
    /** Sends one statement within {@code timeoutNanos}, the time left of the round's bound. */
    List<Row> send(
        long timeoutNanos, SqlCatalogue.Statement statement, @Nullable Object... parameters)
        throws SQLException;
  }

  /**
   * The dedicated connection. It runs in autocommit between rounds, and it restores its autocommit
   * mode and network timeout before it goes back to the pool.
   *
   * <p>One deadline bounds each round: every read gets a network timeout of the time that remains,
   * so a stalled round fails, and PgJDBC closes the connection. Closing a connection does not stop
   * its statement, because PostgreSQL notices a closed client only when it next writes to it. So
   * the round also sets server timeouts that end the heartbeat, and a transaction whose client
   * stopped before {@code COMMIT}, by the deadline. A {@code COMMIT} that PostgreSQL has already
   * started can still finish later. Both settings end with the transaction, so the connection keeps
   * no session state.
   */
  private static final class Held implements AutoCloseable {
    private final Connection connection;
    private final boolean restoreAutoCommit;
    private final int previousTimeout;
    private boolean bounded;

    /**
     * True once the connection is aborted or reports a connection failure (SQLSTATE class 08). A
     * pool proxy can still report an aborted connection as open, so {@link #usable} reads this too.
     */
    private boolean broken;

    Held(Connection connection) throws SQLException {
      this.connection = connection;
      try {
        restoreAutoCommit = !connection.getAutoCommit();
        if (restoreAutoCommit) {
          connection.setAutoCommit(true);
        }
        previousTimeout = connection.getNetworkTimeout();
      } catch (SQLException | RuntimeException error) {
        connection.close();
        throw error;
      }
    }

    /**
     * Sends {@code statement} in its own transaction within {@code timeoutNanos}. A round that
     * fails rolls back; a connection that cannot roll back is aborted, because its state is not
     * known.
     *
     * <p>A round that expires before {@code statement} goes out throws {@link RoundExpired} when
     * the connection stays clean: the round sent nothing, or its {@code ROLLBACK} finished before
     * the deadline. PgJDBC sends {@code BEGIN} with the first statement after {@code
     * setAutoCommit(false)}, so nothing goes out before the settings statement.
     */
    List<Row> round(
        long timeoutNanos, SqlCatalogue.Statement statement, @Nullable Object... parameters)
        throws SQLException {
      long deadline = System.nanoTime() + timeoutNanos;
      if (timeoutNanos < MIN_REMAINING_NANOS) {
        throw new RoundExpired("Heartbeat round reached its deadline before BEGIN");
      }
      boundUntil(deadline);
      connection.setAutoCommit(false);
      // Becomes true just before BEGIN goes out with the settings statement.
      boolean begun = false;
      try {
        long setAt = System.nanoTime();
        long remaining = deadline - setAt;
        if (remaining < MIN_REMAINING_NANOS) {
          throw new RoundExpired("Heartbeat round reached its deadline before BEGIN");
        }
        // PostgreSQL measures statement_timeout for each statement and the idle timeout for each
        // idle gap, and restarts both every time. While the round can hold a row lock, it has one
        // idle gap before the heartbeat, the heartbeat, and one idle gap before COMMIT. So the
        // heartbeat and each gap get one quarter, and the last quarter is kept for COMMIT.
        String budget = Long.toString(serverBudgetMs(TimeUnit.NANOSECONDS.toMillis(remaining)));
        try (PreparedStatement timeouts = connection.prepareStatement(ROUND_TIMEOUTS)) {
          timeouts.setString(1, budget);
          timeouts.setString(2, budget);
          begun = true;
          timeouts.execute();
        }
        // The budgets fit only if the settings statement used at most the quarter kept for COMMIT.
        if (System.nanoTime() - setAt > remaining / 4) {
          throw new RoundExpired("Heartbeat round settings took too long");
        }
        if (deadline - System.nanoTime() <= 0) {
          throw new RoundExpired("Heartbeat round reached its deadline");
        }
        boundUntil(deadline);
        List<Row> rows = Sql.rows(connection, statement, parameters);
        boundUntil(deadline);
        connection.commit();
        // A COMMIT that ends after the deadline does not count as a renewal.
        if (System.nanoTime() - deadline >= 0) {
          throw new RoundDeadline("Heartbeat round reached its deadline");
        }
        return rows;
      } catch (RoundExpired expired) {
        if (begun) {
          try {
            // The rollback keeps the round's deadline, so no command goes out after it.
            boundUntil(deadline);
            connection.rollback();
          } catch (SQLException rollback) {
            // The heartbeat statement did not go out, but the transaction state is not known.
            abort();
            SQLTimeoutException failed = new RoundDeadline(expired.getMessage(), rollback);
            failed.addSuppressed(expired);
            throw failed;
          }
          // A rollback that ends after the deadline did not end in the round's bound, so the
          // connection is discarded, as in every SDK.
          if (System.nanoTime() - deadline >= 0) {
            abort();
            SQLTimeoutException late = new RoundDeadline(expired.getMessage());
            late.addSuppressed(expired);
            throw late;
          }
        }
        throw expired;
      } catch (SQLException | RuntimeException error) {
        if (error instanceof SQLException sql) {
          String state = sql.getSQLState();
          if (state != null && state.startsWith("08")) {
            broken = true;
          }
        }
        try {
          if (!connection.isClosed()) {
            boundUntil(deadline);
            connection.rollback();
          }
        } catch (SQLException rollback) {
          // The rollback keeps the round's deadline. A connection that cannot finish it in time
          // has a state the round cannot know.
          abort();
        }
        throw error;
      } finally {
        if (!connection.isClosed()) {
          connection.setAutoCommit(true);
        }
      }
    }

    /**
     * Whether the connection is still open. A round that failed closes or aborts a connection whose
     * state it cannot know, so an open connection after a failed round is clean.
     */
    boolean usable() {
      if (broken) {
        return false;
      }
      try {
        return !connection.isClosed();
      } catch (SQLException | RuntimeException error) {
        return false;
      }
    }

    /** Aborts the connection, whose state the round cannot know, and marks it broken. */
    private void abort() throws SQLException {
      broken = true;
      connection.abort(Runnable::run);
    }

    /** Bounds the next read by the time left before {@code deadline}, a nanoTime value. */
    private void boundUntil(long deadline) throws SQLException {
      long remaining = deadline - System.nanoTime();
      if (remaining <= 0) {
        throw new RoundDeadline("Heartbeat round reached its deadline");
      }
      int timeout =
          (int) Math.min(Integer.MAX_VALUE, Math.max(1, TimeUnit.NANOSECONDS.toMillis(remaining)));
      connection.setNetworkTimeout(Runnable::run, timeout);
      bounded = true;
    }

    @Override
    public void close() throws SQLException {
      try {
        if (!connection.isClosed()) {
          if (bounded) {
            connection.setNetworkTimeout(Runnable::run, previousTimeout);
          }
          if (restoreAutoCommit) {
            connection.setAutoCommit(false);
          }
        }
      } finally {
        connection.close();
      }
    }
  }
}
