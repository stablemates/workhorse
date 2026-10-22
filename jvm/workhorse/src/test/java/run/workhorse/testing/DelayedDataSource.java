package run.workhorse.testing;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.Statement;
import java.time.Duration;
import javax.sql.DataSource;
import org.jspecify.annotations.Nullable;

/**
 * A {@link DataSource} over a pool whose every round trip takes {@code delay} more: each statement
 * and each {@code COMMIT} waits for it before it goes out. PostgreSQL thus sees each answer
 * followed by an idle gap of {@code delay}, as a remote database or a busy host gives. Each
 * statement still answers in about {@code delay}, so the database never stalls.
 */
public final class DelayedDataSource {
  private DelayedDataSource() {}

  /** {@code pool}, with {@code delay} before each statement and each {@code COMMIT}. */
  public static DataSource wrap(DataSource pool, Duration delay) {
    long delayMs = delay.toMillis();
    return (DataSource)
        Proxy.newProxyInstance(
            DataSource.class.getClassLoader(),
            new Class<?>[] {DataSource.class},
            (proxy, method, arguments) -> {
              Object result = invoke(method, pool, arguments);
              return method.getName().equals("getConnection")
                  ? connection((Connection) result, delayMs)
                  : result;
            });
  }

  private static Connection connection(Connection connection, long delayMs) {
    return (Connection)
        Proxy.newProxyInstance(
            Connection.class.getClassLoader(),
            new Class<?>[] {Connection.class},
            (proxy, method, arguments) -> {
              String name = method.getName();
              if (name.equals("commit")) {
                Thread.sleep(delayMs);
              }
              Object result = invoke(method, connection, arguments);
              if (name.equals("prepareStatement")) {
                return statement((Statement) result, PreparedStatement.class, delayMs);
              }
              if (name.equals("createStatement")) {
                return statement((Statement) result, Statement.class, delayMs);
              }
              return result;
            });
  }

  private static Object statement(Statement statement, Class<?> type, long delayMs) {
    return Proxy.newProxyInstance(
        type.getClassLoader(),
        new Class<?>[] {type},
        (proxy, method, arguments) -> {
          if (method.getName().startsWith("execute")) {
            Thread.sleep(delayMs);
          }
          return invoke(method, statement, arguments);
        });
  }

  private static @Nullable Object invoke(
      Method method, Object target, @Nullable Object @Nullable [] arguments) throws Throwable {
    try {
      return method.invoke(target, arguments);
    } catch (InvocationTargetException error) {
      throw error.getCause();
    }
  }
}
