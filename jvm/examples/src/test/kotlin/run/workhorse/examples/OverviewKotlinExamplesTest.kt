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

/** Runs the Kotlin onboarding of the site page "What is Workhorse?". */
@ExtendWith(ScratchDatabase::class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class OverviewKotlinExamplesTest {
  private val dataSource = ExampleDatabase.dataSource()
  private val queue = Queue(ConnectionSource.of(dataSource))
  private val driver = DurableFlowDriver(dataSource)
  private val calls = CopyOnWriteArrayList<String>()
  private val welcomes = AtomicInteger()

  @Test
  fun theOnboardingWaitsForTheEmailAndCreatesOneWorkspace() {
    val enqueued = "kotlin-${UUID.randomUUID()}"
    val examples =
      OverviewKotlinExamples(
        { accountId, idempotencyKey ->
          calls.add("workspace $accountId $idempotencyKey")
          mapOf("id" to "ws-$accountId")
        },
        { email, _ ->
          calls.add("welcome $email")
          check(welcomes.incrementAndGet() > 1) { "the mail service is not available" }
          mapOf("sent" to true)
        },
      )
    durableFlowWorker(dataSource, driver) {
        val scope = this
        runBlocking { examples.onboard(queue, scope, enqueued, "ada@example.com", "tenant-42") }
      }
      .use { worker ->
        val policy = queue.listConcurrencyPolicies(listOf("onboarding"))[0]
        assertEquals("accounts", policy.namespace)
        assertEquals(3, policy.maxActivePerKey)
        val stored = ExampleDatabase.task("account.onboard", "accountId", enqueued)
        assertEquals("onboarding", stored.queue)
        assertEquals("tenant-42", stored.concurrencyKey)

        val taskId =
          driver.enqueue(
            "account.onboard",
            mapOf("accountId" to "acct-9", "email" to "ada@example.com"),
          )
        driver.deliverSignal(worker, taskId, "email-verified", mapOf("verified" to true))
        val task = driver.finish(worker, taskId)
        assertEquals(TaskState.SUCCEEDED, task.state())
        assertEquals(2, task.currentAttempt(), "the first welcome email failed")
        assertEquals(
          listOf(
            "workspace acct-9 workspace:acct-9",
            "welcome ada@example.com",
            "welcome ada@example.com",
          ),
          calls,
        )
        assertEquals(mapOf("id" to "ws-acct-9"), task.result())
      }
  }
}
