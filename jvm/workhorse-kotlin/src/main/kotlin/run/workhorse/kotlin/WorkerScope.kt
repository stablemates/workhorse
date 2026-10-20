package run.workhorse.kotlin

import java.lang.reflect.Type
import java.time.Duration
import java.util.concurrent.CancellationException
import java.util.concurrent.ExecutionException
import java.util.concurrent.ExecutorService
import javax.sql.DataSource
import kotlinx.coroutines.CoroutineName
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.future.asCompletableFuture
import run.workhorse.BatchHandler
import run.workhorse.BatchOptions
import run.workhorse.CancelledException
import run.workhorse.Handler
import run.workhorse.HandlerContext
import run.workhorse.JsonCodec
import run.workhorse.RetryDelay
import run.workhorse.TaskHandler
import run.workhorse.Worker
import run.workhorse.WorkhorseTelemetry

/** Marks the worker DSL, so a nested block cannot call the outer block's members. */
@DslMarker public annotation class WorkhorseDsl

/**
 * Builds a [Worker] with [configure]. The counterpart of `Worker.builder(dataSource)`.
 *
 * ```
 * val worker = workhorseWorker(dataSource) {
 *   queues = listOf("orders")
 *   handle<Order>("send-receipt") { ctx, order -> receipts.send(order) }
 * }
 * ```
 */
public fun workhorseWorker(dataSource: DataSource, configure: WorkerScope.() -> Unit): Worker =
  WorkerScope(Worker.builder(dataSource)).apply(configure).build()

/**
 * The options and handlers of one worker. Each property sets the `Worker.Builder` option of the
 * same name. A property that stays `null` keeps the core's default.
 *
 * Each suspend handler runs in a coroutine scope of this worker, on a virtual-thread dispatcher.
 */
@WorkhorseDsl
public class WorkerScope internal constructor(private val builder: Worker.Builder) {
  private val scope = CoroutineScope(SupervisorJob() + VirtualThreads + CoroutineName("workhorse"))

  public var queues: List<String>? = null
  public var workerId: String? = null
  public var concurrency: Int? = null
  public var executor: ExecutorService? = null
  public var lease: Duration? = null
  /** The interval between lease renewals. The smallest supported value is 100 ms. */
  public var heartbeat: Duration? = null
  public var pollInterval: Duration? = null
  public var pollingOnly: Boolean? = null
  public var maintenanceInterval: Duration? = null
  public var maintenanceRoutineInterval: Duration? = null
  public var registryInterval: Duration? = null
  public var disableRegistry: Boolean? = null
  public var scheduleNamespaces: List<String>? = null
  public var scheduleCatchupLimit: Int? = null
  public var shutdownGrace: Duration? = null
  public var sharedHeartbeats: Boolean? = null
  public var cohorts: Int? = null
  public var retryDelay: RetryDelay? = null
  public var onRegistrationError: ((Throwable) -> Unit)? = null
  public var onNotificationError: ((Throwable) -> Unit)? = null
  public var logger: System.Logger? = null
  public var codec: JsonCodec? = null
  public var telemetry: WorkhorseTelemetry? = null

  /**
   * Registers [handler] for [taskType]. The worker decodes each payload as [P], with its type
   * arguments, so `handle<List<Order>>` receives a list of `Order`. Registering a task type again
   * replaces its handler.
   *
   * A JSON `null` payload reaches [handler] only when [P] is nullable, as in `handle<Order?>`.
   * Otherwise the attempt fails with `IllegalArgumentException`, and [handler] does not run.
   */
  public inline fun <reified P> handle(taskType: String, handler: SuspendHandler<P>) {
    register(
      taskType,
      javaTypeOf<P>(),
      if (null is P) handler
      else
        SuspendHandler { ctx, payload ->
          handler.handle(
            ctx,
            payload
              ?: throw IllegalArgumentException(
                "The payload of task type $taskType is null, and the payload type is not nullable",
              ),
          )
        },
    )
  }

  /**
   * Registers the blocking batch [handler] for [taskType], as `Worker.Builder.handleBatch` does.
   * The worker decodes each payload as [P], with its type arguments. The module has no suspend
   * batch handler.
   */
  public inline fun <reified P> handleBatch(
    taskType: String,
    options: BatchOptions,
    handler: BatchHandler<P>,
  ) {
    registerBatch(taskType, javaTypeOf<P>(), options, handler)
  }

  @PublishedApi
  internal fun <P> registerBatch(
    taskType: String,
    payloadType: Type,
    options: BatchOptions,
    handler: BatchHandler<P>,
  ) {
    builder.handleBatch(taskType, payloadType, options, handler)
  }

  @PublishedApi
  internal fun <P> register(taskType: String, payloadType: Type, handler: SuspendHandler<P>) {
    builder.handle(SuspendTaskHandler(taskType, payloadType, SuspendHandlerAdapter(scope, handler)))
  }

  /** Configures the core's builder directly, for an option that this scope has no property for. */
  public fun java(configure: Worker.Builder.() -> Unit) {
    builder.configure()
  }

  internal fun build(): Worker {
    queues?.let { builder.queues(*it.toTypedArray()) }
    workerId?.let(builder::workerId)
    concurrency?.let(builder::concurrency)
    executor?.let(builder::executor)
    lease?.let(builder::lease)
    heartbeat?.let(builder::heartbeat)
    pollInterval?.let(builder::pollInterval)
    pollingOnly?.let(builder::pollingOnly)
    maintenanceInterval?.let(builder::maintenanceInterval)
    maintenanceRoutineInterval?.let(builder::maintenanceRoutineInterval)
    registryInterval?.let(builder::registryInterval)
    disableRegistry?.let(builder::disableRegistry)
    scheduleNamespaces?.let { builder.scheduleNamespaces(*it.toTypedArray()) }
    scheduleCatchupLimit?.let(builder::scheduleCatchupLimit)
    shutdownGrace?.let(builder::shutdownGrace)
    sharedHeartbeats?.let(builder::sharedHeartbeats)
    cohorts?.let(builder::cohorts)
    retryDelay?.let(builder::retryDelay)
    onRegistrationError?.let { listener -> builder.onRegistrationError { listener(it) } }
    onNotificationError?.let { listener -> builder.onNotificationError { listener(it) } }
    logger?.let(builder::logger)
    codec?.let(builder::codec)
    telemetry?.let(builder::telemetry)
    return builder.build()
  }
}

/**
 * Registers a suspend handler through `Worker.Builder.handle(TaskHandler)`, so the core decodes
 * each payload as the full [payloadType], with its type arguments.
 */
internal class SuspendTaskHandler<P>(
  private val taskType: String,
  private val payloadType: Type,
  private val handler: Handler<P>,
) : TaskHandler<P> {
  override fun taskType(): String = taskType

  override fun payloadType(): Type = payloadType

  override fun handle(ctx: HandlerContext, payload: P): Any? = handler.handle(ctx, payload)
}

/**
 * Runs a [SuspendHandler] for the core. The core calls [handle] on the task's handler thread, which
 * waits for the handler's coroutine.
 *
 * The coroutine runs in the trace context of the handler thread, so the `workhorse.handler` span is
 * the current span in the handler and in each call it makes ([HandlerTraceContext]).
 *
 * A cancellation of the task's token cancels the coroutine `Job`. An interrupt of the handler
 * thread, which the drain sends at its deadline, also cancels the `Job`. In both cases the handler
 * thread waits until the coroutine ends, so the core never settles a task whose coroutine still
 * runs. A coroutine that does not end in the drain's unwind window keeps the thread, and the core
 * abandons the attempt as it does for a blocked Java handler.
 */
internal class SuspendHandlerAdapter<P>(
  private val scope: CoroutineScope,
  private val handler: SuspendHandler<P>,
) : Handler<P> {
  override fun handle(ctx: HandlerContext, payload: P): Any? {
    val deferred =
      // The core makes the handler span current on this thread only. The element carries it to
      // each thread that runs the coroutine.
      scope.async(
        CoroutineName("workhorse-task-${ctx.task().id()}") + HandlerTraceContext.capture(),
      ) {
        handler.handle(SuspendHandlerContext(ctx), payload)
      }
    val registration =
      ctx.cancellation().onCancel {
        deferred.cancel(TaskCancellationException(ctx.cancellation().reason()?.name))
      }
    val future = deferred.asCompletableFuture()
    var interrupted: InterruptedException? = null
    try {
      while (true) {
        try {
          return future.get()
        } catch (interrupt: InterruptedException) {
          // Keep the first interrupt for the result, and wait again until the coroutine ends.
          if (interrupted == null) interrupted = interrupt
          deferred.cancel(TaskCancellationException("INTERRUPTED"))
        }
      }
    } catch (cancelled: CancellationException) {
      val reason = ctx.cancellation().reason()
      if (reason != null) throw CancelledException(reason).apply { initCause(cancelled) }
      throw interrupted ?: cancelled
    } catch (failed: ExecutionException) {
      // The coroutine's own exception, or the core's suspension `Error`, passes through unchanged.
      throw failed.cause ?: failed
    } finally {
      registration.close()
      if (interrupted != null) Thread.currentThread().interrupt()
    }
  }
}

/** The cause of a handler's `Job` cancellation: the token's reason. */
private class TaskCancellationException(reason: String?) :
  kotlinx.coroutines.CancellationException("task cancelled: ${reason ?: "unknown"}")
