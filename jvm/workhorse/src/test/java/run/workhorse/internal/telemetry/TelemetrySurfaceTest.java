package run.workhorse.internal.telemetry;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import org.junit.jupiter.api.Test;
import run.workhorse.testing.TelemetrySurface;

/**
 * Holds the names that the Java SDK declares to {@code api/telemetry.txt} (ADR 0103, "Telemetry").
 *
 * <p>The file is the TypeScript surface. The Java SDK declares the Ruby reference set and the
 * {@code workhorse.enqueue} span. Each name in the file is either declared here or on {@link
 * #NOT_EMITTED}, so a name added to the file fails this test until the Java SDK emits it or the
 * list names it.
 */
class TelemetrySurfaceTest {
  /**
   * The names of {@code api/telemetry.txt} that the Java SDK does not emit, sorted. SM-1438 owns
   * them.
   */
  private static final List<String> NOT_EMITTED =
      List.of(
          "workhorse.budget.blocked_ready",
          "workhorse.budget.concurrency.active",
          "workhorse.budget.concurrency.limit",
          "workhorse.budget.name",
          "workhorse.budget.next_eligible_delay",
          "workhorse.budget.rate_limit.available_tokens",
          "workhorse.budget.rate_limit.configured",
          "workhorse.cancel.accepted",
          "workhorse.cancellation.status",
          "workhorse.checkpoint.name",
          "workhorse.checkpoint.status",
          "workhorse.child.count",
          "workhorse.child.name",
          "workhorse.child.status",
          "workhorse.cold_export.enabled",
          "workhorse.complete.batch_size",
          "workhorse.deadline.overdue",
          "workhorse.execution_timeout.overdue",
          "workhorse.expiration.status",
          "workhorse.handler.batch.evidence_phase",
          "workhorse.handler.batch.linger_ms",
          "workhorse.handler.batch.max_size",
          "workhorse.handler.duration_ms",
          "workhorse.heartbeat",
          "workhorse.human_wait.name",
          "workhorse.human_wait.status",
          "workhorse.lease.expired",
          "workhorse.maintenance.drift",
          "workhorse.maintenance.timezone",
          "workhorse.operation.status",
          "workhorse.progress.status",
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
          "workhorse.queue.oldest_ready.age",
          "workhorse.queue.oldest_ready_age",
          "workhorse.queue.paused",
          "workhorse.queue.rate_limit.available_tokens",
          "workhorse.queue.rate_limit.configured",
          "workhorse.queue.rate_limit.next_eligible_delay",
          "workhorse.queue.rate_limit.throttled_ready",
          "workhorse.redrive.dry_run",
          "workhorse.redrive.status",
          "workhorse.redrive.target_task_id",
          "workhorse.release.status",
          "workhorse.schedule.count",
          "workhorse.schedule.definition_count",
          "workhorse.schedule.synchronize",
          "workhorse.signal.name",
          "workhorse.signal.status",
          "workhorse.task.count",
          "workhorse.task.state",
          "workhorse.tasks.cancellation",
          "workhorse.tasks.count",
          "workhorse.tasks.enqueue.outcomes",
          "workhorse.tasks.enqueued",
          "workhorse.tasks.redrive",
          "workhorse.wait.delivery.rejected",
          "workhorse.wait.kind",
          "workhorse.wait.name",
          "workhorse.wait.overdue",
          "workhorse.wait.pending",
          "workhorse.wait.status",
          "workhorse.worker.active",
          "workhorse.worker.active_slots",
          "workhorse.worker.capacity",
          "workhorse.worker.concurrency",
          "workhorse.worker.count",
          "workhorse.worker.deregistered",
          "workhorse.worker.draining",
          "workhorse.worker.id",
          "workhorse.worker.paused",
          "workhorse.worker.queues",
          "workhorse.worker.state");

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
    List<String> unaccounted = new ArrayList<>();
    for (String name : SURFACE.names()) {
      if (!declared.contains(name) && !NOT_EMITTED.contains(name)) {
        unaccounted.add(name);
      }
    }
    assertEquals(List.of(), unaccounted, "names the Java SDK neither emits nor lists");
    List<String> stale = new ArrayList<>();
    for (String name : NOT_EMITTED) {
      if (declared.contains(name) || !SURFACE.names().contains(name)) {
        stale.add(name);
      }
    }
    assertEquals(List.of(), stale, "listed names that the SDK emits or the file lacks");
    assertEquals(new ArrayList<>(new TreeSet<>(NOT_EMITTED)), NOT_EMITTED, "the list is sorted");
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
