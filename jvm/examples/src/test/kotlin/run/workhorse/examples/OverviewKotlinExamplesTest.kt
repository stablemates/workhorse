package run.workhorse.examples

import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout
import org.junit.jupiter.api.extension.ExtendWith
import run.workhorse.ConnectionSource
import run.workhorse.Queue
import run.workhorse.TaskState
import run.workhorse.testing.ScratchDatabase

/** Runs the Kotlin fulfillment of the site page "What is Workhorse?". */
@ExtendWith(ScratchDatabase::class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class OverviewKotlinExamplesTest {
  private val dataSource = ExampleDatabase.dataSource()
  private val queue = Queue(ConnectionSource.of(dataSource))
  private val driver = DurableFlowDriver(dataSource)
  private val calls = CopyOnWriteArrayList<String>()
  private val receipts = AtomicInteger()

  @Test
  fun theFulfillmentWaitsForTheParcelAndChargesTheCardOneTime() {
    val enqueued = "kotlin-${UUID.randomUUID()}"
    val examples =
      OverviewKotlinExamples(
        { orderId, idempotencyKey ->
          calls.add("charge $orderId $idempotencyKey")
          mapOf("id" to "ch-$orderId")
        },
        { email, _, trackingNumber ->
          calls.add("receipt $email $trackingNumber")
          check(receipts.incrementAndGet() > 1) { "the mail service is not available" }
          mapOf("sent" to true)
        },
      )
    durableFlowWorker(dataSource, driver) {
        val scope = this
        runBlocking { examples.fulfill(queue, scope, enqueued, "ada@example.com", "merchant-42") }
      }
      .use { worker ->
        val policy = queue.listConcurrencyPolicies(listOf("fulfillment"))[0]
        assertEquals("shop", policy.namespace)
        assertEquals(3, policy.maxActivePerKey)
        val stored = ExampleDatabase.task("order.fulfill", "orderId", enqueued)
        assertEquals("fulfillment", stored.queue)
        assertEquals("merchant-42", stored.concurrencyKey)

        val taskId =
          driver.enqueue(
            "order.fulfill",
            mapOf("orderId" to "order-9", "email" to "ada@example.com"),
          )
        driver.deliverSignal(worker, taskId, "order-shipped", mapOf("trackingNumber" to "TRK-1"))
        val task = driver.finish(worker, taskId)
        assertEquals(TaskState.SUCCEEDED, task.state())
        assertEquals(2, task.currentAttempt(), "the first receipt failed")
        assertEquals(
          listOf(
            "charge order-9 charge:order-9",
            "receipt ada@example.com TRK-1",
            "receipt ada@example.com TRK-1",
          ),
          calls,
        )
        assertEquals(
          mapOf("charge" to mapOf("id" to "ch-order-9"), "trackingNumber" to "TRK-1"),
          task.result(),
        )
      }
  }
}
