package run.workhorse.examples;

import java.util.Map;
import java.util.function.Consumer;
import run.workhorse.Worker;

/** The Java tabs of the site page about human waits. */
public final class HumanWaitsExamples {
  private final Consumer<String> activations;

  /** The handler gives each account that a person approves to {@code activations}. */
  public HumanWaitsExamples(Consumer<String> activations) {
    this.activations = activations;
  }

  /** Registers the {@code account.activate} handler, which waits for a human decision. */
  public Worker.Builder register(Worker.Builder builder) {
    return builder.handle(
        "account.activate",
        Map.class,
        (context, payload) -> {
          String accountId = String.valueOf(payload.get("accountId"));
          // docs:start java-human-waits-wait
          Map<?, ?> review =
              context.waitForHuman(
                  "account-review",
                  Map.of("accountId", accountId, "prompt", "Approve this account?"),
                  Map.class,
                  null);

          if (Boolean.TRUE.equals(review.get("approved"))) {
            activateAccount(accountId);
          }
          // docs:end
          return review;
        });
  }

  private void activateAccount(String accountId) {
    activations.accept(accountId);
  }
}
