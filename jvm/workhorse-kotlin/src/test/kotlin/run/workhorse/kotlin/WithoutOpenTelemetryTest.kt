package run.workhorse.kotlin

import kotlin.coroutines.EmptyCoroutineContext
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Tag
import org.junit.jupiter.api.Test

/**
 * The `testWithoutOpenTelemetry` task runs this class on a class path with no OpenTelemetry jar. A
 * suspend handler then gets no trace context element, and the module loads no OpenTelemetry class.
 */
@Tag("without-opentelemetry")
class WithoutOpenTelemetryTest {
  @Test
  fun capturesNoTraceContextWhenNoLoaderHasOpenTelemetry() {
    assertThrows(ClassNotFoundException::class.java) {
      Class.forName(
        HandlerTraceContext.CONTEXT,
        false,
        WithoutOpenTelemetryTest::class.java.classLoader,
      )
    }
    assertFalse(HandlerTraceContext.available())
    assertSame(EmptyCoroutineContext, HandlerTraceContext.capture())
  }
}
