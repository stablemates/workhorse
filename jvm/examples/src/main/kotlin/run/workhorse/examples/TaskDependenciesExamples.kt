// The Kotlin tabs of the site page about task dependencies.

package run.workhorse.examples

import java.util.UUID
import run.workhorse.Dependencies
import run.workhorse.DependencyPolicy
import run.workhorse.EnqueueOptions
import run.workhorse.Queue
import run.workhorse.kotlin.enqueueSuspend

/** The Kotlin snippets of the site page about task dependencies. */
object TaskDependenciesKotlinExamples {
  /** Enqueues an import and a notification that waits for it, and returns the id of the import. */
  suspend fun enqueueImportAndNotify(queue: Queue): UUID {
    // docs:start kotlin-task-dependencies-enqueue
    val importId = queue.enqueueSuspend("contacts.import", mapOf("source" to "upload")).taskId
    queue.enqueueSuspend(
      "contacts.notify",
      mapOf("importId" to importId.toString()),
      EnqueueOptions.builder()
        .dependencies(
          Dependencies(
            listOf(importId),
            DependencyPolicy.RELEASE,
            DependencyPolicy.FAIL,
            DependencyPolicy.CANCEL,
          ),
        )
        .build(),
    )
    // docs:end
    return importId
  }
}
