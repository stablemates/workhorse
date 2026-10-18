// The Kotlin tab of the site page about operations.

package run.workhorse.examples

import javax.sql.DataSource
import run.workhorse.Admin
import run.workhorse.AdminAudit
import run.workhorse.ConnectionSource
import run.workhorse.WorkerInfo
import run.workhorse.WorkerPauseResult
import run.workhorse.kotlin.listWorkersSuspend
import run.workhorse.kotlin.setWorkerPausedSuspend

/** The Kotlin snippet of the site page about operations. */
object OperationsKotlinExamples {
  /** Lists the fleet and pauses `billing-worker-1`. Returns the fleet and the pause. */
  suspend fun pauseWorker(
    dataSource: DataSource,
    actor: OperationsActor,
    incidentId: String,
  ): Pair<List<WorkerInfo>, WorkerPauseResult?> {
    // docs:start kotlin-operations-pause-worker
    val admin = Admin(ConnectionSource.of(dataSource))
    val workers = admin.listWorkersSuspend()
    val result =
      admin.setWorkerPausedSuspend(
        "billing-worker-1",
        true,
        AdminAudit(actor.email, "investigating slow provider", incidentId),
      )
    // docs:end
    return workers to result
  }
}
