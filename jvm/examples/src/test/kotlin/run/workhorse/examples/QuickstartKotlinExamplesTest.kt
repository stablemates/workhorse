package run.workhorse.examples

import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout
import org.junit.jupiter.api.extension.ExtendWith
import run.workhorse.ConnectionSource
import run.workhorse.Queue
import run.workhorse.TaskState
import run.workhorse.testing.ScratchDatabase

/**
 * Runs the Kotlin snippets of the site quickstart. Each test has its own database, because the
 * worker of the first snippet stops at a task that it has no handler for.
 */
@ExtendWith(ScratchDatabase::class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class QuickstartKotlinExamplesTest {
  @Test
  fun theWorkerRunsTheWelcomeTask() {
    IsolatedExampleDatabase.create("quickstart_kotlin_run").use { database ->
      val task = checkNotNull(runBlocking { QuickstartKotlinExamples.runTask(database.jdbcUrl()) })
      assertEquals("email.welcome", task.type())
      assertEquals(TaskState.SUCCEEDED, task.state())
      assertEquals(mapOf("deliveredTo" to "ada@example.com"), task.result())
    }
  }

  @Test
  fun theOrderAndItsTaskCommitTogether() {
    IsolatedExampleDatabase.create("quickstart_kotlin_order").use { database ->
      val orderId = "kotlin-${UUID.randomUUID()}"
      val queue = Queue(ConnectionSource.of(database.dataSource()))
      runBlocking { QuickstartKotlinExamples.createOrder(database.dataSource(), queue, orderId) }
      assertEquals(1, database.orders(orderId))
      assertEquals(1, database.orderTasks("order.fulfill", orderId))
    }
  }
}
