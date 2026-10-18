package run.workhorse.examples

import java.sql.SQLException
import java.time.Duration
import java.time.Instant
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import javax.sql.DataSource
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout
import org.junit.jupiter.api.extension.ExtendWith
import run.workhorse.Admin
import run.workhorse.ConnectionSource
import run.workhorse.EnqueueOptions
import run.workhorse.Queue
import run.workhorse.SignalStatus
import run.workhorse.TaskState
import run.workhorse.examples.ExamplesPageExamplesTest.ExamplesPageDatabase
import run.workhorse.kotlin.workhorseWorker
import run.workhorse.testing.ScratchDatabase

/** Runs the Kotlin snippets of the site page of examples. */
@ExtendWith(ScratchDatabase::class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class ExamplesPageKotlinExamplesTest {
  private val dataSource = ExampleDatabase.dataSource()
  private val queue = Queue(ConnectionSource.of(dataSource))
  private val admin = Admin(ConnectionSource.of(dataSource))

  companion object {
    @JvmStatic
    @BeforeAll
    fun ordersTable() {
      ExamplesPageDatabase.createOrdersTable()
    }
  }

  @Test
  fun theOrderAndItsTaskCommitTogether() = runBlocking {
    val orderId = "kotlin-${UUID.randomUUID()}"
    ExamplesPageKotlin.createOrder(dataSource, queue, orderId, listOf("book", "lamp"))
    assertEquals(listOf("book", "lamp"), ExamplesPageDatabase.orderItems(orderId))
    assertEquals("orders", ExampleDatabase.task("order.fulfill", "orderId", orderId).queue())
  }

  @Test
  fun theOrderAndItsTaskRollBackTogether() {
    val orderId = "kotlin-${UUID.randomUUID()}"
    assertThrows(SQLException::class.java) {
      runBlocking {
        ExamplesPageKotlin.createOrder(FailingCommitDataSource(), queue, orderId, listOf("book"))
      }
    }
    assertEquals(listOf<String>(), ExamplesPageDatabase.orderItems(orderId))
    assertEquals(0, ExampleDatabase.tasks("order.fulfill", "orderId", orderId).size)
  }

  @Test
  fun theTrialSendsEachEmailOnceAroundTheSleep() {
    val queueName = "examples-page-kotlin-trial"
    val to = "${UUID.randomUUID()}@example.com"
    val taskId =
      queue
        .enqueue(
          "trial.lifecycle",
          mapOf("to" to to, "followUpAt" to Instant.now().plusSeconds(1).toString()),
          EnqueueOptions.builder().queue(queueName).build(),
        )
        .taskId()
    worker(queueName) { ExamplesPageKotlin.registerTrialHandler(this) }
      .use { worker ->
        worker.start()
        val task = ExampleDatabase.awaitTerminal(taskId)
        assertEquals(TaskState.SUCCEEDED, task.state(), task.error().toString())
        assertEquals(mapOf("deliveredTo" to to), task.result())
      }
    assertEquals(
      mapOf(
        "deliveredTo" to to,
        "kind" to "welcome",
        "idempotencyKey" to "welcome:$taskId",
      ),
      admin.getCheckpoint(taskId, "welcome").orElseThrow().value(),
    )
    assertEquals(
      mapOf(
        "deliveredTo" to to,
        "kind" to "follow-up",
        "idempotencyKey" to "follow-up:$taskId",
      ),
      admin.getCheckpoint(taskId, "follow-up").orElseThrow().value(),
    )
  }

  @Test
  fun aRepeatedWebhookReturnsTheFirstTask() = runBlocking {
    val eventId = "evt_${UUID.randomUUID()}"
    val event = ExamplesPageKotlin.StripeEvent(eventId, "invoice.paid", mapOf<String, Any?>())
    val first = ExamplesPageKotlin.handleStripeWebhook(queue, event)
    val second = ExamplesPageKotlin.handleStripeWebhook(queue, event)
    assertEquals(first, second)
    val task = ExampleDatabase.task("stripe.event", "eventId", eventId)
    assertEquals(first["accepted"], task.id())
    assertEquals("webhooks", task.queue())
    assertEquals(mapOf("eventId" to eventId, "eventType" to "invoice.paid"), task.payload())
  }

  @Test
  fun theIncidentScriptRedrivesEachDeadLetterOnce() = runBlocking {
    // The test's worker reads `billing`, and the script redrives every dead letter of `billing`,
    // so the test has its own database.
    IsolatedExampleDatabase.create("examples-page-kotlin-incident").use { db ->
      val admin = db.admin()
      val run = "kotlin-${UUID.randomUUID()}"
      val sources = ExamplesPageDatabase.providerTimeouts(db, run)
      ExamplesPageKotlin.redriveIncident(admin)
      // A second run of the script with the same request ID makes no new task.
      ExamplesPageKotlin.redriveIncident(admin)
      for ((index, source) in sources.withIndex()) {
        val tasks = db.tasks(ExamplesPageDatabase.CHARGE, "run", "$run-$index")
        assertEquals(2, tasks.size, "the dead letter and its redrive")
        assertEquals(source, tasks[0])
        assertEquals(TaskState.FAILED, db.detail(source).state())
        assertEquals("billing", db.detail(tasks[1]).queue())
      }
    }
  }

  @Test
  fun theCancelEndsAWaitingTaskAndTheHandlerRunsTheNext() = runBlocking {
    // The snippet's worker reads the default queue, so the test has its own database.
    IsolatedExampleDatabase.create("examples-page-cancel").use { db ->
      val queue = Queue(ConnectionSource.of(db.dataSource()))
      val parts = mapOf("parts" to listOf("a", "b"), "run" to "kotlin-${UUID.randomUUID()}")
      val canceled = queue.enqueue("export.build", parts).taskId()
      val worker = ExamplesPageKotlin.configureExport(db.dataSource(), queue, canceled)
      assertEquals(TaskState.CANCELED, db.detail(canceled).state())

      val exported = queue.enqueue("export.build", parts).taskId()
      worker.use {
        it.start()
        val task = db.awaitTerminal(exported)
        assertEquals(TaskState.SUCCEEDED, task.state(), task.error().toString())
        assertEquals(mapOf("exported" to true), task.result())
      }
    }
  }

  @Test
  fun theAgentLoopPlansOnceRunsTheToolsAndWaitsForTheApproval() {
    // The worker reads `tools`, which the Java test also uses, so the test has its own database.
    IsolatedExampleDatabase.create("examples-page-kotlin-agent").use { db ->
      val queue = db.queue()
      val queueName = "examples-page-kotlin-agent"
      val plans = AtomicInteger()
      val plan = ExamplesPageDatabase.plan()
      val model =
        object : ExamplesPageKotlin.Model {
          override suspend fun plan(prompt: String, idempotencyKey: String): Map<String, Any?> {
            plans.incrementAndGet()
            return plan
          }
        }
      val taskId =
        queue
          .enqueue(
            "agent.run",
            mapOf("prompt" to "find the invoice", "conversationId" to "conversation-kotlin"),
            EnqueueOptions.builder().queue(queueName).build(),
          )
          .taskId()
      worker(db.dataSource(), queueName, "tools") {
          ExamplesPageKotlin.registerAgent(this, model, Duration.ofMillis(10))
          handle<Map<String, Any?>>("agent.tool") { _, tool -> mapOf("ran" to tool["id"]) }
        }
        .use { worker ->
          worker.start()
          awaitSignal(queue, taskId)
          val task = db.awaitTerminal(taskId)
          assertEquals(TaskState.SUCCEEDED, task.state(), task.error().toString())
          assertEquals(
            mapOf(
              "plan" to plan,
              "tools" to
                mapOf(
                  "search" to mapOf("ran" to "search"),
                  "summarize" to mapOf("ran" to "summarize"),
                ),
              "approved" to true,
            ),
            task.result(),
          )
        }
      assertEquals(1, plans.get())
      for (child in db.detail(taskId).childTaskIds()) {
        val detail = db.detail(child)
        assertEquals("tools", detail.queue())
        assertEquals("conversation-kotlin", detail.concurrencyKey())
      }
    }
  }

  private fun worker(vararg names: String, configure: run.workhorse.kotlin.WorkerScope.() -> Unit) =
    worker(ExampleDatabase.dataSource(), *names, configure = configure)

  private fun worker(
    dataSource: DataSource,
    vararg names: String,
    configure: run.workhorse.kotlin.WorkerScope.() -> Unit,
  ) =
    workhorseWorker(dataSource) {
      queues = names.toList()
      concurrency = 4
      pollInterval = Duration.ofMillis(100)
      configure()
    }

  private fun awaitSignal(queue: Queue, taskId: UUID) {
    val deadline = System.nanoTime() + ExampleDatabase.WAIT.toNanos()
    while (
      queue
        .sendSignal(
          taskId,
          "approval",
          mapOf("approved" to true),
          "approval:$taskId",
          "reviewer@example.com",
        )
        .status() != SignalStatus.DELIVERED
    ) {
      assertTrue(System.nanoTime() < deadline, "the task waits for the approval")
      Thread.sleep(50)
    }
  }
}
