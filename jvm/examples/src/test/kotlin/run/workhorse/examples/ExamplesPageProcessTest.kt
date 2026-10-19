package run.workhorse.examples

import java.nio.file.Files
import java.nio.file.Path
import java.util.UUID
import java.util.concurrent.TimeUnit
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Timeout
import org.junit.jupiter.api.extension.ExtendWith
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource
import run.workhorse.ConnectionSource
import run.workhorse.EnqueueOptions
import run.workhorse.Queue
import run.workhorse.TaskState
import run.workhorse.testing.ScratchDatabase

/**
 * Runs each billing snippet of the site page of examples in a child JVM ([ExamplesPageProcess]).
 * The snippet syncs its schedule, and its worker runs one `invoice.generate` task. Then the test
 * sends `SIGTERM`. The worker claims every task of `billing`, so each run has its own database.
 */
@ExtendWith(ScratchDatabase::class)
@Timeout(value = 180, unit = TimeUnit.SECONDS)
class ExamplesPageProcessTest {
  private var child: Process? = null
  private var errors: Path? = null
  private var database: IsolatedExampleDatabase? = null

  @AfterEach
  fun killChild() {
    try {
      child
        ?.takeIf { it.isAlive }
        ?.let {
          it.destroyForcibly()
          assertTrue(
            it.waitFor(ExampleDatabase.WAIT.toSeconds(), TimeUnit.SECONDS),
            "the child JVM ends before the test drops its database",
          )
        }
      errors?.let { Files.deleteIfExists(it) }
    } finally {
      database?.close()
    }
  }

  @ParameterizedTest
  @ValueSource(
    strings = ["java-examples-page-billing-worker", "kotlin-examples-page-billing-worker"],
  )
  fun theScheduleIsSyncedAndTheWorkerRunsTheTask(snippet: String) {
    val db = IsolatedExampleDatabase.create("examples-page-billing")
    database = db
    val scope = "$snippet-${UUID.randomUUID()}"
    val taskId =
      Queue(ConnectionSource.of(db.dataSource()))
        .enqueue(
          "invoice.generate",
          mapOf("scope" to scope),
          EnqueueOptions.builder().queue("billing").build(),
        )
        .taskId()

    val process = start(snippet, db.jdbcUrl())
    val task = db.awaitTerminal(taskId)
    assertEquals(TaskState.SUCCEEDED, task.state(), errorText())
    assertEquals(mapOf("generated" to true, "payload" to mapOf("scope" to scope)), task.result())
    assertEquals(listOf("0 3 * * *", "billing", "invoice.generate"), schedule(db))

    process.destroy()
    assertTrue(
      process.waitFor(ExampleDatabase.WAIT.toSeconds(), TimeUnit.SECONDS),
      "the child exits",
    )
    // The JVM's exit status for SIGTERM: 128 plus signal 15.
    assertEquals(143, process.exitValue(), errorText())
  }

  private fun schedule(db: IsolatedExampleDatabase): List<String> =
    db.connect().use { connection ->
      connection
        .prepareStatement(
          "SELECT cron_expression, queue_name, task_type FROM workhorse.schedule_definition" +
            " WHERE namespace = 'billing-production' AND schedule_name = 'nightly-invoice-run'",
        )
        .use { statement ->
          statement.executeQuery().use { result ->
            assertTrue(result.next(), "the schedule exists")
            listOf(result.getString(1), result.getString(2), result.getString(3))
          }
        }
    }

  private fun start(snippet: String, jdbcUrl: String): Process {
    val java = Path.of(System.getProperty("java.home"), "bin", "java").toString()
    val command =
      listOf(
        java,
        "-cp",
        System.getProperty("java.class.path"),
        ExamplesPageProcess::class.java.name,
        snippet,
        jdbcUrl,
      )
    val file = Files.createTempFile("workhorse-examples-page-process", ".err")
    errors = file
    val process =
      ProcessBuilder(command)
        .redirectError(file.toFile())
        .redirectOutput(ProcessBuilder.Redirect.DISCARD)
        .start()
    child = process
    return process
  }

  private fun errorText(): String =
    errors?.let { "child standard error: " + Files.readString(it) } ?: ""
}
