package run.workhorse.examples

import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout
import org.junit.jupiter.api.extension.ExtendWith
import run.workhorse.EnqueueOptions
import run.workhorse.TaskState
import run.workhorse.kotlin.enqueueSuspend
import run.workhorse.testing.ScratchDatabase

/** Runs the Kotlin snippets of the site page about batch handlers under a real worker. */
@ExtendWith(ScratchDatabase::class)
// Each test creates and drops its own database, which is slow on a loaded host.
@Timeout(value = 240, unit = TimeUnit.SECONDS)
class BatchHandlersKotlinExamplesTest {
  private val requests = CopyOnWriteArrayList<Int>()
  private val emailProvider = BatchEmailProvider { emails ->
    requests.add(emails.size)
    emails.map { email ->
      val to = (email as Map<*, *>)["to"].toString()
      if (to.startsWith("bounce")) BatchDelivery(to, IllegalStateException("the mailbox is full"))
      else BatchDelivery("msg-$to", null)
    }
  }

  @Test
  fun theBatchHandlerSendsTwentySevenTasksInBatchesOfAtMostTwenty() {
    // The worker reads `email`, which other snippet tests also use, so the test has its own
    // database. The batch sizes then count only the tasks of this test.
    IsolatedExampleDatabase.create("batch-handlers-kotlin").use { database ->
      val isolated = database.queue()
      val run = UUID.randomUUID().toString()
      val email = EnqueueOptions.builder().queue("email").maxAttempts(1).build()
      val tasks = runBlocking {
        (0 until 27).map { index ->
          val to = "${if (index == 0) "bounce" else "user"}-$index-$run@example.com"
          isolated.enqueueSuspend("email.send", mapOf("to" to to), email).taskId
        }
      }
      BatchHandlersKotlinExamples.batchWorker(database.dataSource(), emailProvider).use { worker ->
        worker.start()
        tasks.forEachIndexed { index, taskId ->
          val task = database.awaitTerminal(taskId)
          if (index == 0) {
            assertEquals(TaskState.FAILED, task.state())
          } else {
            assertEquals(TaskState.SUCCEEDED, task.state())
            assertEquals(mapOf("providerId" to "msg-user-$index-$run@example.com"), task.result())
          }
        }
      }
    }
    // A slow claim can split the tasks into more batches, so the test checks the bounds.
    assertEquals(27, requests.sum())
    assertTrue(requests.size >= 2, "requests: $requests")
    assertTrue(requests.all { size -> size <= 20 }, "requests: $requests")
  }

  @Test
  fun theWorkerOfThePageClaimsTheTaskOfTheProducer() {
    // The worker reads only `email`, so the producer must enqueue there. The test has its own
    // database, because other snippet tests also use `email`.
    IsolatedExampleDatabase.create("batch-handlers-producer-kotlin").use { database ->
      runBlocking { BatchHandlersKotlinExamples.enqueueEmail(database.queue()) }
      val tasks = database.tasks("email.send", "to", "person@example.com")
      assertEquals(1, tasks.size)
      BatchHandlersKotlinExamples.batchWorker(database.dataSource(), emailProvider).use { worker ->
        worker.start()
        val task = database.awaitTerminal(tasks.single())
        assertEquals(TaskState.SUCCEEDED, task.state())
        assertEquals(mapOf("providerId" to "msg-person@example.com"), task.result())
      }
    }
  }
}
