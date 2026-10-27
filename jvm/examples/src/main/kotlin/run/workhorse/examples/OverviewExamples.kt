// The Kotlin tab of the site page "What is Workhorse?".

package run.workhorse.examples

import run.workhorse.ConcurrencyPolicyDefinition
import run.workhorse.EnqueueOptions
import run.workhorse.Queue
import run.workhorse.kotlin.WorkerScope
import run.workhorse.kotlin.enqueueSuspend
import run.workhorse.kotlin.syncConcurrencyPoliciesSuspend

/** The fulfillment of the page, with the services of the Java tab. */
class OverviewKotlinExamples(
  private val payments: OverviewExamples.Payments,
  private val mailer: OverviewExamples.Mailer,
) {
  /** Stores the merchant limit, enqueues one fulfillment, and registers its handler. */
  suspend fun fulfill(
    queue: Queue,
    scope: WorkerScope,
    orderId: String,
    email: String,
    merchantId: String,
  ) {
    // docs:start kotlin-overview-fulfill
    // Step 1: allow three active fulfillments per merchant, across all workers.
    // PostgreSQL applies this limit when a worker claims a task.
    queue.syncConcurrencyPoliciesSuspend(
      "shop",
      listOf(ConcurrencyPolicyDefinition("fulfillment", 20, 3)),
    )

    // Enqueue the task. The merchant is the concurrency key.
    queue.enqueueSuspend(
      "order.fulfill",
      mapOf("orderId" to orderId, "email" to email),
      EnqueueOptions.builder().queue("fulfillment").concurrencyKey(merchantId).build(),
    )

    scope.handle<Map<String, Any?>>("order.fulfill") { ctx, order ->
      val id = order.getValue("orderId") as String

      // Step 2: charge the card. The checkpoint stores the charge.
      // On a later run, it returns the stored charge, and the handler
      // does not charge the card a second time.
      val charge = ctx.checkpoint<Map<String, Any?>>("charge") { payments.charge(id, "charge:$id") }

      // Step 3: wait until the carrier ships the parcel. The task releases
      // its worker, and it does not count against the merchant limit.
      val shipped = ctx.waitForSignal<Map<String, Any?>>("order-shipped")
      val tracking = shipped.getValue("trackingNumber") as String

      // Step 4: the signal arrived. The handler ran again from its first line,
      // and the "charge" checkpoint gave back the stored charge.

      // Step 5: send the receipt with the tracking number.
      val address = order.getValue("email") as String
      ctx.checkpoint<Map<String, Any?>>("receipt") { mailer.receipt(address, charge, tracking) }
      mapOf("charge" to charge, "trackingNumber" to tracking)
    }
    // docs:end
  }
}
