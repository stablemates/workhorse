package run.workhorse.internal.telemetry;

import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.WeakHashMap;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Supplier;
import org.jspecify.annotations.Nullable;
import run.workhorse.ClaimedTask;
import run.workhorse.internal.Json;
import run.workhorse.internal.Row;

/**
 * The worker's spans and metrics, with the names, attributes, and outcome values of the Ruby
 * reference ({@code ruby/lib/stablemates/workhorse/worker.rb}). Each method wraps one worker step,
 * so the worker calls it in one statement.
 */
public final class WorkerTelemetry {
  /** The metric outcome of each worker outcome, as Ruby's {@code TELEMETRY_OUTCOMES}. */
  private static final Map<String, String> METRIC_OUTCOMES =
      Map.of(
          "COMPLETED", "succeeded",
          "FAILED", "failed",
          "RETRY", "retry",
          "LEASE_EXPIRED", "lease_lost",
          "RELEASED", "released",
          "DEADLINE_EXCEEDED", "deadline_exceeded",
          "ATTEMPT_TIMEOUT", "timeout",
          "CANCELLED", "canceled",
          "SUSPENDED_FOR_WAIT", "suspended",
          "SUSPENDED_FOR_CHILD", "suspended");

  /** The span outcomes that differ from the metric outcome, as Ruby's {@code SPAN_OUTCOMES}. */
  private static final Map<String, String> SPAN_OUTCOMES =
      Map.of("LEASE_EXPIRED", "stale", "ATTEMPT_TIMEOUT", "timeout_exceeded");

  private static final Set<String> RETRIED_STATES = Set.of("ready", "scheduled");

  /** The error type of a task that redacts its error details, as Ruby's {@code REDACTED_NAME}. */
  private static final String REDACTED_ERROR_TYPE = "RedactedTaskError";

  private final Telemetry telemetry;
  // The handler context of each attempt, so that a lease expiration that the watchdog or a
  // heartbeat
  // settlement records on another thread parents its retry span on the handler span. A settlement
  // can run after the handler finishes, so an entry lives as long as its claimed task object, which
  // each settlement holds. Weak keys drop the entry after the attempt becomes unreachable.
  private final Map<ClaimedTask, Object> handlerContexts = new WeakHashMap<>();
  private final ReentrantLock handlerContextsLock = new ReentrantLock();
  // A thread runs one attempt and one maintenance pass at a time.
  private static final ThreadLocal<@Nullable Execution> EXECUTIONS = new ThreadLocal<>();
  private static final ThreadLocal<@Nullable Pass> PASSES = new ThreadLocal<>();
  private static final ThreadLocal<@Nullable TelemetrySpan> CLAIMS = new ThreadLocal<>();

  /** The worker telemetry on {@code telemetry}. */
  public WorkerTelemetry(Telemetry telemetry) {
    this.telemetry = telemetry;
  }

  /**
   * Runs one claim from {@code queue} in a {@code workhorse.claim} span. The claim reports its
   * tasks with {@link #claimed} on this thread.
   */
  public void claim(String queue, Runnable claim) {
    try (TelemetrySpan span = telemetry.span(Names.SPAN_CLAIM, Map.of(Names.QUEUE_NAME, queue))) {
      CLAIMS.set(span);
      try {
        claim.run();
      } finally {
        CLAIMS.remove();
      }
    }
  }

  /**
   * Records one claim from {@code queue}: its duration from {@code startedAt}, each claimed task,
   * and on the claim span the first task and, for a full-tier claim, the tier.
   */
  public void claimed(String queue, long startedAt, List<ClaimedTask> tasks, boolean fullTier) {
    Map<String, @Nullable Object> duration = new LinkedHashMap<>();
    duration.put(Names.QUEUE_NAME, queue);
    duration.put(Names.CLAIM_RESULT, tasks.isEmpty() ? "empty" : "claimed");
    telemetry.record(Instrument.CLAIM_DURATION, millisSince(startedAt), duration);
    for (ClaimedTask task : tasks) {
      telemetry.add(Instrument.TASKS_CLAIMED, 1, metric(queue, task.type()));
    }
    TelemetrySpan span = CLAIMS.get();
    if (span == null) {
      return;
    }
    if (fullTier) {
      span.setAttribute(Names.QUEUE_TIER, "full");
    }
    if (!tasks.isEmpty()) {
      span(tasks.get(0)).forEach(span::setAttribute);
    }
  }

  /** Records one batch handler invocation as it starts. */
  public void batch(String taskType, List<ClaimedTask> tasks, boolean full, long lingerMs) {
    Map<String, @Nullable Object> attributes = metric(tasks.get(0).queue(), taskType);
    attributes.put(Names.HANDLER_BATCH_FULL, full);
    telemetry.record(Instrument.HANDLER_BATCH_SIZE, tasks.size(), attributes);
    telemetry.record(Instrument.HANDLER_BATCH_LINGER, (double) lingerMs, attributes);
  }

  /**
   * Starts the consumer {@code workhorse.handler} span of one attempt. Its parent is the trace
   * context that the enqueue stored. The caller closes the execution with {@link Execution#finish}.
   */
  public Execution execute(ClaimedTask task) {
    Map<String, @Nullable Object> attributes = span(task);
    attributes.put(Names.QUEUE_NAME, task.queue());
    TelemetrySpan span =
        telemetry.consumerSpan(Names.SPAN_HANDLER, attributes, task.traceContext());
    Execution execution = new Execution(task, span, System.nanoTime());
    Object context = telemetry.currentContext();
    if (context != null) {
      handlerContextsLock.lock();
      try {
        handlerContexts.put(task, context);
      } finally {
        handlerContextsLock.unlock();
      }
    }
    EXECUTIONS.set(execution);
    return execution;
  }

  /**
   * Marks the handler span of the attempt that runs on this thread as failed with {@code
   * errorType}. Only the first error counts.
   */
  public void handlerError(String errorType) {
    Execution execution = EXECUTIONS.get();
    if (execution != null && execution.errorType == null) {
      execution.errorType = errorType;
    }
  }

  /**
   * Sets the span outcome of the attempt that runs on this thread, for an attempt whose outcome is
   * a PostgreSQL status, such as the release of a task with no handler.
   */
  public void handlerSpanOutcome(@Nullable String outcome) {
    Execution execution = EXECUTIONS.get();
    if (execution != null) {
      execution.spanOutcome = outcome;
    }
  }

  /** Runs one fenced completion in a {@code workhorse.complete} span. */
  public boolean complete(ClaimedTask task, Supplier<Boolean> complete) {
    boolean accepted;
    try (TelemetrySpan span = telemetry.span(Names.SPAN_COMPLETE, span(task))) {
      accepted = complete.get();
      span.setAttribute(Names.COMPLETE_ACCEPTED, accepted);
    }
    if (accepted) {
      telemetry.add(Instrument.TASKS_COMPLETED, 1, metric(task.queue(), task.type()));
    }
    return accepted;
  }

  /**
   * Runs one fenced failure in a {@code workhorse.retry} span, and returns the state PostgreSQL
   * chose. The handler span records that state and the type of {@code error}, or {@code
   * RedactedTaskError} for a task that redacts its error details.
   */
  public @Nullable String fail(ClaimedTask task, Throwable error, Supplier<@Nullable String> fail) {
    handlerError(task.redactErrorDetails() ? REDACTED_ERROR_TYPE : error.getClass().getName());
    String state;
    try (TelemetrySpan span = telemetry.span(Names.SPAN_RETRY, span(task))) {
      state = fail.get();
      span.setAttribute(Names.RETRY_OUTCOME, state);
    }
    // The handler span names the state PostgreSQL chose, and the metrics name `retry`.
    handlerSpanOutcome(state);
    Map<String, @Nullable Object> failed = metric(task.queue(), task.type());
    failed.put(Names.ATTEMPT_OUTCOME, state);
    telemetry.add(Instrument.TASKS_FAILED, 1, failed);
    if (state != null && RETRIED_STATES.contains(state)) {
      telemetry.add(Instrument.TASKS_RETRIED, 1, metric(task.queue(), task.type()));
    }
    return state;
  }

  /**
   * Records a lease expiration that PostgreSQL settled from an {@code expire_owned_telemetry_v1}
   * row. A retried task gets a {@code workhorse.retry} span under its handler span.
   */
  public void expired(ClaimedTask task, Row row) {
    String retryState = row.text("retry_state");
    if (retryState == null) {
      return;
    }
    Object parent;
    handlerContextsLock.lock();
    try {
      parent = handlerContexts.get(task);
    } finally {
      handlerContextsLock.unlock();
    }
    try (TelemetrySpan span = telemetry.span(Names.SPAN_RETRY, span(task), parent)) {
      span.setAttribute(Names.RETRY_OUTCOME, retryState);
    }
    telemetry.add(Instrument.TASKS_RETRIED, 1, metric(task.queue(), task.type()));
  }

  /** Records one heartbeat that PostgreSQL rejected with {@code status}. */
  public void heartbeatRejected(@Nullable String status) {
    Map<String, @Nullable Object> attributes = new LinkedHashMap<>();
    attributes.put(Names.HEARTBEAT_STATUS, status);
    telemetry.add(Instrument.HEARTBEAT_FAILURE, 1, attributes);
  }

  /**
   * Runs one maintenance pass in a {@code workhorse.maintenance} span with a {@code
   * workhorse.recovery} span inside it. {@link #maintenancePhase} adds each phase row to the pass.
   */
  public void maintenance(Runnable pass) {
    long rows;
    try (TelemetrySpan span =
        telemetry.span(Names.SPAN_MAINTENANCE, Map.of(Names.MAINTENANCE_OPERATION, "tick"))) {
      try (TelemetrySpan recovery = telemetry.span(Names.SPAN_RECOVERY, Map.of())) {
        Pass current = new Pass(recovery);
        PASSES.set(current);
        try {
          pass.run();
        } finally {
          PASSES.remove();
        }
        rows = current.rows;
      }
      span.setAttribute(Names.MAINTENANCE_ROWS_AFFECTED, rows);
    }
  }

  /**
   * Records one {@code tick_v1} or {@code run_maintenance_v1} phase row. The {@code recover} phase
   * also sets the recovery attributes and counts its expired leases and retried tasks.
   */
  public void maintenancePhase(Row row) {
    String phase = row.text("phase");
    Long affected = row.longValue("rows_affected");
    long rows = affected == null ? 0 : affected;
    boolean skipped = "t".equals(row.text("skipped_lock"));
    boolean error = row.text("error") != null;
    Map<String, @Nullable Object> attributes = new LinkedHashMap<>();
    attributes.put(Names.MAINTENANCE_LOOP, "tick");
    attributes.put(Names.MAINTENANCE_PHASE, phase);
    attributes.put(Names.MAINTENANCE_SKIPPED_LOCK, skipped);
    telemetry.add(Instrument.MAINTENANCE_RUNS, 1, attributes);
    telemetry.add(Instrument.MAINTENANCE_ROWS, (double) rows, attributes);
    String duration = row.text("duration_ms");
    telemetry.record(
        Instrument.MAINTENANCE_DURATION,
        duration == null ? 0 : Double.parseDouble(duration),
        attributes);
    if (error) {
      telemetry.add(Instrument.MAINTENANCE_ERRORS, 1, attributes);
    }
    Pass pass = PASSES.get();
    if (pass != null) {
      pass.rows += rows;
      if ("recover".equals(phase)) {
        recovery(pass.recovery, row, rows, skipped, error);
      }
    }
  }

  /** Records one fired schedule occurrence from a {@code fire_due_schedules_v2} row. */
  public void scheduleFired(Row row, Instant now) {
    if (row.text("task_id") == null) {
      return;
    }
    Map<String, @Nullable Object> attributes = new LinkedHashMap<>();
    attributes.put(Names.SCHEDULE_NAMESPACE, row.text("namespace"));
    attributes.put(Names.SCHEDULE_NAME, row.text("schedule_name"));
    telemetry.add(Instrument.SCHEDULE_FIRED, 1, attributes);
    Instant occurrence = row.instant("occurrence_at");
    if (occurrence != null) {
      double lag = Duration.between(occurrence, now).toNanos() / 1e9;
      telemetry.record(Instrument.SCHEDULE_LAG, Math.max(0, lag), attributes);
    }
  }

  private void recovery(TelemetrySpan span, Row row, long rows, boolean skipped, boolean error) {
    Long expired = row.longValue("expired_leases");
    Long retried = row.longValue("retried");
    long expiredLeases = expired == null ? 0 : expired;
    long retriedTasks = retried == null ? 0 : retried;
    span.setAttribute(Names.RECOVERY_SKIPPED, skipped);
    if (!skipped && !error) {
      span.setAttribute(Names.RECOVERY_ROWS_AFFECTED, rows);
      span.setAttribute(Names.RECOVERY_EXPIRED_LEASES, expiredLeases);
      span.setAttribute(Names.RECOVERY_RETRIED, retriedTasks);
      if (expiredLeases > 0) {
        telemetry.add(Instrument.LEASES_EXPIRED, (double) expiredLeases, Map.of());
      }
      retries(retriedTasks, row.text("retry_dimensions"));
    }
  }

  /** Counts each retried task by queue and type. Retries without both count as unknown. */
  private void retries(long retried, @Nullable String dimensions) {
    Map<List<String>, Long> counts = new LinkedHashMap<>();
    Object parsed = dimensions == null ? null : Json.parse(dimensions);
    if (parsed instanceof List<?> list) {
      for (Object item : list) {
        if (item instanceof Map<?, ?> dimension
            && dimension.get("queue") instanceof String queue
            && dimension.get("type") instanceof String type) {
          counts.merge(List.of(queue, type), 1L, Long::sum);
        }
      }
    }
    long attributed = 0;
    for (Map.Entry<List<String>, Long> entry : counts.entrySet()) {
      attributed += entry.getValue();
      telemetry.add(
          Instrument.TASKS_RETRIED,
          entry.getValue(),
          metric(entry.getKey().get(0), entry.getKey().get(1)));
    }
    if (retried > attributed) {
      telemetry.add(
          Instrument.TASKS_RETRIED, (double) (retried - attributed), metric("unknown", "unknown"));
    }
  }

  private static Map<String, @Nullable Object> span(ClaimedTask task) {
    Map<String, @Nullable Object> attributes = new LinkedHashMap<>();
    attributes.put(Names.TASK_ID, task.id().toString());
    attributes.put(Names.TASK_TYPE, task.type());
    attributes.put(Names.TASK_ATTEMPT, task.attempt());
    return attributes;
  }

  private static Map<String, @Nullable Object> metric(String queue, @Nullable String taskType) {
    Map<String, @Nullable Object> attributes = new LinkedHashMap<>();
    attributes.put(Names.QUEUE_NAME, queue);
    attributes.put(Names.TASK_TYPE, taskType);
    return attributes;
  }

  private static double millisSince(long startedAt) {
    return (System.nanoTime() - startedAt) / 1e6;
  }

  /** The recovery span of the maintenance pass that runs on this thread, and its row total. */
  private static final class Pass {
    final TelemetrySpan recovery;
    long rows;

    Pass(TelemetrySpan recovery) {
      this.recovery = recovery;
    }
  }

  /** One attempt's handler span and its start time. */
  public final class Execution {
    private final ClaimedTask task;
    private final TelemetrySpan span;
    private final long startedAt;
    private @Nullable String errorType;
    private @Nullable String spanOutcome;

    private Execution(ClaimedTask task, TelemetrySpan span, long startedAt) {
      this.task = task;
      this.span = span;
      this.startedAt = startedAt;
    }

    /**
     * Ends the handler span with the attempt's outcome, named as the worker's {@code Outcome}
     * constant, or {@code null} when the attempt reported none. Records the handler duration,
     * runtime, and execution.
     */
    public void finish(@Nullable String outcome) {
      try {
        String metricOutcome =
            outcome == null ? "unknown" : METRIC_OUTCOMES.getOrDefault(outcome, "unknown");
        String spanValue = spanOutcome;
        if (spanValue == null) {
          spanValue =
              outcome == null ? "unknown" : SPAN_OUTCOMES.getOrDefault(outcome, metricOutcome);
        }
        span.setAttribute(Names.HANDLER_OUTCOME, spanValue);
        if (errorType != null) {
          span.recordError(errorType);
        }
        double duration = millisSince(startedAt);
        Map<String, @Nullable Object> attributes = metric(task.queue(), task.type());
        telemetry.add(Instrument.HANDLER_RUNTIME, duration, attributes);
        Map<String, @Nullable Object> withOutcome = new LinkedHashMap<>(attributes);
        withOutcome.put(Names.HANDLER_OUTCOME, metricOutcome);
        telemetry.record(Instrument.HANDLER_DURATION, duration, withOutcome);
        telemetry.add(Instrument.HANDLER_EXECUTIONS, 1, withOutcome);
      } finally {
        EXECUTIONS.remove();
        span.close();
      }
    }
  }
}
