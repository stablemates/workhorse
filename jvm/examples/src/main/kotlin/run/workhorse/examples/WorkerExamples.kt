// The Kotlin tabs of the site page about workers.

package run.workhorse.examples

import java.time.Duration
import javax.sql.DataSource
import run.workhorse.Worker
import run.workhorse.WorkerProcess
import run.workhorse.kotlin.workhorseWorker

/** Runs the worker until the process ends. */
fun registerAndRun(dataSource: DataSource, mailer: Mailer, workerConcurrency: Int) {
  // docs:start kotlin-register-handler
  val worker =
    workhorseWorker(dataSource) {
      queues = listOf("email", "billing")
      concurrency = workerConcurrency
      handle<Map<String, Any?>>("email.send") { _, payload -> mailer.send(payload) }
    }
  worker.run()
  // docs:end
}

/** Builds a worker with the options of the page, and does not run it. */
fun workerWithOptions(
  dataSource: DataSource,
  workerConcurrency: Int,
  workerLease: Duration,
): Worker {
  // docs:start kotlin-worker-options
  val worker =
    workhorseWorker(dataSource) {
      queues = listOf("email", "billing")
      concurrency = workerConcurrency
      lease = workerLease
      workerId = "email-worker-1"
    }
  // docs:end
  return worker
}

/** Runs the worker as the whole process. The process ends when the run ends. */
fun runWorkerProcess(dataSource: DataSource, mailer: Mailer, workerConcurrency: Int) {
  // docs:start kotlin-worker-process
  val worker =
    workhorseWorker(dataSource) {
      queues = listOf("email", "billing")
      concurrency = workerConcurrency
      handle<Map<String, Any?>>("email.send") { _, payload -> mailer.send(payload) }
    }
  WorkerProcess.runWorkerProcess(worker)
  // docs:end
}
