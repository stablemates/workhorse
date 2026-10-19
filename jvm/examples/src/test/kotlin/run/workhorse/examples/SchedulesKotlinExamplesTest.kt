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
import run.workhorse.ScheduleDefinition
import run.workhorse.ScheduledTask
import run.workhorse.testing.ScratchDatabase

/** Runs the Kotlin snippets of the site page about schedules. */
@ExtendWith(ScratchDatabase::class)
// Each test creates and drops its own database, which is slow on a loaded host.
@Timeout(value = 240, unit = TimeUnit.SECONDS)
class SchedulesKotlinExamplesTest {
  private val dataSource = ExampleDatabase.dataSource()
  private val queue = Queue(ConnectionSource.of(dataSource))
  private val examples = SchedulesKotlinExamples(queue, dataSource)

  @Test
  fun theSynchronizationStoresTheDefinition() = runBlocking {
    examples.syncSchedules("0 2 * * *")
    assertEquals(
      mapOf(
        "cron_expression" to "0 2 * * *",
        "timezone" to "America/New_York",
        "queue_name" to "billing",
        "task_type" to "invoice.generate",
        "scope" to "due",
        "configured_enabled" to true,
      ),
      SchedulesExampleRows.definition("billing-production", "invoice-run"),
    )
  }

  @Test
  fun theWorkerThatOffersTheNamespaceFiresItsSchedule() {
    // The snippet's worker reads the default queue, so the test has its own database.
    IsolatedExampleDatabase.create("schedules-kotlin-worker").use { database ->
      val isolated = database.queue()
      val scope = "kotlin-${UUID.randomUUID()}"
      // Each second is an occurrence, so the worker fires one at its next maintenance tick.
      isolated.syncSchedules(
        "billing-production",
        listOf(
          ScheduleDefinition(
            "invoice-run",
            "* * * * * *",
            ScheduledTask(
              "invoice.generate",
              mapOf("scope" to scope),
              "billing",
              0,
              null,
              null,
              null,
            ),
          ),
        ),
      )
      SchedulesKotlinExamples(isolated, database.dataSource()).scheduleWorker().use { worker ->
        worker.start()
        val taskId = SchedulesExampleRows.awaitTask(database, "invoice.generate", scope)
        assertEquals("billing", database.detail(taskId).queue())
      }
    }
  }
}
