package dev.stablemates.workhorse.internal;

import dev.stablemates.workhorse.ConnectionSource;
import java.lang.ref.WeakReference;
import java.sql.Connection;
import java.sql.SQLException;
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
            (timeoutNanos, statement, parameters) -> {
              held.bound(timeoutNanos);
              return Sql.rows(held.connection, statement, parameters);
            })) {
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
            rows =
                round.send(interval, SqlCatalogue.HEARTBEAT_MANY_V1, entry.getKey(), leases(chunk));
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
    /** Sends one statement within {@code timeoutNanos}, the shortest member interval. */
    List<Row> send(
        long timeoutNanos, SqlCatalogue.Statement statement, @Nullable Object... parameters)
        throws SQLException;
  }

  /**
   * The dedicated connection. It runs in autocommit, with a network timeout of one round, and it
   * restores both before it goes back to the pool. A round that overruns the timeout fails, and
   * PgJDBC closes the connection, so a stalled connection cannot stop renewal.
   */
  private static final class Held implements AutoCloseable {
    private final Connection connection;
    private final boolean restoreAutoCommit;
    private final int previousTimeout;
    private int current = -1;

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

    /** Bounds the next round by {@code timeoutNanos}, or by the shortest round timeout. */
    void bound(long timeoutNanos) throws SQLException {
      long milliseconds =
          Math.max(MIN_ROUND_TIMEOUT_MS, TimeUnit.NANOSECONDS.toMillis(timeoutNanos) + 1);
      int timeout = (int) Math.min(Integer.MAX_VALUE, milliseconds);
      if (timeout != current) {
        connection.setNetworkTimeout(Runnable::run, timeout);
        current = timeout;
      }
    }

    @Override
    public void close() throws SQLException {
      try {
        if (!connection.isClosed()) {
          if (current >= 0) {
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
