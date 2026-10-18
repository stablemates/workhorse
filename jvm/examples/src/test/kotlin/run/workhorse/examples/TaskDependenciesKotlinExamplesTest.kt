package run.workhorse.examples

import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout
import org.junit.jupiter.api.extension.ExtendWith
import run.workhorse.ConnectionSource
import run.workhorse.DependencyPolicy
import run.workhorse.Queue
import run.workhorse.TaskDependencyPolicy
import run.workhorse.TaskState
import run.workhorse.testing.ScratchDatabase

/** Runs the Kotlin snippet of the site page about task dependencies. */
@ExtendWith(ScratchDatabase::class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class TaskDependenciesKotlinExamplesTest {
  private val queue = Queue(ConnectionSource.of(ExampleDatabase.dataSource()))

  @Test
  fun theNotificationWaitsForTheImportWithItsPolicies() {
    val importId = runBlocking { TaskDependenciesKotlinExamples.enqueueImportAndNotify(queue) }
    val notify = ExampleDatabase.task("contacts.notify", "importId", importId.toString())
    assertEquals(TaskState.BLOCKED, notify.state())
    assertEquals(listOf(importId), notify.prerequisiteTaskIds())
    assertEquals(
      TaskDependencyPolicy(
        DependencyPolicy.RELEASE,
        DependencyPolicy.FAIL,
        DependencyPolicy.CANCEL,
      ),
      notify.dependencyPolicy(),
    )

    // A cancellation of the import cancels the notification, as `onCancellation` says.
    queue.cancel(importId, "docs-example", "the test ends")
    assertEquals(TaskState.CANCELED, ExampleDatabase.awaitTerminal(notify.id()).state())
  }
}
