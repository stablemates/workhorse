// The Kotlin tabs of the site page about deadlines and execution timeouts.

package run.workhorse.examples

import java.time.Duration
import java.time.Instant
import run.workhorse.EnqueueOptions
import run.workhorse.Queue
import run.workhorse.kotlin.enqueueSuspend

/** The Kotlin snippets of the site page about deadlines and execution timeouts. */
object DeadlinesKotlinExamples {
  /** Enqueues a task with a deadline. */
  suspend fun deadline(queue: Queue, quoteId: String, quoteExpiresAt: Instant) {
    // docs:start kotlin-deadlines-deadline
    queue.enqueueSuspend(
      "price.quote",
      mapOf("quoteId" to quoteId),
      EnqueueOptions.builder().deadline(quoteExpiresAt).build(),
    )
    // docs:end
  }

  /** Enqueues a task with an execution timeout and an attempt budget. */
  suspend fun executionTimeout(
    queue: Queue,
    reportId: String,
    attemptTimeout: Duration,
    attemptBudget: Int,
  ) {
    // docs:start kotlin-deadlines-execution-timeout
    queue.enqueueSuspend(
      "report.build",
      mapOf("reportId" to reportId),
      EnqueueOptions.builder().executionTimeout(attemptTimeout).maxAttempts(attemptBudget).build(),
    )
    // docs:end
  }
}
