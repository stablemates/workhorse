// The Kotlin tabs of the site page about signals.

package run.workhorse.examples

import run.workhorse.kotlin.WorkerScope

/** The handler of the page. It runs [publications] when the review service approves the order. */
class SignalsKotlinExamples(private val publications: () -> Unit) {
  /** Registers the `order.publish` handler, which waits for the `approval` signal. */
  fun register(scope: WorkerScope) {
    scope.handle<Map<String, Any?>>("order.publish") { ctx, _ ->
      // docs:start kotlin-signals-wait
      val approval = ctx.waitForSignal<Map<String, Any?>>("approval")
      if (approval["approved"] == true) publishOrder()
      // docs:end
      approval
    }
  }

  private fun publishOrder() = publications()
}
