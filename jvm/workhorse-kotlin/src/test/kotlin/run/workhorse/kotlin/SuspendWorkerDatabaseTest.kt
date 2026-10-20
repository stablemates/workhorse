package run.workhorse.kotlin

import java.time.Duration
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.yield
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout
import org.junit.jupiter.api.extension.ExtendWith
import run.workhorse.Admin
import run.workhorse.BatchHandlerOutcome
import run.workhorse.BatchOptions
import run.workhorse.BatchSucceeded
import run.workhorse.CancellationReason
import run.workhorse.ConnectionSource
import run.workhorse.EnqueueOptions
import run.workhorse.Queue
import run.workhorse.TaskCheckpoint
import run.workhorse.Worker
import run.workhorse.WorkhorseTelemetry
import run.workhorse.spring.JacksonJsonCodec
import run.workhorse.testing.RecordingOpenTelemetry
import run.workhorse.testing.ScratchDataSource
import run.workhorse.testing.ScratchDatabase
import tools.jackson.databind.json.JsonMapper

/**
 * Suspend handlers and the suspend wrappers against PostgreSQL. Every wait is bounded: a latch or a
 * poll waits at most [WAIT], and the class has a timeout.
 */
@ExtendWith(ScratchDatabase::class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class SuspendWorkerDatabaseTest {
  private val dataSource = ScratchDataSource(true)
  private val queue = Queue(ConnectionSource.of(dataSource))
  private val admin = Admin(ConnectionSource.of(dataSource))
  private var queueName = ""

  @BeforeEach
  fun name() {
    queueName = "kotlin-worker-${UUID.randomUUID()}"
  }

  private fun worker(workerId: String, configure: WorkerScope.() -> Unit): Worker =
    workhorseWorker(dataSource) {
      queues = listOf(queueName)
      this.workerId = workerId
      pollingOnly = true
      pollInterval = Duration.ofMillis(10)
      disableRegistry = true
      configure()
    }

  private fun enqueue(taskType: String, payload: Any?): UUID = runBlocking {
    val options = EnqueueOptions.builder().queue(queueName).build()
    queue.enqueueSuspend(taskType, payload, options).taskId
  }

  @Test
  fun cancelsTheCoroutineJobOfTheHandlerWhenTheTaskIsCancelled() {
    val taskId = enqueue("cancellable", mapOf("order" to 1L))
    val started = CountDownLatch(1)
    val job = AtomicReference<Job?>()
    val observed = AtomicReference<CancellationException?>()
    val worker =
      worker("kotlin-cancel") {
        lease = Duration.ofSeconds(5)
        heartbeat = Duration.ofMillis(100)
        handle<Map<String, Any?>>("cancellable") { _, _ ->
          job.set(currentCoroutineContext()[Job])
          started.countDown()
          try {
            awaitCancellation()
          } catch (cancelled: CancellationException) {
            observed.set(cancelled)
            throw cancelled
          }
        }
      }
    worker.start()
    try {
      assertTrue(started.await(WAIT.toSeconds(), TimeUnit.SECONDS), "the handler started")
      runBlocking { queue.cancelSuspend(taskId, requestedBy = "test", reason = "no longer needed") }
      waitForState(taskId, "canceled")
    } finally {
      worker.close()
    }
    val handlerJob = present(job.get(), "the handler ran in a Job")
    assertTrue(handlerJob.isCancelled, "the cancellation cancels the handler's Job")
    assertTrue(handlerJob.isCompleted, "the handler's Job ends before the worker settles the task")
    val cause = present(observed.get(), "the handler observes a CancellationException")
    assertEquals("task cancelled: ${CancellationReason.REQUESTED.name}", cause.message)
  }

  @Test
  fun cancelsTheCoroutineJobWithShutdownAtTheDrainDeadline() {
    val taskId = enqueue("slow", null)
    val started = CountDownLatch(1)
    val job = AtomicReference<Job?>()
    val reason = AtomicReference<CancellationReason?>()
    val cleanedUp = AtomicReference(false)
    val worker =
      worker("kotlin-shutdown") {
        shutdownGrace = Duration.ofMillis(100)
        handle<Any?>("slow") { ctx, _ ->
          job.set(currentCoroutineContext()[Job])
          started.countDown()
          try {
            delay(WAIT.toMillis())
          } finally {
            reason.set(ctx.cancellation.reason())
            // The cleanup suspends past the drain's interrupt, which follows the cancellation.
            withContext(NonCancellable) { delay(100) }
            cleanedUp.set(true)
          }
        }
      }
    worker.start()
    assertTrue(started.await(WAIT.toSeconds(), TimeUnit.SECONDS), "the handler started")
    worker.close()

    assertEquals(CancellationReason.SHUTDOWN, reason.get())
    val handlerJob = present(job.get(), "the handler ran in a Job")
    assertTrue(handlerJob.isCancelled, "the drain cancels the handler's Job")
    assertTrue(cleanedUp.get(), "the drain waits until the handler's coroutine ends")
    assertEquals("ready", state(taskId).state, "a shutdown returns the task to the queue")
  }

  @Test
  fun checkpointsASuspendOperationAndResumesFromTheCheckpoint() {
    val taskId = enqueue("prepare-then-wait", null)
    val operations = AtomicInteger()
    val seen = AtomicReference<TaskCheckpoint?>()
    val handler =
      SuspendHandler<Any?> { ctx, _ ->
        seen.set(ctx.getCheckpoint("prepare"))
        val prepared =
          ctx.checkpoint<Map<String, Any?>>("prepare") {
            // The operation suspends inside the core's checkpoint call.
            yield()
            delay(1)
            mapOf("operation" to operations.incrementAndGet().toLong())
          }
        ctx.sleep("after-prepare", Duration.ofSeconds(30))
        mapOf("prepared" to prepared)
      }

    val first = worker("kotlin-first") { handle("prepare-then-wait", handler) }
    assertTrue(first.runOnce())
    assertEquals("scheduled", state(taskId).state, "the durable timer suspends the task")
    assertNull(seen.get(), "the first activation read no checkpoint")

    wake(taskId)
    val second = worker("kotlin-second") { handle("prepare-then-wait", handler) }
    val done = drive(second, taskId, "succeeded")
    assertEquals(1, done.attempt, "the resume runs the same attempt")
    assertEquals("""{"prepared": {"operation": 1}}""", done.result)
    assertEquals(1, operations.get(), "the checkpoint operation ran once")
    val checkpoint = present(seen.get(), "the second activation read the checkpoint")
    assertEquals("kotlin-first", checkpoint.workerId())
    val stored = runBlocking { admin.getCheckpointSuspend(taskId, "prepare") }
    assertEquals(mapOf("operation" to 1L), present(stored, "Admin reads the checkpoint").value())
  }

  @Test
  fun suspendsAHandlerThatCatchesTheSuspensionWithRunCatching() {
    val taskId = enqueue("swallow", null)
    val caught = AtomicReference<Throwable?>()
    val worker =
      worker("kotlin-swallow") {
        handle<Any?>("swallow") { ctx, _ ->
          caught.set(runCatching { ctx.sleep("nap", Duration.ofSeconds(30)) }.exceptionOrNull())
          "ignored"
        }
      }

    assertTrue(worker.runOnce())

    assertInstanceOf(Error::class.java, caught.get(), "the handler caught the suspension")
    assertEquals("scheduled", state(taskId).state, "the task suspends all the same")
  }

  @Test
  fun decodesANullPayloadForANullablePayloadType() {
    val taskId = enqueue("nullable", null)
    val payloads = AtomicReference<Any?>("unset")
    val worker =
      worker("kotlin-nullable") {
        handle<Map<String, Any?>?>("nullable") { _, payload ->
          payloads.set(payload)
          payload?.size ?: 0
        }
      }

    assertTrue(worker.runOnce())

    assertNull(payloads.get())
    val done = state(taskId)
    assertEquals("succeeded", done.state)
    assertEquals("0", done.result)
  }

  // SM-1458: the scope has a property for each Worker.Builder option, and a batch registration.
  @Test
  fun setsTheCohortsOfTheWorker() {
    val worker =
      worker("kotlin-cohorts") {
        concurrency = 4
        cohorts = 2
      }

    assertEquals(2, worker.cohorts())
  }

  @Test
  fun recordsTheHandlerSpanThroughTheTelemetryProperty() {
    RecordingOpenTelemetry().use { recording ->
      val taskId = enqueue("traced", mapOf("order" to 1L))
      val worker =
        worker("kotlin-telemetry") {
          telemetry = WorkhorseTelemetry.of(recording.sdk())
          handle<Map<String, Any?>>("traced") { _, _ -> "done" }
        }

      assertTrue(worker.runOnce())

      assertEquals("succeeded", state(taskId).state)
      assertEquals(1, recording.spans("workhorse.handler").size)
    }
  }

  @Test
  fun runsABatchHandlerWithAReifiedPayloadType() {
    val first = enqueue("batched", mapOf("order" to 1L))
    val second = enqueue("batched", mapOf("order" to 2L))
    // A slow claim can split the tasks into two batches, so the test counts the members.
    val members = AtomicInteger()
    val worker =
      worker("kotlin-batch") {
        concurrency = 2
        handleBatch<Map<String, Any?>>("batched", BatchOptions(2, Duration.ofMillis(200))) { items
          ->
          members.addAndGet(items.size)
          items.map<_, BatchHandlerOutcome> { BatchSucceeded(it.payload()["order"]) }
        }
      }

    worker.start()
    try {
      waitForState(first, "succeeded")
      waitForState(second, "succeeded")
    } finally {
      worker.close()
    }

    assertEquals(2, members.get())
    assertEquals("1", state(first).result)
    assertEquals("2", state(second).result)
  }

  // SM-1521: handle and handleBatch decode the full reified payload type.
  @Test
  fun decodesTheTypeArgumentsOfAReifiedPayloadTypeWithTheJacksonCodec() {
    val taskId = enqueue("ship", listOf(mapOf("id" to "A-1"), mapOf("id" to "A-2")))
    val worker =
      worker("kotlin-generic") {
        codec = JacksonJsonCodec(JsonMapper.builder().build())
        handle<List<ShippedOrder>>("ship") { _, orders -> orders.map { it.id } }
      }

    assertTrue(worker.runOnce())

    val done = state(taskId)
    assertEquals("succeeded", done.state, "the handler receives a list of ShippedOrder")
    assertEquals("[\"A-1\", \"A-2\"]", done.result)
  }

  @Test
  fun decodesTheTypeArgumentsOfABatchPayloadTypeWithTheJacksonCodec() {
    val taskId = enqueue("ship-batch", listOf(mapOf("id" to "B-1")))
    val worker =
      worker("kotlin-generic-batch") {
        codec = JacksonJsonCodec(JsonMapper.builder().build())
        handleBatch<List<ShippedOrder>>("ship-batch", BatchOptions(1, Duration.ofMillis(10))) {
          items ->
          items.map<_, BatchHandlerOutcome> { BatchSucceeded(it.payload().first().id) }
        }
      }

    worker.start()
    try {
      waitForState(taskId, "succeeded")
    } finally {
      worker.close()
    }

    assertEquals("\"B-1\"", state(taskId).result)
  }

  private fun <T : Any> present(value: T?, message: String): T =
    value ?: throw AssertionError(message)

  private data class State(val state: String, val attempt: Int, val result: String?)

  private fun state(taskId: UUID): State =
    ScratchDatabase.connect().use { connection ->
      connection.prepareStatement(STATE).use { statement ->
        statement.setString(1, taskId.toString())
        statement.executeQuery().use { result ->
          assertTrue(result.next(), "the task exists")
          State(result.getString("state"), result.getInt("attempt"), result.getString("result"))
        }
      }
    }

  private fun execute(sql: String, parameter: String?) {
    ScratchDatabase.connect().use { connection ->
      connection.prepareStatement(sql).use { statement ->
        if (parameter != null) statement.setString(1, parameter)
        statement.execute()
      }
    }
  }

  /** Wakes a task that a durable timer suspended, as the core's durable context test does. */
  private fun wake(taskId: UUID) {
    execute(
      "UPDATE workhorse.task_runtime SET run_at = clock_timestamp() - interval '1 millisecond'" +
        " WHERE task_id = ?::uuid",
      taskId.toString(),
    )
    execute("SELECT * FROM workhorse.tick_v1(100, 100)", null)
  }

  /** Runs at most 20 passes of [worker] until [taskId] reaches [expected]. */
  private fun drive(worker: Worker, taskId: UUID, expected: String): State {
    repeat(20) {
      val current = state(taskId)
      if (current.state == expected) return current
      execute("SELECT * FROM workhorse.tick_v1(100, 100)", null)
      worker.runOnce()
    }
    val last = state(taskId)
    assertEquals(expected, last.state, "the task did not reach $expected")
    return last
  }

  private fun waitForState(taskId: UUID, expected: String) {
    val deadline = System.nanoTime() + WAIT.toNanos()
    while (state(taskId).state != expected) {
      if (System.nanoTime() > deadline) throw AssertionError("timed out waiting until $expected")
      Thread.sleep(10)
    }
  }

  private companion object {
    val WAIT: Duration = Duration.ofSeconds(20)
    const val STATE =
      "SELECT COALESCE(o.state, r.state) AS state," +
        " COALESCE(o.current_attempt, r.current_attempt) AS attempt, o.result::text AS result" +
        " FROM workhorse.task t" +
        " LEFT JOIN workhorse.task_runtime r ON r.task_id = t.id" +
        " LEFT JOIN workhorse.task_outcome o ON o.task_id = t.id" +
        " WHERE t.id = ?::uuid"
  }
}

/** The element of a generic payload type. Jackson decodes it through its setter. */
class ShippedOrder {
  var id: String = ""
}
