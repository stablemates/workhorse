// Runs an order handler that starts two child tasks, then waits for a signal and a human decision.
// The signal and the decision can be any JSON value. Each durable call of the handler suspends.
//
// Documentation: https://workhorse.run/docs/examples

package run.workhorse.examples.programs

import run.workhorse.ChildRequest
import run.workhorse.WorkerProcess
import run.workhorse.kotlin.workhorseWorker

fun main() {
  val worker =
    workhorseWorker(Programs.dataSource("WORKHORSE_DATABASE_URL")) {
      queues = listOf("orders")
      handle<Map<String, Any?>>("order.process") { context, payload ->
        val children =
          context.runChildrenAll(
            listOf(
              ChildRequest.of("invoice", "invoice.create", payload),
              ChildRequest.of("receipt", "receipt.send", payload),
            ),
          )
        val approval = context.waitForSignal<Any?>("approval")
        val decision =
          context.waitForHuman<Any?>(
            "review",
            mapOf("payload" to payload, "approval" to approval),
          )
        mapOf("children" to children, "approval" to approval, "decision" to decision)
      }
      handle<Map<String, Any?>?>("invoice.create") { _, payload -> completeChild(payload) }
      handle<Map<String, Any?>?>("receipt.send") { _, payload -> completeChild(payload) }
    }
  WorkerProcess.runWorkerProcess(worker)
}

private fun completeChild(payload: Map<String, Any?>?): Map<String, Any?> =
  mapOf("completed" to true, "payload" to payload)
