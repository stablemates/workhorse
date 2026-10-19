// The Kotlin tabs of the site page about enqueue idempotency.

package run.workhorse.examples

import java.time.Duration
import java.util.UUID
import run.workhorse.EnqueueOptions
import run.workhorse.EnqueueResult
import run.workhorse.Idempotency
import run.workhorse.Queue
import run.workhorse.kotlin.enqueueSuspend

/** The Kotlin snippets of the site page about enqueue idempotency. */
object IdempotencyKotlinExamples {
  /** Enqueues a task with an idempotency key, and returns its ID. */
  suspend fun enqueueOnce(queue: Queue, invoiceId: String): UUID {
    // docs:start kotlin-idempotency-enqueue
    val taskId =
      queue
        .enqueueSuspend(
          "invoice.capture",
          mapOf("invoiceId" to invoiceId),
          EnqueueOptions.builder()
            .queue("billing")
            .idempotency(Idempotency("capture:$invoiceId", "invoice-capture", Duration.ofDays(1)))
            .build(),
        )
        .taskId()
    // docs:end
    return taskId
  }

  /** Enqueues a task with an idempotency key, and returns the enqueue result. */
  suspend fun enqueueWithResult(queue: Queue, invoiceId: String, key: String): EnqueueResult {
    // docs:start kotlin-idempotency-outcome
    val result =
      queue.enqueueSuspend(
        "invoice.capture",
        mapOf("invoiceId" to invoiceId),
        EnqueueOptions.builder()
          .idempotency(Idempotency(key, "invoice-capture", Duration.ofDays(1)))
          .build(),
      )
    // docs:end
    return result
  }
}
