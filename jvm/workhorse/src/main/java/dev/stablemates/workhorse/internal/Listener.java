package dev.stablemates.workhorse.internal;

import java.lang.invoke.MethodHandle;
import java.lang.invoke.MethodHandles;
import java.lang.invoke.MethodType;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import javax.sql.DataSource;
import org.jspecify.annotations.Nullable;

/**
 * Wakes one worker when PostgreSQL announces claimable work. Internal to the SDK; the counterpart
 * of Ruby's {@code Worker::Listener} (ADR 0103, "Connection model").
 *
 * <p>The listener holds one connection, which runs {@code LISTEN workhorse_tasks}, on a dedicated
 * platform thread. It blocks in {@code getNotifications} with a bounded timeout, so {@link #close}
 * ends it within one timeout. A notification names a queue, or {@code *} for every queue. A lost
 * connection reconnects with a jittered backoff, and the worker keeps polling meanwhile, so a
 * notification only shortens a wait.
 */
public final class Listener implements AutoCloseable {
  /**
   * PgJDBC's notification API. The root {@code org.postgresql} package carries Checker Framework
   * annotations that the build does not have, so the listener reaches {@code PGConnection} and
   * {@code PGNotification} through method handles instead of a compile-time reference.
   */
  private static final Class<?> PG_CONNECTION;

  private static final MethodHandle GET_NOTIFICATIONS;
  private static final MethodHandle GET_PARAMETER;

  static {
    try {
      PG_CONNECTION = Class.forName("org.postgresql.PGConnection");
      Class<?> notification = Class.forName("org.postgresql.PGNotification");
      MethodHandles.Lookup lookup = MethodHandles.publicLookup();
      GET_NOTIFICATIONS =
          lookup.findVirtual(
              PG_CONNECTION,
              "getNotifications",
              MethodType.methodType(notification.arrayType(), int.class));
      GET_PARAMETER =
          lookup.findVirtual(notification, "getParameter", MethodType.methodType(String.class));
    } catch (ReflectiveOperationException error) {
      throw new ExceptionInInitializerError(error);
    }
  }

  /** The notification channel that PostgreSQL announces claimable work on. */
  private static final String CHANNEL = "workhorse_tasks";

  /**
   * The session commands of the listener connection, the only SQL text in the JVM sources outside
   * {@code SqlCatalogue}. They are not protocol SQL, so the catalogue does not hold them. Go keeps
   * the same two commands as constants: {@code listenForTasksStatement} and {@code
   * unlistenForTasksStatement} in {@code go/statements.go}.
   */
  private static final String LISTEN = "LISTEN " + CHANNEL;

  private static final String UNLISTEN = "UNLISTEN " + CHANNEL;
  private static final int READ_TIMEOUT_MS = 100;
  private static final long INITIAL_RECONNECT_MS = 100;
  private static final long MAX_RECONNECT_MS = 5_000;

  private final DataSource dataSource;
  private final List<String> queues;
  private final Runnable onWake;
  private final Consumer<Throwable> onError;
  private final AtomicBoolean listening = new AtomicBoolean();
  private final CountDownLatch stop = new CountDownLatch(1);
  private final Thread thread;

  private Listener(
      DataSource dataSource, List<String> queues, Runnable onWake, Consumer<Throwable> onError) {
    this.dataSource = dataSource;
    this.queues = List.copyOf(queues);
    this.onWake = onWake;
    this.onError = onError;
    this.thread = new Thread(this::run, "workhorse-notification-listener");
    thread.setDaemon(true);
  }

  /** Starts a listener for {@code queues}. */
  public static Listener start(
      DataSource dataSource, List<String> queues, Runnable onWake, Consumer<Throwable> onError) {
    Listener listener = new Listener(dataSource, queues, onWake, onError);
    listener.thread.start();
    return listener;
  }

  /** Whether the connection currently listens. */
  public boolean isListening() {
    return listening.get();
  }

  /** Stops listening, and waits up to 5 s for the thread to give its connection back. */
  @Override
  public void close() {
    close(System.nanoTime() + TimeUnit.SECONDS.toNanos(5));
  }

  /**
   * Stops listening, and waits for the thread to give its connection back until {@code deadline}, a
   * {@link System#nanoTime} value, or one read timeout at least.
   */
  public void close(long deadline) {
    stop.countDown();
    long wait =
        Math.max(deadline - System.nanoTime(), TimeUnit.MILLISECONDS.toNanos(2L * READ_TIMEOUT_MS));
    try {
      thread.join(java.time.Duration.ofNanos(wait));
    } catch (InterruptedException interrupted) {
      Thread.currentThread().interrupt();
    }
  }

  private void run() {
    long backoff = INITIAL_RECONNECT_MS;
    while (stop.getCount() > 0) {
      try (Connection connection = dataSource.getConnection()) {
        backoff = listen(connection, backoff);
      } catch (SQLException | RuntimeException error) {
        notify(onError, error);
        wake();
      }
      long jittered = Math.round(backoff * ThreadLocalRandom.current().nextDouble(0.9, 1.1));
      try {
        if (stop.await(jittered, TimeUnit.MILLISECONDS)) {
          return;
        }
      } catch (InterruptedException interrupted) {
        return;
      }
      backoff = Math.min(backoff * 2, MAX_RECONNECT_MS);
    }
  }

  /** Listens on {@code connection} until stopped. Returns the backoff for the next connection. */
  private long listen(Connection connection, long backoff) throws SQLException {
    boolean restoreAutoCommit = !connection.getAutoCommit();
    // A LISTEN inside an open transaction takes effect only at the commit.
    if (restoreAutoCommit) {
      connection.setAutoCommit(true);
    }
    try {
      Object notifications = connection.unwrap(PG_CONNECTION);
      try (Statement statement = connection.createStatement()) {
        statement.execute(LISTEN);
      }
      backoff = INITIAL_RECONNECT_MS;
      listening.set(true);
      wake();
      while (stop.getCount() > 0) {
        Object[] received = receive(notifications);
        if (received == null) {
          continue;
        }
        for (Object notification : received) {
          String payload = parameter(notification);
          if (payload.equals("*") || queues.contains(payload)) {
            wake();
          }
        }
      }
      return backoff;
    } finally {
      listening.set(false);
      unlisten(connection, restoreAutoCommit);
    }
  }

  /** The notifications that arrive within one read timeout, or {@code null} for none. */
  private static Object @Nullable [] receive(Object connection) throws SQLException {
    try {
      return (Object[]) GET_NOTIFICATIONS.invoke(connection, READ_TIMEOUT_MS);
    } catch (SQLException | RuntimeException | Error error) {
      throw error;
    } catch (Throwable error) {
      throw new SQLException("getNotifications failed", error);
    }
  }

  private static String parameter(Object notification) throws SQLException {
    try {
      return (String) GET_PARAMETER.invoke(notification);
    } catch (RuntimeException | Error error) {
      throw error;
    } catch (Throwable error) {
      throw new SQLException("getParameter failed", error);
    }
  }

  /** A connection that still listens cannot go back to the pool, so a failure here closes it. */
  private static void unlisten(Connection connection, boolean restoreAutoCommit) {
    try {
      if (connection.isClosed()) {
        return;
      }
      try (Statement statement = connection.createStatement()) {
        statement.execute(UNLISTEN);
      }
      if (restoreAutoCommit) {
        connection.setAutoCommit(false);
      }
    } catch (SQLException | RuntimeException error) {
      try {
        connection.unwrap(Connection.class).close();
      } catch (SQLException | RuntimeException ignored) {
        // The pool sees a closed connection and replaces it.
      }
    }
  }

  private void wake() {
    try {
      onWake.run();
    } catch (RuntimeException ignored) {
      // A callback that throws must not end the listener.
    }
  }

  private static void notify(Consumer<Throwable> callback, Throwable error) {
    try {
      callback.accept(error);
    } catch (RuntimeException ignored) {
      // A callback that throws must not end the listener.
    }
  }
}
