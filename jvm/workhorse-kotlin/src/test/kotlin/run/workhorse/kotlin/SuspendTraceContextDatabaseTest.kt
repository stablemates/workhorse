package run.workhorse.kotlin

import io.opentelemetry.api.trace.Span
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout
import org.junit.jupiter.api.extension.ExtendWith
import run.workhorse.ConnectionSource
import run.workhorse.EnqueueOptions
import run.workhorse.Queue
import run.workhorse.QueueOptions
import run.workhorse.WorkhorseTelemetry
import run.workhorse.testing.RecordingOpenTelemetry
import run.workhorse.testing.ScratchDataSource
import run.workhorse.testing.ScratchDatabase

/**
 * The `workhorse.handler` span is the current span in a suspend handler (SM-1526). The core makes
 * it current on the handler thread, and the coroutine runs on other threads.
 */
@ExtendWith(ScratchDatabase::class)
@Timeout(value = 60, unit = TimeUnit.SECONDS)
class SuspendTraceContextDatabaseTest {
  private val dataSource = ScratchDataSource(true)
  private val queueName = "kotlin-trace-${UUID.randomUUID()}"

  @Test
  fun aSuspendHandlerRunsInTheTraceOfItsHandlerSpan() {
    RecordingOpenTelemetry().use { recording ->
      val telemetry = WorkhorseTelemetry.of(recording.sdk())
      val queue =
        Queue(ConnectionSource.of(dataSource), QueueOptions.builder().telemetry(telemetry).build())
      val options = EnqueueOptions.builder().queue(queueName).build()
      runBlocking { queue.enqueueSuspend("traced-parent", null, options) }
      val seen = ConcurrentHashMap<String, String>()
      val worker =
        workhorseWorker(dataSource) {
          queues = listOf(queueName)
          workerId = "kotlin-trace"
          pollingOnly = true
          disableRegistry = true
          this.telemetry = telemetry
          handle<Any?>("traced-parent") { ctx, _ ->
            seen["handler"] = Span.current().spanContext.spanId
            ctx.checkpoint<String>("step") {
              seen["checkpoint"] = Span.current().spanContext.spanId
              "ok"
            }
            withContext(Dispatchers.Default) {
              seen["dispatcher"] = Span.current().spanContext.spanId
            }
            ctx.setProgress(mapOf("step" to 1L))
            queue.enqueueSuspend("traced-child", null, options).taskId.toString()
          }
        }

      assertTrue(worker.runOnce())

      // The pass also claims the child, which has no handler, so the test selects the parent's
      // span.
      val handler =
        recording.spans("workhorse.handler").single {
          it.attributes.asMap().values.contains("traced-parent")
        }
      val spanId = handler.spanContext.spanId
      assertEquals(spanId, seen["handler"], "the handler coroutine")
      assertEquals(spanId, seen["checkpoint"], "the checkpoint operation")
      assertEquals(spanId, seen["dispatcher"], "a coroutine on another dispatcher")
      val child =
        recording.spans("workhorse.enqueue").single {
          it.attributes.asMap().values.contains("traced-child")
        }
      assertEquals(handler.traceId, child.traceId, "the child enqueue joins the handler's trace")
      assertEquals(spanId, child.parentSpanId, "the handler span is the parent of the enqueue")
    }
  }

  @Test
  fun findsTheOpenTelemetryContextWhenTheApiIsOnTheClassPath() {
    assertTrue(HandlerTraceContext.available(), "the test class path has the OpenTelemetry API")
  }
}
