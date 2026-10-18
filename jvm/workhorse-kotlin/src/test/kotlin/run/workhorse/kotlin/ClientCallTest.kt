package run.workhorse.kotlin

import java.sql.Connection
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
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
}
