// The Kotlin tabs of the site page about batch handlers.

package run.workhorse.examples

import java.time.Duration
import javax.sql.DataSource
import run.workhorse.BatchFailed
import run.workhorse.BatchHandlerOutcome
import run.workhorse.BatchOptions
import run.workhorse.BatchSucceeded
import run.workhorse.Queue
import run.workhorse.Worker
import run.workhorse.kotlin.enqueueSuspend
import run.workhorse.kotlin.workhorseWorker

/** The Kotlin snippets of the site page about batch handlers. */
object BatchHandlersKotlinExamples {
  /** Builds a worker with a batch handler for `email.send`, and does not run it. */
  fun batchWorker(dataSource: DataSource, emailProvider: BatchEmailProvider): Worker {
    // docs:start kotlin-batch-handlers-handle-batch
    val worker =
      workhorseWorker(dataSource) {
        queues = listOf("email")
        concurrency = 32
        handleBatch<Map<String, Any?>>("email.send", BatchOptions(20, Duration.ofMillis(50))) {
          items ->
          val deliveries = emailProvider.sendMany(items.map { item -> item.payload })
          deliveries.map<_, BatchHandlerOutcome> { delivery ->
            val error = delivery.error
            if (error != null) BatchFailed(error)
            else BatchSucceeded(mapOf("providerId" to delivery.id))
          }
        }
      }
    // docs:end
    return worker
  }

  /** Enqueues one ordinary task for the batch handler. */
  suspend fun enqueueEmail(queue: Queue) {
    // docs:start kotlin-batch-handlers-enqueue
    queue.enqueueSuspend("email.send", mapOf("to" to "person@example.com"))
    // docs:end
  }
}
