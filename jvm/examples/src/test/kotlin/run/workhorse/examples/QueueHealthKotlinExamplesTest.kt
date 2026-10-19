package run.workhorse.examples

import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout
import org.junit.jupiter.api.extension.ExtendWith
import run.workhorse.ConnectionSource
import run.workhorse.Queue
import run.workhorse.testing.ScratchDatabase

/** Runs the Kotlin snippets of the site page about queue health. */
@ExtendWith(ScratchDatabase::class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class QueueHealthKotlinExamplesTest {
  private val queue = Queue(ConnectionSource.of(ExampleDatabase.dataSource()))

  @Test
  fun theVerdictHasALevelAndReasons() = runBlocking {
    val health = QueueHealthKotlinExamples.checkHealth(queue)
    val status = health.snapshot["status"] as Map<*, *>
    assertTrue(status["level"] in listOf("healthy", "degraded", "critical"))
    assertTrue(status["reasons"] is List<*>)
  }
}
