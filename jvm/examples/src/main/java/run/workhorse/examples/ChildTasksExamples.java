package run.workhorse.examples;

import java.util.List;
import java.util.Map;
import java.util.Objects;
import run.workhorse.ChildOutcome;
import run.workhorse.ChildRequest;
import run.workhorse.ChildStatus;
import run.workhorse.EnqueueOptions;
import run.workhorse.HandlerContext;

/** The Java tabs of the site page about child tasks. Each method runs inside a handler. */
public final class ChildTasksExamples {
  private ChildTasksExamples() {}

  /** Charges the order in one child task, and returns the receipt of the child. */
  public static Map<?, ?> charge(HandlerContext context, ChildTasksOrder order) {
    // docs:start java-child-tasks-run-child
    Map<?, ?> charge =
        context.runChild(
            "charge",
            "payments.charge",
            Map.of("orderId", order.id()),
            EnqueueOptions.builder().queue("payments").build(),
            Map.class);
    // docs:end
    return charge;
  }

  /** Checks the order for fraud and reserves its stock in two child tasks at the same time. */
  public static Map<String, Object> checkout(HandlerContext context, String orderId) {
    // docs:start java-child-tasks-run-children
    Map<String, ChildOutcome> results =
        context.runChildren(
            List.of(
                ChildRequest.of("fraud", "orders.check-fraud", Map.of("orderId", orderId)),
                ChildRequest.of("inventory", "orders.reserve", Map.of("orderId", orderId))));

    ChildOutcome fraud = Objects.requireNonNull(results.get("fraud"));
    if (fraud.status() == ChildStatus.FAILED) {
      return Map.of("accepted", false, "reason", fraud.error());
    }
    // docs:end
    return Map.of("accepted", true);
  }
}
