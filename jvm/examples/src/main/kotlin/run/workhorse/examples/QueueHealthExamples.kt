// The Kotlin tabs of the site page about queue health.

package run.workhorse.examples

import run.workhorse.Queue
import run.workhorse.QueueHealth
import run.workhorse.kotlin.healthSuspend

/** The Kotlin snippets of the site page about queue health. */
object QueueHealthKotlinExamples {
  /** Reads the health verdict and prints the reasons of a queue that is not healthy. */
  suspend fun checkHealth(queue: Queue): QueueHealth {
    // docs:start kotlin-queue-health-verdict
    val health = queue.healthSuspend()
    val status = health.snapshot["status"] as Map<*, *>
    if (status["level"] != "healthy") {
      System.err.println(status["reasons"])
    }
    // docs:end
    return health
  }
}
