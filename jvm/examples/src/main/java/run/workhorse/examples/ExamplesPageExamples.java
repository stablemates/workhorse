package run.workhorse.examples;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
import org.jspecify.annotations.Nullable;
import run.workhorse.Admin;
import run.workhorse.AdminAudit;
import run.workhorse.BulkRedrivePage;
import run.workhorse.ChildRequest;
import run.workhorse.DeadLetterCursor;
import run.workhorse.EnqueueOptions;
import run.workhorse.EnqueueResult;
import run.workhorse.Idempotency;
import run.workhorse.Queue;
import run.workhorse.RedriveFilter;
import run.workhorse.RedriveResult;
import run.workhorse.ScheduleDefinition;
import run.workhorse.ScheduledTask;
import run.workhorse.Worker;
import run.workhorse.WorkerProcess;

/** The Java tabs of the site page of examples. */
public final class ExamplesPageExamples {
  private final DataSource dataSource;
  private final Queue queue;
  private final Admin admin;

  /** The snippets run on this data source, this queue, and this admin client. */
  public ExamplesPageExamples(DataSource dataSource, Queue queue, Admin admin) {
    this.dataSource = dataSource;
    this.queue = queue;
    this.admin = admin;
  }

  // docs:start java-examples-page-create-order
  void createOrder(String orderId, List<String> items) throws SQLException {
    try (Connection connection = dataSource.getConnection()) {
      connection.setAutoCommit(false);
      try {
        try (PreparedStatement insert =
            connection.prepareStatement("INSERT INTO orders (id, items) VALUES (?, ?)")) {
          insert.setString(1, orderId);
          insert.setArray(2, connection.createArrayOf("text", items.toArray()));
          insert.executeUpdate();
        }
        queue.enqueue(
            connection,
            "order.fulfill",
            Map.of("orderId", orderId),
            EnqueueOptions.builder().queue("orders").build());
        connection.commit();
      } catch (SQLException | RuntimeException error) {
        connection.rollback();
        throw error;
      }
    }
  }

  // docs:end

  // docs:start java-examples-page-trial-lifecycle
  // Stand-ins for a mail provider. A real send passes the key to the provider's
  // idempotency option, and the provider drops a repeated send with the same key.
  static Map<String, Object> sendWelcome(String to, String idempotencyKey) {
    return Map.of("deliveredTo", to, "kind", "welcome", "idempotencyKey", idempotencyKey);
  }

  static Map<String, Object> sendFollowUp(String to, String idempotencyKey) {
    return Map.of("deliveredTo", to, "kind", "follow-up", "idempotencyKey", idempotencyKey);
  }

  static Worker.Builder registerTrialHandler(Worker.Builder worker) {
    return worker.handle(
        "trial.lifecycle",
        Map.class,
        (context, trial) -> {
          if (!(trial.get("to") instanceof String to)
              || !(trial.get("followUpAt") instanceof String followUpAt)) {
            throw new IllegalArgumentException("trial payload needs string to and followUpAt");
          }
          context.checkpoint(
              "welcome", Map.class, () -> sendWelcome(to, "welcome:" + context.task().id()));
          context.sleepUntil("follow-up-window", Instant.parse(followUpAt));
          context.checkpoint(
              "follow-up", Map.class, () -> sendFollowUp(to, "follow-up:" + context.task().id()));
          return Map.of("deliveredTo", to);
        });
  }

  // docs:end

  // docs:start java-examples-page-billing-worker
  void runBillingWorker() {
    // Deployment step: reconcile the namespace to exactly this set.
    ScheduledTask task =
        new ScheduledTask(
            "invoice.generate", Map.of("scope", "due"), "billing", 0, null, null, null);
    queue.syncSchedules(
        "billing-production",
        List.of(new ScheduleDefinition("nightly-invoice-run", "0 3 * * *", task)));

    // Worker process: evaluate and fire schedules for that namespace.
    Worker worker =
        Worker.builder(dataSource)
            .queues("billing")
            .scheduleNamespaces("billing-production")
            .handle(
                "invoice.generate",
                Map.class,
                (context, payload) -> Map.of("generated", true, "payload", payload))
            .build();
    WorkerProcess.runWorkerProcess(worker);
  }

  // docs:end

  // docs:start java-examples-page-stripe-webhook
  record StripeEvent(String id, String type, @Nullable Object data) {}

  Map<String, UUID> handleStripeWebhook(StripeEvent event) {
    EnqueueResult result =
        queue.enqueue(
            "stripe.event",
            Map.of("eventId", event.id(), "eventType", event.type()),
            EnqueueOptions.builder()
                .queue("webhooks")
                .idempotency(
                    new Idempotency("stripe:" + event.id(), "stripe-webhooks", Duration.ofDays(1)))
                .build());
    return Map.of("accepted", result.taskId());
  }

  // docs:end

  // docs:start java-examples-page-redrive-incident
  void redriveIncident() {
    RedriveFilter filter =
        RedriveFilter.builder().queue("billing").errorName("ProviderTimeout").limit(100).build();
    AdminAudit audit =
        new AdminAudit("reviewer@example.com", "provider incident INC-2041 resolved", "INC-2041");

    BulkRedrivePage preview = admin.redriveMany(filter.toBuilder().dryRun(true).build(), audit);
    System.out.println(preview.results().size() + " tasks eligible");

    DeadLetterCursor cursor = null;
    do {
      BulkRedrivePage page = admin.redriveMany(filter.toBuilder().cursor(cursor).build(), audit);
      for (RedriveResult result : page.results()) {
        System.out.println(
            result.status() + " " + result.sourceTaskId() + " -> " + result.targetTaskId());
      }
      cursor = page.nextCursor();
    } while (cursor != null);
  }

  // docs:end

  // docs:start java-examples-page-cancel-export
  static void uploadPart(String part) {
    System.out.println("uploading " + part);
  }

  Worker.Builder configureExport(Worker.Builder worker, UUID taskId) {
    queue.cancel(taskId, "support@example.com", "customer withdrew the order");

    return worker.handle(
        "export.build",
        Map.class,
        (context, export) -> {
          if (!(export.get("parts") instanceof List<?> parts)) {
            throw new IllegalArgumentException("export payload needs an array parts field");
          }
          for (Object part : parts) {
            context.cancellation().throwIfCancelled();
            uploadPart(String.valueOf(part));
          }
          return Map.of("exported", true);
        });
  }

  // docs:end

  // docs:start java-examples-page-agent-loop
  interface Model {
    Map<String, Object> plan(String prompt, String idempotencyKey);
  }

  static Worker.Builder registerAgent(Worker.Builder worker, Model model, Duration cooldown) {
    return worker.handle(
        "agent.run",
        Map.class,
        (context, run) -> {
          if (!(run.get("prompt") instanceof String prompt)
              || !(run.get("conversationId") instanceof String conversationId)) {
            throw new IllegalArgumentException("agent payload needs prompt and conversationId");
          }
          Map<?, ?> plan =
              context.checkpoint(
                  "plan", Map.class, () -> model.plan(prompt, "plan:" + context.task().id()));
          if (!(plan.get("tools") instanceof List<?> planTools)) {
            throw new IllegalArgumentException("model plan needs an array tools field");
          }

          List<ChildRequest> children = new ArrayList<>();
          for (Object value : planTools) {
            if (!(value instanceof Map<?, ?> tool) || !(tool.get("id") instanceof String id)) {
              throw new IllegalArgumentException("tool needs a string id field");
            }
            children.add(
                ChildRequest.of(
                    id,
                    "agent.tool",
                    tool,
                    EnqueueOptions.builder()
                        .queue("tools")
                        .concurrencyKey(conversationId)
                        .build()));
          }

          var tools = context.runChildrenAll(children);
          context.sleep("model-cooldown", cooldown);
          Map<?, ?> approval = context.waitForSignal("approval", Map.class, null);
          return Map.of(
              "plan",
              plan,
              "tools",
              tools,
              "approved",
              Boolean.TRUE.equals(approval.get("approved")));
        });
  }
  // docs:end
}
