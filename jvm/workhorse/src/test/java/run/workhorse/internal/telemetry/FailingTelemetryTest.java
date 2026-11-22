package run.workhorse.internal.telemetry;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;

import io.opentelemetry.api.OpenTelemetry;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.Scope;
import io.opentelemetry.sdk.OpenTelemetrySdk;
import io.opentelemetry.sdk.trace.ReadWriteSpan;
import io.opentelemetry.sdk.trace.ReadableSpan;
import io.opentelemetry.sdk.trace.SdkTracerProvider;
import io.opentelemetry.sdk.trace.SpanProcessor;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Proxy;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import run.workhorse.testing.RecordingOpenTelemetry;

/**
 * A telemetry failure never changes the result of the operation that it observes. The worker
 * telemetry runs each operation once and returns its result when the provider, an instrument, or a
 * span fails.
 */
class FailingTelemetryTest {
  /**
   * An OpenTelemetry instance whose methods in {@code failing} throw. Each other method returns a
   * proxy of its interface type, or the default value of its type.
   */
  @SuppressWarnings("unchecked")
  private static <T> T failing(Class<T> type, Set<String> failing) {
    return (T)
        Proxy.newProxyInstance(
            FailingTelemetryTest.class.getClassLoader(),
            new Class<?>[] {type},
            (proxy, method, arguments) -> {
              if (failing.contains(method.getName())) {
                throw new IllegalStateException(method.getName() + " failed");
              }
              Class<?> result = method.getReturnType();
              if (result == boolean.class) {
                return false;
              }
              if (result.isPrimitive() && result != void.class) {
                return 0;
              }
              if (result.isInterface()) {
                return failing(result, failing);
              }
              return null;
            });
  }

  private static void assertOperationsKeepTheirResults(Telemetry telemetry) {
    WorkerTelemetry worker = new WorkerTelemetry(telemetry);
    AtomicInteger runs = new AtomicInteger();

    worker.claim("default", runs::incrementAndGet);
    worker.maintenance(runs::incrementAndGet);
    assertEquals(2, runs.get());
    worker.claimed("default", System.nanoTime(), List.of(), true);
    worker.heartbeatRejected("lease_lost");
    telemetry.add(Instrument.TASKS_CLAIMED, 1, Map.of());
    telemetry.record(Instrument.CLAIM_DURATION, 1, Map.of());
    try (TelemetrySpan span = telemetry.span(Names.SPAN_COMPLETE, Map.of())) {
      span.setAttribute(Names.TASK_ATTEMPT, 1);
      span.recordError("IllegalStateException");
    }
    try (TelemetrySpan span = telemetry.consumerSpan(Names.SPAN_HANDLER, Map.of(), null)) {
      span.setAttribute(Names.TASK_ATTEMPT, 1);
    }
  }

  @Test
  void keepsTheOperationWhenTheProviderFails() {
    OpenTelemetry provider =
        failing(OpenTelemetry.class, Set.of("getLogsBridge", "getMeterProvider"));
    assertOperationsKeepTheirResults(OpenTelemetryTelemetry.of(provider));
  }

  @Test
  void keepsTheOperationWhenAnInstrumentOrASpanFails() {
    OpenTelemetry provider =
        failing(OpenTelemetry.class, Set.of("add", "record", "startSpan", "setAllAttributes"));
    assertOperationsKeepTheirResults(OpenTelemetryTelemetry.of(provider));
  }

  @Test
  void keepsTheOperationWhenASpanFailsToEnd() {
    SpanProcessor failingEnd =
        new SpanProcessor() {
          @Override
          public void onStart(Context parentContext, ReadWriteSpan span) {}

          @Override
          public boolean isStartRequired() {
            return false;
          }

          @Override
          public void onEnd(ReadableSpan span) {
            throw new IllegalStateException("span processor failed");
          }

          @Override
          public boolean isEndRequired() {
            return true;
          }
        };
    try (OpenTelemetrySdk sdk =
        OpenTelemetrySdk.builder()
            .setTracerProvider(SdkTracerProvider.builder().addSpanProcessor(failingEnd).build())
            .build()) {
      Telemetry telemetry = OpenTelemetryTelemetry.of(sdk);
      assertOperationsKeepTheirResults(telemetry);
      // The span that failed to end is no longer current.
      assertFalse(Span.current().getSpanContext().isValid());
    }
  }

  /** A current span whose span context throws, as a broken tracer can make current. */
  private static Span spanWithFailingContext() {
    return (Span)
        Proxy.newProxyInstance(
            FailingTelemetryTest.class.getClassLoader(),
            new Class<?>[] {Span.class},
            (proxy, method, arguments) -> {
              if (method.getName().equals("getSpanContext")) {
                throw new IllegalStateException("span context failed");
              }
              if (method.isDefault()) {
                return InvocationHandler.invokeDefault(proxy, method, arguments);
              }
              return method.getReturnType() == boolean.class ? false : proxy;
            });
  }

  // A scope only makes a span current, so a try block never reads it.
  @SuppressWarnings("try")
  @Test
  void keepsTheOperationWhenTheCurrentSpanContextFails() {
    try (RecordingOpenTelemetry recording = new RecordingOpenTelemetry();
        Scope ignored = Context.root().with(spanWithFailingContext()).makeCurrent()) {
      Telemetry telemetry = OpenTelemetryTelemetry.of(recording.sdk());
      assertNull(telemetry.injectTraceContext());
      assertOperationsKeepTheirResults(telemetry);
    }
  }
}
