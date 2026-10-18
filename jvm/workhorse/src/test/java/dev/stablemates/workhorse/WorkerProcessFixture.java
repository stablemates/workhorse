package dev.stablemates.workhorse;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintWriter;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.SQLFeatureNotSupportedException;
import java.time.Duration;
import java.util.Map;
import java.util.Properties;
import java.util.ResourceBundle;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;
import java.util.logging.Logger;
import javax.sql.DataSource;
import org.jspecify.annotations.Nullable;

/**
 * The child JVM of {@link WorkerProcessTest}. It runs one worker through {@link
 * WorkerProcess#runWorkerProcess} and reports each step on standard output, one line for each step.
 *
 * <p>Arguments: the mode ({@code drain}, {@code return}, or {@code fail}), the JDBC URL, and the
 * queue. The credentials come from {@code DATABASE_URL_TEST}.
 */
final class WorkerProcessFixture {
  /** Opens when the worker logs its start, so return mode stops a run that already began. */
  private static final CountDownLatch STARTED = new CountDownLatch(1);

  private WorkerProcessFixture() {}

  public static void main(String[] arguments) {
    String mode = arguments[0];
    String url = arguments[1];
    String queue = arguments[2];
    DataSource dataSource = mode.equals("fail") ? new Refusing() : new Direct(url, credentials());
    BufferedReader input =
        new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    Worker worker =
        Worker.builder(dataSource)
            .queues(queue)
            .pollingOnly(true)
            .pollInterval(Duration.ofMillis(10))
            .disableRegistry(true)
            .shutdownGrace(Duration.ofSeconds(30))
            .logger(new Events())
            .handle(
                "drain",
                Object.class,
                (ctx, payload) -> {
                  report("STARTED " + ctx.task().id());
                  // Returns only when the test says so, which it does after the signal.
                  String line = input.readLine();
                  report("HANDLER_DONE " + line);
                  return Map.of("finished", true);
                })
            .build();
    if (mode.equals("return")) {
      Thread.ofPlatform()
          .daemon()
          .start(
              () -> {
                try {
                  if (STARTED.await(30, TimeUnit.SECONDS)) {
                    worker.stop();
                  }
                } catch (InterruptedException ignored) {
                  // The process ends without a stop, and the parent test times out.
                }
              });
    }
    WorkerProcess.runWorkerProcess(worker);
  }

  private static synchronized void report(String line) {
    System.out.println(line);
    System.out.flush();
  }

  private static Properties credentials() {
    Properties properties = new Properties();
    String source = System.getenv().getOrDefault("DATABASE_URL_TEST", "");
    String userInfo = source.isEmpty() ? null : URI.create(source).getRawUserInfo();
    if (userInfo != null) {
      String[] parts = userInfo.split(":", 2);
      properties.setProperty("user", URLDecoder.decode(parts[0], StandardCharsets.UTF_8));
      if (parts.length > 1) {
        properties.setProperty("password", URLDecoder.decode(parts[1], StandardCharsets.UTF_8));
      }
    }
    return properties;
  }

  /** Reports each worker event name on standard output. */
  private static final class Events implements System.Logger {
    @Override
    public String getName() {
      return "fixture";
    }

    @Override
    public boolean isLoggable(Level level) {
      return true;
    }

    @Override
    public void log(
        Level level,
        @Nullable ResourceBundle bundle,
        @Nullable String message,
        @Nullable Throwable thrown) {
      if (message != null && message.contains("event.name=")) {
        String event = message.substring(message.indexOf("event.name=") + 11);
        int end = event.indexOf(',');
        String name = end < 0 ? event : event.substring(0, end);
        report("EVENT " + name);
        if (name.equals("workhorse.worker.started")) {
          STARTED.countDown();
        }
      }
    }

    @Override
    public void log(
        Level level,
        @Nullable ResourceBundle bundle,
        @Nullable String format,
        @Nullable Object... parameters) {
      log(level, bundle, format, (Throwable) null);
    }

    @Override
    public void log(Level level, Supplier<String> message) {
      log(level, null, message.get(), (Throwable) null);
    }
  }

  /** A data source that opens a new connection for each call. */
  private static class Direct implements DataSource {
    private final String url;
    private final Properties credentials;

    Direct(String url, Properties credentials) {
      this.url = url;
      this.credentials = credentials;
    }

    @Override
    public Connection getConnection() throws SQLException {
      return DriverManager.getConnection(url, credentials);
    }

    @Override
    public Connection getConnection(String username, String password) throws SQLException {
      throw new SQLFeatureNotSupportedException();
    }

    @Override
    public @Nullable PrintWriter getLogWriter() {
      return null;
    }

    @Override
    public void setLogWriter(@Nullable PrintWriter out) {}

    @Override
    public void setLoginTimeout(int seconds) {}

    @Override
    public int getLoginTimeout() {
      return 0;
    }

    @Override
    public Logger getParentLogger() throws SQLFeatureNotSupportedException {
      throw new SQLFeatureNotSupportedException();
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

  /** A data source that refuses every connection, so the run throws without a signal. */
  private static final class Refusing extends Direct {
    Refusing() {
      super("", new Properties());
    }

    @Override
    public Connection getConnection() throws SQLException {
      throw new SQLException("the fixture refuses every connection", "08001");
    }
  }
}
