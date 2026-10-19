package run.workhorse.examples

import java.time.Duration
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout
import org.junit.jupiter.api.extension.ExtendWith
import run.workhorse.ConnectionSource
import run.workhorse.EnqueueOutcome
import run.workhorse.Queue
import run.workhorse.testing.ScratchDatabase

/** Runs the Kotlin snippets of the site page about throttle. */
@ExtendWith(ScratchDatabase::class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class ThrottleKotlinExamplesTest {
  private val queue = Queue(ConnectionSource.of(ExampleDatabase.dataSource()))

  @Test
  fun aSecondRequestInTheWindowIsCoalesced() = runBlocking {
    val accountId = "kotlin-${UUID.randomUUID()}"
    val first = ThrottleKotlinExamples.throttle(queue, accountId, Duration.ofMinutes(10))
    val second = ThrottleKotlinExamples.throttle(queue, accountId, Duration.ofMinutes(10))
    assertEquals(EnqueueOutcome.ACCEPTED, first.outcome())
    assertEquals(EnqueueOutcome.COALESCED, second.outcome())
    assertEquals(first.taskId(), second.taskId())
    assertEquals(first.taskId(), ExampleDatabase.task("email.digest", "accountId", accountId).id())
  }
}
