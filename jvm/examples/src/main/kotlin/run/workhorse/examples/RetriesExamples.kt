// The Kotlin tabs of the site page about retries.

package run.workhorse.examples

import run.workhorse.EnqueueOptions
import run.workhorse.Queue
import run.workhorse.kotlin.enqueueSuspend

/** The Kotlin snippets of the site page about retries. */
object RetriesKotlinExamples {
  /** Enqueues a task with an attempt budget. */
  suspend fun attemptBudget(queue: Queue, accountId: String) {
    // docs:start kotlin-retries-attempt-budget
    queue.enqueueSuspend(
      "provider.sync",
      mapOf("accountId" to accountId),
      EnqueueOptions.builder().maxAttempts(5).build(),
    )
    // docs:end
  }

  /** Enqueues a task with a decorrelated-jitter retry policy. */
  suspend fun retryPolicy(queue: Queue, accountId: String) {
    // docs:start kotlin-retries-retry-policy
    val jitter =
      mapOf("type" to "decorrelated-jitter", "baseDelayMs" to 1_000, "maxDelayMs" to 60_000)
    queue.enqueueSuspend(
      "provider.sync",
      mapOf("accountId" to accountId),
      EnqueueOptions.builder().retryPolicy(jitter).maxAttempts(5).build(),
    )
    // docs:end
  }
}
