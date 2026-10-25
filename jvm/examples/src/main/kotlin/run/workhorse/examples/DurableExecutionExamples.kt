// The Kotlin tabs of the site page about durable execution.

package run.workhorse.examples

import java.time.Instant
import run.workhorse.kotlin.WorkerScope

/** The handlers of the page, with the providers of the Java tabs. */
class DurableExecutionKotlinExamples(
  private val payments: DurableExecutionExamples.Payments,
  private val logistics: DurableExecutionExamples.Logistics,
  private val mailer: DurableExecutionExamples.TrialMailer,
) {
  /** Registers the `order.fulfill` handler, which keeps its finished work in checkpoints. */
  fun registerCheckpoints(scope: WorkerScope) {
    scope.handle<Map<String, Any?>>("order.fulfill") { ctx, payload ->
      val orderId = payload.getValue("orderId") as String
      // docs:start kotlin-durable-execution-checkpoint
      val charge =
        ctx.checkpoint<Map<String, Any?>>("charge") { payments.charge(orderId, "charge:$orderId") }
      val shipment =
        ctx.checkpoint<Map<String, Any?>>("shipment") { logistics.createShipment(orderId, charge) }
      // docs:end
      shipment
    }
  }

  /**
   * Registers the `order.fulfill` handler of the "What is Workhorse?" page, which waits for the
   * warehouse between two checkpoints.
   */
  fun registerFulfillment(scope: WorkerScope) {
    scope.handle<Map<String, Any?>>("order.fulfill") { ctx, payload ->
      val orderId = payload.getValue("orderId") as String
      // docs:start kotlin-overview-fulfill
      val charge =
        ctx.checkpoint<Map<String, Any?>>("charge") { payments.charge(orderId, "charge:$orderId") }
      ctx.waitForSignal<Map<String, Any?>>("packed")
      val shipment =
        ctx.checkpoint<Map<String, Any?>>("shipment") { logistics.createShipment(orderId, charge) }
      // docs:end
      shipment
    }
  }

  /** Registers the `trial.follow-up` handler, which waits for a time between two emails. */
  fun registerFollowUp(scope: WorkerScope) {
    scope.handle<Map<String, Any?>>("trial.follow-up") { ctx, payload ->
      val to = payload.getValue("to") as String
      val followUpAt = Instant.parse(payload.getValue("followUpAt") as String)
      // docs:start kotlin-durable-execution-sleep-until
      ctx.checkpoint<Map<String, Any?>>("welcome") { mailer.welcome(to) }
      ctx.sleepUntil("follow-up-window", followUpAt)
      ctx.checkpoint<Map<String, Any?>>("follow-up") { mailer.followUp(to) }
      // docs:end
      null
    }
  }

  /** Registers the `order.review` handler, which waits for a signal and for a person. */
  fun registerExternalWaits(scope: WorkerScope) {
    // The handler reads no payload, so a `null` payload is valid.
    scope.handle<Any?>("order.review") { ctx, _ ->
      // docs:start kotlin-durable-execution-external-waits
      val event = ctx.waitForSignal<Map<String, Any?>>("provider-event")
      val review = ctx.waitForHuman<Any?>("operator-review", mapOf("eventId" to event["id"]))
      // docs:end
      mapOf("event" to event, "review" to review)
    }
  }
}
