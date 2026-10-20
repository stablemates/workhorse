package run.workhorse.kotlin

import java.lang.reflect.Type
import java.time.Duration
import java.time.Instant
import java.util.concurrent.Callable
import kotlin.coroutines.ContinuationInterceptor
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.runBlocking
import run.workhorse.CancellationToken
import run.workhorse.CheckpointOptions
import run.workhorse.ChildOutcome
import run.workhorse.ChildRequest
import run.workhorse.ClaimedTask
import run.workhorse.EnqueueOptions
import run.workhorse.EnqueueRequest
import run.workhorse.EnqueueResult
import run.workhorse.HandlerContext
import run.workhorse.TaskCheckpoint
import run.workhorse.TaskGroupContext
import run.workhorse.TaskGroupLink
import run.workhorse.TaskProgress

/**
 * What a suspend handler receives beside its payload. It wraps the core's `HandlerContext`, and
 * each suspend method runs the matching Java method on a virtual thread.
 *
 * A cancellation of the handler's `Job` does not interrupt a durable call while the core reads or
 * writes. The call runs to its end, so the core keeps a checkpoint or progress write, and then the
 * method throws the cancellation. A cancellation interrupts only the operation of [checkpoint].
 *
 * A durable wait that is not yet done, and a child join whose children have not finished, suspend
 * the task, as in the core. The call unwinds the handler with an internal `Error`. A handler that
 * catches it, for example with `runCatching`, still suspends, because the worker reads the core's
 * suspension flag.
 */
public class SuspendHandlerContext
internal constructor(
  /** The core's context, for a call that this class does not wrap. */
  public val java: HandlerContext,
) {
  /** The task this attempt runs. */
  public val task: ClaimedTask
    get() = java.task()

  /** The attempt's cancellation token. */
  public val cancellation: CancellationToken
    get() = java.cancellation()

  /** Whether the attempt's token is cancelled. */
  public val isCancelled: Boolean
    get() = java.isCancelled

  /** The checkpoint named [name] that this task saved, or `null` when it saved none. */
  public suspend fun getCheckpoint(name: String): TaskCheckpoint? = durable {
    java.getCheckpoint(name).orElse(null)
  }

  /**
   * Returns the value that the checkpoint [name] saved, decoded as [T]. The call runs [operation]
   * only when no such checkpoint exists, and saves its value. With [options], the checkpoint also
   * compares the fingerprint of the input, as the core's `checkpoint` does.
   *
   * If the saved value is `null` and [T] is not nullable, the call throws
   * `IllegalArgumentException`.
   */
  public suspend inline fun <reified T> checkpoint(
    name: String,
    options: CheckpointOptions? = null,
    noinline operation: suspend () -> T,
  ): T {
    val value: T = checkpoint(name, javaTypeOf<T>(), options, operation)
    if (value == null && null !is T) {
      throw IllegalArgumentException(
        "The checkpoint $name holds null, and its type is not nullable",
      )
    }
    return value
  }

  @PublishedApi
  internal suspend fun <T> checkpoint(
    name: String,
    type: Type,
    options: CheckpointOptions?,
    operation: suspend () -> T,
  ): T {
    // The operation runs inside the core's call, on its thread. It keeps the caller's context
    // elements but not its Job: a cancellation interrupts the thread while the operation runs, and
    // `runBlocking` then cancels the operation. `runBlocking` returns only after the operation
    // ends, so work that the operation runs on another dispatcher, for example in `withContext`,
    // also ends first. kotlinx-coroutines 1.10.2, the floor of this module, behaves so. The core's
    // write after the operation is not interrupted.
    val context = currentCoroutineContext().minusKey(ContinuationInterceptor).minusKey(Job)
    return durable { call ->
      val callable = Callable { call.interruptible { runBlocking(context) { operation() } } }
      if (options == null) java.checkpoint(name, type, callable)
      else java.checkpoint(name, type, options, callable)
    }
  }

  /** Suspends the task for [duration] under the durable timer [name]. */
  public suspend fun sleep(name: String, duration: Duration): Unit = durable {
    java.sleep(name, duration)
  }

  /** Suspends the task until [time] under the durable timer [name]. */
  public suspend fun sleepUntil(name: String, time: Instant): Unit = durable {
    java.sleepUntil(name, time)
  }

  /**
   * Returns the payload of the signal [name], decoded as [T]. The task suspends until a signal
   * arrives, or until [timeout] passes. A `null` timeout waits without a limit.
   *
   * If the payload is `null` and [T] is not nullable, the call throws `IllegalArgumentException`.
   */
  public suspend inline fun <reified T> waitForSignal(name: String, timeout: Duration? = null): T {
    val value: T = waitForSignal(name, javaTypeOf<T>(), timeout)
    if (value == null && null !is T) {
      throw IllegalArgumentException(
        "The signal $name has a null payload, and its type is not nullable",
      )
    }
    return value
  }

  @PublishedApi
  internal suspend fun <T> waitForSignal(name: String, type: Type, timeout: Duration?): T =
    durable {
      java.waitForSignal(name, type, timeout)
    }

  /**
   * Returns the decision that a person recorded for the wait [name], decoded as [T]. [context] is
   * the JSON value that person sees. The task suspends until a decision arrives, or until [timeout]
   * passes.
   *
   * If the decision is `null` and [T] is not nullable, the call throws `IllegalArgumentException`.
   */
  public suspend inline fun <reified T> waitForHuman(
    name: String,
    context: Any? = null,
    timeout: Duration? = null,
  ): T {
    val value: T = waitForHuman(name, context, javaTypeOf<T>(), timeout)
    if (value == null && null !is T) {
      throw IllegalArgumentException(
        "The human wait $name has a null decision, and its type is not nullable",
      )
    }
    return value
  }

  @PublishedApi
  internal suspend fun <T> waitForHuman(
    name: String,
    context: Any?,
    type: Type,
    timeout: Duration?,
  ): T = durable { java.waitForHuman(name, context, type, timeout) }

  /**
   * Returns the result of the child task [name], decoded as [T]. The call creates the child and
   * suspends the task until the child succeeds.
   *
   * If the result is `null` and [T] is not nullable, the call throws `IllegalArgumentException`.
   */
  public suspend inline fun <reified T> runChild(
    name: String,
    taskType: String,
    payload: Any? = null,
    options: EnqueueOptions = EnqueueOptions.defaults(),
  ): T {
    val value: T = runChild(name, taskType, payload, options, javaTypeOf<T>())
    if (value == null && null !is T) {
      throw IllegalArgumentException(
        "The child $name has a null result, and its type is not nullable",
      )
    }
    return value
  }

  @PublishedApi
  internal suspend fun <T> runChild(
    name: String,
    taskType: String,
    payload: Any?,
    options: EnqueueOptions,
    resultType: Type,
  ): T = durable { java.runChild(name, taskType, payload, options, resultType) }

  /** Creates [children] together, and returns the outcome of each one by child name. */
  public suspend fun runChildren(children: List<ChildRequest>): Map<String, ChildOutcome> =
    durable {
      java.runChildren(children)
    }

  /** Creates [children] together, and returns the result of each one by child name. */
  public suspend fun runChildrenAll(children: List<ChildRequest>): Map<String, Any?> = durable {
    java.runChildrenAll(children)
  }

  /** The progress that this task reported last, or `null`. */
  public suspend fun getProgress(): TaskProgress? = durable { java.progress.orElse(null) }

  /** Stores [progress], a JSON value, and returns the stored progress. */
  public suspend fun setProgress(progress: Any?): TaskProgress = durable {
    java.setProgress(progress)
  }

  /** The task group operations of this activation. */
  public val taskGroup: SuspendTaskGroupContext
    get() = SuspendTaskGroupContext(java.taskGroup())
}

/** The suspend counterpart of the core's `TaskGroupContext`. */
public class SuspendTaskGroupContext
internal constructor(
  /** The core's task group context. */
  public val java: TaskGroupContext,
) {
  /** The task's role, callback kind, and group, or `null` when the task is in no group. */
  public suspend fun get(): TaskGroupLink? = durable { java.get().orElse(null) }

  /** Adds [requests] to the task's group, under the task's lease and fence. */
  public suspend fun add(requests: List<EnqueueRequest>): List<EnqueueResult> = durable {
    java.add(requests)
  }
}
