package run.workhorse.examples

import java.time.Duration
import java.util.UUID
import javax.sql.DataSource
import run.workhorse.CancelResult
import run.workhorse.CancellationToken
import run.workhorse.Queue
import run.workhorse.Worker
import run.workhorse.kotlin.cancelSuspend
import run.workhorse.kotlin.workhorseWorker

/** The file store of the Kotlin cancellation snippets. */
fun interface CancellationSuspendUploader {
  /** Uploads one part of an order. A slow upload can stop when [cancellation] fires. */
  suspend fun upload(part: Any?, cancellation: CancellationToken)
}

/** The Kotlin tabs of the site page about cancellation. */
class CancellationKotlinExamples(
  private val queue: Queue,
  private val dataSource: DataSource,
  private val uploader: CancellationSuspendUploader,
) {
  /** Cancels a task that no worker holds. */
  suspend fun cancelBeforeStart(taskId: UUID, actor: CancellationActor): CancelResult {
    // docs:start kotlin-cancellation-cancel
    val result =
      queue.cancelSuspend(taskId, requestedBy = actor.email, reason = "customer withdrew the order")
    // docs:end
    return result
  }

  /** A worker on [queueName] whose `order.upload` handler obeys the cancellation. */
  fun uploadWorker(queueName: String): Worker =
    workhorseWorker(dataSource) {
      queues = listOf(queueName)
      lease = Duration.ofSeconds(3)
      handle<Map<String, Any?>>("order.upload") { ctx, payload ->
        // docs:start kotlin-cancellation-obey-signal
        for (part in payload.getValue("parts") as List<*>) {
          ctx.cancellation.throwIfCancelled()
          uploadPart(part, ctx.cancellation)
        }
        // docs:end
        null
      }
    }

  private suspend fun uploadPart(part: Any?, cancellation: CancellationToken) {
    uploader.upload(part, cancellation)
  }
}
