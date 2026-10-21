package run.workhorse.probe;

import com.zaxxer.hikari.HikariDataSource;
import com.zaxxer.hikari.HikariPoolMXBean;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import run.workhorse.Worker;

/**
 * Runs W workers on one HikariCP pool. A task whose payload has {@code handlerMs} returns after
 * that time; any other task holds its slot until SIGTERM. All workers share the pool object, so
 * they share the listener connection and the heartbeat connection that the SDK keys by the {@code
 * DataSource} object.
 */
public final class ConnectionBudgetProbe {
  private ConnectionBudgetProbe() {}

  private static String setting(String name) {
    String value = System.getenv(name);
    if (value == null || value.isEmpty()) {
      throw new IllegalArgumentException(name + " is required");
    }
    return value;
  }

  private static int count(String name) {
    int value = Integer.parseInt(setting(name));
    if (value < 1) {
      throw new IllegalArgumentException(name + " must be a positive integer");
    }
    return value;
  }

  /** A positive integer from an optional variable, or 0 when the variable is empty. */
  private static int optionalCount(String name) {
    String value = System.getenv(name);
    return value == null || value.isEmpty() ? 0 : count(name);
  }

  /** A JSON number, or null for 0. */
  private static String nullable(int value) {
    return value == 0 ? "null" : String.valueOf(value);
  }

  private static String quoted(String value) {
    StringBuilder out = new StringBuilder("\"");
    for (int position = 0; position < value.length(); position++) {
      char character = value.charAt(position);
      switch (character) {
        case '"' -> out.append("\\\"");
        case '\\' -> out.append("\\\\");
        case '\n' -> out.append("\\n");
        case '\r' -> out.append("\\r");
        case '\t' -> out.append("\\t");
        default -> {
          if (character < 0x20) {
            out.append(String.format("\\u%04x", (int) character));
          } else {
            out.append(character);
          }
        }
      }
    }
    return out.append('"').toString();
  }

  private static synchronized void emit(String json) {
    System.out.println(json);
    System.out.flush();
  }

  private static void workerError(int index, Throwable error) {
    emit(
        "{\"event\":\"worker_error\",\"worker\":"
            + index
            + ",\"error\":"
            + quoted(String.valueOf(error))
            + "}");
  }

  private static String decoded(String value) {
    return URLDecoder.decode(value, StandardCharsets.UTF_8);
  }

  /** A pool from a {@code postgres://user:password@host:port/database} URL. */
  private static HikariDataSource pool(String url, int size, String applicationName) {
    URI uri = URI.create(url);
    HikariDataSource dataSource = new HikariDataSource();
    int port = uri.getPort() == -1 ? 5432 : uri.getPort();
    dataSource.setJdbcUrl("jdbc:postgresql://" + uri.getHost() + ":" + port + uri.getRawPath());
    String userInfo = uri.getRawUserInfo();
    if (userInfo != null) {
      int colon = userInfo.indexOf(':');
      dataSource.setUsername(decoded(colon == -1 ? userInfo : userInfo.substring(0, colon)));
      if (colon != -1) {
        dataSource.setPassword(decoded(userInfo.substring(colon + 1)));
      }
    }
    dataSource.setMaximumPoolSize(size);
    // HikariCP fills the pool at start by default. Zero idle connections opens a connection only
    // when the SDK asks for one, so the count shows its need.
    dataSource.setMinimumIdle(0);
    dataSource.addDataSourceProperty("ApplicationName", applicationName);
    return dataSource;
  }

  /** The pool state, seen from inside the process. HikariCP has no pool before the first use. */
  private static void reportPool(HikariDataSource dataSource) {
    HikariPoolMXBean bean = dataSource.getHikariPoolMXBean();
    int total = bean == null ? 0 : bean.getTotalConnections();
    int idle = bean == null ? 0 : bean.getIdleConnections();
    int checkedOut = bean == null ? 0 : bean.getActiveConnections();
    int waiting = bean == null ? 0 : bean.getThreadsAwaitingConnection();
    emit(
        "{\"event\":\"pool\",\"total\":"
            + total
            + ",\"idle\":"
            + idle
            + ",\"checkedOut\":"
            + checkedOut
            + ",\"waiting\":"
            + waiting
            + ",\"max\":"
            + dataSource.getMaximumPoolSize()
            + "}");
  }

  public static void main(String[] args) throws InterruptedException {
    int workerCount = count("WH_BENCH_WORKERS");
    int pollMs = optionalCount("WH_BENCH_POLL_MS");
    int shutdownGraceMs = count("WH_BENCH_SHUTDOWN_GRACE_MS");
    HikariDataSource dataSource =
        pool(
            setting("WH_BENCH_DATABASE_URL"),
            count("WH_BENCH_POOL_SIZE"),
            setting("WH_BENCH_APPLICATION_NAME"));
    CountDownLatch release = new CountDownLatch(1);
    List<Worker> workers = new ArrayList<>();
    List<Integer> indexes = new ArrayList<>();
    for (int index = 0; index < workerCount; index++) {
      try {
        Worker.Builder builder =
            Worker.builder(dataSource)
                .queues(setting("WH_BENCH_QUEUE"))
                .workerId("wh-bench-jvm-" + ProcessHandle.current().pid() + "-" + index)
                .concurrency(count("WH_BENCH_CONCURRENCY"))
                .heartbeat(Duration.ofMillis(count("WH_BENCH_HEARTBEAT_MS")))
                .lease(Duration.ofMillis(count("WH_BENCH_LEASE_MS")))
                .shutdownGrace(Duration.ofMillis(shutdownGraceMs))
                .handle(
                    setting("WH_BENCH_TASK_TYPE"),
                    Object.class,
                    (context, payload) -> {
                      long handlerMs =
                          payload instanceof Map<?, ?> fields
                                  && fields.get("handlerMs") instanceof Number number
                              ? number.longValue()
                              : 0;
                      if (handlerMs > 0) {
                        // The handler returns after its time, when the probe stops, or when the
                        // worker cancels the attempt.
                        long end = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(handlerMs);
                        while (System.nanoTime() < end && !context.isCancelled()) {
                          long waitMs =
                              Math.max(1, Math.min(50, (end - System.nanoTime()) / 1_000_000));
                          if (release.await(waitMs, TimeUnit.MILLISECONDS)) {
                            break;
                          }
                        }
                        return null;
                      }
                      // The handler holds its slot until the probe stops or the worker cancels
                      // the attempt.
                      while (!release.await(50, TimeUnit.MILLISECONDS) && !context.isCancelled()) {
                        Thread.onSpinWait();
                      }
                      return null;
                    });
        if (pollMs > 0) {
          builder.pollInterval(Duration.ofMillis(pollMs));
        }
        workers.add(builder.build());
        indexes.add(index);
      } catch (RuntimeException error) {
        workerError(index, error);
      }
    }
    ScheduledExecutorService reporter = Executors.newSingleThreadScheduledExecutor();
    CountDownLatch done = new CountDownLatch(1);
    Runtime.getRuntime()
        .addShutdownHook(
            new Thread(
                () -> {
                  reporter.shutdownNow();
                  // Stop claims first, then let the handlers return.
                  workers.forEach(Worker::stop);
                  release.countDown();
                  for (int position = 0; position < workers.size(); position++) {
                    try {
                      workers.get(position).close();
                    } catch (RuntimeException error) {
                      workerError(indexes.get(position), error);
                    }
                  }
                  dataSource.close();
                  emit("{\"event\":\"stopped\"}");
                  done.countDown();
                  // The probe stopped cleanly, so it exits 0 rather than with the SIGTERM status.
                  Runtime.getRuntime().halt(0);
                },
                "wh-bench-shutdown"));
    workers.forEach(Worker::start);
    var unused =
        reporter.scheduleAtFixedRate(() -> reportPool(dataSource), 0, 250, TimeUnit.MILLISECONDS);
    emit(
        "{\"event\":\"started\",\"sdk\":\"jvm\",\"workers\":"
            + workerCount
            + ",\"pollMs\":"
            + nullable(pollMs)
            + ",\"shutdownGraceMs\":"
            + shutdownGraceMs
            + ",\"grace\":\"shutdownGrace\"}");
    done.await();
  }
}
