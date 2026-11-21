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
 * worker of the step 3 program claims every task of the queue `default`.
 */
@ExtendWith(ScratchDatabase::class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class QuickstartKotlinExamplesTest {
  @Test
  fun theProgramRunsTheWelcomeTask() {
    IsolatedExampleDatabase.create("quickstart_kotlin_run").use { database ->
      val output = ExampleProgram.run("run.workhorse.examples.QuickstartKt", database.jdbcUrl())
      assertEquals("SUCCEEDED {deliveredTo=ada@example.com}\n", output)
      val tasks = database.tasks("email.welcome", "to", "ada@example.com")
      assertEquals(1, tasks.size)
      val task = database.detail(tasks.single())
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
