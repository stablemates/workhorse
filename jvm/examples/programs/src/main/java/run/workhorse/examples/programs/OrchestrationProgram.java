package run.workhorse.examples.programs;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;
import run.workhorse.ChildRequest;
import run.workhorse.HandlerContext;
import run.workhorse.Worker;
import run.workhorse.WorkerProcess;

/**
 * Runs an order handler that starts two child tasks, then waits for a signal and a human decision.
 * The signal and the decision can be any JSON value.
 *
 * <p>Documentation: https://workhorse.run/docs/examples
 */
public final class OrchestrationProgram {
  private OrchestrationProgram() {}

  public static void main(String[] arguments) {
    Worker worker =
        Worker.builder(Programs.dataSource("WORKHORSE_DATABASE_URL"))
            .queues("orders")
            .handle(
                "order.process",
                Map.class,
                (context, payload) -> {
                  Map<String, @Nullable Object> children =
                      context.runChildrenAll(
                          List.of(
                              ChildRequest.of("invoice", "invoice.create", payload),
                              ChildRequest.of("receipt", "receipt.send", payload)));
                  Object approval = context.waitForSignal("approval", Object.class, null);
                  Map<String, @Nullable Object> review = new HashMap<>();
                  review.put("payload", payload);
                  review.put("approval", approval);
                  Object decision = context.waitForHuman("review", review, Object.class, null);
                  Map<String, @Nullable Object> result = new HashMap<>();
                  result.put("children", children);
                  result.put("approval", approval);
                  result.put("decision", decision);
                  return result;
                })
            .handle("invoice.create", Map.class, OrchestrationProgram::completeChild)
            .handle("receipt.send", Map.class, OrchestrationProgram::completeChild)
            .build();
    WorkerProcess.runWorkerProcess(worker);
  }

  private static Map<String, @Nullable Object> completeChild(
      HandlerContext context, @Nullable Map<?, ?> payload) {
    Map<String, @Nullable Object> result = new HashMap<>();
    result.put("completed", true);
    result.put("payload", payload);
    return result;
  }
}
