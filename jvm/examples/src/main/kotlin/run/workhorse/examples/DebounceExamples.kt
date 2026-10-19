// The Kotlin tabs of the site page about debounce.

package run.workhorse.examples

import java.time.Duration
import run.workhorse.Debounce
import run.workhorse.DebounceSchedule
import run.workhorse.EnqueueOptions
import run.workhorse.EnqueueResult
import run.workhorse.Queue
import run.workhorse.kotlin.enqueueSuspend

/** The Kotlin snippets of the site page about debounce. */
object DebounceKotlinExamples {
  /** Enqueues a debounced task, and returns the enqueue result. */
  suspend fun debounce(
    queue: Queue,
    documentId: String,
    revision: Int,
    quietPeriod: Duration,
  ): EnqueueResult {
    // docs:start kotlin-debounce-enqueue
    val result =
      queue.enqueueSuspend(
        "search.reindex",
        mapOf("documentId" to documentId, "revision" to revision),
        EnqueueOptions.builder()
          .debounce(Debounce(documentId, quietPeriod, DebounceSchedule.RESET, "search-index"))
          .build(),
      )
    // docs:end
    return result
  }
}
