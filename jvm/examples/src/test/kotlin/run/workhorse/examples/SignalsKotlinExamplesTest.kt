package run.workhorse.examples

import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout
import org.junit.jupiter.api.extension.ExtendWith
import run.workhorse.TaskState
import run.workhorse.testing.ScratchDatabase

/** Runs the Kotlin handler of the site page about signals. */
@ExtendWith(ScratchDatabase::class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class SignalsKotlinExamplesTest {
  private val dataSource = ExampleDatabase.dataSource()
  private val driver = DurableFlowDriver(dataSource)

  @Test
  fun anApprovalSignalPublishesTheOrderOneTime() {
    val published = AtomicInteger()
    durableFlowWorker(dataSource, driver) {
        SignalsKotlinExamples { published.incrementAndGet() }.register(this)
      }
      .use { worker ->
        val taskId = driver.enqueue("order.publish", mapOf("orderId" to "ord-381"))
        driver.deliverSignal(worker, taskId, "approval", mapOf("approved" to true))
        val task = driver.finish(worker, taskId)
        assertEquals(TaskState.SUCCEEDED, task.state())
        assertEquals(1, task.currentAttempt())
        assertEquals(mapOf("approved" to true), task.result())
        assertEquals(1, published.get())
      }
  }
}
