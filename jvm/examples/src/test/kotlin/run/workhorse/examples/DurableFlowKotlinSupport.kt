package run.workhorse.examples

import java.time.Duration
import javax.sql.DataSource
import run.workhorse.RetryDelay
import run.workhorse.Worker
import run.workhorse.kotlin.WorkerScope
import run.workhorse.kotlin.workhorseWorker

/** A Kotlin worker on the private queue of [driver], with the options of its Java builder. */
fun durableFlowWorker(
  dataSource: DataSource,
  driver: DurableFlowDriver,
  register: WorkerScope.() -> Unit,
): Worker =
  workhorseWorker(dataSource) {
    queues = listOf(driver.queueName())
    pollingOnly = true
    pollInterval = Duration.ofMillis(10)
    disableRegistry = true
    retryDelay = RetryDelay { _, _ -> Duration.ofMillis(10) }
    register()
  }
