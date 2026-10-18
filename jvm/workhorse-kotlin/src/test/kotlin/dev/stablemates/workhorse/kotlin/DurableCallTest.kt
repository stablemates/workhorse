package dev.stablemates.workhorse.kotlin

import dev.stablemates.workhorse.internal.Suspension
import java.time.Duration
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout

/**
 * The order of a cancellation and the end of a [durable] call, and the interrupts of a
 * [DurableCall]. Every wait is bounded.
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS)
class DurableCallTest {
  /**
   * Starts [call] in [durable], cancels the caller while the call runs, and returns what the caller
   * got. The call waits until the cancellation reached the caller, and then continues.
   */
  private fun cancelDuring(call: (DurableCall) -> Any?): Throwable? {
    val started = CountDownLatch(1)
    val cancelled = CountDownLatch(1)
    val thrown = AtomicReference<Throwable?>()
    runBlocking {
      val caller =
        launch(VirtualThreads) {
          try {
            durable { gate ->
              started.countDown()
              assertTrue(cancelled.await(WAIT_SECONDS, TimeUnit.SECONDS), "the caller is cancelled")
              call(gate)
            }
          } catch (error: Throwable) {
            thrown.set(error)
          }
        }
      assertTrue(started.await(WAIT_SECONDS, TimeUnit.SECONDS), "the call started")
      // The cancellation reaches the caller's wait at once, before the call ends.
      caller.cancel()
      cancelled.countDown()
      caller.join()
    }
    return thrown.get()
  }

  @Test
  fun keepsTheSuspensionErrorThatTheCallThrowsAfterTheCancellation() {
    // The core cancels the token, which cancels the handler's Job, and then throws its suspension.
    val thrown = cancelDuring { throw Suspension() }
    assertInstanceOf(Suspension::class.java, thrown, "the suspension reaches the worker")
  }

  @Test
  fun keepsAFailureThatTheCallThrowsAfterTheCancellation() {
    val failure = IllegalStateException("the write failed")
    val thrown = cancelDuring { throw failure }
    assertEquals(failure, thrown)
  }

  @Test
  fun deliversTheCancellationAfterACallThatReturns() {
    val ended = AtomicReference<Boolean?>()
    val thrown = cancelDuring {
      ended.set(true)
      "written"
    }
    assertEquals(true, ended.get(), "the call runs to its end")
    assertInstanceOf(CancellationException::class.java, thrown)
  }

  @Test
  fun startsCallerCodeInterruptedAfterACancellationAndClearsTheInterruptAfterIt() {
    val gate = DurableCall()
    gate.cancel()
    assertFalse(Thread.currentThread().isInterrupted, "the cancellation waits for caller code")
    val inside = gate.interruptible { Thread.currentThread().isInterrupted }
    assertTrue(inside, "caller code after the cancellation starts interrupted")
    assertFalse(
      Thread.interrupted(),
      "the core's statements after the caller code see no interrupt",
    )
  }

  @Test
  fun interruptsCallerCodeThatRunsWhenTheCancellationArrives() {
    val gate = DurableCall()
    val running = CountDownLatch(1)
    val interrupted = AtomicReference<Boolean?>()
    val leaked = AtomicReference<Boolean?>()
    val thread =
      Thread.ofVirtual().start {
        gate.interruptible {
          running.countDown()
          try {
            Thread.sleep(WAIT_SECONDS * 1000)
            interrupted.set(false)
          } catch (_: InterruptedException) {
            interrupted.set(true)
          }
        }
        leaked.set(Thread.currentThread().isInterrupted)
      }
    assertTrue(running.await(WAIT_SECONDS, TimeUnit.SECONDS), "the caller code started")
    gate.cancel()
    assertTrue(thread.join(Duration.ofSeconds(WAIT_SECONDS)), "the caller code ended")
    assertEquals(true, interrupted.get(), "the cancellation interrupts the caller code")
    assertEquals(false, leaked.get(), "the interrupt does not stay after the caller code")
  }

  @Test
  fun givesTheCallerACancellationForAnInterruptedExceptionWhileItIsActive() {
    val interrupt = InterruptedException("the operation was interrupted")
    val thrown = runBlocking { runCatching { durable { throw interrupt } }.exceptionOrNull() }
    assertInstanceOf(CancellationException::class.java, thrown)
    assertEquals(interrupt, present(thrown, "the call failed").cause, "the cause is kept")
  }

  @Test
  fun keepsTheCoreStatementsFreeOfTheInterruptAfterACancellation() {
    val before = AtomicReference<Boolean?>()
    val thrown = cancelDuring { before.set(Thread.currentThread().isInterrupted) }
    assertInstanceOf(CancellationException::class.java, thrown)
    assertEquals(false, before.get(), "the core's statements see no interrupt")
  }

  @Test
  fun deliversTheCancellationWhenTheGateInterruptsCallerCode() {
    // A blocking checkpoint operation answers the interrupt with an InterruptedException.
    val thrown = cancelDuring { gate -> gate.interruptible { Thread.sleep(WAIT_SECONDS * 1000) } }
    assertInstanceOf(CancellationException::class.java, thrown)
  }

  private fun <T : Any> present(value: T?, message: String): T =
    value ?: throw AssertionError(message)

  private companion object {
    const val WAIT_SECONDS = 20L
  }
}
