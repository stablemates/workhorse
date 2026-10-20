package run.workhorse.kotlin

import java.time.Duration
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout
import org.junit.jupiter.api.extension.ExtendWith
import run.workhorse.ConnectionSource
import run.workhorse.EnqueueOptions
import run.workhorse.Queue
import run.workhorse.Worker
import run.workhorse.testing.ScratchDataSource
import run.workhorse.testing.ScratchDatabase

/**
 * A JSON `null` and a reified type that is not nullable (SM-1526). The handler or the context call
 * throws `IllegalArgumentException`, and never gives `null` to code that expects a value. A
 * nullable type still receives `null`.
 */
@ExtendWith(ScratchDatabase::class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class NonNullTypeDatabaseTest {
  private val dataSource = ScratchDataSource(true)
  private val queue = Queue(ConnectionSource.of(dataSource))
  private var queueName = ""

  @BeforeEach
  fun name() {
    queueName = "kotlin-non-null-${UUID.randomUUID()}"
  }

  private fun worker(configure: WorkerScope.() -> Unit): Worker =
    workhorseWorker(dataSource) {
      queues = listOf(queueName)
      workerId = "kotlin-non-null"
      pollingOnly = true
      pollInterval = Duration.ofMillis(10)
      disableRegistry = true
      configure()
    }

  private fun enqueue(taskType: String, payload: Any?): UUID = runBlocking {
    val options = EnqueueOptions.builder().queue(queueName).maxAttempts(1).build()
    queue.enqueueSuspend(taskType, payload, options).taskId
  }

  @Test
  fun rejectsANullPayloadForAPayloadTypeThatIsNotNullable() {
    val taskId = enqueue("strict", null)
    val calls = AtomicInteger()
    val worker = worker {
      handle<Map<String, Any?>>("strict") { _, payload ->
        calls.incrementAndGet()
        payload.size
      }
    }

    assertTrue(worker.runOnce())

    assertEquals(0, calls.get(), "the handler does not run with a null payload")
    assertEquals("failed", state(taskId))
    assertTrue(error(taskId).contains("IllegalArgumentException"), error(taskId))
  }

  @Test
  fun rejectsANullCheckpointValueForATypeThatIsNotNullable() {
    val taskId = enqueue("checkpoint", null)
    val outcomes = ConcurrentHashMap<String, String>()
    val worker = worker {
      handle<Any?>("checkpoint") { ctx, _ ->
        val saved: String? = ctx.checkpoint<String?>("token") { null }
        outcomes["nullable"] = "value=$saved"
        outcomes["strict"] =
          try {
            val token: String = ctx.checkpoint<String>("token") { "fresh" }
            "length=${token.length}"
          } catch (rejected: IllegalArgumentException) {
            "rejected"
          }
        "done"
      }
    }

    assertTrue(worker.runOnce())

    assertEquals("succeeded", state(taskId))
    assertEquals("value=null", outcomes["nullable"], "a nullable type receives null")
    assertEquals("rejected", outcomes["strict"])
  }

  @Test
  fun rejectsANullSignalPayloadForATypeThatIsNotNullable() {
    val taskId = enqueue("signal", null)
    val outcomes = ConcurrentHashMap<String, String>()
    val worker = worker {
      handle<Any?>("signal") { ctx, _ ->
        val first: String? = ctx.waitForSignal<String?>("first")
        outcomes["nullable"] = "value=$first"
        outcomes["strict"] =
          try {
            val second: String = ctx.waitForSignal<String>("second")
            "length=${second.length}"
          } catch (rejected: IllegalArgumentException) {
            "rejected"
          }
        "done"
      }
    }

    assertTrue(worker.runOnce())
    signal(taskId, "first")
    assertTrue(worker.runOnce(), "the first signal resumes the task")
    assertEquals("scheduled", state(taskId), "the task waits for the second signal")
    signal(taskId, "second")
    drive(worker, taskId)

    assertEquals("value=null", outcomes["nullable"], "a nullable type receives null")
    assertEquals("rejected", outcomes["strict"])
  }

  @Test
  fun rejectsANullHumanDecisionForATypeThatIsNotNullable() {
    val taskId = enqueue("human", null)
    val outcome = ConcurrentHashMap<String, String>()
    val worker = worker {
      handle<Any?>("human") { ctx, _ ->
        outcome["strict"] =
          try {
            val decision: String = ctx.waitForHuman<String>("approve")
            "length=${decision.length}"
          } catch (rejected: IllegalArgumentException) {
            "rejected"
          }
        "done"
      }
    }

    assertTrue(worker.runOnce())
    runBlocking { queue.completeHumanWaitSuspend(taskId, "approve", null, "approve-1", "test") }
    drive(worker, taskId)

    assertEquals("rejected", outcome["strict"])
  }

  @Test
  fun rejectsANullChildResultForATypeThatIsNotNullable() {
    val taskId = enqueue("parent", null)
    val outcome = ConcurrentHashMap<String, String>()
    val worker = worker {
      handle<Any?>("child") { _, _ -> null }
      handle<Any?>("parent") { ctx, _ ->
        outcome["strict"] =
          try {
            val result: String =
              ctx.runChild<String>(
                "child",
                "child",
                options = EnqueueOptions.builder().queue(queueName).build(),
              )
            "length=${result.length}"
          } catch (rejected: IllegalArgumentException) {
            "rejected"
          }
        "done"
      }
    }

    drive(worker, taskId)

    assertEquals("rejected", outcome["strict"])
  }

  private fun signal(taskId: UUID, name: String) {
    runBlocking { queue.sendSignalSuspend(taskId, name, null, "$name-1", "test") }
  }

  /** Runs at most 20 passes of [worker] until [taskId] succeeds. */
  private fun drive(worker: Worker, taskId: UUID) {
    repeat(20) {
      if (state(taskId) == "succeeded") return
      query("SELECT 1 FROM workhorse.tick_v1(100, 100)", null)
      worker.runOnce()
    }
    assertEquals("succeeded", state(taskId), error(taskId))
  }

  private fun state(taskId: UUID): String =
    checkNotNull(
      query(
        "SELECT COALESCE(o.state, r.state) FROM workhorse.task t" +
          " LEFT JOIN workhorse.task_runtime r ON r.task_id = t.id" +
          " LEFT JOIN workhorse.task_outcome o ON o.task_id = t.id WHERE t.id = ?::uuid",
        taskId.toString(),
      ),
    )

  private fun error(taskId: UUID): String =
    query("SELECT error::text FROM workhorse.task_outcome WHERE task_id = ?::uuid", "$taskId")
      ?: "no error"

  private fun query(sql: String, parameter: String?): String? =
    ScratchDatabase.connect().use { connection ->
      connection.prepareStatement(sql).use { statement ->
        if (parameter != null) statement.setString(1, parameter)
        statement.executeQuery().use { result -> if (result.next()) result.getString(1) else null }
      }
    }
}
