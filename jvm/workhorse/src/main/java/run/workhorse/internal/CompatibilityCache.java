package run.workhorse.internal;

import java.lang.ref.ReferenceQueue;
import java.lang.ref.WeakReference;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicReference;
import org.jspecify.annotations.Nullable;
import run.workhorse.CompatibilityException;

/**
 * The compatibility results of one {@code Queue} or {@code Admin} (ADR 0103, "Connection model").
 *
 * <p>The cache holds one result for the source, and one result for each physical connection that
 * reaches the client in a caller call. A pool gives a new proxy object for each checkout, so the
 * key is the PgJDBC connection that {@code unwrap(PGConnection.class)} returns. The map compares
 * keys by identity and holds them weakly, so a closed connection leaves the cache.
 *
 * <p>The root {@code org.postgresql} package carries Checker Framework annotations that the build
 * does not have, so the cache reaches {@code PGConnection} by name, as {@link Listener} does.
 *
 * <p>The check runs without a lock. Two calls can check the same connection at the same time; the
 * first result to arrive stays. A driver error is not cached.
 */
public final class CompatibilityCache {
  private static final Class<?> PG_CONNECTION;

  static {
    try {
      PG_CONNECTION = Class.forName("org.postgresql.PGConnection");
    } catch (ClassNotFoundException error) {
      throw new ExceptionInInitializerError(error);
    }
  }

  /** One check result. {@code code} is {@code null} when the client can continue. */
  private record Result(CompatibilityException.@Nullable Code code) {}

  private final AtomicReference<@Nullable Result> source = new AtomicReference<>();
  private final ConcurrentHashMap<Key, Result> connections = new ConcurrentHashMap<>();
  private final ReferenceQueue<Object> collected = new ReferenceQueue<>();

  /**
   * The refusal code for {@code connection}, or {@code null} when the client can continue.
   *
   * @param caller true when the caller owns the connection, false when it comes from the source
   */
  public CompatibilityException.@Nullable Code check(Connection connection, boolean caller) {
    if (!caller) {
      Result cached = source.get();
      if (cached == null) {
        Result evaluated = new Result(Compatibility.evaluate(connection));
        cached = source.compareAndSet(null, evaluated) ? evaluated : source.get();
      }
      return cached == null ? null : cached.code();
    }
    expunge();
    Key key = new Key(physical(connection), collected);
    Result cached = connections.get(key);
    if (cached == null) {
      Result evaluated = new Result(Compatibility.evaluate(connection));
      cached = connections.putIfAbsent(key, evaluated);
      if (cached == null) {
        cached = evaluated;
      }
    }
    return cached.code();
  }

  /** The PgJDBC connection behind a pool proxy, or the connection itself when it has none. */
  private static Object physical(Connection connection) {
    try {
      if (connection.isWrapperFor(PG_CONNECTION)) {
        return connection.unwrap(PG_CONNECTION);
      }
    } catch (SQLException error) {
      // A wrapper that cannot unwrap keys the cache by its own object.
    }
    return connection;
  }

  private void expunge() {
    Object reference;
    while ((reference = collected.poll()) != null) {
      connections.remove(reference);
    }
  }

  /** A weak key that compares its referent by identity. */
  private static final class Key extends WeakReference<Object> {
    private final int hash;

    Key(Object referent, ReferenceQueue<Object> queue) {
      super(referent, queue);
      this.hash = System.identityHashCode(referent);
    }

    @Override
    public int hashCode() {
      return hash;
    }

    // The key compares connections by identity on purpose: two connections are never equal.
    @SuppressWarnings("ReferenceEquality")
    @Override
    public boolean equals(@Nullable Object other) {
      if (this == other) {
        return true;
      }
      if (!(other instanceof Key key)) {
        return false;
      }
      Object referent = get();
      return referent != null && referent == key.get();
    }
  }
}
