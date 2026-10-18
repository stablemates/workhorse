// The Kotlin tab of the site page about priority.

package run.workhorse.examples

import run.workhorse.EnqueueOptions
import run.workhorse.Queue
import run.workhorse.kotlin.enqueueSuspend

/** The Kotlin snippet of the site page about priority. */
object PriorityKotlinExamples {
  /** Enqueues an urgent invoice reminder. */
  suspend fun enqueueUrgent(queue: Queue, invoiceId: String) {
    // docs:start kotlin-priority-enqueue
    queue.enqueueSuspend(
      "invoice.remind",
      mapOf("invoiceId" to invoiceId),
      EnqueueOptions.builder().queue("billing").priority(10).build(),
    )
    // docs:end
  }
}
