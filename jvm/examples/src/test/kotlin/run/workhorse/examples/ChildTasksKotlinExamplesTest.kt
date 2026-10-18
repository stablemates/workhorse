package run.workhorse.examples

import java.time.Duration
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout
import org.junit.jupiter.api.extension.ExtendWith
import run.workhorse.EnqueueOptions
import run.workhorse.RetryDelay
import run.workhorse.TaskState
import run.workhorse.Worker
import run.workhorse.kotlin.WorkerScope
import run.workhorse.kotlin.enqueueSuspend
import run.workhorse.kotlin.workhorseWorker
import run.workhorse.testing.ScratchDatabase

/** Runs the Kotlin snippets of the site page about child tasks under a real worker. */
@ExtendWith(ScratchDatabase::class)
// Each test creates and drops its own database, which is slow on a loaded host.
@Timeout(value = 240, unit = TimeUnit.SECONDS)
class ChildTasksKotlinExamplesTest {
  // The worker reads `orders` and `payments`, which other snippet tests also use, so each test has
  // its own database.
  private val database = IsolatedExampleDatabase.create("child-tasks-kotlin")
  private val dataSource = database.dataSource()
  private val queue = database.queue()

  @AfterEach
  fun dropDatabase() {
    database.close()
  }

  @Test
  fun runChildGivesTheParentTheReceiptOfTheChild() {
    val parentId = enqueue("orders.charge-kotlin", mapOf("id" to "ord-7"))
    worker {
      handle<Map<String, Any?>>("orders.charge-kotlin") { context, order ->
        ChildTasksKotlinExamples.charge(context, ChildTasksOrder(order.getValue("id") as String))
      }
      handle<Map<String, Any?>>("payments.charge") { _, payment ->
        mapOf("receiptId" to "rcpt-${payment["orderId"]}")
      }
    }
      .use { worker ->
        worker.start()
        val parent = database.awaitTerminal(parentId)
        assertEquals(TaskState.SUCCEEDED, parent.state())
        assertEquals(mapOf("receiptId" to "rcpt-ord-7"), parent.result())
        assertEquals(1, parent.childTaskIds().size)
        assertEquals("payments", database.detail(parent.childTaskIds()[0]).queue())
      }
  }

  @Test
  fun runChildrenGivesTheParentTheFailedFraudCheck() {
    val parentId = enqueue("orders.checkout-kotlin", mapOf("orderId" to "ord-9"))
    worker {
      handle<Map<String, Any?>>("orders.checkout-kotlin") { context, order ->
        ChildTasksKotlinExamples.checkout(context, order.getValue("orderId") as String)
      }
      handle<Map<String, Any?>>("orders.check-fraud") { _, _ ->
        throw IllegalStateException("the card is on a block list")
      }
      handle<Map<String, Any?>>("orders.reserve") { _, _ -> mapOf("reserved" to true) }
    }
      .use { worker ->
        worker.start()
        val parent = database.awaitTerminal(parentId)
        assertEquals(TaskState.SUCCEEDED, parent.state())
        val result = parent.result() as Map<*, *>
        assertEquals(false, result["accepted"])
        assertNotNull(result["reason"])
        assertEquals(2, parent.childTaskIds().size)
        for (childId in parent.childTaskIds()) {
          assertEquals("orders", database.detail(childId).queue())
        }
      }
  }

  private fun enqueue(taskType: String, payload: Map<String, String>): UUID = runBlocking {
    queue.enqueueSuspend(taskType, payload, EnqueueOptions.builder().queue("orders").build()).taskId
  }

  /** A worker that retries a failed child at once, so the fraud child fails fast. */
  private fun worker(configure: WorkerScope.() -> Unit): Worker =
    workhorseWorker(dataSource) {
      queues = listOf("orders", "payments")
      pollInterval = Duration.ofMillis(50)
      retryDelay = RetryDelay { _, _ -> Duration.ZERO }
      configure()
    }
}
