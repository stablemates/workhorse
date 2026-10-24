package run.workhorse.internal.telemetry;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.jspecify.annotations.Nullable;

/**
 * The span and attribute names the Java SDK emits. Each one is in {@code api/telemetry.txt}, and
 * {@code TelemetrySurfaceTest} fails when one is not.
 *
 * <p>The set is the Ruby reference set ({@code ruby/lib/stablemates/workhorse/worker.rb}), the
 * {@code workhorse.enqueue} span of the TypeScript queue, and the attributes of the log records
 * that the worker and the queue emit with the TypeScript event names.
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
  public static final String CANCEL_ACCEPTED = "workhorse.cancel.accepted";
  public static final String CHECKPOINT_NAME = "workhorse.checkpoint.name";
  public static final String CHECKPOINT_STATUS = "workhorse.checkpoint.status";
  public static final String CHILD_COUNT = "workhorse.child.count";
  public static final String CHILD_NAME = "workhorse.child.name";
  public static final String CHILD_STATUS = "workhorse.child.status";
  public static final String CLAIM_RESULT = "workhorse.claim.result";
  public static final String COMPLETE_ACCEPTED = "workhorse.complete.accepted";
  public static final String ENQUEUE_COUNT = "workhorse.enqueue.count";
  public static final String ENQUEUE_OUTCOME = "workhorse.enqueue.outcome";
  public static final String EXPIRATION_STATUS = "workhorse.expiration.status";
  public static final String HANDLER_BATCH_EVIDENCE_PHASE =
      "workhorse.handler.batch.evidence_phase";
  public static final String HANDLER_BATCH_FULL = "workhorse.handler.batch.full";
  public static final String HANDLER_BATCH_LINGER_MS = "workhorse.handler.batch.linger_ms";
  public static final String HANDLER_BATCH_MAX_SIZE = "workhorse.handler.batch.max_size";
  public static final String HANDLER_DURATION_MS = "workhorse.handler.duration_ms";
  public static final String HANDLER_OUTCOME = "workhorse.handler.outcome";
  public static final String HEARTBEAT_STATUS = "workhorse.heartbeat.status";
  public static final String HUMAN_WAIT_NAME = "workhorse.human_wait.name";
  public static final String HUMAN_WAIT_STATUS = "workhorse.human_wait.status";
  public static final String MAINTENANCE_LOOP = "workhorse.maintenance.loop";
  public static final String MAINTENANCE_OPERATION = "workhorse.maintenance.operation";
  public static final String MAINTENANCE_PHASE = "workhorse.maintenance.phase";
  public static final String MAINTENANCE_ROWS_AFFECTED = "workhorse.maintenance.rows_affected";
  public static final String MAINTENANCE_SKIPPED_LOCK = "workhorse.maintenance.skipped_lock";
  public static final String PROGRESS_STATUS = "workhorse.progress.status";
  public static final String QUEUE_NAME = "workhorse.queue.name";
  public static final String QUEUE_TIER = "workhorse.queue.tier";
  public static final String RECOVERY_EXPIRED_LEASES = "workhorse.recovery.expired_leases";
  public static final String RECOVERY_RETRIED = "workhorse.recovery.retried";
  public static final String RECOVERY_ROWS_AFFECTED = "workhorse.recovery.rows_affected";
  public static final String RECOVERY_SKIPPED = "workhorse.recovery.skipped";
  public static final String RELEASE_STATUS = "workhorse.release.status";
  public static final String RETRY_OUTCOME = "workhorse.retry.outcome";
  public static final String SCHEDULE_NAME = "workhorse.schedule.name";
  public static final String SCHEDULE_NAMESPACE = "workhorse.schedule.namespace";
  public static final String SIGNAL_NAME = "workhorse.signal.name";
  public static final String SIGNAL_STATUS = "workhorse.signal.status";
  public static final String TASK_ATTEMPT = "workhorse.task.attempt";
  public static final String TASK_ID = "workhorse.task.id";
  public static final String TASK_TYPE = "workhorse.task.type";
  public static final String WAIT_NAME = "workhorse.wait.name";
  public static final String WAIT_STATUS = "workhorse.wait.status";
  public static final String WORKER_ACTIVE_SLOTS = "workhorse.worker.active_slots";
  public static final String WORKER_CONCURRENCY = "workhorse.worker.concurrency";
  public static final String WORKER_DEREGISTERED = "workhorse.worker.deregistered";
  public static final String WORKER_DRAINING = "workhorse.worker.draining";
  public static final String WORKER_ELAPSED_MS = "workhorse.worker.elapsed_ms";
  public static final String WORKER_ID = "workhorse.worker.id";
  public static final String WORKER_PAUSED = "workhorse.worker.paused";
  public static final String WORKER_POOL_MAX_SIZE = "workhorse.worker.pool_max_size";
  public static final String WORKER_QUEUES = "workhorse.worker.queues";
  public static final String WORKER_STATEMENT = "workhorse.worker.statement";

  /**
   * The log event names of the TypeScript {@code WorkhorseLogEvent} union in {@code
   * typescript/core/src/telemetry.ts}. {@link Telemetry#log} emits a record only for one of them,
   * so an event that only the Java SDK writes to {@code System.Logger} stays out of OpenTelemetry.
   */
  public static final Set<String> LOG_EVENTS =
      Set.of(
          "workhorse.cold_export_policy.synchronized",
          "workhorse.handler.batch_dispatched",
          "workhorse.handler.batch_evidence_failed",
          "workhorse.handler.finished",
          "workhorse.handler.missing",
          "workhorse.handler.registered",
          "workhorse.handler.signal_swallowed",
          "workhorse.handler.started",
          "workhorse.leases.recovered",
          "workhorse.maintenance.completed",
          "workhorse.maintenance_policy.synchronized",
          "workhorse.queue.paused",
          "workhorse.queue.purged",
          "workhorse.queue.resumed",
          "workhorse.queue.tier_set",
          "workhorse.retention_policy.synchronized",
          "workhorse.schedule.fire_replayed",
          "workhorse.schedule.fired",
          "workhorse.schedules.synchronized",
          "workhorse.task.cancellation_acknowledged",
          "workhorse.task.cancellation_processed",
          "workhorse.task.checkpoint_saved",
          "workhorse.task.child_processed",
          "workhorse.task.claimed",
          "workhorse.task.completed",
          "workhorse.task.completion_rejected",
          "workhorse.task.debounce_rejected",
          "workhorse.task.debounced",
          "workhorse.task.enqueue_replayed",
          "workhorse.task.enqueued",
          "workhorse.task.execution_finished",
          "workhorse.task.failure_processed",
          "workhorse.task.heartbeat_accepted",
          "workhorse.task.heartbeat_rejected",
          "workhorse.task.human_wait_processed",
          "workhorse.task.ownership_expired",
          "workhorse.task.progress_updated",
          "workhorse.task.redrive_processed",
          "workhorse.task.release_processed",
          "workhorse.task.run_now_requested",
          "workhorse.task.signal_processed",
          "workhorse.task.throttled",
          "workhorse.task.wait_processed",
          "workhorse.tasks.promoted",
          "workhorse.tasks.redrive_processed",
          "workhorse.worker.deregistered",
          "workhorse.worker.paused",
          "workhorse.worker.polling_only",
          "workhorse.worker.registered",
          "workhorse.worker.registration_failed",
          "workhorse.worker.resumed",
          "workhorse.worker.started",
          "workhorse.worker.statement_slow",
          "workhorse.worker.stop_requested",
          "workhorse.worker.stopped",
          "workhorse.worker_registry.pruned");

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
