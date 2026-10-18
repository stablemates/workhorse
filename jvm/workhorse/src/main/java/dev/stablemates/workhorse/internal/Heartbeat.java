package dev.stablemates.workhorse.internal;

import dev.stablemates.workhorse.ConnectionSource;
import java.lang.ref.WeakReference;
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
import java.util.WeakHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;
import javax.sql.DataSource;
import org.jspecify.annotations.Nullable;

/**
 * Renews the leases of running attempts on a dedicated platform thread. Internal to the SDK; the
 * counterpart of Ruby's {@code Worker::Heartbeat} (ADR 0071).
 *
 * <p>Every worker on one {@link DataSource} shares one dedicated heartbeat, keyed by the {@code
 * DataSource} object. That heartbeat holds one connection while it has members, so handlers that
 * hold every other connection never delay a lease round. A worker with shared heartbeats has its
 * own heartbeat, which borrows a connection for each round instead.
 */
public final class Heartbeat {
  /** The most leases one {@code heartbeat_many_v1} call renews. */
  private static final int ROUND_LIMIT = 100;

  /** The wait before a dedicated heartbeat checks out a new connection after a failed round. */
  private static final long RETRY_NANOS = TimeUnit.MILLISECONDS.toNanos(100);

  /**
   * The shortest network timeout of a dedicated round. A round is bounded by the shortest member
   * interval (ADR 0071), but a socket timeout of a few milliseconds would fail healthy rounds.
   */
  private static final long MIN_ROUND_TIMEOUT_MS = 50;

  /**
   * A round with less time than this left fails before it sends its heartbeat. At this size every
   * server budget is at least 1 ms, and the budgets still fit in the time left.
   */
  private static final long MIN_REMAINING_NANOS = TimeUnit.MILLISECONDS.toNanos(8);

  /**
   * Sets both server timeouts for the current transaction only. {@code SET LOCAL} cannot take a
   * bind parameter, and {@code set_config(..., true)} has the same scope.
   */
  private static final String ROUND_TIMEOUTS =
      "SELECT set_config('statement_timeout', ?, true), "
          + "set_config('idle_in_transaction_session_timeout', ?, true)";

  private static final ReentrantLock DEDICATED_LOCK = new ReentrantLock();
  // Weak values: a heartbeat holds its DataSource, so a strong value would keep the weak key
  // alive forever. The workers that use a heartbeat, and its own thread, keep it alive.
  private static final Map<DataSource, WeakReference<Heartbeat>> DEDICATED = new WeakHashMap<>();

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

    /** Records an accepted round that left at {@code sentAt}, a {@link System#nanoTime} value. */
    void renew(long sentAt);

    /** Acts on a status other than {@code accepted}. */
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

  private Heartbeat(DataSource dataSource, boolean dedicated) {
    this.dataSource = dataSource;
    this.dedicated = dedicated;
  }

  /** The heartbeat that every worker on {@code dataSource} shares. */
  public static Heartbeat dedicated(DataSource dataSource) {
    DEDICATED_LOCK.lock();
    try {
      WeakReference<Heartbeat> reference = DEDICATED.get(dataSource);
      Heartbeat heartbeat = reference == null ? null : reference.get();
      if (heartbeat == null) {
        heartbeat = new Heartbeat(dataSource, true);
        DEDICATED.put(dataSource, new WeakReference<>(heartbeat));
      }
      return heartbeat;
    } finally {
      DEDICATED_LOCK.unlock();
    }
  }

  /** A heartbeat of one worker that borrows a connection for each round. */
  public static Heartbeat borrowing(DataSource dataSource) {
    return new Heartbeat(dataSource, false);
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
      Thread current = thread;
      if (current == null || !current.isAlive()) {
        Thread started = new Thread(this::run, "workhorse-heartbeats");
        started.setDaemon(true);
        thread = started;
        started.start();
      }
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

  private void run() {
    if (!dedicated) {
      ConnectionSource source = ConnectionSource.of(dataSource);
      try {
        rounds(
            (timeoutNanos, statement, parameters) -> {
              Connection connection = source.acquire();
              try {
                return Sql.rows(connection, statement, parameters);
              } finally {
                source.release(connection, false);
              }
            });
      } catch (SQLException unreachable) {
        // A borrowing round skips a failed round, so rounds does not throw here.
      }
      return;
    }
    // Holds one connection across rounds. A round that fails discards the connection, and the
    // next round checks out a new one. A pool that refuses a connection leaves the lease watchdog
    // to cover the rounds that keep failing.
    while (true) {
      try (Held held = new Held(dataSource.getConnection())) {
        if (rounds(
            (timeoutNanos, statement, parameters) ->
                held.round(timeoutNanos, statement, parameters))) {
          return;
        }
      } catch (SQLException | RuntimeException error) {
        // The next pass checks out a new connection, unless no member is left to renew.
        lock.lock();
        try {
          if (stopIfIdleLocked()) {
            return;
          }
        } finally {
          lock.unlock();
        }
      }
      waitFor(RETRY_NANOS);
    }
  }

  /**
   * Runs rounds until no member remains, and returns {@code true} then. A round falls due one
   * shortest member interval after the previous one. A dedicated round that fails throws, so the
   * caller can replace the connection; a borrowing round that fails is skipped.
   */
  private boolean rounds(Round round) throws SQLException {
    long previous = System.nanoTime();
    while (true) {
      List<Member> due;
      long interval = Long.MAX_VALUE;
      lock.lock();
      try {
        for (Member member : members.values()) {
          interval = Math.min(interval, member.intervalNanos());
        }
        if (stopIfIdleLocked()) {
          return true;
        }
        long remaining = previous + interval - System.nanoTime();
        if (remaining > 0) {
          changed.awaitNanos(remaining);
          continue;
        }
        due = new ArrayList<>(members.values());
      } catch (InterruptedException interrupted) {
        Thread.currentThread().interrupt();
        return true;
      } finally {
        lock.unlock();
      }
      previous = System.nanoTime();
      Map<String, List<Member>> byWorker = new LinkedHashMap<>();
      for (Member member : due) {
        byWorker.computeIfAbsent(member.workerId(), ignored -> new ArrayList<>()).add(member);
      }
      for (Map.Entry<String, List<Member>> entry : byWorker.entrySet()) {
        List<Member> group = entry.getValue();
        for (int start = 0; start < group.size(); start += ROUND_LIMIT) {
          List<Member> chunk = group.subList(start, Math.min(group.size(), start + ROUND_LIMIT));
          long sentAt = System.nanoTime();
          List<Row> rows;
          try {
            String payload = leases(chunk);
            // The round's deadline started at sentAt, so serialization counts against it.
            long remaining = roundBoundNanos(interval) - (System.nanoTime() - sentAt);
            rows = round.send(remaining, SqlCatalogue.HEARTBEAT_MANY_V1, entry.getKey(), payload);
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
          settle(chunk, statuses, sentAt);
        }
      }
    }
  }

  /**
   * The deadline of one round for the shortest member interval {@code intervalNanos}: the interval
   * plus 1 ms, and at least the shortest round timeout.
   */
  private static long roundBoundNanos(long intervalNanos) {
    return Math.max(
        TimeUnit.MILLISECONDS.toNanos(MIN_ROUND_TIMEOUT_MS),
        intervalNanos + TimeUnit.MILLISECONDS.toNanos(1));
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

  private void settle(List<Member> chunk, Map<String, String> statuses, long sentAt) {
    for (Member member : chunk) {
      if (!registered(member)) {
        continue;
      }
      String status = statuses.getOrDefault(member.taskId().toString(), "stale");
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

  private static void waitFor(long nanos) {
    try {
      TimeUnit.NANOSECONDS.sleep(nanos);
    } catch (InterruptedException interrupted) {
      Thread.currentThread().interrupt();
    }
  }

  /** Ends the thread when no member remains. A register that races this starts a new one. */
  private boolean stopIfIdleLocked() {
    if (!members.isEmpty()) {
      return false;
    }
    if (Thread.currentThread().equals(thread)) {
      thread = null;
    }
    return true;
  }

  private interface Round {
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
     */
    List<Row> round(
        long timeoutNanos, SqlCatalogue.Statement statement, @Nullable Object... parameters)
        throws SQLException {
      long deadline = System.nanoTime() + timeoutNanos;
      boundUntil(deadline);
      connection.setAutoCommit(false);
      try {
        long setAt = System.nanoTime();
        long remaining = deadline - setAt;
        if (remaining < MIN_REMAINING_NANOS) {
          throw new SQLTimeoutException("Heartbeat round reached its deadline");
        }
        // PostgreSQL measures statement_timeout for each statement and the idle timeout for each
        // idle gap, and restarts both every time. While the round can hold a row lock, it has one
        // idle gap before the heartbeat, the heartbeat, and one idle gap before COMMIT. So the
        // heartbeat gets one half, each gap one eighth, and the last quarter is kept for COMMIT.
        long milliseconds = TimeUnit.NANOSECONDS.toMillis(remaining);
        try (PreparedStatement timeouts = connection.prepareStatement(ROUND_TIMEOUTS)) {
          timeouts.setString(1, Long.toString(Math.max(1, milliseconds / 2)));
          timeouts.setString(2, Long.toString(Math.max(1, milliseconds / 8)));
          timeouts.execute();
        }
        // The budgets fit only if the settings statement used at most the quarter kept for COMMIT.
        if (System.nanoTime() - setAt > remaining / 4) {
          throw new SQLTimeoutException("Heartbeat round settings took too long");
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
      } catch (SQLException | RuntimeException error) {
        try {
          if (!connection.isClosed()) {
            boundUntil(deadline);
            connection.rollback();
          }
        } catch (SQLException rollback) {
          // The rollback keeps the round's deadline. A connection that cannot finish it in time
          // has a state the round cannot know.
          connection.abort(Runnable::run);
        }
        throw error;
      } finally {
        if (!connection.isClosed()) {
          connection.setAutoCommit(true);
        }
      }
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
