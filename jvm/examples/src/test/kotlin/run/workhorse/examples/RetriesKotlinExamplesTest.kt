package run.workhorse.examples

import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout
import org.junit.jupiter.api.extension.ExtendWith
import run.workhorse.ConnectionSource
import run.workhorse.Queue
import run.workhorse.testing.ScratchDatabase

/** Runs the Kotlin snippets of the site page about retries. */
@ExtendWith(ScratchDatabase::class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class RetriesKotlinExamplesTest {
  private val queue = Queue(ConnectionSource.of(ExampleDatabase.dataSource()))

  @Test
  fun theAttemptBudgetReachesTheTask() = runBlocking {
    val accountId = "kotlin-${UUID.randomUUID()}"
    RetriesKotlinExamples.attemptBudget(queue, accountId)
    assertEquals(5, ExampleDatabase.task("provider.sync", "accountId", accountId).maxAttempts())
  }

  @Test
  fun theRetryPolicyReachesTheTask() = runBlocking {
    val accountId = "kotlin-${UUID.randomUUID()}"
    RetriesKotlinExamples.retryPolicy(queue, accountId)
    val task = ExampleDatabase.task("provider.sync", "accountId", accountId)
    assertEquals(5, task.maxAttempts())
    val policy = checkNotNull(task.retryPolicy())
    assertEquals("decorrelated-jitter", policy["type"])
    assertEquals(1_000L, (policy["baseDelayMs"] as Number).toLong())
    assertEquals(60_000L, (policy["maxDelayMs"] as Number).toLong())
  }
}
