package run.workhorse.examples;

import com.zaxxer.hikari.HikariDataSource;
import jakarta.servlet.DispatcherType;
import jakarta.servlet.ServletContext;
import jakarta.servlet.http.HttpServletRequest;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.util.EnumSet;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
import org.jspecify.annotations.Nullable;
import run.workhorse.Admin;
import run.workhorse.AdminAudit;
import run.workhorse.BatchHandlerOutcome;
import run.workhorse.BatchOptions;
import run.workhorse.BatchSucceeded;
import run.workhorse.ConcurrencyPolicyDefinition;
import run.workhorse.ConnectionSource;
import run.workhorse.DeadLetter;
import run.workhorse.DeadLetterPage;
import run.workhorse.DeadLetterQuery;
import run.workhorse.Debounce;
import run.workhorse.DebounceSchedule;
import run.workhorse.Dependencies;
import run.workhorse.DependencyPolicy;
import run.workhorse.EnqueueOptions;
import run.workhorse.EnqueueResult;
import run.workhorse.Idempotency;
import run.workhorse.Queue;
import run.workhorse.RateLimit;
import run.workhorse.RateLimitPolicyDefinition;
import run.workhorse.ScheduleDefinition;
import run.workhorse.ScheduledTask;
import run.workhorse.TaskPage;
import run.workhorse.TaskQuery;
import run.workhorse.TaskState;
import run.workhorse.Worker;
import run.workhorse.WorkerInfo;
import run.workhorse.WorkerProcess;
import run.workhorse.dashboard.Dashboard;
import run.workhorse.dashboard.DashboardAuthorization;

/**
 * The Java snippets of the landing page (https://workhorse.run). Each {@code docs:start
 * landing-<name>-java} region is one snippet. Each nested class holds one snippet, as each module
 * of {@code rust/examples/landing.rs} does, so that two snippets can use the same method name.
 *
 * <p>The landing page shows the pillar snippets beside their execution journals, in a pane of about
 * 72 columns. google-java-format joins every statement that fits in 100 columns, so a {@code
 * spotless:off} fence keeps those regions in its style at 72 columns.
 */
public final class Landing {
  private Landing() {}

  /** The first snippet of the page: enqueue a task and run a worker. */
  static final class HeroExample {
    private HeroExample() {}

    // docs:start landing-hero-java
    static void run(DataSource dataSource) {
      new Queue(ConnectionSource.of(dataSource))
          .enqueue("email.welcome", Map.of("to", "ada@example.com"));

      Worker worker =
          Worker.builder(dataSource)
              .concurrency(4)
              .handle(
                  "email.welcome",
                  Map.class,
                  (context, payload) -> Map.of("deliveredTo", payload.get("to")))
              .build();
      WorkerProcess.runWorkerProcess(worker);
    }
    // docs:end
  }

  /** Enqueue in the transaction of the application. */
  static final class EnqueueExample {
    private EnqueueExample() {}

    // docs:start landing-enqueue-java
    static void createOrder(DataSource dataSource, String orderId, long total) throws SQLException {
      try (Connection connection = dataSource.getConnection()) {
        connection.setAutoCommit(false);
        try (PreparedStatement insert =
            connection.prepareStatement("INSERT INTO orders (id, total) VALUES (?, ?)")) {
          insert.setString(1, orderId);
          insert.setLong(2, total);
          insert.executeUpdate();
        }

        // Same transaction: the task exists exactly when the order does.
        new Queue(ConnectionSource.of(dataSource))
            .enqueue(connection, "order.confirm", Map.of("orderId", orderId));
        connection.commit();
      }
    }
    // docs:end
  }

  /** Checkpoints. */
  static final class CheckpointsExample {
    private CheckpointsExample() {}

    // spotless:off
    // docs:start landing-checkpoints-java
    static Map<String, Object> chargeCard(@Nullable Object amount) {
      return Map.of("id", "ch_" + amount);
    }

    static Map<String, @Nullable Object> renderInvoice(
        @Nullable Object chargeId) {
      return Map.of("chargeId", chargeId);
    }

    static Worker.Builder registerInvoice(Worker.Builder worker) {
      return worker.handle(
          "invoice.issue",
          Map.class,
          (context, invoice) -> {
            // Later runs return the stored checkpoint result.
            Map<?, ?> charge =
                context.checkpoint(
                    "charge",
                    Map.class,
                    () -> chargeCard(invoice.get("amount")));

            Map<?, ?> pdf =
                context.checkpoint(
                    "render",
                    Map.class,
                    () -> renderInvoice(charge.get("id")));

            System.out.println("email " + invoice.get("email") + " " + pdf);
            return Map.of("chargeId", charge.get("id"));
          });
    }
    // docs:end
    // spotless:on
  }

  /** A durable sleep. */
  static final class SleepExample {
    private SleepExample() {}

    // docs:start landing-sleep-java
    static Map<String, @Nullable Object> placeOrder(Map<?, ?> payload) {
      return Map.of("orderId", payload.get("orderId"));
    }

    static Worker.Builder registerSettlement(Worker.Builder worker) {
      return worker.handle(
          "order.settle",
          Map.class,
          (context, payload) -> {
            Map<?, ?> order = context.checkpoint("place", Map.class, () -> placeOrder(payload));

            // Slot released here. The process can restart, deploy, or die.
            context.sleep("settlement-window", Duration.ofHours(1));

            return Map.of("settled", order.get("orderId"));
          });
    }
    // docs:end
  }

  /** Deadlines, timeouts, and retries. */
  static final class RetriesExample {
    private RetriesExample() {}

    // docs:start landing-retries-java
    static EnqueueResult remind(Queue queue, String matchId, Instant kickoff) {
      return queue.enqueue(
          "match.reminder",
          Map.of("matchId", matchId),
          EnqueueOptions.builder()
              // Pointless after kickoff, whatever else happens.
              .deadline(kickoff)
              // Any single attempt is stuck after 30 seconds.
              .executionTimeout(Duration.ofSeconds(30))
              .maxAttempts(5)
              .retryPolicy(
                  Map.of(
                      "type", "exponential",
                      "initialDelayMs", 1_000,
                      "multiplier", 2,
                      "maxDelayMs", 60_000))
              .build());
    }
    // docs:end
  }

  /** Enqueue idempotency. */
  static final class IdempotencyExample {
    private IdempotencyExample() {}

    // docs:start landing-idempotency-java
    // A retried webhook gets the same taskId back instead of a second capture.
    static EnqueueResult capture(Queue queue) {
      return queue.enqueue(
          "invoice.capture",
          Map.of("invoiceId", "inv-1"),
          EnqueueOptions.builder()
              .queue("billing")
              .idempotency(new Idempotency("capture:inv-1", "tenant-42", Duration.ofDays(1)))
              .build());
    }
    // docs:end
  }

  /** Schedules. */
  static final class SchedulesExample {
    private SchedulesExample() {}

    // spotless:off
    // docs:start landing-schedules-java
    static void run(DataSource dataSource) {
      // Run on every deployment with the complete list.
      ScheduledTask task = ScheduledTask.of("invoices.generate", Map.of());
      ScheduleDefinition schedule =
          new ScheduleDefinition("nightly-invoice-run", "0 2 * * *", task);
      Queue queue = new Queue(ConnectionSource.of(dataSource));
      queue.syncSchedules("billing", List.of(schedule), true);

      // Any worker in the namespace fires due schedules itself.
      Worker worker =
          Worker.builder(dataSource).scheduleNamespaces("billing").build();
      WorkerProcess.runWorkerProcess(worker);
    }
    // docs:end
    // spotless:on
  }

  /** Concurrency and rate limits. */
  static final class FlowControlExample {
    private FlowControlExample() {}

    // spotless:off
    // docs:start landing-flow-control-java
    static void configure(Queue queue, String messageId, String tenantId) {
      // At most 20 mail tasks active; at most 2 per tenant.
      ConcurrencyPolicyDefinition mail =
          new ConcurrencyPolicyDefinition("mail", 20, 2);
      queue.syncConcurrencyPolicies("workers", List.of(mail), false);

      RateLimit rate = new RateLimit(100, Duration.ofSeconds(1), 200);
      RateLimitPolicyDefinition provider =
          new RateLimitPolicyDefinition("provider-api", rate);
      queue.syncRateLimitPolicies("workers", List.of(provider), false);

      queue.enqueue(
          "mail.send",
          Map.of("messageId", messageId),
          EnqueueOptions.builder()
              .queue("mail")
              .concurrencyKey("tenant:" + tenantId)
              .build());
    }
    // docs:end
    // spotless:on
  }

  /** Dependencies and child tasks. */
  static final class DependenciesExample {
    private DependenciesExample() {}

    // spotless:off
    // docs:start landing-dependencies-java
    static void confirm(Queue queue, String orderId) {
      Map<String, Object> order = Map.of("orderId", orderId);
      EnqueueResult inventory = queue.enqueue("inventory.reserve", order);

      Dependencies dependencies =
          new Dependencies(
              List.of(inventory.taskId()),
              DependencyPolicy.RELEASE,
              DependencyPolicy.CANCEL,
              DependencyPolicy.CANCEL);
      EnqueueOptions options =
          EnqueueOptions.builder().dependencies(dependencies).build();
      queue.enqueue("order.confirm", order, options);
    }

    static Worker.Builder registerFulfillment(Worker.Builder worker) {
      return worker.handle(
          "order.fulfill",
          Map.class,
          (context, order) -> {
            EnqueueOptions options =
                EnqueueOptions.builder().queue("payments").build();
            Map<String, @Nullable Object> capture =
                Map.of("orderId", order.get("id"));
            Map<?, ?> receipt =
                context.runChild(
                    "charge",
                    "payment.capture",
                    capture,
                    options,
                    Map.class);
            return Map.of("receipt", receipt);
          });
    }
    // docs:end
    // spotless:on
  }

  /** Debounce. */
  static final class CoalescingExample {
    private CoalescingExample() {}

    // docs:start landing-coalescing-java
    static void reindex(Queue queue, String documentId, Duration quietPeriod) {
      Debounce debounce =
          new Debounce(documentId, quietPeriod, DebounceSchedule.RESET, "search-index");
      EnqueueOptions options = EnqueueOptions.builder().debounce(debounce).build();
      EnqueueResult first =
          queue.enqueue("search.reindex", Map.of("documentId", documentId, "revision", 1), options);
      EnqueueResult latest =
          queue.enqueue("search.reindex", Map.of("documentId", documentId, "revision", 2), options);
      System.out.println(first.outcome() + " " + latest.outcome());
    }
    // docs:end
  }

  /** Signals and human waits. */
  static final class ExternalWaitsExample {
    private ExternalWaitsExample() {}

    // spotless:off
    // docs:start landing-external-waits-java
    static Worker.Builder registerRelease(Worker.Builder worker) {
      return worker.handle(
          "release.publish",
          Map.class,
          (context, release) -> {
            Object scan =
                context.waitForSignal("security-scan", Object.class, null);

            Map<String, @Nullable Object> request =
                Map.of("releaseId", release.get("id"), "scan", scan);
            Map<?, ?> review =
                context.waitForHuman(
                    "release-approval", request, Map.class, null);

            return Map.of("published", review.get("approved"));
          });
    }

    static void deliverScan(
        Queue queue, UUID taskId, Object result, String deliveryId) {
      queue.sendSignal(
          taskId, "security-scan", result, deliveryId, "security-scanner");
    }
    // docs:end
    // spotless:on
  }

  /** Batch handlers. */
  static final class BatchHandlersExample {
    private BatchHandlersExample() {}

    // docs:start landing-batch-handlers-java
    static Worker.Builder registerEmailBatch(
        Worker.Builder worker, int batchSize, Duration linger) {
      return worker.handleBatch(
          "email.send",
          Object.class,
          new BatchOptions(batchSize, linger),
          items ->
              items.stream()
                  .<BatchHandlerOutcome>map(item -> new BatchSucceeded(item.payload()))
                  .toList());
    }
    // docs:end
  }

  /** Cancellation. */
  static final class CancellationExample {
    private CancellationExample() {}

    // docs:start landing-cancellation-java
    static Worker.Builder configureExport(Queue queue, Worker.Builder worker, UUID taskId) {
      worker.handle(
          "rows.export",
          List.class,
          (context, rows) -> {
            for (Object row : rows) {
              context.cancellation().throwIfCancelled();
              System.out.println("upload " + row);
            }
            return Map.of("stopped", false);
          });

      queue.cancel(taskId, "operator@example.com", "customer withdrew the request");
      return worker;
    }
    // docs:end
  }

  /** Dead letters. */
  static final class DeadLettersExample {
    private DeadLettersExample() {}

    // docs:start landing-dead-letters-java
    static void redriveBilling(Admin admin) {
      DeadLetterQuery query =
          DeadLetterQuery.builder().queue("billing").errorName("CardDeclined").limit(100).build();
      DeadLetterPage page = admin.listDeadLetters(query);

      for (DeadLetter failure : page.items()) {
        AdminAudit audit =
            new AdminAudit(
                "operator@example.com",
                "provider incident resolved",
                "incident-2026-08-03:" + failure.taskId());
        admin.redrive(failure.taskId(), audit);
      }
    }
    // docs:end
  }

  /** The dashboard. */
  static final class OperateDashboardExample {
    private OperateDashboardExample() {}

    // docs:start landing-operate-dashboard-java
    static @Nullable String adminSession(HttpServletRequest request) {
      return request.getHeader("X-Admin");
    }

    static void mount(DataSource dataSource, ServletContext servletContext) {
      Dashboard dashboard =
          Dashboard.builder(
                  ConnectionSource.of(dataSource),
                  request -> {
                    String actor = adminSession(request);
                    return actor != null
                        ? DashboardAuthorization.principal(actor)
                        : DashboardAuthorization.deny();
                  })
              .path("/workhorse")
              .build();
      servletContext
          .addFilter("workhorse-dashboard", dashboard)
          .addMappingForUrlPatterns(EnumSet.of(DispatcherType.REQUEST), false, "/workhorse/*");
    }
    // docs:end
  }

  /** Queue health and the task list. */
  static final class OperateHealthExample {
    private OperateHealthExample() {}

    // docs:start landing-operate-health-java
    static void inspect(DataSource dataSource) {
      Map<String, @Nullable Object> health =
          new Queue(ConnectionSource.of(dataSource)).health().snapshot();
      if (health.get("status") instanceof Map<?, ?> status
          && !"healthy".equals(status.get("level"))) {
        System.out.println(status.get("reasons"));
      }

      // Cross-state listing on a dedicated projection: reading it never slows dispatch down.
      TaskQuery query =
          TaskQuery.builder()
              .states(List.of(TaskState.ACTIVE, TaskState.SCHEDULED))
              .limit(100)
              .build();
      TaskPage live = new Admin(ConnectionSource.of(dataSource)).listTasks(query);
      System.out.println(live.items().size());
    }
    // docs:end
  }

  /** The worker fleet. */
  static final class OperateFleetExample {
    private OperateFleetExample() {}

    // docs:start landing-operate-fleet-java
    static void pauseBilling(DataSource dataSource) {
      Admin admin = new Admin(ConnectionSource.of(dataSource));
      for (WorkerInfo entry : admin.listWorkers()) {
        if (!entry.queue().equals("billing")) {
          continue;
        }
        AdminAudit audit =
            new AdminAudit(
                "operator@example.com", "rolling deploy", "deploy-2026-08-23:" + entry.workerId());
        admin.setWorkerPaused(entry.workerId(), true, audit);
      }
    }
    // docs:end
  }

  /** A worker process for deployment. */
  static final class DeployExample {
    private DeployExample() {}

    // docs:start landing-deploy-java
    static void run() {
      // The application supplies the pool. JDBC_DATABASE_URL holds a jdbc:postgresql: URL.
      HikariDataSource dataSource = new HikariDataSource();
      dataSource.setJdbcUrl(System.getenv("JDBC_DATABASE_URL"));
      dataSource.setMaximumPoolSize(10);

      Worker worker =
          Worker.builder(dataSource)
              .queues("email")
              .concurrency(8)
              // Bounded graceful drain on SIGTERM.
              .shutdownGrace(Duration.ofSeconds(25))
              .handle("email.send", Map.class, (context, email) -> Map.of("sent", email.get("to")))
              .build();
      WorkerProcess.runWorkerProcess(worker);
    }
    // docs:end
  }
}
