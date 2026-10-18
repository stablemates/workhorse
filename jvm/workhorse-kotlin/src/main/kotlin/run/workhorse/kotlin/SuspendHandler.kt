package run.workhorse.kotlin

/**
 * Runs the tasks of one task type as a coroutine. The suspend counterpart of the core's `Handler`.
 *
 * The worker runs each call in a coroutine of its scope, on a virtual-thread dispatcher. When the
 * task's cancellation token is cancelled, the worker cancels the coroutine `Job` of the call. The
 * return value is the task's JSON result. A handler fails its attempt when it throws.
 *
 * @param P the payload type. A JSON payload can be `null`, so write `SuspendHandler<Order?>` to
 *   receive it.
 */
public fun interface SuspendHandler<P> {
  /** Runs one task, and returns its result, or `null` for the JSON value `null`. */
  public suspend fun handle(ctx: SuspendHandlerContext, payload: P): Any?
}
