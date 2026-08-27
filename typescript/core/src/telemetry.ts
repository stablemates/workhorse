import type {
  CancelStatus,
  ClaimedJob,
  HeartbeatStatus,
  RedriveStatus,
  TraceContext,
} from "./types.js";

export type TelemetryAttributeValue =
  | string
  | number
  | boolean
  | readonly string[]
  | readonly number[]
  | readonly boolean[];
export type TelemetryAttributes = Readonly<Record<string, TelemetryAttributeValue>>;
export type TelemetrySpanKind = "internal" | "consumer";
export type TelemetryContext = unknown;

export interface TelemetryMetricOptions {
  description: string;
  unit: string;
}

export interface TelemetryCounter {
  add(value: number, attributes?: TelemetryAttributes): void;
}

export interface TelemetryRecorder {
  record(value: number, attributes?: TelemetryAttributes): void;
}

export interface WorkhorseTelemetrySpan {
  setAttribute(name: string, value: TelemetryAttributeValue): this;
  setAttributes(attributes: TelemetryAttributes): this;
  setStatus(status: "error"): this;
  recordException(error: unknown): void;
}

export interface TelemetryObservationDefinition extends TelemetryMetricOptions {
  name: string;
}

export interface TelemetryObservation {
  name: string;
  value: number;
  attributes?: TelemetryAttributes;
}

export interface WorkhorseTelemetryProvider {
  emitLog(record: {
    severity: "debug" | "info" | "warn";
    eventName: WorkhorseLogEvent;
    body: string;
    attributes: TelemetryAttributes;
  }): void;
  createCounter(name: string, options: TelemetryMetricOptions): TelemetryCounter;
  createHistogram(name: string, options: TelemetryMetricOptions): TelemetryRecorder;
  createGauge(name: string, options: TelemetryMetricOptions): TelemetryRecorder;
  registerObservations(
    definitions: readonly TelemetryObservationDefinition[],
    collect: () => Promise<readonly TelemetryObservation[]>,
  ): () => void;
  activeContext(): TelemetryContext;
  injectTraceContext(): TraceContext | null;
  extractTraceContext(traceContext: TraceContext | null): TelemetryContext;
  withSpan<T>(
    name: string,
    attributes: TelemetryAttributes,
    operation: (span: WorkhorseTelemetrySpan) => Promise<T>,
    parent: TelemetryContext,
    kind: TelemetrySpanKind,
  ): Promise<T>;
}

const noOpCounter: TelemetryCounter = { add() {} };
const noOpRecorder: TelemetryRecorder = { record() {} };
const noOpSpan: WorkhorseTelemetrySpan = {
  setAttribute() {
    return this;
  },
  setAttributes() {
    return this;
  },
  setStatus() {
    return this;
  },
  recordException() {},
};
const noOpTelemetryProvider: WorkhorseTelemetryProvider = {
  emitLog() {},
  createCounter: () => noOpCounter,
  createHistogram: () => noOpRecorder,
  createGauge: () => noOpRecorder,
  registerObservations: () => () => {},
  activeContext: () => undefined,
  injectTraceContext: () => null,
  extractTraceContext: () => undefined,
  withSpan: async (_name, _attributes, operation) => operation(noOpSpan),
};

let telemetryProvider: WorkhorseTelemetryProvider = noOpTelemetryProvider;
const queueMetricRegistrations = new Set<QueueMetricRegistration>();

/** Register the one process-wide telemetry provider. */
export function registerTelemetryProvider(provider: WorkhorseTelemetryProvider): () => void {
  if (provider === noOpTelemetryProvider) {
    throw new Error("The permanent no-op telemetry provider cannot be registered");
  }
  if (telemetryProvider !== noOpTelemetryProvider) {
    throw new Error("A Workhorse telemetry provider is already registered");
  }

  telemetryProvider = provider;
  try {
    for (const registration of queueMetricRegistrations) registration.activate(provider);
  } catch (error) {
    for (const registration of queueMetricRegistrations) registration.deactivate();
    telemetryProvider = noOpTelemetryProvider;
    throw error;
  }

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (telemetryProvider !== provider) return;
    for (const registration of queueMetricRegistrations) registration.deactivate();
    telemetryProvider = noOpTelemetryProvider;
  };
}

export const MAX_TRACE_CONTEXT_BYTES = 1_024;
/** Maximum span attributes Workhorse emits on any one span. */
export const TRACE_ATTRIBUTE_COUNT_LIMIT = 8;
/** Upper bound applications should configure on each SDK metric stream. */
export const METRIC_ATTRIBUTE_CARDINALITY_LIMIT = 2_000;

export type WorkhorseLogEvent =
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
  severity: "debug" | "info" | "warn",
  eventName: WorkhorseLogEvent,
  body: string,
  attributes: TelemetryAttributes,
): void {
  telemetryProvider.emitLog({ severity, eventName, body, attributes });
}

export function logDebug(
  eventName: WorkhorseLogEvent,
  body: string,
  attributes: TelemetryAttributes = {},
): void {
  emitLog("debug", eventName, body, attributes);
}

export function logInfo(
  eventName: WorkhorseLogEvent,
  body: string,
  attributes: TelemetryAttributes = {},
): void {
  emitLog("info", eventName, body, attributes);
}

export function logWarn(
  eventName: WorkhorseLogEvent,
  body: string,
  attributes: TelemetryAttributes = {},
): void {
  emitLog("warn", eventName, body, attributes);
}

function lazyMetric<TInstrument, TArguments extends unknown[]>(
  create: (provider: WorkhorseTelemetryProvider) => TInstrument,
  invoke: (instrument: TInstrument, ...args: TArguments) => void,
): (...args: TArguments) => void {
  let instrument: TInstrument | undefined;
  let provider: WorkhorseTelemetryProvider | undefined;
  return (...args) => {
    if (instrument === undefined || telemetryProvider !== provider) {
      provider = telemetryProvider;
      instrument = create(provider);
    }
    invoke(instrument, ...args);
  };
}

function lazyCounter(name: string, options: TelemetryMetricOptions): TelemetryCounter {
  return {
    add: lazyMetric(
      (provider) => provider.createCounter(name, options),
      (instrument, ...args: Parameters<TelemetryCounter["add"]>) => instrument.add(...args),
    ),
  };
}

function lazyHistogram(name: string, options: TelemetryMetricOptions): TelemetryRecorder {
  return {
    record: lazyMetric(
      (provider) => provider.createHistogram(name, options),
      (instrument, ...args: Parameters<TelemetryRecorder["record"]>) => instrument.record(...args),
    ),
  };
}

/**
 * Synchronous gauge on the lazy lifecycle. Exported for `WorkhorseMetricsObserver`, which records
 * its own gauges rather than emitting through {@link telemetryMetrics}.
 */
export function lazyGauge(name: string, options: TelemetryMetricOptions): TelemetryRecorder {
  return {
    record: lazyMetric(
      (provider) => provider.createGauge(name, options),
      (instrument, ...args: Parameters<TelemetryRecorder["record"]>) => instrument.record(...args),
    ),
  };
}

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

export function jobSpanAttributes(
  job: Pick<ClaimedJob, "id" | "type" | "attempt">,
): TelemetryAttributes {
  return {
    "workhorse.job.id": job.id,
    "workhorse.job.type": job.type,
    "workhorse.job.attempt": job.attempt,
  };
}

export function jobMetricAttributes(job: Pick<ClaimedJob, "queue" | "type">): TelemetryAttributes {
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

const queueMetricDefinitions: readonly TelemetryObservationDefinition[] = [
  {
    name: "workhorse.queue.depth",
    description: "Current live work by dispatch state",
    unit: "{job}",
  },
  {
    name: "workhorse.queue.oldest_ready_age",
    description: "Age of the oldest ready job",
    unit: "ms",
  },
  {
    name: "workhorse.queue.dependencies.blocked",
    description: "Jobs waiting for prerequisite policy resolution",
    unit: "{job}",
  },
  {
    name: "workhorse.queue.dependencies.pending_edges",
    description: "Unresolved prerequisite edges",
    unit: "{edge}",
  },
  {
    name: "workhorse.queue.dependencies.failed_resolutions",
    description: "Retained jobs failed by dependency policy",
    unit: "{job}",
  },
  {
    name: "workhorse.queue.dependencies.capped",
    description: "Whether dependency pressure values reached their scan limit",
    unit: "1",
  },
  {
    name: "workhorse.queue.children.waiting_parents",
    description: "Parents suspended while linked children settle",
    unit: "{job}",
  },
  {
    name: "workhorse.queue.children.pending",
    description: "Linked children without a terminal outcome",
    unit: "{job}",
  },
  {
    name: "workhorse.queue.children.unjoined_results",
    description: "Successful child results not yet consumed by their parent",
    unit: "{result}",
  },
  {
    name: "workhorse.queue.children.failed_parents",
    description: "Retained parents failed by linked child policy",
    unit: "{job}",
  },
  {
    name: "workhorse.queue.children.canceled_parents",
    description: "Retained parents canceled by linked child policy",
    unit: "{job}",
  },
  {
    name: "workhorse.queue.children.capped",
    description: "Whether child orchestration values reached their scan limit",
    unit: "1",
  },
  {
    name: "workhorse.queue.concurrency.limit",
    description: "Configured queue concurrency limit",
    unit: "{job}",
  },
  {
    name: "workhorse.queue.concurrency.active",
    description: "Unexpired active jobs counted by queue concurrency admission",
    unit: "{job}",
  },
  {
    name: "workhorse.queue.concurrency.blocked_ready",
    description: "Bounded ready depth blocked by queue concurrency policy",
    unit: "{job}",
  },
  {
    name: "workhorse.queue.rate_limit.configured",
    description: "Configured sustained queue start rate",
    unit: "{job}/s",
  },
  {
    name: "workhorse.queue.rate_limit.available_tokens",
    description: "Refilled queue start tokens available now",
    unit: "{token}",
  },
  {
    name: "workhorse.queue.rate_limit.throttled_ready",
    description: "Bounded ready depth waiting for rate-limit tokens",
    unit: "{job}",
  },
  {
    name: "workhorse.queue.rate_limit.next_eligible_delay",
    description: "Delay until the earliest sampled throttled job can start",
    unit: "ms",
  },
];

async function collectQueueMetrics(source: QueueMetricSource): Promise<TelemetryObservation[]> {
  const observations: TelemetryObservation[] = [];
  const observe = (name: string, value: number, attributes: TelemetryAttributes) => {
    observations.push({ name, value, attributes });
  };
  for (const snapshot of await source.queueMetricSnapshot()) {
    const queueAttribute = { "workhorse.queue.name": snapshot.queue };
    for (const [state, value] of [
      ["ready", snapshot.readyDepth],
      ["scheduled", snapshot.scheduledDepth],
      ["active", snapshot.activeLeases],
    ] as const) {
      observe("workhorse.queue.depth", value, { ...queueAttribute, "workhorse.job.state": state });
    }
    if (snapshot.oldestReadyAgeMs !== null)
      observe("workhorse.queue.oldest_ready_age", snapshot.oldestReadyAgeMs, queueAttribute);
    observe(
      "workhorse.queue.dependencies.blocked",
      snapshot.dependencyBlockedDepth,
      queueAttribute,
    );
    observe(
      "workhorse.queue.dependencies.pending_edges",
      snapshot.dependencyPendingEdges,
      queueAttribute,
    );
    observe(
      "workhorse.queue.dependencies.failed_resolutions",
      snapshot.dependencyFailedResolutions,
      queueAttribute,
    );
    observe(
      "workhorse.queue.dependencies.capped",
      snapshot.dependencyCountsCapped ? 1 : 0,
      queueAttribute,
    );
    observe(
      "workhorse.queue.children.waiting_parents",
      snapshot.childWaitingParents,
      queueAttribute,
    );
    observe("workhorse.queue.children.pending", snapshot.childPendingChildren, queueAttribute);
    observe(
      "workhorse.queue.children.unjoined_results",
      snapshot.childUnjoinedResults,
      queueAttribute,
    );
    observe("workhorse.queue.children.failed_parents", snapshot.childFailedParents, queueAttribute);
    observe(
      "workhorse.queue.children.canceled_parents",
      snapshot.childCanceledParents,
      queueAttribute,
    );
    observe("workhorse.queue.children.capped", snapshot.childCountsCapped ? 1 : 0, queueAttribute);
    if (snapshot.concurrencyLimit !== null) {
      observe("workhorse.queue.concurrency.limit", snapshot.concurrencyLimit, queueAttribute);
      observe("workhorse.queue.concurrency.active", snapshot.concurrencyActive, queueAttribute);
      observe(
        "workhorse.queue.concurrency.blocked_ready",
        snapshot.blockedReadyDepth,
        queueAttribute,
      );
    }
    if (snapshot.rateLimitPerSecond !== null) {
      observe("workhorse.queue.rate_limit.configured", snapshot.rateLimitPerSecond, queueAttribute);
      observe(
        "workhorse.queue.rate_limit.available_tokens",
        snapshot.rateLimitAvailableTokens,
        queueAttribute,
      );
      observe(
        "workhorse.queue.rate_limit.throttled_ready",
        snapshot.rateLimitThrottledReadyDepth,
        queueAttribute,
      );
      if (snapshot.rateLimitNextEligibleDelayMs !== null)
        observe(
          "workhorse.queue.rate_limit.next_eligible_delay",
          snapshot.rateLimitNextEligibleDelayMs,
          queueAttribute,
        );
    }
  }
  return observations;
}

class QueueMetricRegistration {
  private cleanup: (() => void) | undefined;

  constructor(private readonly source: QueueMetricSource) {}

  activate(provider: WorkhorseTelemetryProvider): void {
    this.deactivate();
    this.cleanup = provider.registerObservations(queueMetricDefinitions, () =>
      collectQueueMetrics(this.source),
    );
  }

  deactivate(): void {
    this.cleanup?.();
    this.cleanup = undefined;
  }
}

/** Register one database-wide asynchronous queue observation and return its cleanup function. */
export function registerQueueMetrics(source: QueueMetricSource): () => void {
  const registration = new QueueMetricRegistration(source);
  queueMetricRegistrations.add(registration);
  registration.activate(telemetryProvider);
  return () => {
    if (!queueMetricRegistrations.delete(registration)) return;
    registration.deactivate();
  };
}

export function injectTraceContext(): TraceContext | null {
  const traceContext = telemetryProvider.injectTraceContext();
  if (traceContext === null) return null;
  if (Buffer.byteLength(JSON.stringify(traceContext), "utf8") > MAX_TRACE_CONTEXT_BYTES) {
    return null;
  }
  return traceContext;
}

export function extractTraceContext(traceContext: TraceContext | null): TelemetryContext {
  return telemetryProvider.extractTraceContext(traceContext);
}

export async function withSpan<T>(
  name: string,
  attributes: TelemetryAttributes,
  operation: (span: WorkhorseTelemetrySpan) => Promise<T>,
  parent: TelemetryContext = telemetryProvider.activeContext(),
  kind: TelemetrySpanKind = "internal",
): Promise<T> {
  return telemetryProvider.withSpan(
    name,
    attributes,
    async (span) => {
      try {
        return await operation(span);
      } catch (error) {
        span.setStatus("error");
        span.recordException(error instanceof Error ? error : String(error));
        throw error;
      }
    },
    parent,
    kind,
  );
}
