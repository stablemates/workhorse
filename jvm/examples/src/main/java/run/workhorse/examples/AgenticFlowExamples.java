package run.workhorse.examples;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.function.UnaryOperator;
import org.jspecify.annotations.Nullable;
import run.workhorse.ChildRequest;
import run.workhorse.EnqueueOptions;
import run.workhorse.Worker;

/** The Java tabs of the site page about the durable agentic flow. */
public final class AgenticFlowExamples {
  private final UnaryOperator<String> model;
  private final String toolQueue;
  private final Duration cooldown;

  /**
   * The loop plans with {@code model}, runs its tools on {@code toolQueue}, and waits for {@code
   * cooldown} before it asks for approval.
   */
  public AgenticFlowExamples(UnaryOperator<String> model, String toolQueue, Duration cooldown) {
    this.model = model;
    this.toolQueue = toolQueue;
    this.cooldown = cooldown;
  }

  /** Registers the {@code agent.loop} handler and the two tool handlers. */
  public Worker.Builder register(Worker.Builder builder) {
    EnqueueOptions toolOptions = EnqueueOptions.builder().queue(toolQueue).build();
    return builder
        .handle(
            "agent.loop",
            Map.class,
            (context, payload) -> {
              String prompt = String.valueOf(payload.get("prompt"));
              List<ChildRequest> toolRequests =
                  List.of(
                      ChildRequest.of("research", "agent.research", payload, toolOptions),
                      ChildRequest.of("calculate", "agent.calculate", payload, toolOptions));
              // docs:start java-agentic-flow-loop
              String plan = context.checkpoint("plan", String.class, () -> callModel(prompt));
              context.setProgress(Map.of("stage", "planned"));
              Map<String, @Nullable Object> tools = context.runChildrenAll(toolRequests);
              context.sleep("model-cooldown", cooldown);
              Map<?, ?> approval = context.waitForSignal("approval", Map.class, null);
              // docs:end
              return Map.of("plan", plan, "tools", tools, "approval", approval);
            })
        .handle("agent.research", Map.class, (context, payload) -> Map.of("sources", 3L))
        .handle("agent.calculate", Map.class, (context, payload) -> Map.of("total", 42L));
  }

  private String callModel(String prompt) {
    return model.apply(prompt);
  }
}
