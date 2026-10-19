package run.workhorse.examples;

import java.util.Map;
import run.workhorse.Worker;

/** The Java tabs of the site page about signals. */
public final class SignalsExamples {
  private final Runnable publications;

  /** The handler runs {@code publications} when the review service approves the order. */
  public SignalsExamples(Runnable publications) {
    this.publications = publications;
  }

  /** Registers the {@code order.publish} handler, which waits for the {@code approval} signal. */
  public Worker.Builder register(Worker.Builder builder) {
    return builder.handle(
        "order.publish",
        Map.class,
        (context, payload) -> {
          // docs:start java-signals-wait
          Map<?, ?> approval = context.waitForSignal("approval", Map.class, null);
          if (Boolean.TRUE.equals(approval.get("approved"))) {
            publishOrder();
          }
          // docs:end
          return approval;
        });
  }

  private void publishOrder() {
    publications.run();
  }
}
