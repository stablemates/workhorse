package run.workhorse.examples

import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.Collections
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout
import org.junit.jupiter.api.extension.ExtendWith
import run.workhorse.CancelStatus
import run.workhorse.ConnectionSource
import run.workhorse.EnqueueOptions
import run.workhorse.Queue
import run.workhorse.TaskState
import run.workhorse.testing.ScratchDatabase

/** Runs the Kotlin snippets of the site page about cancellation. */
@ExtendWith(ScratchDatabase::class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class CancellationKotlinExamplesTest {
  private val dataSource = ExampleDatabase.dataSource()
  private val queue = Queue(ConnectionSource.of(dataSource))
  private val uploaded = Collections.synchronizedList(mutableListOf<Any?>())
  private val started = CountDownLatch(1)
  private val examples =
    CancellationKotlinExamples(queue, dataSource) { part, cancellation ->
      uploaded.add(part)
      started.countDown()
      // The first part is slow: it ends only when the cancellation reaches the handler.
      cancellation.await(ExampleDatabase.WAIT)
    }

  @Test
  fun aScheduledTaskIsCanceledAtOnce() = runBlocking {
    val taskId =
      queue
        .enqueue(
          "order.upload",
          mapOf("parts" to listOf("part-1")),
          EnqueueOptions.builder()
            .queue("uploads-${UUID.randomUUID()}")
            .runAt(Instant.now().plus(10, ChronoUnit.MINUTES))
            .build(),
        )
        .taskId()
    val result = examples.cancelBeforeStart(taskId, CancellationActor("dana@example.com"))
    assertEquals(CancelStatus.CANCELED, result.status())
    assertEquals("dana@example.com", result.requestedBy())
    assertEquals("customer withdrew the order", result.reason())
    assertEquals(TaskState.CANCELED, ExampleDatabase.detail(taskId).state())
  }

  @Test
  fun theHandlerStopsBeforeTheNextPart() {
    val queueName = "uploads-${UUID.randomUUID()}"
    val taskId =
      queue
        .enqueue(
          "order.upload",
          mapOf("parts" to listOf("part-1", "part-2", "part-3")),
          EnqueueOptions.builder().queue(queueName).build(),
        )
        .taskId()
    examples.uploadWorker(queueName).use { worker ->
      worker.start()
      assertTrue(started.await(ExampleDatabase.WAIT.toMillis(), TimeUnit.MILLISECONDS))
      assertEquals(
        CancelStatus.CANCEL_REQUESTED,
        queue.cancel(taskId, "dana@example.com", "customer withdrew the order").status(),
      )
      assertEquals(TaskState.CANCELED, ExampleDatabase.awaitTerminal(taskId).state())
    }
    assertEquals(listOf("part-1"), uploaded.toList())
  }
}
