package run.workhorse.internal.telemetry;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;
import run.workhorse.testing.TelemetrySurface;

/**
 * Holds the names that the Java SDK declares to {@code api/telemetry.txt} (ADR 0103, "Telemetry").
 *
 * <p>The file is the TypeScript surface. The Java SDK declares the Ruby reference set, the {@code
 * workhorse.enqueue} span, and the attributes of its log records. Each name in the file is either
 * declared here or on {@link #NOT_EMITTED}, so a name added to the file fails this test until the
 * Java SDK emits it or the list names it.
 */
class TelemetrySurfaceTest {
  /**
   * The queue and budget gauges of the TypeScript-only {@code registerQueueMetrics} operator
   * function (SM-1532).
   */
  private static final List<String> QUEUE_METRICS =
      List.of(
          "workhorse.budget.blocked_ready",
          "workhorse.budget.concurrency.active",
          "workhorse.budget.concurrency.limit",
          "workhorse.budget.name",
          "workhorse.budget.next_eligible_delay",
          "workhorse.budget.rate_limit.available_tokens",
          "workhorse.budget.rate_limit.configured",
          "workhorse.queue.children.canceled_parents",
          "workhorse.queue.children.capped",
          "workhorse.queue.children.failed_parents",
          "workhorse.queue.children.pending",
          "workhorse.queue.children.unjoined_results",
          "workhorse.queue.children.waiting_parents",
          "workhorse.queue.concurrency.active",
          "workhorse.queue.concurrency.blocked_ready",
          "workhorse.queue.concurrency.limit",
          "workhorse.queue.dependencies.blocked",
          "workhorse.queue.dependencies.capped",
          "workhorse.queue.dependencies.failed_resolutions",
          "workhorse.queue.dependencies.pending_edges",
          "workhorse.queue.depth",
          "workhorse.queue.oldest_ready_age",
          "workhorse.queue.rate_limit.available_tokens",
          "workhorse.queue.rate_limit.configured",
          "workhorse.queue.rate_limit.next_eligible_delay",
          "workhorse.queue.rate_limit.throttled_ready");

  /** The gauges of the TypeScript-only {@code WorkhorseMetricsObserver} operator class. */
  private static final List<String> METRICS_OBSERVER =
      List.of(
          "workhorse.deadline.overdue",
          "workhorse.execution_timeout.overdue",
          "workhorse.lease.expired",
          "workhorse.queue.oldest_ready.age",
          "workhorse.queue.paused",
          "workhorse.tasks.count",
          "workhorse.wait.delivery.rejected",
          "workhorse.wait.kind",
          "workhorse.wait.overdue",
          "workhorse.wait.pending",
          "workhorse.worker.active",
          "workhorse.worker.capacity",
          "workhorse.worker.count",
          "workhorse.worker.state");

  /**
   * The span of the TypeScript {@code Queue.heartbeat} method. The Java SDK has no single
   * heartbeat.
   */
  private static final List<String> SINGLE_HEARTBEAT = List.of("workhorse.heartbeat");

  /** The TypeScript-only {@code syncMaintenancePolicy} and {@code setColdExportPolicy} methods. */
  private static final List<String> POLICY_SYNC =
      List.of("workhorse.cold_export.enabled", "workhorse.maintenance.timezone");

  /**
   * The TypeScript batch completion span. The Java worker gives each fused completion its own span.
   */
  private static final List<String> FUSED_COMPLETION = List.of("workhorse.complete.batch_size");

  /** The cancel, redrive, schedule sync, and enqueue outcome names, which SM-1609 owns. */
  private static final List<String> QUEUE_AND_ADMIN =
      List.of(
          "workhorse.cancellation.status",
          "workhorse.operation.status",
          "workhorse.redrive.dry_run",
          "workhorse.redrive.status",
          "workhorse.redrive.target_task_id",
          "workhorse.schedule.count",
          "workhorse.schedule.definition_count",
          "workhorse.schedule.synchronize",
          "workhorse.task.count",
          "workhorse.task.state",
          "workhorse.tasks.cancellation",
          "workhorse.tasks.enqueue.outcomes",
          "workhorse.tasks.enqueued",
          "workhorse.tasks.redrive");

  /** The names of {@code api/telemetry.txt} that the Java SDK does not emit. */
  private static final List<List<String>> NOT_EMITTED =
      List.of(
          QUEUE_METRICS,
          METRICS_OBSERVER,
          SINGLE_HEARTBEAT,
          POLICY_SYNC,
          FUSED_COMPLETION,
          QUEUE_AND_ADMIN);

  private static final TelemetrySurface SURFACE = TelemetrySurface.read();

  @Test
  void declaresEachInstrumentWithTheKindUnitAndDescriptionOfTheFile() {
    for (Instrument instrument : Instrument.values()) {
      TelemetrySurface.Instrument governed = SURFACE.instruments().get(instrument.instrumentName());
      assertTrue(governed != null, instrument.instrumentName() + " is not in api/telemetry.txt");
      String kind = instrument.kind() == Instrument.Kind.HISTOGRAM ? "histogram" : "counter";
      assertEquals(governed.kind(), kind, instrument.instrumentName());
      assertEquals(governed.unit(), instrument.unit(), instrument.instrumentName());
      assertEquals(governed.description(), instrument.description(), instrument.instrumentName());
    }
  }

  @Test
  void declaresOnlySpansAndAttributesOfTheFile() throws IllegalAccessException {
    for (String span : declared(true)) {
      assertTrue(SURFACE.spans().contains(span), span + " is not a span in api/telemetry.txt");
    }
    for (String attribute : declared(false)) {
      assertTrue(
          SURFACE.attributes().contains(attribute),
          attribute + " is not an attribute in api/telemetry.txt");
    }
  }

  @Test
  void accountsForEveryNameOfTheFile() throws IllegalAccessException {
    Set<String> declared = new TreeSet<>(declared(true));
    declared.addAll(declared(false));
    for (Instrument instrument : Instrument.values()) {
      declared.add(instrument.instrumentName());
    }
    List<String> listed = new ArrayList<>();
    for (List<String> group : NOT_EMITTED) {
      assertEquals(new ArrayList<>(new TreeSet<>(group)), group, "each group is sorted");
      listed.addAll(group);
    }
    assertEquals(listed.size(), new TreeSet<>(listed).size(), "a name is in one group only");
    List<String> unaccounted = new ArrayList<>();
    for (String name : SURFACE.names()) {
      if (!declared.contains(name) && !listed.contains(name)) {
        unaccounted.add(name);
      }
    }
    assertEquals(List.of(), unaccounted, "names the Java SDK neither emits nor lists");
    List<String> stale = new ArrayList<>();
    for (String name : listed) {
      if (declared.contains(name) || !SURFACE.names().contains(name)) {
        stale.add(name);
      }
    }
    assertEquals(List.of(), stale, "listed names that the SDK emits or the file lacks");
  }

  /**
   * The source of the union is {@code typescript/core/src/telemetry.ts}. {@code api/typescript.txt}
   * prints the same union, but every CI lane reads the source.
   */
  @Test
  void forwardsTheLogEventNamesOfTheTypeScriptUnion() throws IOException {
    Path file =
        Path.of(System.getProperty("workhorse.schema"))
            .getParent()
            .getParent()
            .getParent()
            .resolve("typescript/core/src/telemetry.ts");
    String source = Files.readString(file);
    int start = source.indexOf("export type WorkhorseLogEvent =");
    String union = source.substring(start, source.indexOf(';', start));
    Set<String> events = new TreeSet<>();
    Matcher matcher = Pattern.compile("\"([^\"]+)\"").matcher(union);
    while (matcher.find()) {
      events.add(matcher.group(1));
    }
    assertEquals(55, events.size(), "the union has 55 events");
    assertEquals(events, new TreeSet<>(Names.LOG_EVENTS));
  }

  /** The span names, or the attribute names, of {@link Names}. */
  private static List<String> declared(boolean spans) throws IllegalAccessException {
    List<String> names = new ArrayList<>();
    for (Field field : Names.class.getFields()) {
      if (Modifier.isStatic(field.getModifiers()) && field.getType() == String.class) {
        if (field.getName().startsWith("SPAN_") == spans) {
          names.add((String) field.get(null));
        }
      }
    }
    return names;
  }
}
