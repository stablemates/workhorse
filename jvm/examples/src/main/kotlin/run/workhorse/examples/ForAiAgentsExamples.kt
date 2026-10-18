// The Kotlin tab of the site page for AI agents.

package run.workhorse.examples

import org.postgresql.ds.PGSimpleDataSource
import run.workhorse.Admin
import run.workhorse.ConnectionSource
import run.workhorse.EnqueueOptions
import run.workhorse.Queue
import run.workhorse.TaskDetail
import run.workhorse.kotlin.enqueueSuspend
import run.workhorse.kotlin.getTaskSuspend
import run.workhorse.kotlin.workhorseWorker

/** The Kotlin snippet of the site page for AI agents. */
object ForAiAgentsKotlinExamples {
  // docs:start kotlin-for-ai-agents-integrate
  fun sendConfirmationEmail(orderId: String): String = "receipt-for-$orderId"

  suspend fun integrate(databaseUrl: String): TaskDetail? {
    val dataSource = PGSimpleDataSource().apply { setURL(databaseUrl) } // a JDBC URL
    val queue = Queue(ConnectionSource.of(dataSource))

    val taskId =
      dataSource.connection.use { connection ->
        connection.autoCommit = false
        try {
          val sql = "INSERT INTO orders (id, status) VALUES (?, ?)"
          connection.prepareStatement(sql).use { insert ->
            insert.setString(1, "order-42")
            insert.setString(2, "new")
            insert.executeUpdate()
          }
          val enqueued =
            queue.enqueueSuspend(
              "order.created",
              mapOf("orderId" to "order-42"),
              EnqueueOptions.builder()
                .maxAttempts(5)
                .retryPolicy(mapOf("type" to "fixed", "delayMs" to 1_000))
                .build(),
              connection,
            )
          connection.commit()
          enqueued.taskId()
        } catch (error: Throwable) {
          connection.rollback()
          throw error
        }
      }

    workhorseWorker(dataSource) {
        pollingOnly = true
        handle<Map<String, Any?>>("order.created") { context, payload ->
          val orderId = payload["orderId"] as String
          // The send runs once. A replay reuses the recorded receipt.
          val receipt = context.checkpoint("confirmation-email") { sendConfirmationEmail(orderId) }
          mapOf("processedOrderId" to orderId, "receipt" to receipt)
        }
      }
      .use { worker -> worker.runOnce() } // Production workers call WorkerProcess.runWorkerProcess.

    val task = Admin(ConnectionSource.of(dataSource)).getTaskSuspend(taskId)
    println("${task?.state()} ${task?.result()}")
    return task
  }
  // docs:end
}
