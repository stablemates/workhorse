package run.workhorse.kotlin

import java.lang.invoke.MethodHandle
import java.lang.invoke.MethodHandles
import java.lang.invoke.MethodType
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.EmptyCoroutineContext
import kotlinx.coroutines.ThreadContextElement

/**
 * Carries the OpenTelemetry context of the handler thread into the coroutine of a suspend handler,
 * with no dependency on OpenTelemetry. The core makes the `workhorse.handler` span current only on
 * the handler thread, and the coroutine runs on other threads. The element makes the context
 * current on each thread that runs the coroutine, and so in each durable and blocking call that the
 * coroutine makes. A task that the handler enqueues then joins the handler's trace.
 *
 * The first call looks up `io.opentelemetry.context.Context` by reflection, through the thread
 * context class loader and then the module's own loader, as [SpringTransactionScope] does. If
 * neither loader has the class, the module loads no OpenTelemetry class, and a handler coroutine
 * gets no element.
 */
internal object HandlerTraceContext {
  internal const val CONTEXT: String = "io.opentelemetry.context.Context"
  private const val SCOPE: String = "io.opentelemetry.context.Scope"

  private val handles: Handles? by lazy {
    find(
      listOf(
        Thread.currentThread().contextClassLoader,
        HandlerTraceContext::class.java.classLoader,
      ),
    )
  }

  /** Whether a loader has the OpenTelemetry context API. */
  fun available(): Boolean = handles != null

  /**
   * The element that makes the calling thread's current context current in a coroutine. The result
   * is empty when the API is absent, or when the root context is current.
   */
  fun capture(): CoroutineContext {
    val found = handles ?: return EmptyCoroutineContext
    val context = checkNotNull(found.current.invoke())
    if (context == found.root.invoke()) return EmptyCoroutineContext
    return Element(found.makeCurrent, context)
  }

  private fun find(loaders: List<ClassLoader?>): Handles? =
    loaders.filterNotNull().firstNotNullOfOrNull { loader ->
      try {
        val context = Class.forName(CONTEXT, false, loader)
        val scope = Class.forName(SCOPE, false, loader)
        val lookup = MethodHandles.publicLookup()
        Handles(
          current = lookup.findStatic(context, "current", MethodType.methodType(context)),
          root = lookup.findStatic(context, "root", MethodType.methodType(context)),
          makeCurrent = lookup.findVirtual(context, "makeCurrent", MethodType.methodType(scope)),
        )
      } catch (_: ReflectiveOperationException) {
        null
      } catch (_: LinkageError) {
        null
      }
    }

  private class Handles(
    val current: MethodHandle,
    val root: MethodHandle,
    val makeCurrent: MethodHandle,
  )

  /**
   * Makes [context] current while a thread runs the coroutine. The state is the OpenTelemetry
   * `Scope`, which restores the thread's earlier context when it closes.
   */
  private class Element(private val makeCurrent: MethodHandle, private val context: Any) :
    ThreadContextElement<AutoCloseable> {
    override val key: CoroutineContext.Key<Element>
      get() = Key

    override fun updateThreadContext(context: CoroutineContext): AutoCloseable =
      makeCurrent.invoke(this.context) as AutoCloseable

    override fun restoreThreadContext(context: CoroutineContext, oldState: AutoCloseable) {
      oldState.close()
    }

    companion object Key : CoroutineContext.Key<Element>
  }
}
