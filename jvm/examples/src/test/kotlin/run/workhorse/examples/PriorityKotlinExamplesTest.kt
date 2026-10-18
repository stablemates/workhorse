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

/** Runs the Kotlin snippet of the site page about priority. */
@ExtendWith(ScratchDatabase::class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class PriorityKotlinExamplesTest {
  private val queue = Queue(ConnectionSource.of(ExampleDatabase.dataSource()))

  @Test
  fun thePriorityReachesTheTask() = runBlocking {
    val invoiceId = "kotlin-${UUID.randomUUID()}"
    PriorityKotlinExamples.enqueueUrgent(queue, invoiceId)
    val task = ExampleDatabase.task("invoice.remind", "invoiceId", invoiceId)
    assertEquals("billing", task.queue())
    assertEquals(10, task.priority())
  }
}
