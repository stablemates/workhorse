package run.workhorse.examples

import java.time.Duration
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout
import org.junit.jupiter.api.extension.ExtendWith
import run.workhorse.EnqueueOptions
import run.workhorse.EnqueueRequest
import run.workhorse.TaskGroup
import run.workhorse.TaskGroupCallbackKind
import run.workhorse.TaskGroupCallbacks
import run.workhorse.TaskGroupResult
import run.workhorse.TaskGroupState
import run.workhorse.TaskState
import run.workhorse.kotlin.taskGroupSuspend
import run.workhorse.kotlin.workhorseWorker
import run.workhorse.testing.ScratchDatabase

/** Runs the Kotlin snippets of the site page about task groups under real workers. */
@ExtendWith(ScratchDatabase::class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class TaskGroupsKotlinExamplesTest {
  // The workers read `imports` and `import-rows`, which the Java tests also use, so each test has
  // its own database.
  private val database = IsolatedExampleDatabase.create("task-groups-kotlin")
  private val dataSource = database.dataSource()
  private val queue = database.queue()

  @AfterEach
  fun dropDatabase() {
    database.close()
  }

  @Test
  fun theGroupHoldsEveryRowAndEnqueuesTheReportWhenItFinishes() {
    // 1,001 rows take two add calls of the builder.
    val rows = (0 until 1_001).map { index -> "row-$index" }
    val group = runBlocking {
      TaskGroupsKotlinExamples.importRows(queue, TaskGroupsImportFile(rows))
    }
    assertEquals(TaskGroupState.SEALED, group.state())
    assertEquals(1_001, group.counts().total())
    assertEquals(TaskGroupCallbackKind.ON_FINISH, group.callbacks()[0].kind())

    workhorseWorker(dataSource) {
        queues = listOf("imports")
        concurrency = 32
        pollInterval = Duration.ofMillis(50)
        handle<Map<String, Any?>>("imports.row") { _, _ -> null }
        handle<Map<String, Any?>>("imports.report") { _, _ -> mapOf("sent" to true) }
      }
      .use { worker ->
        worker.start()
        val finished = awaitFinished(group.id())
        assertEquals(TaskGroupResult.SUCCEEDED, finished.result())
        assertEquals(1_001, finished.counts().succeeded())
        val report = database.awaitTerminal(callbackTask(finished))
        assertEquals("imports.report", report.type())
        assertEquals("imports", report.queue())
        assertEquals(TaskState.SUCCEEDED, report.state())
      }
  }

  @Test
  fun theReportHandlerReadsTheCountsOfItsGroup() {
    val rows = EnqueueOptions.builder().queue("import-rows").maxAttempts(1).build()
    val report =
      EnqueueRequest.of(
        "imports.report",
        mapOf("importId" to "imp-7"),
        EnqueueOptions.builder().queue("imports").build(),
      )
    val group = runBlocking {
      queue
        .taskGroupSuspend(TaskGroupCallbacks(report, null, null)) {
          add(
            listOf(
              EnqueueRequest.of("imports.row", mapOf("row" to "good"), rows),
              EnqueueRequest.of("imports.row", mapOf("row" to "bad"), rows),
            ),
          )
        }
        .group
    }
    val reports = CopyOnWriteArrayList<List<Any?>>()
    val reporter = TaskGroupsReporter { importId, succeeded, failed ->
      reports.add(listOf(importId, succeeded, failed))
    }

    val rowWorker =
      workhorseWorker(dataSource) {
        queues = listOf("import-rows")
        pollInterval = Duration.ofMillis(50)
        handle<Map<String, Any?>>("imports.row") { _, row ->
          require(row["row"] != "bad") { "the row has no email" }
          null
        }
      }
    rowWorker.use {
      TaskGroupsKotlinExamples.reportWorker(dataSource, reporter).use { reportWorker ->
        rowWorker.start()
        reportWorker.start()
        val done = database.awaitTerminal(callbackTask(awaitFinished(group.id())))
        assertEquals(TaskState.SUCCEEDED, done.state())
        assertEquals(mapOf("sent" to true), done.result())
        assertEquals(listOf(listOf("imp-7", 1L, 1L)), reports)
      }
    }
  }

  private fun callbackTask(group: TaskGroup): UUID = checkNotNull(group.callbacks()[0].taskId())

  private fun awaitFinished(groupId: UUID): TaskGroup {
    val deadline = System.nanoTime() + ExampleDatabase.WAIT.toNanos()
    while (true) {
      val group = queue.getTaskGroup(groupId).orElseThrow()
      if (group.state() == TaskGroupState.FINISHED) {
        return group
      }
      assertTrue(System.nanoTime() < deadline, "group $groupId is still ${group.state()}")
      Thread.sleep(50)
    }
  }
}
