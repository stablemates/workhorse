package run.workhorse.examples

import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout
import org.junit.jupiter.api.extension.ExtendWith
import run.workhorse.testing.ScratchDatabase

/** Runs the Kotlin snippet of the site page about operations. */
@ExtendWith(ScratchDatabase::class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class OperationsKotlinExamplesTest {
  private val dataSource = ExampleDatabase.dataSource()

  @Test
  fun theOperatorPausesTheRegisteredWorker() {
    OperationsExamplesTest.startBillingWorker(dataSource).use { worker ->
      val (workers, result) =
        runBlocking {
          OperationsKotlinExamples.pauseWorker(
            dataSource,
            OperationsActor("dana@example.com"),
            "kotlin-${UUID.randomUUID()}",
          )
        }
      assertTrue(workers.any { it.workerId() == "billing-worker-1" })
      val pause = checkNotNull(result)
      assertTrue(pause.paused())
      assertEquals("dana@example.com", pause.pausedBy())
      assertEquals("investigating slow provider", pause.reason())
      worker.stop()
    }
  }
}
