package consumer

import dev.stablemates.workhorse.Admin
import dev.stablemates.workhorse.ConnectionSource
import dev.stablemates.workhorse.EnqueueOptions
import dev.stablemates.workhorse.Queue
import dev.stablemates.workhorse.TaskState
import dev.stablemates.workhorse.kotlin.WorkerScope
import dev.stablemates.workhorse.kotlin.enqueueSuspend
import dev.stablemates.workhorse.kotlin.getTaskSuspend
import dev.stablemates.workhorse.kotlin.workhorseWorker
import java.nio.file.Path
import kotlinx.coroutines.runBlocking
import org.postgresql.ds.PGSimpleDataSource

private const val QUEUE = "release-consumer"
private const val TASK_TYPE = "release.consumer"

/**
 * Without an argument, prints the file name of the jar that holds the Kotlin module. With a PostgreSQL JDBC URL, enqueues
 * one task, runs it through a suspend handler, checks its outcome, and prints the task id for the
 * check to read back.
 */
fun main(args: Array<String>) {
  println(Path.of(WorkerScope::class.java.protectionDomain.codeSource.location.path).fileName)
  if (args.isEmpty()) return

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
  val task = runBlocking { Admin(ConnectionSource.of(dataSource)).getTaskSuspend(taskId) }
  check(task?.state() == TaskState.SUCCEEDED && task.result() == mapOf("echo" to mapOf("packaged" to true))) {
    "task $taskId is ${task?.state()}"
  }
  println(taskId)
}
