package run.workhorse.examples

import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout
import org.junit.jupiter.api.extension.ExtendWith
import run.workhorse.AdminAudit
import run.workhorse.EnqueueOptions
import run.workhorse.RedriveStatus
import run.workhorse.TaskState
import run.workhorse.kotlin.workhorseWorker
import run.workhorse.testing.ScratchDatabase

/** Runs the Kotlin snippets of the site page about dead letters and redrive. */
@ExtendWith(ScratchDatabase::class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class DeadLettersKotlinExamplesTest {
  // The worker reads `payments`, and each redrive leaves a ready copy there, so each test has its
  // own database.
  private val database = IsolatedExampleDatabase.create("dead-letters-kotlin")
  private val dataSource = database.dataSource()
  private val queue = database.queue()
  private val admin = database.admin()
  private val examples = DeadLettersKotlinExamples(admin)

  @AfterEach
  fun dropDatabase() {
    database.close()
  }

  /** The error of the payment provider in the outage. */
  class ProviderTimeout : RuntimeException("the payment provider did not answer")

  @Test
  fun theListHoldsTheFailedCharge() = runBlocking {
    val taskId = failedCharge()
    val letter = examples.listFailures().items().single { it.taskId() == taskId }
    assertEquals("payments", letter.queue())
    assertEquals("ProviderTimeout", (letter.error() as Map<*, *>)["name"])
  }

  @Test
  fun theRedriveCreatesANewReadyTaskAndReplaysTheSameRequest() = runBlocking {
    val sourceTaskId = failedCharge()
    val result = examples.redriveOne(sourceTaskId)
    assertEquals(RedriveStatus.REDRIVEN, result.status())
    assertEquals(TaskState.FAILED, result.sourceState())
    assertEquals(TaskState.READY, result.targetState())
    val target = checkNotNull(result.targetTaskId())
    val copy = database.detail(target)
    assertEquals("payments", copy.queue())
    assertEquals("payment.charge", copy.type())
    val replay = examples.redriveOne(sourceTaskId)
    assertEquals(RedriveStatus.REPLAYED, replay.status())
    assertEquals(target, replay.targetTaskId())
  }

  @Test
  fun theBacklogRedrivesEveryPageAfterTheDryRun() = runBlocking {
    val sources = listOf(failedCharge(), failedCharge())
    val preview = examples.redriveBacklog()
    for (source in sources) {
      assertTrue(
        preview.results().any {
          it.sourceTaskId() == source && it.status() == RedriveStatus.ELIGIBLE
        },
        "the dry run lists $source",
      )
      // The loop redrove the source with this request, so the same request only replays it.
      val replay =
        admin.redrive(source, AdminAudit("ops@example.com", "Provider outage ended", "outage-0314"))
      assertEquals(RedriveStatus.REPLAYED, replay.status())
      assertNotNull(replay.targetTaskId())
    }
  }

  /** Runs one `payment.charge` task on `payments` that fails with ProviderTimeout. */
  private fun failedCharge(): UUID {
    val taskId =
      queue
        .enqueue(
          "payment.charge",
          mapOf("chargeId" to "kotlin-${UUID.randomUUID()}"),
          EnqueueOptions.builder().queue("payments").maxAttempts(1).build(),
        )
        .taskId()
    workhorseWorker(dataSource) {
        queues = listOf("payments")
        handle<Map<String, Any?>>("payment.charge") { _, _ -> throw ProviderTimeout() }
      }
      .use { worker -> worker.runOnce() }
    assertEquals(TaskState.FAILED, database.awaitTerminal(taskId).state())
    return taskId
  }
}
