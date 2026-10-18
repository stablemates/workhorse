package dev.stablemates.workhorse.internal.telemetry;

/**
 * The instruments the Java SDK records, with the kind, unit, and description of {@code
 * api/telemetry.txt}. The counterpart of Ruby's {@code Telemetry::INSTRUMENTS}.
 */
public enum Instrument {
  TASKS_CLAIMED(
      "workhorse.tasks.claimed", Kind.COUNTER, "{task}", "Tasks claimed for handler execution"),
  TASKS_COMPLETED(
      "workhorse.tasks.completed", Kind.COUNTER, "{task}", "Tasks completed under a valid lease"),
  TASKS_FAILED(
      "workhorse.tasks.failed", Kind.COUNTER, "{task}", "Handler failures submitted to PostgreSQL"),
  TASKS_RETRIED(
      "workhorse.tasks.retried",
      Kind.COUNTER,
      "{task}",
      "Failed or expired tasks returned to live work"),
  LEASES_EXPIRED(
      "workhorse.leases.expired",
      Kind.COUNTER,
      "{lease}",
      "Expired leases recovered by maintenance"),
  HANDLER_RUNTIME(
      "workhorse.handler.runtime", Kind.DOUBLE_COUNTER, "ms", "Cumulative handler execution time"),
  HANDLER_EXECUTIONS(
      "workhorse.handler.executions",
      Kind.COUNTER,
      "{execution}",
      "Worker handler activations by outcome"),
  HEARTBEAT_FAILURE(
      "workhorse.worker.heartbeat.failure",
      Kind.COUNTER,
      "{heartbeat}",
      "Worker heartbeats rejected by PostgreSQL ownership or timing checks"),
  SCHEDULE_FIRED(
      "workhorse.schedule.fired",
      Kind.COUNTER,
      "{occurrence}",
      "Recurring schedule occurrences durably fired"),
  MAINTENANCE_RUNS(
      "workhorse.maintenance.runs",
      Kind.COUNTER,
      "{run}",
      "Workhorse maintenance phase executions"),
  MAINTENANCE_ROWS(
      "workhorse.maintenance.rows",
      Kind.COUNTER,
      "{row}",
      "Rows affected by Workhorse maintenance phases"),
  MAINTENANCE_ERRORS(
      "workhorse.maintenance.errors",
      Kind.COUNTER,
      "{error}",
      "Workhorse maintenance phase failures"),
  CLAIM_DURATION(
      "workhorse.claim.duration", Kind.HISTOGRAM, "ms", "PostgreSQL claim operation latency"),
  HANDLER_DURATION("workhorse.handler.duration", Kind.HISTOGRAM, "ms", "Handler execution latency"),
  HANDLER_BATCH_SIZE(
      "workhorse.handler.batch.size",
      Kind.HISTOGRAM,
      "{task}",
      "Tasks delivered in one batch handler invocation"),
  HANDLER_BATCH_LINGER(
      "workhorse.handler.batch.linger",
      Kind.HISTOGRAM,
      "ms",
      "Time from the first batch member arriving until dispatch"),
  SCHEDULE_LAG(
      "workhorse.schedule.lag",
      Kind.HISTOGRAM,
      "s",
      "Delay between a scheduled occurrence and its durable firing"),
  MAINTENANCE_DURATION(
      "workhorse.maintenance.duration",
      Kind.HISTOGRAM,
      "ms",
      "Workhorse maintenance phase duration");

  /** How an instrument records. {@code api/telemetry.txt} prints both counter kinds as counter. */
  public enum Kind {
    /** A monotonic sum of whole numbers. */
    COUNTER,
    /** A monotonic sum of fractional numbers, such as milliseconds. */
    DOUBLE_COUNTER,
    /** A distribution of fractional numbers. */
    HISTOGRAM
  }

  private final String instrumentName;
  private final Kind kind;
  private final String unit;
  private final String description;

  Instrument(String instrumentName, Kind kind, String unit, String description) {
    this.instrumentName = instrumentName;
    this.kind = kind;
    this.unit = unit;
    this.description = description;
  }

  /** The instrument name. */
  public String instrumentName() {
    return instrumentName;
  }

  /** How the instrument records. */
  public Kind kind() {
    return kind;
  }

  /** The UCUM unit. */
  public String unit() {
    return unit;
  }

  /** The description. */
  public String description() {
    return description;
  }
}
