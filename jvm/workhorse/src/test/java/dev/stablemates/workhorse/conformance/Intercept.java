package dev.stablemates.workhorse.conformance;

import dev.stablemates.workhorse.internal.SqlCatalogue;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Array;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.sql.DataSource;
import org.jspecify.annotations.Nullable;

/**
 * A pooled {@link DataSource} that shows each worker statement to a {@link Hook}. The counterpart
 * of the Ruby lane's {@code wrap_rows}: the runner injects faults around the worker's statements,
 * never into the worker itself.
 *
 * <p>The worker runs every catalogue statement through {@code prepareStatement}, binds it, calls
 * {@code execute}, and reads the result set. The proxy records the bound values, calls the hook
 * before {@code execute}, and calls it again after the worker closes the result set, so a hook can
 * hold a statement on either side. It can also replace a {@code timestamptz} value as the worker
 * reads it. The pool keeps closed connections for reuse, so a fixture opens few sessions.
 */
final class Intercept implements DataSource, AutoCloseable {
  /** One worker statement, as the proxy sees it. */
  static final class Call {
    private final String sql;
    private final Map<Integer, @Nullable Object> placeholders =
        Collections.synchronizedMap(new LinkedHashMap<>());
    private final List<Map<String, @Nullable Object>> read = new ArrayList<>();
    private int rows;
    private @Nullable SQLException error;
    private final AtomicBoolean finished = new AtomicBoolean();

    private Call(String sql) {
      this.sql = sql;
    }

    /** Whether this call runs {@code statement}. */
    boolean is(SqlCatalogue.Statement statement) {
      return sql.equals(statement.sql());
    }

    /** The value bound to protocol parameter {@code $n} of {@code statement}. */
    @Nullable Object parameter(SqlCatalogue.Statement statement, int protocol) {
      for (int placeholder = 1; placeholder <= statement.placeholderCount(); placeholder++) {
        if (statement.protocolParameter(placeholder) == protocol) {
          return placeholders.get(placeholder);
        }
      }
      throw new IllegalArgumentException(statement + " has no parameter $" + protocol);
    }

    /** The rows the result set returned. Valid in {@link Hook#after}. */
    int rows() {
      return rows;
    }

    /** The values the worker read from each row, by column label. Valid in {@link Hook#after}. */
    List<Map<String, @Nullable Object>> read() {
      return read;
    }

    /** The error {@code execute} raised, or {@code null}. Valid in {@link Hook#after}. */
    @Nullable SQLException error() {
      return error;
    }
  }

  /** What the runner does around each worker statement. */
  interface Hook {
    /** Runs before PostgreSQL sees the statement. */
    default void before(Call call) throws Exception {}

    /** Runs after the worker read the result, or after an error. */
    default void after(Call call) throws Exception {}

    /** The {@code timestamptz} value the worker reads from {@code column}. */
    default @Nullable OffsetDateTime timestamp(
        Call call, String column, @Nullable OffsetDateTime value) throws Exception {
      return value;
    }
  }

  private final Connections.Opener opener;
  private final Hook hook;
  private final ConcurrentLinkedQueue<Connection> idle = new ConcurrentLinkedQueue<>();
  private final ConcurrentLinkedQueue<Connection> opened = new ConcurrentLinkedQueue<>();
  private final AtomicBoolean closed = new AtomicBoolean();

  Intercept(Connections.Opener opener, Hook hook) {
    this.opener = opener;
    this.hook = hook;
  }

  @Override
  public Connection getConnection() throws SQLException {
    if (closed.get()) {
      throw new SQLException("the fixture's connection pool is closed");
    }
    Connection connection = idle.poll();
    while (connection != null && connection.isClosed()) {
      connection = idle.poll();
    }
    if (connection == null) {
      connection = opener.open();
      opened.add(connection);
      // A close that ran while this session opened can miss it, so the session closes itself.
      if (closed.get()) {
        connection.close();
        throw new SQLException("the fixture's connection pool is closed");
      }
    }
    Connection real = connection;
    AtomicBoolean returned = new AtomicBoolean();
    return proxy(
        Connection.class,
        (proxy, method, arguments) ->
            switch (method.getName()) {
              case "close" -> release(real, returned);
              case "isClosed" -> returned.get() || real.isClosed();
              case "prepareStatement" ->
                  statement(
                      (PreparedStatement) invoke(real, method, arguments),
                      new Call((String) arguments[0]));
              default -> invoke(real, method, arguments);
            });
  }

  /** Returns a closed connection to the pool once. */
  private @Nullable Object release(Connection real, AtomicBoolean returned) throws SQLException {
    if (returned.compareAndSet(false, true) && !real.isClosed()) {
      real.setAutoCommit(true);
      idle.add(real);
    }
    return null;
  }

  private PreparedStatement statement(PreparedStatement real, Call call) {
    return proxy(
        PreparedStatement.class,
        (proxy, method, arguments) -> {
          String name = method.getName();
          if (name.startsWith("set")
              && arguments != null
              && arguments[0] instanceof Integer index) {
            call.placeholders.put(
                index,
                switch (name) {
                  case "setNull" -> null;
                  case "setArray" -> ((Array) arguments[1]).getArray();
                  default -> arguments[1];
                });
          }
          return switch (name) {
            case "execute" -> execute(real, method, arguments, call);
            case "getResultSet" -> {
              ResultSet resultSet = (ResultSet) invoke(real, method, arguments);
              yield resultSet == null ? null : results(resultSet, call);
            }
            case "close" -> closing(real, method, arguments, call);
            default -> invoke(real, method, arguments);
          };
        });
  }

  /** Runs {@code execute} between the hook's two calls. */
  private boolean execute(
      PreparedStatement real, Method method, @Nullable Object[] arguments, Call call)
      throws Throwable {
    hook.before(call);
    boolean results;
    try {
      results = (Boolean) invoke(real, method, arguments);
    } catch (SQLException error) {
      call.error = error;
      finish(call);
      throw error;
    }
    if (!results) {
      finish(call);
    }
    return results;
  }

  private ResultSet results(ResultSet real, Call call) {
    return proxy(
        ResultSet.class,
        (proxy, method, arguments) ->
            switch (method.getName()) {
              case "next" -> {
                boolean more = (Boolean) invoke(real, method, arguments);
                if (more) {
                  call.rows++;
                  call.read.add(new LinkedHashMap<>());
                }
                yield more;
              }
              case "getString", "getArray" ->
                  remember(real, call, arguments[0], invoke(real, method, arguments));
              case "getObject" -> {
                Object value = invoke(real, method, arguments);
                if (arguments.length == 2
                    && arguments[1] == OffsetDateTime.class
                    && arguments[0] instanceof Integer column) {
                  value =
                      hook.timestamp(
                          call, real.getMetaData().getColumnLabel(column), (OffsetDateTime) value);
                }
                yield remember(real, call, arguments[0], value);
              }
              case "close" -> closing(real, method, arguments, call);
              default -> invoke(real, method, arguments);
            });
  }

  /** Closes a statement or a result set, and then shows the finished call to the hook. */
  private @Nullable Object closing(
      Object real, Method method, @Nullable Object[] arguments, Call call) throws Throwable {
    try {
      return invoke(real, method, arguments);
    } finally {
      finish(call);
    }
  }

  /** Records a value the worker read in the current row, and returns it. */
  private static @Nullable Object remember(
      ResultSet real, Call call, @Nullable Object column, @Nullable Object value)
      throws SQLException {
    if (column instanceof Integer index && !call.read.isEmpty()) {
      call.read.get(call.read.size() - 1).put(real.getMetaData().getColumnLabel(index), value);
    }
    return value;
  }

  private void finish(Call call) throws Exception {
    if (call.finished.compareAndSet(false, true)) {
      hook.after(call);
    }
  }

  /** Closes every session the pool opened. */
  @Override
  public void close() {
    closed.set(true);
    for (Connection connection : opened) {
      try {
        connection.close();
      } catch (SQLException ignored) {
        // The fixture is over; a session that fails to close ends with the scratch database.
      }
    }
  }

  private static @Nullable Object invoke(Object target, Method method, @Nullable Object[] arguments)
      throws Throwable {
    try {
      return method.invoke(target, arguments);
    } catch (InvocationTargetException error) {
      throw error.getCause();
    }
  }

  private static <T> T proxy(Class<T> type, InvocationHandler handler) {
    return type.cast(
        Proxy.newProxyInstance(Intercept.class.getClassLoader(), new Class<?>[] {type}, handler));
  }

  @Override
  public Connection getConnection(String username, String password) throws SQLException {
    throw new java.sql.SQLFeatureNotSupportedException();
  }

  @Override
  public java.io.@Nullable PrintWriter getLogWriter() {
    return null;
  }

  @Override
  public void setLogWriter(java.io.@Nullable PrintWriter out) {}

  @Override
  public void setLoginTimeout(int seconds) {}

  @Override
  public int getLoginTimeout() {
    return 0;
  }

  @Override
  public java.util.logging.Logger getParentLogger()
      throws java.sql.SQLFeatureNotSupportedException {
    throw new java.sql.SQLFeatureNotSupportedException();
  }

  @Override
  public <T> T unwrap(Class<T> type) throws SQLException {
    throw new SQLException("not a wrapper");
  }

  @Override
  public boolean isWrapperFor(Class<?> type) {
    return false;
  }
}
