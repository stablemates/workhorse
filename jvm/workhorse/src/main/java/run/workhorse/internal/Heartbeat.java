package run.workhorse.internal;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.sql.SQLTimeoutException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.BooleanSupplier;
import javax.sql.DataSource;
import org.jspecify.annotations.Nullable;
import run.workhorse.ConnectionSource;

/**
 * Renews the leases of running attempts on a dedicated platform thread. Internal to the SDK; the
 * counterpart of Ruby's {@code Worker::Heartbeat} (ADR 0071).
 *
 * <p>Every worker on one {@link DataSource} object shares one dedicated heartbeat. The key is the
 * object itself, by reference identity, never by {@code equals}. That heartbeat holds one
 * connection while a worker holds a {@link Reservation} or an attempt is registered, so handlers
 * that hold every other connection never delay a lease round. A worker with shared heartbeats has
 * its own heartbeat, which borrows a connection for each round instead.
 *
 * <p>A dedicated heartbeat checks out its connection, and each replacement, on one checkout thread
 * at a time. A round waits for that checkout only inside its own bound, so the timeout of the pool
 * never delays a renewal past the bound. A round without a connection fails, the checkout goes on
 * with a capped backoff, and the lease watchdog bounds the loss.
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
  }

  private final DataSource dataSource;
  private final boolean dedicated;
  private final ReentrantLock lock = new ReentrantLock();
  private final Condition changed = lock.newCondition();
  private final Map<List<Object>, Member> members = new LinkedHashMap<>();
  private @Nullable Thread thread;

  /** A round that replaces every connection, for tests of the schedule. */
  private final @Nullable Round fixedRound;

  /** Whether the heartbeat holds a connection across rounds: dedicated, with no fixed round. */
  private final boolean holdsConnection;

  /** The open reservations of workers. They change under {@link #lock}. */
  private final List<Reservation> reservations = new ArrayList<>();

  /**
   * The held connection, or {@code null}. A checkout installs it, and only the heartbeat thread
   * sends rounds on it or discards it. It changes under {@link #lock}.
   */
  private @Nullable Held held;

  /** Mirrors {@code held != null}, so a worker reads it without the lock. */
  private volatile boolean connected;

  /** Whether a checkout of the held connection runs. It changes under {@link #lock}. */
  private boolean checkingOut;

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

  /** The batch that the next dedicated round sends first. Only the heartbeat thread uses it. */
  private int rotation;

  /**
   * The members that the latest round reported busy, which a retry renews before the next regular
   * slot, or {@code null}. A round of either kind replaces it. Only the heartbeat thread uses it.
   */
  private @Nullable List<Member> busyRetry;

  /** When the busy retry falls due, a {@link System#nanoTime} value. */
  private long busyRetryAt;

  /**
   * True when the latest {@link #sendBatches} call stopped at a batch that expired before its
   * heartbeat statement ({@link RoundExpired}). A busy retry that stops this way fails, so it
   * schedules no other retry. Only the heartbeat thread uses it.
   */
  private boolean roundExpired;

  Heartbeat(DataSource dataSource, boolean dedicated) {
    this(dataSource, dedicated, null);
  }

  /**
   * A heartbeat whose rounds go through {@code fixedRound} instead of a connection, when it is not
   * {@code null}. A failed round then acts as a failed dedicated round.
   */
  Heartbeat(DataSource dataSource, boolean dedicated, @Nullable Round fixedRound) {
    this.dataSource = dataSource;
    this.dedicated = dedicated;
    this.fixedRound = fixedRound;
    this.holdsConnection = dedicated && fixedRound == null;
  }

  /** The heartbeat that every worker on the {@code dataSource} object shares. */
  public static Heartbeat dedicated(DataSource dataSource) {
    return DEDICATED.get(dataSource, source -> new Heartbeat(source, true));
  }

  /** A heartbeat of one worker that borrows a connection for each round. */
  public static Heartbeat borrowing(DataSource dataSource) {
    return new Heartbeat(dataSource, false);
  }

  /**
   * Reserves the held connection for a worker, and returns the reservation. While a reservation is
   * open, a dedicated heartbeat keeps its connection, and replaces a lost one at once, also when no
   * attempt is registered. {@code intervalNanos} is the worker's heartbeat interval, which caps the
   * wait between two failed checkouts. {@code onConnected} runs on the checkout thread each time a
   * new connection is installed. A reservation of a borrowing heartbeat is always connected.
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

    private Reservation(long intervalNanos, Runnable onConnected) {
      this.intervalNanos = intervalNanos;
      this.onConnected = onConnected;
    }

    /**
     * Whether the heartbeat holds a usable connection now. A failed renewal on a connection that
     * stays open, and a round that a row lock holds, keep it connected. Only a lost connection
     * clears it, until the replacement arrives.
     */
    public boolean connected() {
      return !holdsConnection || connected;
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
   * needs one. The caller holds {@link #lock}.
   */
  private void startCheckoutLocked() {
    if (!holdsConnection || held != null || checkingOut || !wantedLocked()) {
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
   * <p>The thread is the one owner of each connection that it gets. It installs the connection, or
   * gives it back to the pool when nothing needs it or the heartbeat already holds one. The thread
   * ends when it installs a connection or when nothing needs one. So the heartbeat runs at most one
   * checkout at a time, however many waits time out. The installed connection wakes every
   * reservation.
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
      boolean done;
      lock.lock();
      try {
        if (installed != null) {
          done = true;
          checkingOut = false;
          if (held == null && wantedLocked()) {
            held = installed;
            connected = true;
            checkoutFailure = null;
            for (Reservation reservation : reservations) {
              wake.add(reservation.onConnected);
            }
          } else {
            extra = installed;
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
      closeQuietly(extra);
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
    }
  }

  /**
   * Acts on the connection of a failed round. A failed renewal on a connection that stays open
   * keeps the connection, because its rollback ended the round's transaction. Thus a statement
   * error does not close the claim gate of the workers. A closed or aborted connection is
   * discarded, and its replacement checkout starts at once. A round that got no connection discards
   * nothing, so a connection that a checkout installed after the round's deadline stays.
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
      startCheckoutLocked();
    } finally {
      lock.unlock();
    }
    closeQuietly(failed);
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
   * connection while a reservation is open, and replaces a discarded one. The thread ends, and the
   * connection goes back to the pool, when no member and no reservation is left. A register or a
   * reserve that races the end starts a new thread.
   *
   * <p>A dedicated round that fails keeps a connection that stays open, and discards a closed or
   * aborted one ({@link #discard}). The replacement checkout then starts at once: rounds waits for
   * the slot itself, and starts one overdue round at once. A round that expires before its
   * heartbeat statement with a clean connection does not throw out of rounds (RoundExpired), so the
   * next round uses the same connection. A borrowing round that fails is skipped.
   */
  private void run() {
    Round round;
    Round fixed = fixedRound;
    if (fixed != null) {
      round = fixed;
    } else if (dedicated) {
      round = this::sendOnHeld;
    } else {
      ConnectionSource source = ConnectionSource.of(dataSource);
      round =
          (timeoutNanos, statement, parameters) -> {
            Connection connection = source.acquire();
            try {
              return Sql.rows(connection, statement, parameters);
            } finally {
              source.release(connection, false);
            }
          };
    }
    boolean idle = true;
    while (true) {
      boolean exit = false;
      Held release = null;
      lock.lock();
      try {
        while (members.isEmpty()) {
          idle = true;
          if (reservations.isEmpty()) {
            exit = true;
            release = exitLocked();
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
        release = exitLocked();
      } finally {
        lock.unlock();
      }
      if (exit) {
        closeQuietly(release);
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
   * Ends the heartbeat thread, and returns the held connection, which the caller gives back to the
   * pool after it releases {@link #lock}. The caller holds {@link #lock}.
   */
  private @Nullable Held exitLocked() {
    if (Thread.currentThread().equals(thread)) {
      thread = null;
    }
    Held previous = held;
    held = null;
    connected = false;
    return previous;
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
      throw new SQLTimeoutException("The heartbeat got no connection before the round's deadline");
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
   * start, so missed slots are never replayed. A dedicated round that fails throws, so the caller
   * can replace the connection; a borrowing round that fails is skipped.
   *
   * <p>A round sends one statement for each worker and each {@link #ROUND_LIMIT} leases ({@link
   * #batches}). On the dedicated connection, all of them share one deadline: the round start plus
   * {@link #roundBoundNanos}. A statement that would start after it waits for the next round, so a
   * slow statement cannot delay another renewal past it. Each round starts with the next batch, so
   * a batch that is always slow cannot keep a later batch from its turn. A borrowing round has no
   * deadline, and sends every batch.
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
      int first;
      List<Batch> batches;
      if (retry) {
        deadline = retryDeadline(start, interval, previous + interval, due);
        // A retry that cannot finish in time sends nothing. It does not touch the connection, and
        // the loop waits for the regular slot, as after an empty selection.
        if (dedicated && !busyRetryFits(start, deadline)) {
          continue;
        }
        batches = batches(due);
        // A retry starts with its first batch, so it does not move the rotation of regular rounds.
        first = 0;
      } else {
        previous = start;
        // The deadline starts before the payloads are built, so serialization counts against it.
        deadline = start + roundBoundNanos(interval);
        batches = batches(due);
        first = nextFirstBatch(batches.size());
      }
      roundsStarted.incrementAndGet();
      List<Member> busy = sendBatches(batches, first, deadline, round);
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
   * One {@code heartbeat_many_v2} statement: the leases of one worker, at most {@link
   * #ROUND_LIMIT}.
   */
  record Batch(String workerId, List<Member> members) {}

  /** The statements of one round, in member order: one for each worker and each 100 leases. */
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
   * The batch that a dedicated round sends first. It moves by one each round, so no batch is always
   * last. A borrowing round always starts with the first batch, because it sends every batch.
   */
  int nextFirstBatch(int count) {
    if (!dedicated || count == 0) {
      return 0;
    }
    int first = Math.floorMod(rotation, count);
    rotation = first + 1;
    return first;
  }

  /**
   * Sends {@code batches} in order from {@code first}, and returns the registered members that came
   * back {@code busy}. On the dedicated connection a batch that would start after {@code deadline}
   * is not sent, and a failed batch throws. A batch that expires before its heartbeat statement
   * ({@link RoundExpired}) ends the round without a throw: the results of the earlier batches
   * count, and the caller keeps the connection. A busy retry that ends this way schedules no other
   * retry ({@link #roundExpired}). A borrowing round sends every batch and skips a failed one.
   */
  List<Member> sendBatches(List<Batch> batches, int first, long deadline, Round round)
      throws SQLException {
    roundExpired = false;
    List<Member> busy = new ArrayList<>();
    for (int index = 0; index < batches.size(); index++) {
      Batch batch = batches.get((first + index) % batches.size());
      long sentAt = System.nanoTime();
      if (dedicated && deadline - sentAt <= 0) {
        return busy;
      }
      List<Row> rows;
      try {
        String payload = leases(batch.members());
        long remaining = deadline - System.nanoTime();
        rows = round.send(remaining, SqlCatalogue.HEARTBEAT_MANY_V2, batch.workerId(), payload);
      } catch (RoundExpired expired) {
        if (dedicated) {
          roundExpired = true;
          return busy;
        }
        continue;
      } catch (SQLException | RuntimeException error) {
        if (dedicated) {
          throw error;
        }
        continue;
      }
      Map<String, String> statuses = new HashMap<>();
      for (Row row : rows) {
        statuses.put(row.requiredText("task_id"), row.requiredText("status"));
      }
      settle(batch.members(), statuses, sentAt, busy);
    }
    return busy;
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

  private static String leases(List<Member> chunk) {
    List<Object> leases = new ArrayList<>();
    for (Member member : chunk) {
      Map<String, @Nullable Object> lease = new LinkedHashMap<>();
      lease.put("taskId", member.taskId().toString());
      lease.put("fenceToken", Long.toString(member.fenceToken()));
      lease.put("leaseMs", member.leaseMs());
      leases.add(lease);
    }
    return Json.write(leases);
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
        // heartbeat gets one half, each gap one eighth, and the last quarter is kept for COMMIT.
        long milliseconds = TimeUnit.NANOSECONDS.toMillis(remaining);
        try (PreparedStatement timeouts = connection.prepareStatement(ROUND_TIMEOUTS)) {
          timeouts.setString(1, Long.toString(Math.max(1, milliseconds / 2)));
          timeouts.setString(2, Long.toString(Math.max(1, milliseconds / 8)));
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
          throw new SQLTimeoutException("Heartbeat round reached its deadline");
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
            SQLTimeoutException failed = new SQLTimeoutException(expired.getMessage(), rollback);
            failed.addSuppressed(expired);
            throw failed;
          }
          // A rollback that ends after the deadline did not end in the round's bound, so the
          // connection is discarded, as in every SDK.
          if (System.nanoTime() - deadline >= 0) {
            abort();
            SQLTimeoutException late = new SQLTimeoutException(expired.getMessage());
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
        throw new SQLTimeoutException("Heartbeat round reached its deadline");
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
