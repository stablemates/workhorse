package run.workhorse.kotlin

import java.sql.Connection
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout
import org.junit.jupiter.api.assertThrows
import org.junit.jupiter.api.extension.ExtendWith
import run.workhorse.ConnectionSource
import run.workhorse.EnqueueOptions
import run.workhorse.Queue
import run.workhorse.testing.ScratchDataSource
import run.workhorse.testing.ScratchDatabase

/**
 * How a `Queue` or `Admin` wrapper picks its thread. No test here opens a Spring transaction scope.
 * `SuspendTransactionTest` covers the calls inside a scope, and `WithoutSpringTest` covers a class
 * path with no `spring-tx`.
 */
@ExtendWith(ScratchDatabase::class)
@Timeout(value = 60, unit = TimeUnit.SECONDS)
class ClientCallTest {
  @Test
  fun findsTheClassThroughTheFirstLoaderThatHasIt() {
    val platform = ClassLoader.getPlatformClassLoader()
    assertNull(SpringTransactionScope.find(listOf(platform, null)), "no loader has the class")
    assertNotNull(
      SpringTransactionScope.find(listOf(platform, null, ClientCallTest::class.java.classLoader)),
      "the fallback loader has the class",
    )
  }

  @Test
  fun findsNoScopeOutsideASpringTransaction() {
    assertFalse(SpringTransactionScope.active())
  }

  @Test
  fun runsASourceFormCallOnAVirtualThreadOutsideAScope() {
    val scratch = ScratchDataSource(true)
    val acquiredOn = AtomicReference<Thread?>()
    val source =
      object : ConnectionSource by ConnectionSource.of(scratch) {
        override fun acquire(): Connection {
          acquiredOn.set(Thread.currentThread())
          return scratch.connection
        }

        override fun release(connection: Connection, transactional: Boolean) = connection.close()
      }
    val caller = Thread.currentThread()
    val taskId = runBlocking {
      Queue(source)
        .enqueueSuspend(
          "kotlin.thread",
          null,
          EnqueueOptions.builder().queue("kotlin-thread-${UUID.randomUUID()}").build(),
        )
        .taskId
    }
    assertNotNull(taskId)
    val thread = checkNotNull(acquiredOn.get())
    assertTrue(thread.isVirtual, "a virtual thread acquired the connection")
    assertTrue(thread !== caller, "not the calling thread")
  }

  @Test
  fun aBoundCallFinishesThroughACancellationWithNoInterrupt() {
    val started = CountDownLatch(1)
    val cancelled = CountDownLatch(1)
    val finished = AtomicBoolean()
    val interrupted = AtomicBoolean()
    val caller = Thread.currentThread()
    val ranOn = AtomicReference<Thread?>()
    assertThrows<CancellationException> {
      runBlocking {
        val job = checkNotNull(coroutineContext[Job])
        thread {
          started.await()
          job.cancel()
          cancelled.countDown()
        }
        bound {
          ranOn.set(Thread.currentThread())
          started.countDown()
          // An interrupt would end this wait with an `InterruptedException`.
          cancelled.await()
          interrupted.set(Thread.currentThread().isInterrupted)
          finished.set(true)
        }
      }
    }
    assertTrue(finished.get(), "the call ran to its end")
    assertFalse(interrupted.get(), "the call got no interrupt")
    assertEquals(caller, ranOn.get(), "the call ran on the calling thread")
  }

  @Test
  fun aCancelledCallerDoesNotStartABoundCall() {
    val started = AtomicBoolean()
    assertThrows<CancellationException> {
      runBlocking {
        checkNotNull(coroutineContext[Job]).cancel()
        bound { started.set(true) }
      }
    }
    assertFalse(started.get())
  }

  // SM-1526: a cancellation does not interrupt a call on the caller's own connection, because an
  // interrupt closes the socket of a virtual thread and PostgreSQL ends the caller's transaction.
  @Test
  fun aCallOnTheCallersConnectionKeepsItsTransactionThroughACancellation() {
    val queue = Queue(ConnectionSource.of(ScratchDataSource(true)))
    val options = EnqueueOptions.builder().queue("kotlin-own-${UUID.randomUUID()}").build()
    ScratchDatabase.connect().use { caller ->
      caller.autoCommit = false
      val pid = single(caller, "SELECT pg_backend_pid()", null)
      val taskId = AtomicReference<UUID?>()
      ScratchDatabase.connect().use { locker ->
        // The lock makes the enqueue wait inside its statement.
        locker.autoCommit = false
        locker.createStatement().use { it.execute("LOCK TABLE workhorse.task IN EXCLUSIVE MODE") }
        runBlocking {
          val call =
            launch(Dispatchers.Default) {
              taskId.set(queue.enqueueSuspend("kotlin.own", null, options, caller).taskId)
            }
          waitForLock(pid)
          call.cancel()
          // A cancelled call waits for its statement, so it cannot end while the lock holds.
          delay(200)
          assertFalse(call.isCompleted, "the call waits for its statement")
          locker.rollback()
          call.join()
          assertTrue(call.isCancelled, "the caller gets the cancellation")
        }
      }
      assertTrue(caller.isValid(5), "the caller's connection is still open")
      caller.commit()
      val stored =
        single(caller, "SELECT count(*) FROM workhorse.task WHERE task_type = ?", "kotlin.own")
      assertEquals("1", stored, "the enqueue commits with the caller's transaction")
      assertNull(taskId.get(), "the cancelled caller does not see the result")
    }
  }

  /**
   * Waits at most 10 s until the backend [pid] waits for a lock. Each check is its own autocommit
   * statement, because PostgreSQL keeps one statistics snapshot for the length of a transaction.
   */
  private fun waitForLock(pid: String?) {
    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
    val sql =
      "SELECT count(*) FROM pg_stat_activity WHERE pid = ?::int AND wait_event_type = 'Lock'"
    ScratchDatabase.connect().use { observer ->
      while (single(observer, sql, pid) != "1") {
        if (System.nanoTime() > deadline) throw AssertionError("the call never waited for the lock")
        Thread.sleep(10)
      }
    }
  }

  private fun single(connection: Connection, sql: String, parameter: String?): String? =
    connection.prepareStatement(sql).use { statement ->
      if (parameter != null) statement.setString(1, parameter)
      statement.executeQuery().use { result -> if (result.next()) result.getString(1) else null }
    }
}
