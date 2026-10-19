package run.workhorse.examples

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

/** Runs the Kotlin snippets of the site page about enqueue idempotency. */
@ExtendWith(ScratchDatabase::class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class IdempotencyKotlinExamplesTest {
  private val queue = Queue(ConnectionSource.of(ExampleDatabase.dataSource()))

  @Test
  fun aSecondRequestWithTheSameKeyReturnsTheSameTask() = runBlocking {
    val invoiceId = "kotlin-${UUID.randomUUID()}"
    val first = IdempotencyKotlinExamples.enqueueOnce(queue, invoiceId)
    val second = IdempotencyKotlinExamples.enqueueOnce(queue, invoiceId)
    assertEquals(first, second)
    assertEquals(first, ExampleDatabase.task("invoice.capture", "invoiceId", invoiceId).id())
    assertEquals("billing", ExampleDatabase.detail(first).queue())
  }

  @Test
  fun theResultSaysIfTheRequestWasADuplicate() = runBlocking {
    val invoiceId = "kotlin-${UUID.randomUUID()}"
    val key = "capture:$invoiceId"
    val first = IdempotencyKotlinExamples.enqueueWithResult(queue, invoiceId, key)
    val second = IdempotencyKotlinExamples.enqueueWithResult(queue, invoiceId, key)
    assertEquals(EnqueueOutcome.ACCEPTED, first.outcome())
    assertEquals(EnqueueOutcome.REPLAYED, second.outcome())
    assertEquals(first.taskId(), second.taskId())
  }
}
