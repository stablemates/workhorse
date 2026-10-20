package run.workhorse.testing;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.util.concurrent.atomic.AtomicInteger;
import run.workhorse.internal.SqlCatalogue;

/**
 * Gives a new proxy for each checkout of a physical connection, as a connection pool does. The
 * proxy unwraps to the physical connection, and it counts each compatibility query that reaches
 * PostgreSQL.
 */
public final class PooledConnections {
  /** Runs before each compatibility query, for example to hold it. */
  @FunctionalInterface
  public interface Hook {
    /** Runs before the query. */
    void beforeCheck() throws Exception;
  }

  private final AtomicInteger checks = new AtomicInteger();
  private final Hook hook;

  /** Proxies that run each compatibility query at once. */
  public PooledConnections() {
    this(() -> {});
  }

  /** Proxies that run {@code hook} before each compatibility query. */
  public PooledConnections(Hook hook) {
    this.hook = hook;
  }

  /** The number of compatibility queries that the proxies sent. */
  public int compatibilityChecks() {
    return checks.get();
  }

  /** A new proxy over {@code physical}, as one pool checkout gives it. */
  public Connection checkout(Connection physical) {
    return (Connection)
        Proxy.newProxyInstance(
            Connection.class.getClassLoader(),
            new Class<?>[] {Connection.class},
            (proxy, method, arguments) -> {
              if (method.getName().equals("prepareStatement")
                  && SqlCatalogue.COMPATIBILITY_STATE.sql().equals(arguments[0])) {
                checks.incrementAndGet();
                hook.beforeCheck();
              }
              if (method.getName().equals("close")) {
                return null;
              }
              try {
                return method.invoke(physical, arguments);
              } catch (InvocationTargetException error) {
                throw error.getCause();
              }
            });
  }
}
