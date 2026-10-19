package run.workhorse.examples

import java.time.Duration
import java.time.Instant
import java.time.temporal.ChronoUnit
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

/** Runs the Kotlin snippets of the site page about deadlines and execution timeouts. */
@ExtendWith(ScratchDatabase::class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class DeadlinesKotlinExamplesTest {
  private val queue = Queue(ConnectionSource.of(ExampleDatabase.dataSource()))

  @Test
  fun theDeadlineReachesTheTask() = runBlocking {
    val quoteId = "kotlin-${UUID.randomUUID()}"
    val quoteExpiresAt = Instant.now().plus(1, ChronoUnit.HOURS).truncatedTo(ChronoUnit.SECONDS)
    DeadlinesKotlinExamples.deadline(queue, quoteId, quoteExpiresAt)
    assertEquals(
      quoteExpiresAt,
      ExampleDatabase.task("price.quote", "quoteId", quoteId).deadlineAt(),
    )
  }

  @Test
  fun theExecutionTimeoutAndTheBudgetReachTheTask() = runBlocking {
    val reportId = "kotlin-${UUID.randomUUID()}"
    DeadlinesKotlinExamples.executionTimeout(queue, reportId, Duration.ofMinutes(2), 3)
    val task = ExampleDatabase.task("report.build", "reportId", reportId)
    assertEquals(Duration.ofMinutes(2), task.executionTimeout())
    assertEquals(3, task.maxAttempts())
  }
}
