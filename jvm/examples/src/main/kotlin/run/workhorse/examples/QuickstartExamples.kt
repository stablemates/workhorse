// The Kotlin tabs of the site quickstart.

package run.workhorse.examples

import javax.sql.DataSource
import org.postgresql.ds.PGSimpleDataSource
import run.workhorse.Admin
import run.workhorse.ConnectionSource
import run.workhorse.Queue
import run.workhorse.TaskDetail
import run.workhorse.kotlin.enqueueSuspend
import run.workhorse.kotlin.getTaskSuspend
import run.workhorse.kotlin.workhorseWorker

/** The Kotlin snippets of the site quickstart. */
object QuickstartKotlinExamples {
  /**
   * Enqueues one `email.welcome` task, runs it, and returns its detail. `databaseUrl` is a
   * PostgreSQL JDBC URL.
   */
  suspend fun runTask(databaseUrl: String): TaskDetail? {
    // docs:start kotlin-quickstart-run-task
    val dataSource = PGSimpleDataSource().apply { setURL(databaseUrl) } // a JDBC URL
    val queue = Queue(ConnectionSource.of(dataSource))
    val taskId = queue.enqueueSuspend("email.welcome", mapOf("to" to "ada@example.com")).taskId()

    workhorseWorker(dataSource) {
        handle<Map<String, Any?>>("email.welcome") { _, payload ->
          mapOf("deliveredTo" to payload["to"])
        }
      }
      .use { worker -> worker.runOnce() } // production uses WorkerProcess.runWorkerProcess

    val task = Admin(ConnectionSource.of(dataSource)).getTaskSuspend(taskId)
    println("${task?.state()} ${task?.result()}")
    // docs:end
    return task
  }

  // docs:start kotlin-quickstart-enqueue-with-data
  suspend fun createOrder(dataSource: DataSource, queue: Queue, orderId: String) {
    dataSource.connection.use { connection ->
      connection.autoCommit = false
      try {
        connection.prepareStatement("INSERT INTO orders (id) VALUES (?)").use { insert ->
          insert.setString(1, orderId)
          insert.executeUpdate()
        }
        queue.enqueueSuspend("order.fulfill", mapOf("orderId" to orderId), connection = connection)
        connection.commit()
      } catch (error: Throwable) {
        connection.rollback()
        throw error
      }
    }
  }
  // docs:end
}
