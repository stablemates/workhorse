package run.workhorse.examples;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.Admin;
import run.workhorse.ConcurrencyPolicy;
import run.workhorse.DeadLetter;
import run.workhorse.DeadLetterQuery;
import run.workhorse.EnqueueOptions;
import run.workhorse.EnqueueOutcome;
import run.workhorse.EnqueueResult;
import run.workhorse.HumanWaitQuery;
import run.workhorse.Queue;
import run.workhorse.RateLimit;
import run.workhorse.RateLimitPolicy;
import run.workhorse.SignalWaitQuery;
import run.workhorse.TaskDetail;
import run.workhorse.TaskState;
import run.workhorse.Worker;
import run.workhorse.WorkerInfo;
import run.workhorse.testing.ScratchDatabase;

/**
 * Runs each Java snippet of the landing page that does not run until the process ends. {@link
 * LandingProcessExamplesTest} runs the others.
 */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 180, unit = TimeUnit.SECONDS)
class LandingExamplesTest {
  private static @Nullable LandingDatabase database;

  @BeforeAll
  static void createDatabase() throws Exception {
    database = LandingDatabase.create("landing-java");
  }

  @AfterAll
  static void dropDatabase() throws Exception {
    if (database != null) {
      database.close();
    }
  }

  private static LandingDatabase db() {
    LandingDatabase current = database;
    if (current == null) {
      throw new IllegalStateException("the database is not created");
    }
    return current;
  }

  /** The error of the declined card in the dead letter snippet. */
  static final class CardDeclined extends Exception {
    private static final long serialVersionUID = 1L;

    CardDeclined() {
      super("card declined");
    }
  }

  @Test
  void theOrderAndItsTaskCommitTogether() throws Exception {
    String orderId = "java-" + UUID.randomUUID();
    Landing.EnqueueExample.createOrder(db().dataSource(), orderId, 4200);
    assertEquals(1, db().orders(orderId));
    assertEquals(1, db().tasks("order.confirm", "orderId", orderId).size());
  }

  @Test
  void theInvoiceHandlerStoresBothCheckpoints() throws Exception {
    UUID taskId =
        db().queue()
            .enqueue("invoice.issue", Map.of("amount", 4200, "email", "ada@example.com"))
            .taskId();
    try (Worker worker = Landing.CheckpointsExample.registerInvoice(db().worker()).build()) {
      db().runUntil(worker, taskId, TaskState.SUCCEEDED);
    }
    assertEquals(Map.of("chargeId", "ch_4200"), db().detail(taskId).result());
    assertEquals(2, db().admin().listCheckpoints(taskId).size());
  }

  @Test
  void theSettlementSleepsAfterItsCheckpoint() throws Exception {
    String orderId = "java-" + UUID.randomUUID();
    UUID taskId = db().queue().enqueue("order.settle", Map.of("orderId", orderId)).taskId();
    try (Worker worker = Landing.SleepExample.registerSettlement(db().worker()).build()) {
      db().runUntil(worker, taskId, TaskState.SCHEDULED);
    }
    assertEquals(
        Map.of("orderId", orderId),
        db().admin().getCheckpoint(taskId, "place").orElseThrow().value());
    assertEquals(
        Duration.ofHours(1),
        db().admin().getWait(taskId, "settlement-window").orElseThrow().duration());
  }

  @Test
  void theReminderCarriesItsDeadlineTimeoutAndRetryPolicy() {
    Instant kickoff = Instant.now().plus(2, ChronoUnit.DAYS).truncatedTo(ChronoUnit.SECONDS);
    EnqueueResult result = Landing.RetriesExample.remind(db().queue(), "match-1", kickoff);
    TaskDetail task = db().detail(result.taskId());
    assertEquals(kickoff, task.deadlineAt());
    assertEquals(Duration.ofSeconds(30), task.executionTimeout());
    assertEquals(5, task.maxAttempts());
    Map<String, @Nullable Object> policy = task.retryPolicy();
    assertEquals("exponential", policy == null ? null : policy.get("type"));
    assertEquals(60_000L, policy == null ? null : policy.get("maxDelayMs"));
  }

  @Test
  void aSecondCaptureReplaysTheFirstTask() {
    EnqueueResult first = Landing.IdempotencyExample.capture(db().queue());
    EnqueueResult second = Landing.IdempotencyExample.capture(db().queue());
    assertEquals(first.taskId(), second.taskId());
    assertEquals(EnqueueOutcome.REPLAYED, second.outcome());
    assertEquals("billing", db().detail(first.taskId()).queue());
  }

  @Test
  void thePoliciesAndTheMailTaskReachTheDatabase() throws Exception {
    String messageId = "java-" + UUID.randomUUID();
    Queue queue = db().queue();
    Landing.FlowControlExample.configure(queue, messageId, "acme");

    ConcurrencyPolicy mail = queue.listConcurrencyPolicies(List.of("mail")).get(0);
    assertEquals("workers", mail.namespace());
    assertEquals(20, mail.maxActive());
    assertEquals(2, mail.maxActivePerKey());
    RateLimitPolicy provider = queue.listRateLimitPolicies(List.of("provider-api")).get(0);
    assertEquals(new RateLimit(100, Duration.ofSeconds(1), 200), provider.rate());

    TaskDetail task = db().detail(db().tasks("mail.send", "messageId", messageId).getFirst());
    assertEquals("mail", task.queue());
    assertEquals("tenant:acme", task.concurrencyKey());
  }

  @Test
  void theConfirmationWaitsForTheReservation() throws Exception {
    String orderId = "java-" + UUID.randomUUID();
    Landing.DependenciesExample.confirm(db().queue(), orderId);
    UUID inventory = db().tasks("inventory.reserve", "orderId", orderId).getFirst();
    TaskDetail confirm = db().detail(db().tasks("order.confirm", "orderId", orderId).getFirst());
    assertEquals(List.of(inventory), confirm.prerequisiteTaskIds());
    assertEquals(TaskState.BLOCKED, confirm.state());
  }

  @Test
  void theFulfillmentReturnsTheReceiptOfItsChild() throws Exception {
    String orderId = "java-" + UUID.randomUUID();
    UUID taskId = db().queue().enqueue("order.fulfill", Map.of("id", orderId)).taskId();
    Worker.Builder builder =
        db().worker("default", "payments")
            .handle(
                "payment.capture",
                Map.class,
                (context, capture) -> Map.of("captured", capture.get("orderId")));
    try (Worker worker = Landing.DependenciesExample.registerFulfillment(builder).build()) {
      db().runUntil(worker, taskId, TaskState.SUCCEEDED);
    }
    assertEquals(Map.of("receipt", Map.of("captured", orderId)), db().detail(taskId).result());
  }

  @Test
  void theSecondReindexReplacesTheFirst() throws Exception {
    String documentId = "java-" + UUID.randomUUID();
    List<String> lines =
        LandingDatabase.standardOutput(
            () ->
                Landing.CoalescingExample.reindex(db().queue(), documentId, Duration.ofMinutes(5)));
    assertEquals(List.of("ACCEPTED REPLACED"), lines);
    List<UUID> tasks = db().tasks("search.reindex", "documentId", documentId);
    assertEquals(1, tasks.size());
    assertEquals(
        Map.of("documentId", documentId, "revision", 2L), db().detail(tasks.get(0)).payload());
  }

  @Test
  void theReleasePublishesAfterTheScanAndTheApproval() throws Exception {
    Queue queue = db().queue();
    Admin admin = db().admin();
    UUID taskId = queue.enqueue("release.publish", Map.of("id", "release-java")).taskId();
    try (Worker worker = Landing.ExternalWaitsExample.registerRelease(db().worker()).build()) {
      LandingDatabase.runUntil(
          worker,
          () ->
              admin.listSignalWaits(SignalWaitQuery.defaults()).items().stream()
                  .anyMatch(wait -> wait.taskId().equals(taskId)));
      Landing.ExternalWaitsExample.deliverScan(
          queue, taskId, Map.of("clean", true), "scan-delivery-java");
      LandingDatabase.runUntil(
          worker,
          () ->
              admin.listHumanWaits(HumanWaitQuery.defaults()).items().stream()
                  .anyMatch(wait -> wait.taskId().equals(taskId)));
      assertEquals(
          Map.of("releaseId", "release-java", "scan", Map.of("clean", true)),
          admin.listHumanWaits(HumanWaitQuery.defaults()).items().stream()
              .filter(wait -> wait.taskId().equals(taskId))
              .findFirst()
              .orElseThrow()
              .context());
      queue.completeHumanWait(
          taskId, "release-approval", Map.of("approved", true), "approval-java", "dana");
      db().runUntil(worker, taskId, TaskState.SUCCEEDED);
    }
    assertEquals(Map.of("published", true), db().detail(taskId).result());
  }

  @Test
  void theBatchHandlerReturnsEachPayload() throws Exception {
    Queue queue = db().queue();
    UUID first = queue.enqueue("email.send", Map.of("to", "ada@example.com")).taskId();
    UUID second = queue.enqueue("email.send", Map.of("to", "grace@example.com")).taskId();
    try (Worker worker =
        Landing.BatchHandlersExample.registerEmailBatch(
                db().worker().concurrency(10), 10, Duration.ofMillis(100))
            .build()) {
      LandingDatabase.runUntil(
          worker,
          () ->
              db().detail(first).state() == TaskState.SUCCEEDED
                  && db().detail(second).state() == TaskState.SUCCEEDED);
    }
    assertEquals(Map.of("to", "ada@example.com"), db().detail(first).result());
    assertEquals(Map.of("to", "grace@example.com"), db().detail(second).result());
  }

  @Test
  void theExportIsCanceledAndAnotherExportRuns() throws Exception {
    Queue queue = db().queue();
    UUID canceled = queue.enqueue("rows.export", List.of("row-1", "row-2")).taskId();
    Worker.Builder builder =
        Landing.CancellationExample.configureExport(queue, db().worker(), canceled);
    assertEquals(TaskState.CANCELED, db().detail(canceled).state());

    UUID exported = queue.enqueue("rows.export", List.of("row-3")).taskId();
    try (Worker worker = builder.build()) {
      db().runUntil(worker, exported, TaskState.SUCCEEDED);
    }
    assertEquals(Map.of("stopped", false), db().detail(exported).result());
  }

  @Test
  void theDeclinedChargeIsRedriven() throws Exception {
    UUID taskId =
        db().queue()
            .enqueue(
                "charge.capture",
                Map.of("chargeId", "java"),
                EnqueueOptions.builder().queue("billing").maxAttempts(1).build())
            .taskId();
    try (Worker worker =
        db().worker("billing")
            .handle(
                "charge.capture",
                Map.class,
                (context, charge) -> {
                  throw new CardDeclined();
                })
            .build()) {
      db().runUntil(worker, taskId, TaskState.FAILED);
    }
    Admin admin = db().admin();
    Landing.DeadLettersExample.redriveBilling(admin);
    DeadLetter failure =
        admin.listDeadLetters(DeadLetterQuery.builder().queue("billing").build()).items().stream()
            .filter(item -> item.taskId().equals(taskId))
            .findFirst()
            .orElseThrow();
    assertEquals(1, failure.redriveCount());
  }

  @Test
  void theDashboardAnswersAnAdminSession() throws Exception {
    try (ExampleServer server =
        new ExampleServer(
            context -> {
              // The test server sends the user as X-User. The snippet reads X-Admin.
              context
                  .addFilter(
                      "admin-header",
                      (request, response, chain) ->
                          chain.doFilter(
                              new HttpServletRequestWrapper((HttpServletRequest) request) {
                                @Override
                                public @Nullable String getHeader(String name) {
                                  return name.equalsIgnoreCase("X-Admin")
                                      ? super.getHeader("X-User")
                                      : super.getHeader(name);
                                }
                              },
                              response))
                  .addMappingForUrlPatterns(null, false, "/*");
              Landing.OperateDashboardExample.mount(db().dataSource(), context);
            })) {
      assertEquals(401, server.get("/workhorse", ""), "no session answers 401");
      assertEquals(302, server.get("/workhorse", "dana"), "an admin session reaches the dashboard");
      assertEquals(200, server.get("/other", ""), "another path reaches the application");
    }
  }

  @Test
  void theHealthCheckPrintsTheNumberOfLiveTasks() throws Exception {
    db().queue()
        .enqueue(
            "report.build",
            Map.of("reportId", "java"),
            EnqueueOptions.builder().runAt(Instant.now().plus(1, ChronoUnit.DAYS)).build());
    List<String> lines =
        LandingDatabase.standardOutput(
            () -> Landing.OperateHealthExample.inspect(db().dataSource()));
    assertTrue(Integer.parseInt(lines.getLast()) >= 1, String.join("\n", lines));
  }

  @Test
  void theBillingWorkerIsPaused() throws Exception {
    Admin admin = db().admin();
    try (Worker worker =
        Worker.builder(db().dataSource()).queues("billing").workerId("billing-java").build()) {
      worker.start();
      LandingDatabase.await(() -> isPaused(admin, "billing-java") != null);
      Landing.OperateFleetExample.pauseBilling(db().dataSource());
      LandingDatabase.await(() -> Boolean.TRUE.equals(isPaused(admin, "billing-java")));
    }
  }

  /**
   * Whether the registry shows {@code workerId} as paused, or null when it lists no such worker.
   */
  private static @Nullable Boolean isPaused(Admin admin, String workerId) {
    for (WorkerInfo entry : admin.listWorkers()) {
      if (entry.workerId().equals(workerId)) {
        return entry.paused();
      }
    }
    return null;
  }
}
