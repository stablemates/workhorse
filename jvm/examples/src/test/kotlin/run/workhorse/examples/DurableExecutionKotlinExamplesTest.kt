package run.workhorse.examples

import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout
import org.junit.jupiter.api.extension.ExtendWith
import run.workhorse.TaskState
import run.workhorse.testing.ScratchDatabase

/** Runs the Kotlin handlers of the site page about durable execution. */
@ExtendWith(ScratchDatabase::class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class DurableExecutionKotlinExamplesTest {
  private val dataSource = ExampleDatabase.dataSource()
  private val driver = DurableFlowDriver(dataSource)
  private val calls = CopyOnWriteArrayList<String>()
  private val shipments = AtomicInteger()

  @Test
  fun aRetryReturnsTheStoredChargeAndDoesNotChargeAgain() {
    durableFlowWorker(dataSource, driver) { examples().registerCheckpoints(this) }
      .use { worker ->
        val taskId = driver.enqueue("order.fulfill", mapOf("orderId" to "ord-7"))
        val task = driver.finish(worker, taskId)
        assertEquals(TaskState.SUCCEEDED, task.state())
        assertEquals(2, task.currentAttempt(), "the first shipment call failed")
        assertEquals(listOf("charge ord-7 charge:ord-7", "ship ord-7", "ship ord-7"), calls)
        assertEquals(mapOf("shipmentId" to "ship-ord-7", "chargeId" to "ch-ord-7"), task.result())
      }
  }

  @Test
  fun theFollowUpWaitsForItsTimeAndTheWelcomeRunsOneTime() {
    durableFlowWorker(dataSource, driver) { examples().registerFollowUp(this) }
      .use { worker ->
        val followUpAt = Instant.now().plusMillis(500)
        val taskId =
          driver.enqueue(
            "trial.follow-up",
            mapOf("to" to "person@example.com", "followUpAt" to followUpAt.toString()),
          )
        val task = driver.finish(worker, taskId)
        assertEquals(TaskState.SUCCEEDED, task.state())
        assertEquals(1, task.currentAttempt(), "a wait keeps the attempt")
        assertEquals(listOf("welcome person@example.com", "follow-up person@example.com"), calls)
      }
  }

  @Test
  fun theReviewReturnsTheSignalAndTheDecision() {
    durableFlowWorker(dataSource, driver) { examples().registerExternalWaits(this) }
      .use { worker ->
        val taskId = driver.enqueue("order.review", null)
        driver.deliverSignal(worker, taskId, "provider-event", mapOf("id" to "evt-5"))
        driver.completeHumanWait(worker, taskId, "operator-review", mapOf("approved" to true))
        val task = driver.finish(worker, taskId)
        assertEquals(TaskState.SUCCEEDED, task.state())
        assertEquals(
          mapOf("event" to mapOf("id" to "evt-5"), "review" to mapOf("approved" to true)),
          task.result(),
        )
      }
  }

  private fun examples() =
    DurableExecutionKotlinExamples(
      { orderId, idempotencyKey ->
        calls.add("charge $orderId $idempotencyKey")
        mapOf("id" to "ch-$orderId")
      },
      { orderId, charge ->
        calls.add("ship $orderId")
        check(shipments.incrementAndGet() > 1) { "the shipment service is not available" }
        mapOf("shipmentId" to "ship-$orderId", "chargeId" to (charge as Map<*, *>)["id"])
      },
      object : DurableExecutionExamples.TrialMailer {
        override fun welcome(to: String): Map<String, Any?> {
          calls.add("welcome $to")
          return mapOf("sent" to true)
        }

        override fun followUp(to: String): Map<String, Any?> {
          calls.add("follow-up $to")
          return mapOf("sent" to true)
        }
      },
    )
}
