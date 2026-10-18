package dev.stablemates.workhorse.kotlin

import java.lang.reflect.GenericArrayType
import java.lang.reflect.ParameterizedType
import java.lang.reflect.Type
import java.lang.reflect.TypeVariable
import java.lang.reflect.WildcardType
import java.util.concurrent.Executors
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import kotlin.reflect.javaType
import kotlin.reflect.typeOf
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.async
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.withContext

/**
 * The dispatcher of every suspend handler and every blocking call of this module. It starts one
 * virtual thread for each coroutine task, as the core does for each handler (ADR 0103,
 * "Concurrency"). Virtual threads do not keep the JVM alive, so the module never closes it.
 */
internal val VirtualThreads: CoroutineDispatcher =
  Executors.newThreadPerTaskExecutor(Thread.ofVirtual().name("workhorse-kotlin-", 0).factory())
    .asCoroutineDispatcher()

/**
 * Runs a blocking call of the core on a virtual thread. A cancellation of the caller interrupts
 * that thread. An interrupt closes the socket of a JDBC read on a virtual thread, so the connection
 * of a cancelled call is not usable after it.
 */
@PublishedApi
internal suspend fun <T> blocking(call: () -> T): T = runInterruptible(VirtualThreads, call)

/**
 * Runs a durable call of a suspend handler on a virtual thread. Unlike [blocking], a cancellation
 * of the caller does not interrupt the core's own statements, because an interrupt closes the
 * socket of a virtual thread and loses the write. The call runs to its end, and then the caller
 * gets the cancellation, or the call's own failure when the call fails. Only the caller code that
 * [call] marks with [DurableCall.interruptible], such as a checkpoint operation, gets an interrupt.
 * A caller that is already cancelled does not start the call.
 */
@OptIn(ExperimentalCoroutinesApi::class)
internal suspend fun <T> durable(call: (DurableCall) -> T): T {
  val context = currentCoroutineContext()
  context.ensureActive()
  val gate = DurableCall()
  // The call is not a child of the caller, so a cancellation of the caller does not cancel it. It
  // keeps the caller's context elements, as `runInterruptible` does.
  val running = CoroutineScope(context.minusKey(Job) + VirtualThreads).async { call(gate) }
  val result =
    try {
      running.await()
    } catch (interrupt: InterruptedException) {
      // Caller code answered an interrupt while the caller is active. `runInterruptible` gives the
      // caller a cancellation in this case too.
      val cause = running.getCompletionExceptionOrNull() ?: interrupt
      throw CancellationException("Blocking call was interrupted", cause)
    } catch (cancelled: CancellationException) {
      gate.cancel()
      // A failure of the call wins over the cancellation, as with `withContext`. The core cancels
      // the token before it throws its suspension `Error`, and that `Error` must reach the worker.
      // An `InterruptedException` answers the gate's interrupt, so the caller gets the
      // cancellation, as `runInterruptible` does.
      val failure =
        withContext(NonCancellable) {
          running.join()
          running.getCompletionExceptionOrNull()
        }
      throw when (failure) {
        null,
        is CancellationException,
        is InterruptedException -> cancelled
        else -> failure
      }
    }
  // A cancellation that arrives as the call ends reaches the caller too, as with `blocking`.
  context.ensureActive()
  return result
}

/**
 * The interrupt state of one [durable] call. A cancellation interrupts the call's thread only while
 * caller code runs in [interruptible]. Otherwise the cancellation waits, and the next
 * [interruptible] block starts with the interrupt.
 */
internal class DurableCall {
  private val lock = ReentrantLock()
  private var thread: Thread? = null
  private var depth = 0
  private var cancelled = false

  /** Records the caller's cancellation, and interrupts caller code that runs now. */
  fun cancel() {
    lock.withLock {
      cancelled = true
      if (depth > 0) thread?.interrupt()
    }
  }

  /**
   * Runs [operation], caller code, so that a cancellation interrupts it. When the outermost block
   * ends, the thread loses its interrupt, before control returns to the core's statements.
   */
  fun <T> interruptible(operation: () -> T): T {
    lock.withLock {
      if (depth++ == 0) thread = Thread.currentThread()
      if (cancelled) Thread.currentThread().interrupt()
    }
    try {
      return operation()
    } finally {
      lock.withLock {
        if (--depth == 0) {
          thread = null
          Thread.interrupted()
        }
      }
    }
  }
}

/** The Java type of [T], with its type arguments, for the core's codec. */
@OptIn(ExperimentalStdlibApi::class)
@PublishedApi
internal inline fun <reified T> javaTypeOf(): Type =
  when (val type = typeOf<T>().javaType) {
    is Class<*> -> type.kotlin.javaObjectType
    else -> type
  }

/**
 * The class that [type] erases to, with a primitive class boxed. A generic array erases to the
 * array class of its erased component, so `Array<List<Long>>` gives `List[]`.
 */
@PublishedApi
internal fun erasure(type: Type): Class<*> =
  when (type) {
    is Class<*> -> type.kotlin.javaObjectType
    is ParameterizedType -> erasure(type.rawType)
    is GenericArrayType ->
      java.lang.reflect.Array.newInstance(erasure(type.genericComponentType), 0).javaClass
    is WildcardType -> erasure(type.upperBounds.first())
    is TypeVariable<*> -> erasure(type.bounds.first())
    else -> Any::class.java
  }
