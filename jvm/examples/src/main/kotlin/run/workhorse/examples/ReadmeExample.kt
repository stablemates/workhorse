// The Kotlin snippet of `jvm/README.md`, an excerpt of `jvm/release-consumer/kotlin`. The build does
// not format this file, so the region keeps the layout of the release consumer.

package run.workhorse.examples

import java.util.UUID
import kotlinx.coroutines.runBlocking
import org.postgresql.ds.PGSimpleDataSource
import run.workhorse.ConnectionSource
import run.workhorse.EnqueueOptions
import run.workhorse.Queue
import run.workhorse.kotlin.enqueueSuspend
import run.workhorse.kotlin.workhorseWorker

private const val QUEUE = "readme-kotlin"
private const val TASK_TYPE = "readme.kotlin"

/** Enqueues one task and runs it. `args[0]` is a PostgreSQL JDBC URL. */
fun runReadmeExample(args: Array<String>): UUID {
  // docs:start kotlin-readme-run-one-task
  val dataSource = PGSimpleDataSource().apply { setURL(args[0]) }
  val queue = Queue(ConnectionSource.of(dataSource))
  val taskId = runBlocking {
    queue
      .enqueueSuspend(TASK_TYPE, mapOf("packaged" to true), EnqueueOptions.builder().queue(QUEUE).build())
      .taskId()
  }

  workhorseWorker(dataSource) {
      queues = listOf(QUEUE)
      disableRegistry = true
      handle<Map<String, Any?>>(TASK_TYPE) { _, payload -> mapOf("echo" to payload) }
    }
    .use { worker -> check(worker.runOnce()) { "the worker ran no handler" } }
  // docs:end
  return taskId
}
