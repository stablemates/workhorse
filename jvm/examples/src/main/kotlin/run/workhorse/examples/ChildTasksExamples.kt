// The Kotlin tabs of the site page about child tasks.

package run.workhorse.examples

import run.workhorse.ChildRequest
import run.workhorse.ChildStatus
import run.workhorse.EnqueueOptions
import run.workhorse.kotlin.SuspendHandlerContext

/** The Kotlin snippets of the site page about child tasks. Each function runs inside a handler. */
object ChildTasksKotlinExamples {
  /** Charges the order in one child task, and returns the receipt of the child. */
  suspend fun charge(context: SuspendHandlerContext, order: ChildTasksOrder): Map<String, Any?> {
    // docs:start kotlin-child-tasks-run-child
    val charge =
      context.runChild<Map<String, Any?>>(
        "charge",
        "payments.charge",
        mapOf("orderId" to order.id),
        EnqueueOptions.builder().queue("payments").build(),
      )
    // docs:end
    return charge
  }

  /** Checks the order for fraud and reserves its stock in two child tasks at the same time. */
  suspend fun checkout(context: SuspendHandlerContext, orderId: String): Map<String, Any?> {
    // docs:start kotlin-child-tasks-run-children
    val results =
      context.runChildren(
        listOf(
          ChildRequest.of("fraud", "orders.check-fraud", mapOf("orderId" to orderId)),
          ChildRequest.of("inventory", "orders.reserve", mapOf("orderId" to orderId)),
        ),
      )

    val fraud = results.getValue("fraud")
    if (fraud.status == ChildStatus.FAILED) {
      return mapOf("accepted" to false, "reason" to fraud.error)
    }
    // docs:end
    return mapOf("accepted" to true)
  }
}
