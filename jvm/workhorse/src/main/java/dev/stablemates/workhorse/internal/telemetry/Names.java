package dev.stablemates.workhorse.internal.telemetry;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * The span and attribute names the Java SDK emits. Each one is in {@code api/telemetry.txt}, and
 * {@code TelemetrySurfaceTest} fails when one is not.
 *
 * <p>The set is the Ruby reference set ({@code ruby/lib/stablemates/workhorse/worker.rb}) plus the
 * {@code workhorse.enqueue} span of the TypeScript queue.
 */
public final class Names {
  /** The span around one enqueue or one batch enqueue. */
  public static final String SPAN_ENQUEUE = "workhorse.enqueue";

  /** The span around one claim from one queue. */
  public static final String SPAN_CLAIM = "workhorse.claim";

  /** The consumer span around one handler run. Its parent is the stored trace context. */
  public static final String SPAN_HANDLER = "workhorse.handler";

  /** The span around one fenced completion. */
  public static final String SPAN_COMPLETE = "workhorse.complete";

  /** The span around one failure or one lease expiration that PostgreSQL settles. */
  public static final String SPAN_RETRY = "workhorse.retry";

  /** The span around one maintenance pass. */
  public static final String SPAN_MAINTENANCE = "workhorse.maintenance";

  /** The span around the recovery phases of one maintenance pass. */
  public static final String SPAN_RECOVERY = "workhorse.recovery";

  public static final String ATTEMPT_OUTCOME = "workhorse.attempt.outcome";
  public static final String CLAIM_RESULT = "workhorse.claim.result";
  public static final String COMPLETE_ACCEPTED = "workhorse.complete.accepted";
  public static final String ENQUEUE_COUNT = "workhorse.enqueue.count";
  public static final String ENQUEUE_OUTCOME = "workhorse.enqueue.outcome";
  public static final String HANDLER_BATCH_FULL = "workhorse.handler.batch.full";
  public static final String HANDLER_OUTCOME = "workhorse.handler.outcome";
  public static final String HEARTBEAT_STATUS = "workhorse.heartbeat.status";
  public static final String MAINTENANCE_LOOP = "workhorse.maintenance.loop";
  public static final String MAINTENANCE_OPERATION = "workhorse.maintenance.operation";
  public static final String MAINTENANCE_PHASE = "workhorse.maintenance.phase";
  public static final String MAINTENANCE_ROWS_AFFECTED = "workhorse.maintenance.rows_affected";
  public static final String MAINTENANCE_SKIPPED_LOCK = "workhorse.maintenance.skipped_lock";
  public static final String QUEUE_NAME = "workhorse.queue.name";
  public static final String QUEUE_TIER = "workhorse.queue.tier";
  public static final String RECOVERY_EXPIRED_LEASES = "workhorse.recovery.expired_leases";
  public static final String RECOVERY_RETRIED = "workhorse.recovery.retried";
  public static final String RECOVERY_ROWS_AFFECTED = "workhorse.recovery.rows_affected";
  public static final String RECOVERY_SKIPPED = "workhorse.recovery.skipped";
  public static final String RETRY_OUTCOME = "workhorse.retry.outcome";
  public static final String SCHEDULE_NAME = "workhorse.schedule.name";
  public static final String SCHEDULE_NAMESPACE = "workhorse.schedule.namespace";
  public static final String TASK_ATTEMPT = "workhorse.task.attempt";
  public static final String TASK_ID = "workhorse.task.id";
  public static final String TASK_TYPE = "workhorse.task.type";

  private Names() {}

  /**
   * The attributes of a {@link #SPAN_ENQUEUE} span, as the TypeScript queue sets them: the queue
   * when every request names the same one, the task type of a single request, and the count.
   */
  public static Map<String, @Nullable Object> enqueue(List<String> queues, List<String> taskTypes) {
    Map<String, @Nullable Object> attributes = new LinkedHashMap<>();
    if (!queues.isEmpty() && queues.stream().distinct().count() == 1) {
      attributes.put(QUEUE_NAME, queues.get(0));
    }
    if (taskTypes.size() == 1) {
      attributes.put(TASK_TYPE, taskTypes.get(0));
    }
    attributes.put(ENQUEUE_COUNT, (long) taskTypes.size());
    return attributes;
  }
}
