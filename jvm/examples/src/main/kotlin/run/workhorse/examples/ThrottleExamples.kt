// The Kotlin tabs of the site page about throttle.

package run.workhorse.examples

import java.time.Duration
import run.workhorse.EnqueueOptions
import run.workhorse.EnqueueResult
import run.workhorse.Queue
import run.workhorse.Throttle
import run.workhorse.kotlin.enqueueSuspend

/** The Kotlin snippets of the site page about throttle. */
object ThrottleKotlinExamples {
  /** Enqueues a throttled task, and returns the enqueue result. */
  suspend fun throttle(queue: Queue, accountId: String, digestWindow: Duration): EnqueueResult {
    // docs:start kotlin-throttle-enqueue
    val result =
      queue.enqueueSuspend(
        "email.digest",
        mapOf("accountId" to accountId),
        EnqueueOptions.builder().throttle(Throttle(accountId, digestWindow, "digest")).build(),
      )
    // docs:end
    return result
  }
}
