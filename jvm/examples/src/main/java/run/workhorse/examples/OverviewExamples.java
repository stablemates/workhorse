package run.workhorse.examples;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;
import run.workhorse.ConcurrencyPolicyDefinition;
import run.workhorse.EnqueueOptions;
import run.workhorse.Queue;
import run.workhorse.Worker;

/** The Java tab of the site page "What is Workhorse?". */
public final class OverviewExamples {
  /** The payment provider that charges the card of an order. */
  public interface Payments {
    /** Charges the card of the order, and returns the charge. */
    Map<String, @Nullable Object> charge(String orderId, String idempotencyKey);
  }

  /** The service that sends the receipt. */
  public interface Mailer {
    /** Sends the receipt for the charge and the parcel, and returns the result. */
    Map<String, @Nullable Object> receipt(
        String email, @Nullable Object charge, String trackingNumber);
  }

  private final Payments payments;
  private final Mailer mailer;

  /** The handler of the page uses these services. */
  public OverviewExamples(Payments payments, Mailer mailer) {
    this.payments = payments;
    this.mailer = mailer;
  }

  /** Stores the merchant limit, enqueues one fulfillment, and registers its handler. */
  public Worker.Builder fulfill(
      Queue queue, Worker.Builder builder, String orderId, String email, String merchantId) {
    // docs:start java-overview-fulfill
    // Step 1: allow three active fulfillments per merchant, across all workers.
    // PostgreSQL applies this limit when a worker claims a task.
    queue.syncConcurrencyPolicies(
        "shop", List.of(new ConcurrencyPolicyDefinition("fulfillment", 20, 3)));

    // Enqueue the task. The merchant is the concurrency key.
    queue.enqueue(
        "order.fulfill",
        Map.of("orderId", orderId, "email", email),
        EnqueueOptions.builder().queue("fulfillment").concurrencyKey(merchantId).build());

    builder.handle(
        "order.fulfill",
        Map.class,
        (context, order) -> {
          String id = String.valueOf(order.get("orderId"));

          // Step 2: charge the card. The checkpoint stores the charge.
          // On a later run, it returns the stored charge, and the handler
          // does not charge the card a second time.
          Object charge =
              context.checkpoint("charge", Object.class, () -> payments.charge(id, "charge:" + id));

          // Step 3: wait until the carrier ships the parcel. The task releases
          // its worker, and it does not count against the merchant limit.
          Map<?, ?> shipped = context.waitForSignal("order-shipped", Map.class, null);
          String tracking = String.valueOf(shipped.get("trackingNumber"));

          // Step 4: the signal arrived. The handler ran again from its first line,
          // and the "charge" checkpoint gave back the stored charge.

          // Step 5: send the receipt with the tracking number.
          String address = String.valueOf(order.get("email"));
          context.checkpoint(
              "receipt", Object.class, () -> mailer.receipt(address, charge, tracking));
          Map<String, @Nullable Object> result = new HashMap<>();
          result.put("charge", charge);
          result.put("trackingNumber", tracking);
          return result;
        });
    // docs:end
    return builder;
  }
}
