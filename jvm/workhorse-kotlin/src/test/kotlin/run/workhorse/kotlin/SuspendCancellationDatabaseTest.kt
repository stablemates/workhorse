package run.workhorse.kotlin

import java.lang.reflect.InvocationTargetException
import java.lang.reflect.Proxy
import java.sql.Connection
import java.time.Duration
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.locks.LockSupport
import javax.sql.DataSource
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout
import org.junit.jupiter.api.extension.ExtendWith
import run.workhorse.ConnectionSource
import run.workhorse.EnqueueOptions
import run.workhorse.Queue
import run.workhorse.ShutdownIncompleteException
import run.workhorse.Worker
import run.workhorse.testing.ScratchDataSource
import run.workhorse.testing.ScratchDatabase

/**
 * A coroutine cancellation against the durable writes of a suspend handler. The module lets the
 * write finish, because an interrupt closes a virtual thread's socket, and then delivers the
 * cancellation to the handler. Every wait is bounded: a latch or a poll waits at most [WAIT], and
 * the class has a timeout.
 */
@ExtendWith(ScratchDatabase::class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class SuspendCancellationDatabaseTest {
  private val scratch = ScratchDataSource(true)
  private val queue = Queue(ConnectionSource.of(scratch))
  private var queueName = ""

  @BeforeEach
  fun name() {
    queueName = "kotlin-cancellation-${UUID.randomUUID()}"
  }

  /**
   * A source that holds the first statement whose SQL contains [marker]. The held statement waits
   * on its own thread until the test releases it or the thread is interrupted, and then runs.
   */
  private class HeldWrite(private val source: ScratchDataSource, private val marker: String) :
    DataSource by source {
    val holding = CountDownLatch(1)
    val released = CountDownLatch(1)
    val interruptedDuringWrite = CopyOnWriteArrayList<Boolean>()

    override fun getConnection(): Connection {
      val connection = source.connection
      return Proxy.newProxyInstance(
        Connection::class.java.classLoader,
        arrayOf(Connection::class.java),
      ) { _, method, arguments ->
        val sql = arguments?.firstOrNull()
        if (
          method.name == "prepareStatement" &&
            sql is String &&
            sql.contains(marker) &&
            holding.count > 0
        ) {
          holding.countDown()
          hold()
        }
        try {
          method.invoke(connection, *(arguments ?: emptyArray()))
        } catch (error: InvocationTargetException) {
          throw error.cause ?: error
        }
      } as Connection
    }

    private fun hold() {
      val limit = System.nanoTime() + WAIT.toNanos()
      while (
        !Thread.currentThread().isInterrupted && released.count > 0 && System.nanoTime() < limit
      ) {
        LockSupport.parkNanos(TimeUnit.MILLISECONDS.toNanos(1))
      }
      interruptedDuringWrite.add(Thread.currentThread().isInterrupted)
    }
  }

  private fun worker(source: DataSource, configure: WorkerScope.() -> Unit): Worker =
    workhorseWorker(source) {
      queues = listOf(queueName)
      workerId = "kotlin-cancellation"
      pollingOnly = true
      pollInterval = Duration.ofMillis(10)
      disableRegistry = true
      configure()
    }

  private fun enqueue(taskType: String): UUID = runBlocking {
    val options = EnqueueOptions.builder().queue(queueName).maxAttempts(1).build()
    queue.enqueueSuspend(taskType, null, options).taskId
  }

  /** What the handler saw: its Job, and what the checkpoint call returned or threw. */
  private class Observed {
    val job = AtomicReference<Job?>()
    val returned = AtomicReference<Any?>()
    val thrown = AtomicReference<Throwable?>()
    val done = CountDownLatch(1)
  }

  private fun checkpointHandler(observed: Observed) =
    SuspendHandler<Any?> { ctx, _ ->
      observed.job.set(currentCoroutineContext()[Job])
      try {
        observed.returned.set(ctx.checkpoint<Long>("charge") { 7L })
      } catch (error: Throwable) {
        observed.thrown.set(error)
        throw error
      } finally {
        observed.done.countDown()
      }
    }

  @Test
  fun writesACheckpointThroughAJobCancellationAndThenDeliversIt() {
    val taskId = enqueue("checkpointed")
    val held = HeldWrite(scratch, "save_checkpoint_v")
    val observed = Observed()
    val worker = worker(held) { handle("checkpointed", checkpointHandler(observed)) }
    worker.start()
    try {
      assertTrue(held.holding.await(WAIT.toSeconds(), TimeUnit.SECONDS), "the write started")
      val job = present(observed.job.get(), "the handler ran in a Job")
      job.cancel()
      held.released.countDown()
      assertTrue(observed.done.await(WAIT.toSeconds(), TimeUnit.SECONDS), "the handler ended")
    } finally {
      worker.close()
    }

    assertEquals(listOf(false), held.interruptedDuringWrite, "the write is not interrupted")
    assertEquals(1L, checkpoints(taskId), "the checkpoint row is written")
    assertNull(observed.returned.get(), "the checkpoint call does not return after the cancel")
    assertTrue(
      observed.thrown.get() is CancellationException,
      "the handler sees the cancellation after the write: ${observed.thrown.get()}",
    )
  }

  @Test
  fun writesACheckpointThroughTheDrainAndThenDeliversTheCancellation() {
    val taskId = enqueue("checkpointed")
    val held = HeldWrite(scratch, "save_checkpoint_v")
    val observed = Observed()
    val worker =
      worker(held) {
        shutdownGrace = Duration.ZERO
        handle("checkpointed", checkpointHandler(observed))
      }
    worker.start()
    val drain: Thread
    try {
      assertTrue(held.holding.await(WAIT.toSeconds(), TimeUnit.SECONDS), "the write started")
      val job = present(observed.job.get(), "the handler ran in a Job")
      drain = Thread.ofVirtual().start { worker.close() }
      waitUntil("the drain cancels the handler's Job") { job.isCancelled }
      held.released.countDown()
      assertTrue(observed.done.await(WAIT.toSeconds(), TimeUnit.SECONDS), "the handler ended")
    } finally {
      held.released.countDown()
      worker.close()
    }
    assertTrue(drain.join(WAIT), "the drain ended")

    assertEquals(listOf(false), held.interruptedDuringWrite, "the write is not interrupted")
    assertEquals(1L, checkpoints(taskId), "the checkpoint row is written")
    assertTrue(
      observed.thrown.get() is CancellationException,
      "the handler sees the cancellation after the write: ${observed.thrown.get()}",
    )
  }

  @Test
  fun stillInterruptsABlockingCheckpointOperation() {
    val taskId = enqueue("blocked")
    val started = CountDownLatch(1)
    val interrupted = AtomicReference<Boolean?>()
    val observed = Observed()
    val worker =
      worker(scratch) {
        handle<Any?>("blocked") { ctx, _ ->
          observed.job.set(currentCoroutineContext()[Job])
          try {
            ctx.checkpoint<Long>("charge") {
              started.countDown()
              try {
                Thread.sleep(WAIT.toMillis())
                interrupted.set(false)
              } catch (interrupt: InterruptedException) {
                interrupted.set(true)
                throw interrupt
              }
              7L
            }
          } catch (error: Throwable) {
            observed.thrown.set(error)
            throw error
          } finally {
            observed.done.countDown()
          }
        }
      }
    worker.start()
    try {
      assertTrue(started.await(WAIT.toSeconds(), TimeUnit.SECONDS), "the operation started")
      present(observed.job.get(), "the handler ran in a Job").cancel()
      assertTrue(observed.done.await(WAIT.toSeconds(), TimeUnit.SECONDS), "the handler ended")
    } finally {
      worker.close()
    }

    assertEquals(true, interrupted.get(), "the cancellation interrupts the blocking operation")
    assertEquals(0L, checkpoints(taskId), "an interrupted operation saves no checkpoint")
    assertTrue(
      observed.thrown.get() is CancellationException,
      "the handler sees the cancellation: ${observed.thrown.get()}",
    )
  }

  /**
   * A checkpoint operation that runs on another dispatcher, and ignores the cancellation until the
   * test releases it. It records when it ends, and the handler records when it returns.
   */
  private class OtherDispatcher {
    val started = CountDownLatch(1)
    val release = CountDownLatch(1)
    val ended = AtomicReference<Long?>()
    val returned = AtomicReference<Long?>()

    suspend fun operation(): Long =
      withContext(Dispatchers.IO) {
        started.countDown()
        // A blocking call that does not answer the cancellation, as a blocking HTTP request.
        while (!release.await(10, TimeUnit.MILLISECONDS)) {
          // Waits for the test.
        }
        ended.set(System.nanoTime())
        7L
      }
  }

  private fun otherDispatcherHandler(other: OtherDispatcher, observed: Observed) =
    SuspendHandler<Any?> { ctx, _ ->
      observed.job.set(currentCoroutineContext()[Job])
      try {
        observed.returned.set(ctx.checkpoint<Long>("charge") { other.operation() })
      } catch (error: Throwable) {
        observed.thrown.set(error)
        throw error
      } finally {
        other.returned.set(System.nanoTime())
        observed.done.countDown()
      }
    }

  // SM-1522: the checkpoint call returns only after the operation's Job ends.
  @Test
  fun aCancelledCheckpointWaitsForItsOperationOnAnotherDispatcher() {
    val taskId = enqueue("charged")
    val other = OtherDispatcher()
    val observed = Observed()
    val worker = worker(scratch) { handle("charged", otherDispatcherHandler(other, observed)) }
    worker.start()
    try {
      assertTrue(other.started.await(WAIT.toSeconds(), TimeUnit.SECONDS), "the operation started")
      present(observed.job.get(), "the handler ran in a Job").cancel()
      assertFalse(
        observed.done.await(200, TimeUnit.MILLISECONDS),
        "the checkpoint call waits while the operation runs",
      )
      assertEquals("active", state(taskId), "the task does not settle while the operation runs")
      other.release.countDown()
      assertTrue(observed.done.await(WAIT.toSeconds(), TimeUnit.SECONDS), "the handler ended")
    } finally {
      other.release.countDown()
      worker.close()
    }

    val ended = present(other.ended.get(), "the operation ended")
    assertTrue(ended <= present(other.returned.get(), "the call returned"), "the order of the ends")
    assertEquals(0L, checkpoints(taskId), "a cancelled operation saves no checkpoint")
    assertTrue(
      observed.thrown.get() is CancellationException,
      "the handler sees the cancellation: ${observed.thrown.get()}",
    )
  }

  /**
   * The drain cancels the handler's Job, but the task stays active while its checkpoint operation
   * runs. The grace is zero, so the drain gives the handler one unwind window of 250 ms. The test
   * holds the operation for longer than 100 ms after the cancellation. On a loaded host, the hold
   * can last longer than that window, and close throws while the attempt still ends (SM-1563). So
   * the test accepts that close, and then waits until the attempt gives its task back.
   */
  @Test
  fun theDrainDoesNotReleaseATaskWhileItsCheckpointOperationRuns() {
    val taskId = enqueue("charged")
    val other = OtherDispatcher()
    val observed = Observed()
    val worker =
      worker(scratch) {
        shutdownGrace = Duration.ZERO
        handle("charged", otherDispatcherHandler(other, observed))
      }
    worker.start()
    val drain: Thread
    // The drain thread is not the test thread, so the test asserts its error after the join.
    val drainError = AtomicReference<Throwable?>()
    try {
      assertTrue(other.started.await(WAIT.toSeconds(), TimeUnit.SECONDS), "the operation started")
      val job = present(observed.job.get(), "the handler ran in a Job")
      drain =
        Thread.ofVirtual().start {
          try {
            closeAfterTheUnwindWindow(worker)
          } catch (error: Throwable) {
            drainError.set(error)
          }
        }
      waitUntil("the drain cancels the handler's Job") { job.isCancelled }
      assertFalse(observed.done.await(100, TimeUnit.MILLISECONDS), "the call waits")
      assertEquals("active", state(taskId), "the drain does not release the task yet")
      other.release.countDown()
      assertTrue(observed.done.await(WAIT.toSeconds(), TimeUnit.SECONDS), "the handler ended")
    } finally {
      other.release.countDown()
      closeAfterTheUnwindWindow(worker)
    }
    assertTrue(drain.join(WAIT), "the drain ended")
    assertNull(drainError.get(), "the drain closed the worker without an error")
    waitUntil("the attempt ended") { state(taskId) != "active" }
    assertEquals("ready", state(taskId), "the drain gives the task back after the operation")

    val ended = present(other.ended.get(), "the operation ended")
    assertTrue(ended <= present(other.returned.get(), "the call returned"), "the order of the ends")
    assertEquals(0L, checkpoints(taskId), "a cancelled operation saves no checkpoint")
  }

  @Test
  fun doesNotStartADurableCallAfterTheCancellation() {
    val taskId = enqueue("late")
    val observed = Observed()
    val worker =
      worker(scratch) {
        handle<Any?>("late") { ctx, _ ->
          val job = present(currentCoroutineContext()[Job], "the handler ran in a Job")
          observed.job.set(job)
          job.cancel()
          try {
            ctx.setProgress(mapOf("step" to 1L))
          } catch (error: Throwable) {
            observed.thrown.set(error)
            throw error
          } finally {
            observed.done.countDown()
          }
        }
      }
    worker.start()
    try {
      assertTrue(observed.done.await(WAIT.toSeconds(), TimeUnit.SECONDS), "the handler ended")
    } finally {
      worker.close()
    }

    assertTrue(observed.thrown.get() is CancellationException, "the call sees the cancellation")
    assertFalse(progressWritten(taskId), "a cancelled caller does not start the write")
  }

  /**
   * Closes [worker], and accepts a drain whose handler ended after the unwind window. Every other
   * error still fails the test.
   */
  private fun closeAfterTheUnwindWindow(worker: Worker) {
    try {
      worker.close()
    } catch (slow: ShutdownIncompleteException) {
      // The attempt still ends. The test waits for its final state in the database.
    }
  }

  private fun <T : Any> present(value: T?, message: String): T =
    value ?: throw AssertionError(message)

  private fun waitUntil(message: String, condition: () -> Boolean) {
    val deadline = System.nanoTime() + WAIT.toNanos()
    while (!condition()) {
      if (System.nanoTime() > deadline) throw AssertionError("timed out: $message")
      Thread.sleep(1)
    }
  }

  private fun state(taskId: UUID): String =
    ScratchDatabase.connect().use { connection ->
      connection
        .prepareStatement(
          "SELECT COALESCE(o.state, r.state) FROM workhorse.task t" +
            " LEFT JOIN workhorse.task_runtime r ON r.task_id = t.id" +
            " LEFT JOIN workhorse.task_outcome o ON o.task_id = t.id WHERE t.id = ?::uuid",
        )
        .use { statement ->
          statement.setString(1, taskId.toString())
          statement.executeQuery().use { result ->
            assertTrue(result.next(), "the task exists")
            result.getString(1)
          }
        }
    }

  private fun checkpoints(taskId: UUID): Long =
    count("SELECT count(*) FROM workhorse.task_checkpoint WHERE task_id = ?::uuid", taskId)

  private fun progressWritten(taskId: UUID): Boolean =
    count(
      "SELECT count(*) FROM workhorse.task_progress WHERE task_id = ?::uuid",
      taskId,
    ) > 0

  private fun count(sql: String, taskId: UUID): Long =
    ScratchDatabase.connect().use { connection ->
      connection.prepareStatement(sql).use { statement ->
        statement.setString(1, taskId.toString())
        statement.executeQuery().use { result ->
          assertTrue(result.next(), "the count returns a row")
          result.getLong(1)
        }
      }
    }

  private companion object {
    val WAIT: Duration = Duration.ofSeconds(20)
  }
}
