package run.workhorse.examples;

import java.time.Instant;
import java.util.Map;
import org.jspecify.annotations.Nullable;
import run.workhorse.Worker;

/** The Java tabs of the site page about durable execution. */
public final class DurableExecutionExamples {
  /** The payment provider of the order handler. */
  public interface Payments {
    /** Charges the card of the order, and returns the charge. */
    Map<String, @Nullable Object> charge(String orderId, String idempotencyKey);
  }

  /** The shipment provider of the order handler. */
  public interface Logistics {
    /** Creates the shipment of the order, and returns the shipment. */
    Map<String, @Nullable Object> createShipment(String orderId, @Nullable Object charge);
  }

  /** The mail provider of the trial handler. */
  public interface TrialMailer {
    /** Sends the welcome email, and returns the result. */
    Map<String, @Nullable Object> welcome(String to);

    /** Sends the follow-up email, and returns the result. */
    Map<String, @Nullable Object> followUp(String to);
  }

  private final Payments payments;
  private final Logistics logistics;
  private final TrialMailer mailer;

  /** The handlers of the page use these providers. */
  public DurableExecutionExamples(Payments payments, Logistics logistics, TrialMailer mailer) {
    this.payments = payments;
    this.logistics = logistics;
    this.mailer = mailer;
  }

  /** Registers the {@code order.fulfill} handler, which keeps its finished work in checkpoints. */
  public Worker.Builder registerCheckpoints(Worker.Builder builder) {
    return builder.handle(
        "order.fulfill",
        Map.class,
        (context, payload) -> {
          String orderId = String.valueOf(payload.get("orderId"));
          // docs:start java-durable-execution-checkpoint
          Object charge =
              context.checkpoint(
                  "charge", Object.class, () -> payments.charge(orderId, "charge:" + orderId));
          Object shipment =
              context.checkpoint(
                  "shipment", Object.class, () -> logistics.createShipment(orderId, charge));
          // docs:end
          return shipment;
        });
  }

  /** Registers the {@code trial.follow-up} handler, which waits for a time between two emails. */
  public Worker.Builder registerFollowUp(Worker.Builder builder) {
    return builder.handle(
        "trial.follow-up",
        Map.class,
        (context, payload) -> {
          String to = String.valueOf(payload.get("to"));
          Instant followUpAt = Instant.parse(String.valueOf(payload.get("followUpAt")));
          // docs:start java-durable-execution-sleep-until
          context.checkpoint("welcome", Object.class, () -> mailer.welcome(to));
          context.sleepUntil("follow-up-window", followUpAt);
          context.checkpoint("follow-up", Object.class, () -> mailer.followUp(to));
          // docs:end
          return null;
        });
  }

  /** Registers the {@code order.review} handler, which waits for a signal and for a person. */
  public Worker.Builder registerExternalWaits(Worker.Builder builder) {
    return builder.handle(
        "order.review",
        Map.class,
        (context, payload) -> {
          // docs:start java-durable-execution-external-waits
          Map<?, ?> event = context.waitForSignal("provider-event", Map.class, null);
          Object review =
              context.waitForHuman(
                  "operator-review", Map.of("eventId", event.get("id")), Object.class, null);
          // docs:end
          return Map.of("event", event, "review", review);
        });
  }
}
