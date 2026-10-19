package run.workhorse.examples

import java.util.concurrent.TimeUnit
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout
import org.junit.jupiter.api.extension.ExtendWith
import run.workhorse.ConnectionSource
import run.workhorse.EnqueueOptions
import run.workhorse.Queue
import run.workhorse.TaskState
import run.workhorse.kotlin.workhorseWorker
import run.workhorse.testing.ScratchDatabase

/** Runs the Kotlin snippet of the site page about progress under a worker. */
@ExtendWith(ScratchDatabase::class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class ProgressKotlinExamplesTest {
  private val dataSource = ExampleDatabase.dataSource()

  @Test
  fun theHandlerReportsTheLastBatch() {
    val queueName = "progress-kotlin"
    val rows = ProgressExamplesTest.ProgressRows()
    val taskId =
      Queue(ConnectionSource.of(dataSource))
        .enqueue(
          "import.rows",
          mapOf("source" to "rows.csv"),
          EnqueueOptions.builder().queue(queueName).build(),
        )
        .taskId()
    val examples = ProgressKotlinExamples(rows)
    workhorseWorker(dataSource) {
        queues = listOf(queueName)
        disableRegistry = true
        handle<Map<String, Any?>>("import.rows") { context, payload ->
          examples.importRows(context, payload)
        }
      }
      .use { worker -> assertTrue(worker.runOnce()) }

    val task = ExampleDatabase.awaitTerminal(taskId)
    assertEquals(TaskState.SUCCEEDED, task.state())
    assertEquals(mapOf("processed" to 6L), task.result())
    assertEquals(listOf("rows.csv"), rows.sources)
    assertEquals(3, rows.imported.size)
    assertEquals(
      mapOf("phase" to "importing", "processed" to 6L),
      checkNotNull(task.progress()).value(),
    )
  }
}
