package run.workhorse.examples

import javax.sql.DataSource
import run.workhorse.CatchupPolicy
import run.workhorse.Queue
import run.workhorse.ScheduleDefinition
import run.workhorse.ScheduledTask
import run.workhorse.Worker
import run.workhorse.kotlin.syncSchedulesSuspend
import run.workhorse.kotlin.workhorseWorker

/** The Kotlin tabs of the site page about schedules. */
class SchedulesKotlinExamples(private val queue: Queue, private val dataSource: DataSource) {
  /** Declares the schedules of the namespace. */
  suspend fun syncSchedules(nightlyCron: String) {
    // docs:start kotlin-schedules-sync
    val task =
      ScheduledTask("invoice.generate", mapOf("scope" to "due"), "billing", 0, null, null, null)
    queue.syncSchedulesSuspend(
      "billing-production",
      listOf(
        ScheduleDefinition(
          "invoice-run",
          nightlyCron,
          task,
          "America/New_York",
          CatchupPolicy.SKIP,
          true,
        ),
      ),
    )
    // docs:end
  }

  /** Builds a worker that offers the namespace, and does not run it. */
  fun scheduleWorker(): Worker {
    // docs:start kotlin-schedules-namespaces
    val worker = workhorseWorker(dataSource) { scheduleNamespaces = listOf("billing-production") }
    // docs:end
    return worker
  }
}
