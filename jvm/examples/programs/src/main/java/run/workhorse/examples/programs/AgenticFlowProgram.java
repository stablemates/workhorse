package run.workhorse.examples.programs;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
import org.jspecify.annotations.Nullable;
import run.workhorse.Admin;
import run.workhorse.ChildRequest;
import run.workhorse.ConnectionSource;
import run.workhorse.EnqueueOptions;
import run.workhorse.HandlerContext;
import run.workhorse.Idempotency;
import run.workhorse.JsonCodec;
import run.workhorse.Queue;
import run.workhorse.RateLimit;
import run.workhorse.RateLimitPolicyDefinition;
import run.workhorse.SignalStatus;
import run.workhorse.TaskDetail;
import run.workhorse.TaskProgress;
import run.workhorse.TaskState;
import run.workhorse.Worker;

/**
 * A durable agentic flow in an ordinary handler: a checkpointed plan, child tool tasks, a durable
 * cooldown timer, and an approval signal. It is the JVM counterpart of {@code
 * typescript/examples/agentic-flow.mjs}. The model and the tools are deterministic stubs, so the
 * program calls no model API.
 *
 * <p>Documentation: https://workhorse.run/docs/agentic-flow
 */
public final class AgenticFlowProgram {
  static final String PARENT_QUEUE = "agentic-flow";
  static final String TOOL_QUEUE = "agentic-tools";
  static final String POLICY_NAMESPACE = "agentic-flow-example";

  private static final List<String> PROGRESS_ORDER =
      List.of("planned", "tools-complete", "awaiting-approval", "finalizing");

  private AgenticFlowProgram() {}

  /** The model and the tool calls of the flow. */
  interface Effects {
    /** Calls the model for {@code phase}, {@code plan} or {@code answer}. */
    Map<String, Object> callModel(
        String phase, String prompt, @Nullable Map<String, @Nullable Object> tools, String key);

    /** Calls the tool {@code tool} with {@code input}. */
    Map<String, Object> callTool(String tool, String input, String key);
  }

  /** The stubs of {@code defaultEffects()} in the TypeScript program. */
  static Effects defaultEffects() {
    return new Effects() {
      @Override
      public Map<String, Object> callModel(
          String phase, String prompt, @Nullable Map<String, @Nullable Object> tools, String key) {
        if (phase.equals("plan")) {
          return Map.of(
              "idempotencyKey",
              key,
              "steps",
              List.of("research the request", "calculate supporting evidence"));
        }
        Map<?, ?> research = tools == null ? Map.of() : (Map<?, ?>) tools.get("research");
        Map<?, ?> calculate = tools == null ? Map.of() : (Map<?, ?>) tools.get("calculate");
        return Map.of(
            "idempotencyKey",
            key,
            "text",
            "Approved answer for "
                + prompt
                + ": "
                + (research == null ? null : research.get("summary"))
                + "; total="
                + (calculate == null ? null : calculate.get("total")));
      }

      @Override
      public Map<String, Object> callTool(String tool, String input, String key) {
        if (tool.equals("research")) {
          return Map.of("idempotencyKey", key, "summary", "durable context for " + input);
        }
        return Map.of("idempotencyKey", key, "total", input.length());
      }
    };
  }

  /** Sets the progress stage, unless the task already reached it or a later one. */
  static void reportProgress(HandlerContext context, String stage) {
    int next = PROGRESS_ORDER.indexOf(stage);
    if (next < 0) {
      throw new IllegalArgumentException("Unknown progress stage " + stage);
    }
    Object value = context.getProgress().map(TaskProgress::value).orElse(null);
    Object current = value instanceof Map<?, ?> map ? map.get("stage") : null;
    // List.of rejects a null search, so a task without progress compares as before every stage.
    int reached = current == null ? -1 : PROGRESS_ORDER.indexOf(current);
    if (reached >= next) {
      return;
    }
    context.setProgress(Map.of("stage", stage));
  }

  /** The parent worker that runs {@code agent.loop}. */
  static Worker parentWorker(DataSource dataSource, Effects effects, Duration cooldown) {
    return Worker.builder(dataSource)
        .queues(PARENT_QUEUE)
        .workerId("agentic-flow-parent")
        .pollInterval(Duration.ofMillis(1))
        .handle(
            "agent.loop",
            Map.class,
            (context, payload) -> {
              String prompt = String.valueOf(payload.get("prompt"));
              String conversationId = String.valueOf(payload.get("conversationId"));
              String taskId = context.task().id().toString();
              Map<?, ?> plan =
                  context.checkpoint(
                      "plan",
                      Map.class,
                      () -> effects.callModel("plan", prompt, null, taskId + ":plan"));
              reportProgress(context, "planned");

              EnqueueOptions toolOptions =
                  EnqueueOptions.builder().queue(TOOL_QUEUE).concurrencyKey(conversationId).build();
              Map<String, @Nullable Object> tools =
                  context.runChildrenAll(
                      List.of(
                          ChildRequest.of(
                              "research",
                              "agent.tool",
                              Map.of("tool", "research", "input", prompt),
                              toolOptions),
                          ChildRequest.of(
                              "calculate",
                              "agent.tool",
                              Map.of("tool", "calculate", "input", prompt),
                              toolOptions)));
              reportProgress(context, "tools-complete");

              context.sleep("model-cooldown", cooldown);
              reportProgress(context, "awaiting-approval");
              Map<?, ?> approval = context.waitForSignal("approval", Map.class, null);
              Map<String, @Nullable Object> result = new LinkedHashMap<>();
              if (!Boolean.TRUE.equals(approval.get("approved"))) {
                result.put("status", "rejected");
                result.put("plan", plan);
                result.put("tools", tools);
                return result;
              }

              reportProgress(context, "finalizing");
              Map<?, ?> response =
                  context.checkpoint(
                      "final-response",
                      Map.class,
                      () -> effects.callModel("answer", prompt, tools, taskId + ":final-response"));
              result.put("status", "completed");
              result.put("plan", plan);
              result.put("tools", tools);
              result.put("response", response);
              return result;
            })
        .build();
  }

  /** The tool worker that runs {@code agent.tool}. */
  static Worker toolWorker(DataSource dataSource, Effects effects) {
    return Worker.builder(dataSource)
        .queues(TOOL_QUEUE)
        .workerId("agentic-flow-tools")
        .concurrency(2)
        .pollInterval(Duration.ofMillis(1))
        .handle(
            "agent.tool",
            Map.class,
            (context, payload) -> {
              String key = context.task().id() + ":tool-call";
              Map<?, ?> result =
                  context.checkpoint(
                      "tool-call",
                      Map.class,
                      () ->
                          effects.callTool(
                              String.valueOf(payload.get("tool")),
                              String.valueOf(payload.get("input")),
                              key));
              reportProgress(context, "planned");
              return result;
            })
        .build();
  }

  /**
   * Runs one flow to its end, and returns the task id, its result, and its last progress value. The
   * loop runs a bounded number of passes.
   */
  static Map<String, @Nullable Object> run(
      DataSource dataSource,
      String conversationId,
      String prompt,
      Duration cooldown,
      Effects effects)
      throws InterruptedException {
    Queue queue = new Queue(ConnectionSource.of(dataSource));
    queue.assertCompatible();
    Admin admin = new Admin(ConnectionSource.of(dataSource));
    queue.syncRateLimitPolicies(
        POLICY_NAMESPACE,
        List.of(
            new RateLimitPolicyDefinition(
                TOOL_QUEUE,
                new RateLimit(100, Duration.ofSeconds(1), 100),
                new RateLimit(10, Duration.ofSeconds(1), 10))),
        false);

    try (Worker parent = parentWorker(dataSource, effects, cooldown);
        Worker tools = toolWorker(dataSource, effects)) {
      UUID taskId =
          queue
              .enqueue(
                  "agent.loop",
                  Map.of("conversationId", conversationId, "prompt", prompt),
                  EnqueueOptions.builder()
                      .queue(PARENT_QUEUE)
                      .idempotency(new Idempotency("agentic-flow:" + conversationId))
                      .build())
              .taskId();

      boolean approvalDelivered = false;
      for (int pass = 0; pass < 100; pass++) {
        parent.runOnce();
        tools.runOnce();

        if (!approvalDelivered) {
          SignalStatus status =
              queue
                  .sendSignal(
                      taskId,
                      "approval",
                      Map.of("approved", true),
                      "agentic-flow:" + conversationId + ":approval",
                      "agentic-flow-example")
                  .status();
          approvalDelivered = status == SignalStatus.DELIVERED || status == SignalStatus.DUPLICATE;
        }

        TaskDetail snapshot = admin.getTask(taskId).orElseThrow();
        if (snapshot.state() == TaskState.SUCCEEDED) {
          Map<String, @Nullable Object> outcome = new LinkedHashMap<>();
          outcome.put("taskId", taskId.toString());
          outcome.put("result", snapshot.result());
          TaskProgress progress = snapshot.progress();
          outcome.put("progress", progress == null ? null : progress.value());
          return outcome;
        }
        if (snapshot.state() == TaskState.FAILED || snapshot.state() == TaskState.CANCELED) {
          throw new IllegalStateException(
              "Agentic flow finished in " + snapshot.state() + " state");
        }
        Thread.sleep(20);
      }
      throw new IllegalStateException(
          "Agentic flow " + taskId + " did not finish within the bounded example loop");
    }
  }

  public static void main(String[] arguments) throws InterruptedException {
    Map<String, @Nullable Object> outcome =
        run(
            Programs.dataSource("WORKHORSE_DATABASE_URL"),
            "conversation-example",
            "Explain durable agent execution",
            Duration.ofMillis(10),
            defaultEffects());
    System.out.println(JsonCodec.standard().encode(outcome));
  }
}
