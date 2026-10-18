// The Kotlin tabs of the site page about task groups.

package run.workhorse.examples

import javax.sql.DataSource
import run.workhorse.EnqueueOptions
import run.workhorse.EnqueueRequest
import run.workhorse.Queue
import run.workhorse.TaskGroup
import run.workhorse.TaskGroupCallbacks
import run.workhorse.Worker
import run.workhorse.kotlin.taskGroupSuspend
import run.workhorse.kotlin.workhorseWorker

/** The Kotlin snippets of the site page about task groups. */
object TaskGroupsKotlinExamples {
  /** Creates and seals a group with one task for each row of the file. */
  suspend fun importRows(queue: Queue, file: TaskGroupsImportFile): TaskGroup {
    // docs:start kotlin-task-groups-create
    val imports = EnqueueOptions.builder().queue("imports").build()
    val rows =
      file.rows.map { row ->
        EnqueueRequest.of("imports.row", mapOf("importId" to "imp-7", "row" to row), imports)
      }
    val report = EnqueueRequest.of("imports.report", mapOf("importId" to "imp-7"), imports)

    val group =
      queue
        .taskGroupSuspend(TaskGroupCallbacks(report, null, null)) {
          rows.chunked(1_000).forEach { slice -> add(slice) }
        }
        .group
    // docs:end
    return group
  }

  /** Builds a worker that sends the report of a group, and does not run it. */
  fun reportWorker(dataSource: DataSource, reporter: TaskGroupsReporter): Worker {
    // docs:start kotlin-task-groups-read-counts
    val worker =
      workhorseWorker(dataSource) {
        queues = listOf("imports")
        handle<Map<String, Any?>>("imports.report") { context, report ->
          val counts = checkNotNull(context.taskGroup.get()) { "no task group" }.group.counts
          reporter.send(report["importId"], counts.succeeded, counts.failed)
          mapOf("sent" to true)
        }
      }
    // docs:end
    return worker
  }
}
