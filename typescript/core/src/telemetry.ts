import {
  SpanKind,
  SpanStatusCode,
  context,
  metrics,
  propagation,
  trace,
  type Attributes,
  type BatchObservableCallback,
  type Context,
  type Counter,
  type Gauge,
  type Histogram,
  type MetricOptions,
  type Span,
  type TextMapGetter,
  type TextMapSetter,
} from "@opentelemetry/api";
import { SeverityNumber, logs, type LogAttributes, type Logger } from "@opentelemetry/api-logs";
import type {
  CancelStatus,
  ClaimedJob,
  HeartbeatStatus,
  RedriveStatus,
  TraceContext,
} from "./types.js";

const INSTRUMENTATION_NAME = "@workhorse/core";

export const MAX_TRACE_CONTEXT_BYTES = 1_024;
/** Maximum span attributes Workhorse emits on any one span. */
export const TRACE_ATTRIBUTE_COUNT_LIMIT = 8;
/** Upper bound applications should configure on each SDK metric stream. */
export const METRIC_ATTRIBUTE_CARDINALITY_LIMIT = 2_000;

const tracer = trace.getTracer(INSTRUMENTATION_NAME);

function lazyLogger(): Pick<Logger, "emit"> {
  let logger: Logger | undefined;
  let provider = logs.getLoggerProvider();
  return {
    emit(record) {
      const activeProvider = logs.getLoggerProvider();
      if (logger === undefined || activeProvider !== provider) {
        provider = activeProvider;
        logger = provider.getLogger(INSTRUMENTATION_NAME);
      }
      logger.emit(record);
    },
  };
}

const telemetryLogger = lazyLogger();

type WorkhorseLogEvent =
  | "workhorse.handler.batch_dispatched"
  | "workhorse.handler.batch_evidence_failed"
  | "workhorse.handler.finished"
  | "workhorse.handler.registered"
  | "workhorse.handler.signal_swallowed"
  | "workhorse.handler.started"
  | "workhorse.job.cancellation_acknowledged"
  | "workhorse.job.cancellation_processed"
  | "workhorse.job.checkpoint_saved"
  | "workhorse.job.child_processed"
  | "workhorse.job.debounce_rejected"
  | "workhorse.job.debounced"
  | "workhorse.job.claimed"
  | "workhorse.job.completed"
  | "workhorse.job.completion_rejected"
  | "workhorse.job.enqueue_replayed"
  | "workhorse.job.enqueued"
  | "workhorse.job.throttled"
  | "workhorse.job.execution_finished"
  | "workhorse.job.failure_processed"
  | "workhorse.job.heartbeat_accepted"
  | "workhorse.job.heartbeat_rejected"
  | "workhorse.job.ownership_expired"
  | "workhorse.job.progress_updated"
  | "workhorse.job.redrive_processed"
  | "workhorse.job.run_now_requested"
  | "workhorse.job.signal_processed"
  | "workhorse.job.human_wait_processed"
  | "workhorse.job.wait_processed"
  | "workhorse.jobs.promoted"
  | "workhorse.jobs.redrive_processed"
  | "workhorse.leases.recovered"
  | "workhorse.maintenance.completed"
  | "workhorse.maintenance_policy.synchronized"
  | "workhorse.queue.paused"
  | "workhorse.queue.purged"
  | "workhorse.queue.resumed"
  | "workhorse.retention_policy.synchronized"
  | "workhorse.schedule.fire_replayed"
  | "workhorse.schedule.fired"
  | "workhorse.schedules.synchronized"
  | "workhorse.worker.deregistered"
  | "workhorse.worker.paused"
  | "workhorse.worker.registered"
  | "workhorse.worker.registration_failed"
  | "workhorse.worker.resumed"
  | "workhorse.worker.started"
  | "workhorse.worker.stop_requested"
  | "workhorse.worker.stopped"
  | "workhorse.worker_registry.pruned";

function emitLog(
  severityNumber: SeverityNumber,
  severityText: "DEBUG" | "INFO" | "WARN",
  eventName: WorkhorseLogEvent,
  body: string,
  attributes: LogAttributes,
): void {
  telemetryLogger.emit({ severityNumber, severityText, eventName, body, attributes });
}

export function logDebug(
  eventName: WorkhorseLogEvent,
  body: string,
  attributes: LogAttributes = {},
): void {
  emitLog(SeverityNumber.DEBUG, "DEBUG", eventName, body, attributes);
}

export function logInfo(
  eventName: WorkhorseLogEvent,
  body: string,
  attributes: LogAttributes = {},
): void {
  emitLog(SeverityNumber.INFO, "INFO", eventName, body, attributes);
}

export function logWarn(
  eventName: WorkhorseLogEvent,
  body: string,
  attributes: LogAttributes = {},
): void {
  emitLog(SeverityNumber.WARN, "WARN", eventName, body, attributes);
}

function lazyMetric<TInstrument, TArguments extends unknown[]>(
  create: () => TInstrument,
  invoke: (instrument: TInstrument, ...args: TArguments) => void,
): (...args: TArguments) => void {
  let instrument: TInstrument | undefined;
  let provider = metrics.getMeterProvider();
  return (...args) => {
    const activeProvider = metrics.getMeterProvider();
    if (instrument === undefined || activeProvider !== provider) {
      provider = activeProvider;
      instrument = create();
    }
    invoke(instrument, ...args);
  };
}

function lazyCounter(name: string, options: MetricOptions): Pick<Counter, "add"> {
  return {
    add: lazyMetric(
      () => metrics.getMeter(INSTRUMENTATION_NAME).createCounter(name, options),
      (instrument, ...args: Parameters<Counter["add"]>) => instrument.add(...args),
    ),
  };
}

function lazyHistogram(name: string, options: MetricOptions): Pick<Histogram, "record"> {
  return {
    record: lazyMetric(
      () => metrics.getMeter(INSTRUMENTATION_NAME).createHistogram(name, options),
      (instrument, ...args: Parameters<Histogram["record"]>) => instrument.record(...args),
    ),
  };
}

/**
 * Synchronous gauge on the lazy lifecycle. Exported for `WorkhorseMetricsObserver`, which records
 * its own gauges rather than emitting through {@link telemetryMetrics}.
 */
export function lazyGauge(name: string, options: MetricOptions): Pick<Gauge, "record"> {
  return {
    record: lazyMetric(
      () => metrics.getMeter(INSTRUMENTATION_NAME).createGauge(name, options),
      (instrument, ...args: Parameters<Gauge["record"]>) => instrument.record(...args),
    ),
  };
}

const carrierSetter: TextMapSetter<Record<string, string>> = {
  set(carrier, key, value) {
    carrier[key.toLowerCase()] = value;
  },
};
const carrierGetter: TextMapGetter<TraceContext> = {
  keys: (carrier) => Object.keys(carrier),
  get: (carrier, key) => carrier[key.toLowerCase() as keyof TraceContext],
};

export const telemetryMetrics = {
  enqueued: lazyCounter("workhorse.jobs.enqueued", {
    description: "Jobs accepted for durable execution",
    unit: "{job}",
  }),
  enqueueOutcomes: lazyCounter("workhorse.jobs.enqueue.outcomes", {
    description: "Enqueue requests by PostgreSQL acceptance outcome",
    unit: "{request}",
  }),
  claimed: lazyCounter("workhorse.jobs.claimed", {
    description: "Jobs claimed for handler execution",
    unit: "{job}",
  }),
  completed: lazyCounter("workhorse.jobs.completed", {
    description: "Jobs completed under a valid lease",
    unit: "{job}",
  }),
  failed: lazyCounter("workhorse.jobs.failed", {
    description: "Handler failures submitted to PostgreSQL",
    unit: "{job}",
  }),
  retried: lazyCounter("workhorse.jobs.retried", {
    description: "Failed or expired jobs returned to live work",
    unit: "{job}",
  }),
  expiredLeases: lazyCounter("workhorse.leases.expired", {
    description: "Expired leases recovered by maintenance",
    unit: "{lease}",
  }),
  claimDuration: lazyHistogram("workhorse.claim.duration", {
    description: "PostgreSQL claim operation latency",
    unit: "ms",
  }),
  handlerDuration: lazyHistogram("workhorse.handler.duration", {
    description: "Handler execution latency",
    unit: "ms",
  }),
  handlerRuntime: lazyCounter("workhorse.handler.runtime", {
    description: "Cumulative handler execution time",
    unit: "ms",
  }),
  handlerBatchSize: lazyHistogram("workhorse.handler.batch.size", {
    description: "Jobs delivered in one batch handler invocation",
    unit: "{job}",
  }),
  handlerBatchLinger: lazyHistogram("workhorse.handler.batch.linger", {
    description: "Time from the first batch member arriving until dispatch",
    unit: "ms",
  }),
  maintenanceDrift: lazyHistogram("workhorse.maintenance.drift", {
    description: "Delay beyond a worker maintenance loop's configured cadence",
    unit: "ms",
  }),
  handlerExecutions: lazyCounter("workhorse.handler.executions", {
    description: "Worker handler activations by outcome",
    unit: "{execution}",
  }),
  cancellations: lazyCounter("workhorse.jobs.cancellation", {
    description: "Job cancellation requests by durable result",
    unit: "{request}",
  }),
  redrives: lazyCounter("workhorse.jobs.redrive", {
    description: "Job redrive requests by durable result",
    unit: "{request}",
  }),
  schedulesFired: lazyCounter("workhorse.schedule.fired", {
    description: "Recurring schedule occurrences durably fired",
    unit: "{occurrence}",
  }),
  scheduleLag: lazyHistogram("workhorse.schedule.lag", {
    description: "Delay between a scheduled occurrence and its durable firing",
    unit: "s",
  }),
  heartbeatFailures: lazyCounter("workhorse.worker.heartbeat.failure", {
    description: "Worker heartbeats rejected by PostgreSQL ownership or timing checks",
    unit: "{heartbeat}",
  }),
  maintenanceRuns: lazyCounter("workhorse.maintenance.runs", {
    description: "Workhorse maintenance phase executions",
    unit: "{run}",
  }),
  maintenanceRows: lazyCounter("workhorse.maintenance.rows", {
    description: "Rows affected by Workhorse maintenance phases",
    unit: "{row}",
  }),
  maintenanceDuration: lazyHistogram("workhorse.maintenance.duration", {
    description: "Workhorse maintenance phase duration",
    unit: "ms",
  }),
  maintenanceErrors: lazyCounter("workhorse.maintenance.errors", {
    description: "Workhorse maintenance phase failures",
    unit: "{error}",
  }),
};

/** Bounded `workhorse.handler.outcome` values. `unknown` covers an activation that ended without
 * reaching a recorded outcome, which only a defect in worker control flow produces. */
export type JobExecutionOutcome =
  | "canceled"
  | "deadline_exceeded"
  | "failed"
  | "lease_lost"
  | "retry"
  | "succeeded"
  | "suspended"
  | "timeout"
  | "unknown";

export function recordHandlerExecution(
  queue: string,
  type: string,
  outcome: JobExecutionOutcome,
): void {
  telemetryMetrics.handlerExecutions.add(1, {
    "workhorse.queue.name": queue,
    "workhorse.job.type": type,
    "workhorse.handler.outcome": outcome,
  });
}

export function recordMaintenanceMetrics(event: {
  loop: string;
  phase: string;
  rowsAffected: number;
  durationMs: number;
  skippedLock: boolean;
  error: unknown;
}): void {
  const attributes = {
    "workhorse.maintenance.loop": event.loop,
    "workhorse.maintenance.phase": event.phase,
    "workhorse.maintenance.skipped_lock": event.skippedLock,
  };
  telemetryMetrics.maintenanceRuns.add(1, attributes);
  telemetryMetrics.maintenanceRows.add(event.rowsAffected, attributes);
  telemetryMetrics.maintenanceDuration.record(event.durationMs, attributes);
  if (event.error !== null) telemetryMetrics.maintenanceErrors.add(1, attributes);
}

export function recordCancellation(status: CancelStatus): void {
  telemetryMetrics.cancellations.add(1, { "workhorse.cancellation.status": status });
}

export function recordRedrive(status: RedriveStatus, count = 1): void {
  if (count > 0) telemetryMetrics.redrives.add(count, { "workhorse.redrive.status": status });
}

export function recordScheduleFired(namespace: string, name: string, occurrenceAt: Date): void {
  const attributes = {
    "workhorse.schedule.namespace": namespace,
    "workhorse.schedule.name": name,
  };
  telemetryMetrics.schedulesFired.add(1, attributes);
  telemetryMetrics.scheduleLag.record(
    Math.max(0, Date.now() - occurrenceAt.getTime()) / 1_000,
    attributes,
  );
}

export function recordHeartbeatFailure(status: Exclude<HeartbeatStatus, "accepted">): void {
  telemetryMetrics.heartbeatFailures.add(1, { "workhorse.heartbeat.status": status });
}

export function jobSpanAttributes(job: Pick<ClaimedJob, "id" | "type" | "attempt">): Attributes {
  return {
    "workhorse.job.id": job.id,
    "workhorse.job.type": job.type,
    "workhorse.job.attempt": job.attempt,
  };
}

export function jobMetricAttributes(job: Pick<ClaimedJob, "queue" | "type">): Attributes {
  return {
    "workhorse.queue.name": job.queue,
    "workhorse.job.type": job.type,
  };
}

export interface QueueMetricSnapshot {
  queue: string;
  readyDepth: number;
  scheduledDepth: number;
  activeLeases: number;
  dependencyBlockedDepth: number;
  dependencyPendingEdges: number;
  dependencyFailedResolutions: number;
  dependencyCountsCapped: boolean;
  childWaitingParents: number;
  childPendingChildren: number;
  childUnjoinedResults: number;
  childFailedParents: number;
  childCanceledParents: number;
  childCountsCapped: boolean;
  oldestReadyAgeMs: number | null;
  concurrencyLimit: number | null;
  concurrencyActive: number;
  blockedReadyDepth: number;
  rateLimitPerSecond: number | null;
  rateLimitAvailableTokens: number;
  rateLimitThrottledReadyDepth: number;
  rateLimitNextEligibleDelayMs: number | null;
}

export interface QueueMetricSource {
  queueMetricSnapshot(): Promise<QueueMetricSnapshot[]>;
}

/** Register one database-wide asynchronous queue observation and return its cleanup function. */
export function registerQueueMetrics(source: QueueMetricSource): () => void {
  const activeMeter = metrics.getMeter(INSTRUMENTATION_NAME);
  const queueDepth = activeMeter.createObservableGauge("workhorse.queue.depth", {
    description: "Current live work by dispatch state",
    unit: "{job}",
  });
  const oldestReadyAge = activeMeter.createObservableGauge("workhorse.queue.oldest_ready_age", {
    description: "Age of the oldest ready job",
    unit: "ms",
  });
  const dependencyBlocked = activeMeter.createObservableGauge(
    "workhorse.queue.dependencies.blocked",
    { description: "Jobs waiting for prerequisite policy resolution", unit: "{job}" },
  );
  const dependencyPending = activeMeter.createObservableGauge(
    "workhorse.queue.dependencies.pending_edges",
    { description: "Unresolved prerequisite edges", unit: "{edge}" },
  );
  const dependencyFailed = activeMeter.createObservableGauge(
    "workhorse.queue.dependencies.failed_resolutions",
    { description: "Retained jobs failed by dependency policy", unit: "{job}" },
  );
  const dependencyCapped = activeMeter.createObservableGauge(
    "workhorse.queue.dependencies.capped",
    { description: "Whether dependency pressure values reached their scan limit", unit: "1" },
  );
  const childWaiting = activeMeter.createObservableGauge(
    "workhorse.queue.children.waiting_parents",
    {
      description: "Parents suspended while linked children settle",
      unit: "{job}",
    },
  );
  const childPending = activeMeter.createObservableGauge("workhorse.queue.children.pending", {
    description: "Linked children without a terminal outcome",
    unit: "{job}",
  });
  const childUnjoined = activeMeter.createObservableGauge(
    "workhorse.queue.children.unjoined_results",
    {
      description: "Successful child results not yet consumed by their parent",
      unit: "{result}",
    },
  );
  const childFailed = activeMeter.createObservableGauge("workhorse.queue.children.failed_parents", {
    description: "Retained parents failed by linked child policy",
    unit: "{job}",
  });
  const childCanceled = activeMeter.createObservableGauge(
    "workhorse.queue.children.canceled_parents",
    {
      description: "Retained parents canceled by linked child policy",
      unit: "{job}",
    },
  );
  const childCapped = activeMeter.createObservableGauge("workhorse.queue.children.capped", {
    description: "Whether child orchestration values reached their scan limit",
    unit: "1",
  });
  const concurrencyLimit = activeMeter.createObservableGauge("workhorse.queue.concurrency.limit", {
    description: "Configured queue concurrency limit",
    unit: "{job}",
  });
  const concurrencyActive = activeMeter.createObservableGauge(
    "workhorse.queue.concurrency.active",
    {
      description: "Unexpired active jobs counted by queue concurrency admission",
      unit: "{job}",
    },
  );
  const concurrencyBlocked = activeMeter.createObservableGauge(
    "workhorse.queue.concurrency.blocked_ready",
    { description: "Bounded ready depth blocked by queue concurrency policy", unit: "{job}" },
  );
  const rateConfigured = activeMeter.createObservableGauge(
    "workhorse.queue.rate_limit.configured",
    { description: "Configured sustained queue start rate", unit: "{job}/s" },
  );
  const rateAvailable = activeMeter.createObservableGauge(
    "workhorse.queue.rate_limit.available_tokens",
    { description: "Refilled queue start tokens available now", unit: "{token}" },
  );
  const rateThrottled = activeMeter.createObservableGauge(
    "workhorse.queue.rate_limit.throttled_ready",
    { description: "Bounded ready depth waiting for rate-limit tokens", unit: "{job}" },
  );
  const rateNextEligibleDelay = activeMeter.createObservableGauge(
    "workhorse.queue.rate_limit.next_eligible_delay",
    { description: "Delay until the earliest sampled throttled job can start", unit: "ms" },
  );
  const instruments = [
    queueDepth,
    oldestReadyAge,
    dependencyBlocked,
    dependencyPending,
    dependencyFailed,
    dependencyCapped,
    childWaiting,
    childPending,
    childUnjoined,
    childFailed,
    childCanceled,
    childCapped,
    concurrencyLimit,
    concurrencyActive,
    concurrencyBlocked,
    rateConfigured,
    rateAvailable,
    rateThrottled,
    rateNextEligibleDelay,
  ];
  const callback: BatchObservableCallback = async (result) => {
    for (const snapshot of await source.queueMetricSnapshot()) {
      const queueAttribute = { "workhorse.queue.name": snapshot.queue };
      result.observe(queueDepth, snapshot.readyDepth, {
        ...queueAttribute,
        "workhorse.job.state": "ready",
      });
      result.observe(queueDepth, snapshot.scheduledDepth, {
        ...queueAttribute,
        "workhorse.job.state": "scheduled",
      });
      result.observe(queueDepth, snapshot.activeLeases, {
        ...queueAttribute,
        "workhorse.job.state": "active",
      });
      if (snapshot.oldestReadyAgeMs !== null) {
        result.observe(oldestReadyAge, snapshot.oldestReadyAgeMs, queueAttribute);
      }
      result.observe(dependencyBlocked, snapshot.dependencyBlockedDepth, queueAttribute);
      result.observe(dependencyPending, snapshot.dependencyPendingEdges, queueAttribute);
      result.observe(dependencyFailed, snapshot.dependencyFailedResolutions, queueAttribute);
      result.observe(dependencyCapped, snapshot.dependencyCountsCapped ? 1 : 0, queueAttribute);
      result.observe(childWaiting, snapshot.childWaitingParents, queueAttribute);
      result.observe(childPending, snapshot.childPendingChildren, queueAttribute);
      result.observe(childUnjoined, snapshot.childUnjoinedResults, queueAttribute);
      result.observe(childFailed, snapshot.childFailedParents, queueAttribute);
      result.observe(childCanceled, snapshot.childCanceledParents, queueAttribute);
      result.observe(childCapped, snapshot.childCountsCapped ? 1 : 0, queueAttribute);
      if (snapshot.concurrencyLimit !== null) {
        result.observe(concurrencyLimit, snapshot.concurrencyLimit, queueAttribute);
        result.observe(concurrencyActive, snapshot.concurrencyActive, queueAttribute);
        result.observe(concurrencyBlocked, snapshot.blockedReadyDepth, queueAttribute);
      }
      if (snapshot.rateLimitPerSecond !== null) {
        result.observe(rateConfigured, snapshot.rateLimitPerSecond, queueAttribute);
        result.observe(rateAvailable, snapshot.rateLimitAvailableTokens, queueAttribute);
        result.observe(rateThrottled, snapshot.rateLimitThrottledReadyDepth, queueAttribute);
        if (snapshot.rateLimitNextEligibleDelayMs !== null) {
          result.observe(
            rateNextEligibleDelay,
            snapshot.rateLimitNextEligibleDelayMs,
            queueAttribute,
          );
        }
      }
    }
  };
  activeMeter.addBatchObservableCallback(callback, instruments);
  return () => activeMeter.removeBatchObservableCallback(callback, instruments);
}

export function injectTraceContext(): TraceContext | null {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier, carrierSetter);
  const traceContext: TraceContext = {
    ...(typeof carrier.traceparent === "string" ? { traceparent: carrier.traceparent } : {}),
    ...(typeof carrier.tracestate === "string" ? { tracestate: carrier.tracestate } : {}),
  };
  if (traceContext.traceparent === undefined) return null;
  if (Buffer.byteLength(JSON.stringify(traceContext), "utf8") > MAX_TRACE_CONTEXT_BYTES) {
    return null;
  }
  return traceContext;
}

export function extractTraceContext(traceContext: TraceContext | null): Context {
  return traceContext === null
    ? context.active()
    : propagation.extract(context.active(), traceContext, carrierGetter);
}

export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  operation: (span: Span) => Promise<T>,
  parent: Context = context.active(),
  kind: SpanKind = SpanKind.INTERNAL,
): Promise<T> {
  return tracer.startActiveSpan(name, { kind, attributes }, parent, async (span) => {
    try {
      return await operation(span);
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      if (error instanceof Error) span.recordException(error);
      else span.recordException(String(error));
      throw error;
    } finally {
      span.end();
    }
  });
}
