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

/** Runs the Kotlin snippets of the site page about debounce. */
@ExtendWith(ScratchDatabase::class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class DebounceKotlinExamplesTest {
  private val queue = Queue(ConnectionSource.of(ExampleDatabase.dataSource()))

  @Test
  fun aSecondRevisionReplacesThePendingTask() = runBlocking {
    val documentId = "kotlin-${UUID.randomUUID()}"
    val first = DebounceKotlinExamples.debounce(queue, documentId, 1, Duration.ofMinutes(5))
    val second = DebounceKotlinExamples.debounce(queue, documentId, 2, Duration.ofMinutes(5))
    assertEquals(EnqueueOutcome.ACCEPTED, first.outcome())
    assertEquals(EnqueueOutcome.REPLACED, second.outcome())
    assertEquals(first.taskId(), second.taskId())
    // The payload holds the latest revision.
    assertEquals(
      listOf(first.taskId()),
      ExampleDatabase.tasks("search.reindex", "revision", "2").filter { it == first.taskId() },
    )
    assertEquals(
      first.taskId(),
      ExampleDatabase.task("search.reindex", "documentId", documentId).id(),
    )
  }
}
