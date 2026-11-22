package run.workhorse.internal.telemetry;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.OpenTelemetry;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import run.workhorse.testing.RecordingOpenTelemetry;

/**
 * The default telemetry reads the current {@code GlobalOpenTelemetry} and never installs one, as
 * the TypeScript SDK reads its provider at each use. An application can then register its global
 * instance after it builds a queue, an admin client, or a worker.
 */
class GlobalOpenTelemetryTest {
  private final RecordingOpenTelemetry recording = new RecordingOpenTelemetry();

  @BeforeEach
  void reset() {
    GlobalOpenTelemetry.resetForTest();
  }

  @AfterEach
  void close() {
    GlobalOpenTelemetry.resetForTest();
    recording.close();
  }

  @Test
  void aUseBeforeTheApplicationRegistersAnInstanceInstallsNoGlobalInstance() {
    Telemetry telemetry = OpenTelemetryTelemetry.global();
    telemetry.add(Instrument.TASKS_CLAIMED, 1, Map.of());
    telemetry.record(Instrument.CLAIM_DURATION, 1, Map.of());
    telemetry.span(Names.SPAN_ENQUEUE, Map.of()).close();
    telemetry.logEnabled(Telemetry.Severity.INFO);
    telemetry.log(Telemetry.Severity.INFO, "workhorse.queue.paused", "paused", Map.of());

    assertFalse(GlobalOpenTelemetry.isSet());
    GlobalOpenTelemetry.set(recording.sdk());

    telemetry.add(Instrument.TASKS_CLAIMED, 1, Map.of());
    telemetry.span(Names.SPAN_ENQUEUE, Map.of()).close();
    assertTrue(telemetry.logEnabled(Telemetry.Severity.INFO));
    telemetry.log(Telemetry.Severity.INFO, "workhorse.queue.paused", "paused", Map.of());

    assertEquals(1, recording.spans(Names.SPAN_ENQUEUE).size());
    assertEquals(1, recording.logs("workhorse.queue.paused").size());
    assertTrue(
        recording.metrics().stream()
            .anyMatch(metric -> metric.getName().equals("workhorse.tasks.claimed")));
  }

  @Test
  void readsTheNoopInstanceUntilTheGlobalInstanceIsSet() {
    AtomicInteger reads = new AtomicInteger();
    OpenTelemetry registered = recording.sdk();
    boolean[] set = {false};
    GlobalSource source =
        new GlobalSource(
            () -> set[0],
            () -> {
              reads.incrementAndGet();
              return registered;
            },
            () -> false);

    assertSame(OpenTelemetry.noop(), source.get());
    assertEquals(0, reads.get());
    set[0] = true;
    assertSame(registered, source.get());
    assertEquals(1, reads.get());
  }

  @Test
  void readsTheGlobalInstanceOnAnApiWithoutIsSet() {
    OpenTelemetry registered = recording.sdk();
    AtomicInteger probes = new AtomicInteger();
    GlobalSource source =
        new GlobalSource(
            () -> {
              probes.incrementAndGet();
              throw new NoSuchMethodError("GlobalOpenTelemetry.isSet");
            },
            () -> registered,
            () -> false);

    assertSame(registered, source.get());
    assertSame(registered, source.get());
    // The source probes once, because a failed link fails again at each call.
    assertEquals(1, probes.get());
  }

  @Test
  void readsTheAutoconfigurationSettingAtEachUseBeforeTheGlobalInstanceIsSet() {
    OpenTelemetry registered = recording.sdk();
    boolean[] autoConfigure = {false};
    GlobalSource source = new GlobalSource(() -> false, () -> registered, () -> autoConfigure[0]);

    assertSame(OpenTelemetry.noop(), source.get());
    autoConfigure[0] = true;
    assertSame(registered, source.get());
    autoConfigure[0] = false;
    assertSame(OpenTelemetry.noop(), source.get());
  }

  @ParameterizedTest
  @ValueSource(
      strings = {
        "otel.java.global-autoconfigure.enabled",
        "otel.java.global.autoconfigure.enabled"
      })
  void readsTheAutoconfigurationPropertyAsOpenTelemetryReadsIt(String key) {
    String before = System.getProperty(key);
    try {
      assertFalse(GlobalSource.autoConfigureEnabled());
      System.setProperty(key, "true");
      assertTrue(GlobalSource.autoConfigureEnabled());
    } finally {
      if (before == null) {
        System.clearProperty(key);
      } else {
        System.setProperty(key, before);
      }
    }
  }
}
