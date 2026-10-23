package run.workhorse.internal;

import java.lang.invoke.MethodHandle;
import java.lang.invoke.MethodHandles;
import java.lang.invoke.MethodType;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Consumer;
import javax.sql.DataSource;
import org.jspecify.annotations.Nullable;

/**
 * Wakes workers when PostgreSQL announces claimable work. Internal to the SDK; the counterpart of
 * Ruby's {@code Worker::Listener} (ADR 0103, "Connection model").
 *
 * <p>Every worker on one {@link DataSource} object shares one listener, as it shares the heartbeat
 * ({@link #shared}). The key is the object itself, by reference identity, never by {@code equals}.
 * So a pool budgets one listener connection however many workers it serves. The listener holds that
 * connection, which runs {@code LISTEN workhorse_tasks}, on a dedicated platform thread while it
 * has subscribers. It blocks in {@code getNotifications} with a bounded timeout, so a stop ends it
 * within one timeout. A notification names a queue, or {@code *} for every queue, and wakes each
 * subscriber whose queues match. A lost connection reconnects with a jittered backoff, and each
 * worker keeps polling meanwhile, so a notification only shortens a wait.
 */
public final class Listener {
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

  private static final IdentityRegistry<DataSource, Listener> SHARED = new IdentityRegistry<>();

  private final DataSource dataSource;
  private final ReentrantLock lock = new ReentrantLock();

  /** The subscribers, in subscription order. They change under {@link #lock}. */
  private final List<Subscription> subscribers = new ArrayList<>();

  private final AtomicBoolean listening = new AtomicBoolean();

  /**
   * Whether the thread holds its connection, from the checkout until the connection goes back. A
   * {@code LISTEN} can still be in flight while it is true.
   */
  private final AtomicBoolean holding = new AtomicBoolean();

  /** The thread, or {@code null} when none runs. It changes under {@link #lock}. */
  private @Nullable Thread thread;

  /** The stop signal of the thread's current pass. It changes under {@link #lock}. */
  private CountDownLatch stop = new CountDownLatch(1);

  /**
   * The checkout that has not given a thread its connection yet, or {@code null}. A pass or a
   * thread that stops leaves it for the next one, so stops and restarts never add a second
   * checkout. It changes under {@link #lock}, and its owner is settled there once: a thread adopts
   * the connection, or {@link #giveBack} gives it back to the pool when no subscriber is left. A
   * checkout that goes back stays here until the pool has the connection, so a new subscriber waits
   * for that return and does not start a second checkout.
   */
  private @Nullable Pending pending;

  /** One checkout of the listener connection. */
  private static final class Pending {
    final CompletableFuture<Connection> result;

    /** Completes when the connection is back in the pool. */
    final CompletableFuture<@Nullable Void> returned = new CompletableFuture<>();

    /** True once the checkout goes back to the pool. It changes under {@link #lock}. */
    boolean returning;

    Pending(CompletableFuture<Connection> result) {
      this.result = result;
    }
  }

  /**
   * Runs when a listener thread waits for the return of an earlier checkout, on that thread, or
   * {@code null}. A test uses it to know that the thread does not start a second checkout.
   */
  volatile @Nullable Runnable onReturnPending;

  private Listener(DataSource dataSource) {
    this.dataSource = dataSource;
  }

  /** The listener that every worker on the {@code dataSource} object shares. */
  public static Listener shared(DataSource dataSource) {
    return SHARED.get(dataSource, Listener::new);
  }

  /**
   * Wakes {@code onWake} for each notification that names one of {@code queues} or every queue, and
   * gives each connection failure to {@code onError}. The first subscriber starts the thread. It
   * never waits: a thread that still stops, perhaps on a stalled connection, sees the new
   * subscriber once that connection is back in the pool, and listens again. A new thread also waits
   * for a connection that still goes back to the pool after it arrived with no subscriber. So a
   * pool never holds two listener connections, and the worker polls meanwhile.
   */
  public Subscription subscribe(List<String> queues, Runnable onWake, Consumer<Throwable> onError) {
    Subscription subscription = new Subscription(queues, onWake, onError);
    lock.lock();
    try {
      subscribers.add(subscription);
      Thread current = thread;
      if (current == null || !current.isAlive()) {
        stop = new CountDownLatch(1);
        Thread started = new Thread(this::run, "workhorse-notification-listener");
        started.setDaemon(true);
        thread = started;
        started.start();
      }
    } finally {
      lock.unlock();
    }
    return subscription;
  }

  /** One worker's registration. {@link #close} removes it, and closing twice is harmless. */
  public final class Subscription implements AutoCloseable {
    private final List<String> queues;
    private final Runnable onWake;
    private final Consumer<Throwable> onError;

    private Subscription(List<String> queues, Runnable onWake, Consumer<Throwable> onError) {
      this.queues = List.copyOf(queues);
      this.onWake = onWake;
      this.onError = onError;
    }

    /** Whether the shared connection currently listens. */
    public boolean isListening() {
      return listening.get();
    }

    /**
     * Whether the listener holds its connection from the pool, also while its {@code LISTEN} is in
     * flight. A starting worker reads it to know that the listener's connection is no longer free.
     */
    public boolean holdsConnection() {
      return holding.get();
    }

    /** Removes the subscription, and waits up to 5 s for the thread to give its connection back. */
    @Override
    public void close() {
      close(System.nanoTime() + TimeUnit.SECONDS.toNanos(5));
    }

    /**
     * Removes the subscription. The last subscriber stops the thread, and waits for it to give its
     * connection back until {@code deadline}, a {@link System#nanoTime} value. The thread ends
     * within one read timeout of the stop.
     */
    public void close(long deadline) {
      Thread stopping = null;
      lock.lock();
      try {
        if (subscribers.remove(this) && subscribers.isEmpty()) {
          stop.countDown();
          stopping = thread;
        }
      } finally {
        lock.unlock();
      }
      if (stopping == null || stopping.equals(Thread.currentThread())) {
        return;
      }
      long wait = deadline - System.nanoTime();
      if (wait <= 0) {
        return;
      }
      try {
        stopping.join(Duration.ofNanos(wait));
      } catch (InterruptedException interrupted) {
        Thread.currentThread().interrupt();
      }
    }
  }

  /**
   * Listens until stopped. Once its connection is back in the pool, the thread ends unless a
   * subscriber arrived while it stopped.
   */
  private void run() {
    CountDownLatch current;
    lock.lock();
    try {
      current = stop;
    } finally {
      lock.unlock();
    }
    while (true) {
      listenUntil(current);
      boolean exit = false;
      Pending left = null;
      lock.lock();
      try {
        // Nothing interrupts the thread, but an interrupted thread could not wait, so it ends. The
        // next subscriber starts a new one.
        if (subscribers.isEmpty() || Thread.currentThread().isInterrupted()) {
          if (Thread.currentThread().equals(thread)) {
            thread = null;
          }
          // A checkout that ended while this thread waited out its backoff has no owner yet. This
          // thread gives it back, and a new subscriber waits for that return.
          Pending ended = pending;
          if (ended != null && ended.result.isDone() && !ended.returning) {
            ended.returning = true;
            left = ended;
          }
          exit = true;
        } else {
          if (current.getCount() == 0) {
            stop = new CountDownLatch(1);
          }
          current = stop;
        }
      } finally {
        lock.unlock();
      }
      if (exit) {
        if (left != null) {
          giveBack(left);
        }
        return;
      }
    }
  }

  private void listenUntil(CountDownLatch stop) {
    long backoff = INITIAL_RECONNECT_MS;
    while (stop.getCount() > 0) {
      try (Connection connection = checkout(stop)) {
        if (connection == null) {
          return;
        }
        holding.set(true);
        try {
          backoff = listen(connection, stop, backoff);
          // A stopped pass no longer listens. A subscriber that arrived during the stop reads the
          // cleared flag after this wake.
          wakeAll();
        } finally {
          holding.set(false);
        }
      } catch (SQLException | RuntimeException error) {
        report(error);
        wakeAll();
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

  /**
   * A connection from the pool, or {@code null} when {@code stop} counts down first. The checkout
   * runs on its own thread, so a full pool cannot hold a stop for the timeout of the pool. A
   * stopped pass leaves the checkout for the next pass ({@link #pending}). A checkout that still
   * goes back to the pool keeps its place, so this thread waits for that return, and then starts
   * its own checkout.
   */
  private @Nullable Connection checkout(CountDownLatch stop) throws SQLException {
    while (stop.getCount() > 0) {
      Pending current;
      lock.lock();
      try {
        current = pending;
        if (current == null) {
          Pending created = new Pending(Checkout.start(dataSource, "workhorse-listener-checkout"));
          pending = created;
          current = created;
          var unused = created.result.whenComplete((connection, error) -> orphaned(created));
        }
      } finally {
        lock.unlock();
      }
      if (isReturning(current)) {
        Runnable hook = onReturnPending;
        if (hook != null) {
          hook.run();
        }
        if (!await(current.returned, stop)) {
          return null;
        }
        continue;
      }
      if (!await(current.result, stop)) {
        return null;
      }
      Connection connection;
      try {
        connection = current.result.get();
      } catch (ExecutionException failed) {
        adopt(current);
        Throwable cause = failed.getCause();
        if (cause instanceof SQLException error) {
          throw error;
        }
        if (cause instanceof RuntimeException error) {
          throw error;
        }
        throw new SQLException("The listener could not check out a connection", cause);
      } catch (InterruptedException interrupted) {
        Thread.currentThread().interrupt();
        return null;
      }
      // The connection is this thread's only when the checkout is still pending and does not go
      // back: otherwise it ended with no subscriber, and its return comes first.
      if (adopt(current)) {
        return connection;
      }
    }
    return null;
  }

  /**
   * Waits until {@code future} completes, and returns {@code true}, or returns {@code false} when
   * {@code stop} counts down first or the thread is interrupted. It checks {@code stop} once each
   * read timeout.
   */
  private static boolean await(CompletableFuture<?> future, CountDownLatch stop) {
    while (stop.getCount() > 0) {
      try {
        future.get(READ_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        return true;
      } catch (TimeoutException waiting) {
        // The stop check runs once each read timeout.
      } catch (ExecutionException failed) {
        return true;
      } catch (InterruptedException interrupted) {
        Thread.currentThread().interrupt();
        return false;
      }
    }
    return false;
  }

  private boolean isReturning(Pending checkout) {
    lock.lock();
    try {
      return checkout.returning;
    } finally {
      lock.unlock();
    }
  }

  /**
   * Takes {@code checkout} as the thread's own, and returns whether it was still pending and did
   * not go back to the pool.
   */
  private boolean adopt(Pending checkout) {
    lock.lock();
    try {
      if (pending != checkout || checkout.returning) {
        return false;
      }
      pending = null;
      return true;
    } finally {
      lock.unlock();
    }
  }

  /**
   * Gives the connection of {@code checkout} back to the pool when the checkout ends with no
   * subscriber left. Otherwise the checkout stays pending, and the thread of a subscriber adopts
   * it.
   */
  private void orphaned(Pending checkout) {
    lock.lock();
    try {
      if (pending != checkout || checkout.returning || !subscribers.isEmpty()) {
        return;
      }
      checkout.returning = true;
    } finally {
      lock.unlock();
    }
    giveBack(checkout);
  }

  /**
   * Gives the connection of {@code checkout}, which ended, back to the pool, and then frees the
   * checkout's place. Only the caller that set {@link Pending#returning} calls it, without {@link
   * #lock}.
   */
  private void giveBack(Pending checkout) {
    try {
      Checkout.closeQuietly(
          checkout.result.isCompletedExceptionally() ? null : checkout.result.join());
    } finally {
      lock.lock();
      try {
        if (pending == checkout) {
          pending = null;
        }
      } finally {
        lock.unlock();
      }
      checkout.returned.complete(null);
    }
  }

  /** Listens on {@code connection} until stopped. Returns the backoff for the next connection. */
  private long listen(Connection connection, CountDownLatch stop, long backoff)
      throws SQLException {
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
      wakeAll();
      while (stop.getCount() > 0) {
        Object[] received = receive(notifications);
        if (received == null) {
          continue;
        }
        for (Object notification : received) {
          wakeMatching(parameter(notification));
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

  private List<Subscription> subscribers() {
    lock.lock();
    try {
      return List.copyOf(subscribers);
    } finally {
      lock.unlock();
    }
  }

  private void wakeMatching(String payload) {
    for (Subscription subscriber : subscribers()) {
      if (payload.equals("*") || subscriber.queues.contains(payload)) {
        run(subscriber.onWake);
      }
    }
  }

  private void wakeAll() {
    for (Subscription subscriber : subscribers()) {
      run(subscriber.onWake);
    }
  }

  private void report(Throwable error) {
    for (Subscription subscriber : subscribers()) {
      try {
        subscriber.onError.accept(error);
      } catch (RuntimeException ignored) {
        // A callback that throws must not end the listener, or keep another subscriber's report.
      }
    }
  }

  private static void run(Runnable callback) {
    try {
      callback.run();
    } catch (RuntimeException ignored) {
      // A callback that throws must not end the listener, or keep another subscriber's wake.
    }
  }
}
