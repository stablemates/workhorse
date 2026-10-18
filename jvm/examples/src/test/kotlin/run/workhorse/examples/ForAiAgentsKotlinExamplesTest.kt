package run.workhorse.examples

import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout
import org.junit.jupiter.api.extension.ExtendWith
import run.workhorse.TaskState
import run.workhorse.testing.ScratchDatabase

/** Runs the Kotlin snippet of the site page for AI agents. */
@ExtendWith(ScratchDatabase::class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class ForAiAgentsKotlinExamplesTest {
  @Test
  fun theIntegrationCommitsTheOrderAndStoresTheResult() {
    IsolatedExampleDatabase.create("for_ai_agents_kotlin").use { database ->
      val task =
        checkNotNull(runBlocking { ForAiAgentsKotlinExamples.integrate(database.jdbcUrl()) })
      assertEquals(1, database.orders("order-42"))
      assertEquals(TaskState.SUCCEEDED, task.state())
      assertEquals(5, task.maxAttempts())
      assertEquals(mapOf("type" to "fixed", "delayMs" to 1_000L), task.retryPolicy())
      assertEquals(
        mapOf("processedOrderId" to "order-42", "receipt" to "receipt-for-order-42"),
        task.result(),
      )
    }
  }
}
