package run.workhorse.examples;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import javax.sql.DataSource;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.Admin;
import run.workhorse.ConnectionSource;
import run.workhorse.EnqueueOptions;
import run.workhorse.Queue;
import run.workhorse.SignalStatus;
import run.workhorse.TaskCheckpoint;
import run.workhorse.TaskDetail;
import run.workhorse.TaskState;
import run.workhorse.Worker;
import run.workhorse.testing.ScratchDatabase;

/** Runs the Java snippets of the site page of examples. */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class ExamplesPageExamplesTest {
  private final DataSource dataSource = ExampleDatabase.dataSource();
  private final Queue queue = new Queue(ConnectionSource.of(dataSource));
  private final Admin admin = new Admin(ConnectionSource.of(dataSource));
  private final ExamplesPageExamples examples = new ExamplesPageExamples(dataSource, queue, admin);

  @BeforeAll
  static void ordersTable() throws SQLException {
    ExamplesPageDatabase.createOrdersTable();
  }

  @Test
  void theOrderAndItsTaskCommitTogether() throws SQLException {
    String orderId = "java-" + UUID.randomUUID();
    examples.createOrder(orderId, List.of("book", "lamp"));
    assertEquals(List.of("book", "lamp"), ExamplesPageDatabase.orderItems(orderId));
    TaskDetail task = ExampleDatabase.task("order.fulfill", "orderId", orderId);
    assertEquals("orders", task.queue());
  }

  @Test
  void theOrderAndItsTaskRollBackTogether() throws SQLException {
    String orderId = "java-" + UUID.randomUUID();
    ExamplesPageExamples failing =
        new ExamplesPageExamples(new FailingCommitDataSource(), queue, admin);
    assertThrows(SQLException.class, () -> failing.createOrder(orderId, List.of("book")));
    assertEquals(List.of(), ExamplesPageDatabase.orderItems(orderId));
    assertEquals(0, ExampleDatabase.tasks("order.fulfill", "orderId", orderId).size());
  }

  @Test
  void theTrialSendsEachEmailOnceAroundTheSleep() throws Exception {
    String queueName = "examples-page-java-trial";
    String to = UUID.randomUUID() + "@example.com";
    UUID taskId =
        queue
            .enqueue(
                "trial.lifecycle",
                Map.of("to", to, "followUpAt", Instant.now().plusSeconds(1).toString()),
                EnqueueOptions.builder().queue(queueName).build())
            .taskId();
    try (Worker worker =
        ExamplesPageExamples.registerTrialHandler(ExamplesPageDatabase.worker(queueName)).build()) {
      worker.start();
      TaskDetail task = ExampleDatabase.awaitTerminal(taskId);
      assertEquals(TaskState.SUCCEEDED, task.state(), String.valueOf(task.error()));
      assertEquals(Map.of("deliveredTo", to), task.result());
    }
    assertEquals(
        Map.of("deliveredTo", to, "kind", "welcome", "idempotencyKey", "welcome:" + taskId),
        checkpoint(taskId, "welcome").value());
    assertEquals(
        Map.of("deliveredTo", to, "kind", "follow-up", "idempotencyKey", "follow-up:" + taskId),
        checkpoint(taskId, "follow-up").value());
  }

  @Test
  void aRepeatedWebhookReturnsTheFirstTask() throws SQLException {
    String eventId = "evt_" + UUID.randomUUID();
    ExamplesPageExamples.StripeEvent event =
        new ExamplesPageExamples.StripeEvent(eventId, "invoice.paid", Map.of());
    Map<String, UUID> first = examples.handleStripeWebhook(event);
    Map<String, UUID> second = examples.handleStripeWebhook(event);
    assertEquals(first, second);
    TaskDetail task = ExampleDatabase.task("stripe.event", "eventId", eventId);
    assertEquals(first.get("accepted"), task.id());
    assertEquals("webhooks", task.queue());
    assertEquals(Map.of("eventId", eventId, "eventType", "invoice.paid"), task.payload());
  }

  @Test
  void theIncidentScriptRedrivesEachDeadLetterOnce() throws Exception {
    // The test's worker reads `billing`, and the script redrives every dead letter of `billing`,
    // so the test has its own database.
    try (IsolatedExampleDatabase database =
        IsolatedExampleDatabase.create("examples-page-java-incident")) {
      ExamplesPageExamples isolated =
          new ExamplesPageExamples(database.dataSource(), database.queue(), database.admin());
      String run = "java-" + UUID.randomUUID();
      List<UUID> sources = ExamplesPageDatabase.providerTimeouts(database, run);
      isolated.redriveIncident();
      // A second run of the script with the same request ID makes no new task.
      isolated.redriveIncident();
      for (UUID source : sources) {
        String key = run + "-" + sources.indexOf(source);
        List<UUID> tasks = database.tasks(ExamplesPageDatabase.CHARGE, "run", key);
        assertEquals(2, tasks.size(), "the dead letter and its redrive");
        assertEquals(source, tasks.get(0));
        assertEquals(TaskState.FAILED, database.detail(source).state());
        assertEquals("billing", database.detail(tasks.get(1)).queue());
      }
    }
  }

  @Test
  void theCancelEndsAWaitingTaskAndTheHandlerRunsTheNext() throws Exception {
    String queueName = "examples-page-java-export";
    EnqueueOptions options = EnqueueOptions.builder().queue(queueName).build();
    UUID canceled =
        queue.enqueue("export.build", Map.of("parts", List.of("a", "b")), options).taskId();
    Worker.Builder builder =
        examples.configureExport(ExamplesPageDatabase.worker(queueName), canceled);
    TaskDetail detail = ExampleDatabase.detail(canceled);
    assertEquals(TaskState.CANCELED, detail.state());

    UUID exported =
        queue.enqueue("export.build", Map.of("parts", List.of("a", "b")), options).taskId();
    try (Worker worker = builder.build()) {
      worker.start();
      TaskDetail task = ExampleDatabase.awaitTerminal(exported);
      assertEquals(TaskState.SUCCEEDED, task.state(), String.valueOf(task.error()));
      assertEquals(Map.of("exported", true), task.result());
    }
  }

  @Test
  void theAgentLoopPlansOnceRunsTheToolsAndWaitsForTheApproval() throws Exception {
    // The worker reads `tools`, which the Kotlin test also uses, so the test has its own database.
    try (IsolatedExampleDatabase database =
        IsolatedExampleDatabase.create("examples-page-java-agent")) {
      Queue isolated = database.queue();
      String queueName = "examples-page-java-agent";
      AtomicInteger plans = new AtomicInteger();
      Map<String, Object> plan = ExamplesPageDatabase.plan();
      ExamplesPageExamples.Model model =
          (prompt, idempotencyKey) -> {
            plans.incrementAndGet();
            return plan;
          };
      UUID taskId =
          isolated
              .enqueue(
                  "agent.run",
                  Map.of("prompt", "find the invoice", "conversationId", "conversation-java"),
                  EnqueueOptions.builder().queue(queueName).build())
              .taskId();
      try (Worker worker =
          ExamplesPageExamples.registerAgent(
                  ExamplesPageDatabase.worker(database.dataSource(), queueName, "tools")
                      .handle(
                          "agent.tool",
                          Map.class,
                          (context, tool) -> Map.of("ran", String.valueOf(tool.get("id")))),
                  model,
                  Duration.ofMillis(10))
              .build()) {
        worker.start();
        awaitSignal(isolated, taskId);
        TaskDetail task = database.awaitTerminal(taskId);
        assertEquals(TaskState.SUCCEEDED, task.state(), String.valueOf(task.error()));
        assertEquals(
            Map.of(
                "plan",
                plan,
                "tools",
                Map.of("search", Map.of("ran", "search"), "summarize", Map.of("ran", "summarize")),
                "approved",
                true),
            task.result());
      }
      assertEquals(1, plans.get());
      for (UUID child : database.detail(taskId).childTaskIds()) {
        TaskDetail detail = database.detail(child);
        assertEquals("tools", detail.queue());
        assertEquals("conversation-java", detail.concurrencyKey());
      }
    }
  }

  private static void awaitSignal(Queue queue, UUID taskId) throws InterruptedException {
    long deadline = System.nanoTime() + ExampleDatabase.WAIT.toNanos();
    while (queue
            .sendSignal(
                taskId,
                "approval",
                Map.of("approved", true),
                "approval:" + taskId,
                "reviewer@example.com")
            .status()
        != SignalStatus.DELIVERED) {
      assertTrue(System.nanoTime() < deadline, "the task waits for the approval");
      Thread.sleep(50);
    }
  }

  private TaskCheckpoint checkpoint(UUID taskId, String name) {
    return admin.getCheckpoint(taskId, name).orElseThrow();
  }

  /** Reads and prepares the rows of the snippet tests of the page. */
  static final class ExamplesPageDatabase {
    /** The task type of the dead letters of the incident test. */
    static final String CHARGE = "invoice.charge";

    private ExamplesPageDatabase() {}

    static void createOrdersTable() throws SQLException {
      try (Connection connection = ScratchDatabase.connect();
          Statement statement = connection.createStatement()) {
        statement.execute("CREATE TABLE IF NOT EXISTS orders (id text PRIMARY KEY, items text[])");
      }
    }

    static List<String> orderItems(String orderId) throws SQLException {
      try (Connection connection = ScratchDatabase.connect();
          PreparedStatement statement =
              connection.prepareStatement("SELECT items FROM orders WHERE id = ?")) {
        statement.setString(1, orderId);
        try (ResultSet result = statement.executeQuery()) {
          if (!result.next()) {
            return List.of();
          }
          return List.of((String[]) result.getArray(1).getArray());
        }
      }
    }

    /** A worker builder on {@code queues} that polls often, so a short wait ends soon. */
    static Worker.Builder worker(String... queues) {
      return worker(ExampleDatabase.dataSource(), queues);
    }

    /** A worker builder on {@code queues} of {@code dataSource} that polls often. */
    static Worker.Builder worker(DataSource dataSource, String... queues) {
      return Worker.builder(dataSource)
          .queues(queues)
          .concurrency(4)
          .pollInterval(Duration.ofMillis(100));
    }

    /**
     * Makes two dead letters on {@code billing} of {@code database} that failed with {@code
     * ProviderTimeout}. Their payloads hold {@code run} with {@code <run>-0} and {@code <run>-1}.
     */
    static List<UUID> providerTimeouts(IsolatedExampleDatabase database, String run)
        throws InterruptedException {
      Queue queue = database.queue();
      String queueName = "billing";
      EnqueueOptions options = EnqueueOptions.builder().queue(queueName).maxAttempts(1).build();
      List<UUID> sources =
          List.of(
              queue.enqueue(CHARGE, Map.of("run", run + "-0"), options).taskId(),
              queue.enqueue(CHARGE, Map.of("run", run + "-1"), options).taskId());
      try (Worker worker =
          worker(database.dataSource(), queueName)
              .handle(
                  CHARGE,
                  Map.class,
                  (context, payload) -> {
                    throw new ProviderTimeout();
                  })
              .build()) {
        worker.start();
        for (UUID source : sources) {
          assertEquals(TaskState.FAILED, database.awaitTerminal(source).state());
        }
      }
      return sources;
    }

    static Map<String, Object> plan() {
      return Map.of(
          "tools",
          List.of(Map.of("id", "search", "query", "invoice INV-7"), Map.of("id", "summarize")));
    }
  }

  /** The failure of the provider in the incident. */
  static final class ProviderTimeout extends RuntimeException {
    private static final long serialVersionUID = 1L;

    ProviderTimeout() {
      super("the provider timed out");
    }
  }
}
