package run.workhorse.examples

import java.time.Duration
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout
import org.junit.jupiter.api.extension.ExtendWith
import run.workhorse.Admin
import run.workhorse.ConnectionSource
import run.workhorse.TaskState
import run.workhorse.testing.ScratchDatabase

/** Runs the Kotlin handlers of the site page about the durable agentic flow. */
@ExtendWith(ScratchDatabase::class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class AgenticFlowKotlinExamplesTest {
  private val dataSource = ExampleDatabase.dataSource()
  private val driver = DurableFlowDriver(dataSource)

  @Test
  fun theLoopPlansOneTimeRunsItsToolsAndWaitsForApproval() {
    val modelCalls = AtomicInteger()
    val examples =
      AgenticFlowKotlinExamples(
        { prompt ->
          modelCalls.incrementAndGet()
          "plan for $prompt"
        },
        driver.queueName(),
        Duration.ofMillis(200),
      )
    durableFlowWorker(dataSource, driver) { examples.register(this) }
      .use { worker ->
        val taskId =
          driver.enqueue(
            "agent.loop",
            mapOf("conversationId" to "conv-12", "prompt" to "Plan the trip"),
          )
        driver.deliverSignal(worker, taskId, "approval", mapOf("approved" to true))
        val task = driver.finish(worker, taskId)
        assertEquals(TaskState.SUCCEEDED, task.state())
        assertEquals(
          mapOf(
            "plan" to "plan for Plan the trip",
            "tools" to
              mapOf("research" to mapOf("sources" to 3L), "calculate" to mapOf("total" to 42L)),
            "approval" to mapOf("approved" to true),
          ),
          task.result(),
        )
        assertEquals(1, modelCalls.get(), "each replay returns the stored plan")
        assertEquals(
          mapOf("stage" to "planned"),
          Admin(ConnectionSource.of(dataSource)).getProgress(taskId).orElseThrow().value(),
        )
      }
  }
}
