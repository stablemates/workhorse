import type {
  CancelStatus,
  ClaimedTask,
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
  | "workhorse.task.cancellation_acknowledged"
  | "workhorse.task.cancellation_processed"
  | "workhorse.task.checkpoint_saved"
  | "workhorse.task.child_processed"
  | "workhorse.task.debounce_rejected"
  | "workhorse.task.debounced"
  | "workhorse.task.claimed"
  | "workhorse.task.completed"
  | "workhorse.task.completion_rejected"
  | "workhorse.task.enqueue_replayed"
  | "workhorse.task.enqueued"
  | "workhorse.task.throttled"
  | "workhorse.task.execution_finished"
  | "workhorse.task.failure_processed"
  | "workhorse.task.heartbeat_accepted"
  | "workhorse.task.heartbeat_rejected"
  | "workhorse.task.ownership_expired"
  | "workhorse.task.progress_updated"
  | "workhorse.task.redrive_processed"
  | "workhorse.task.run_now_requested"
  | "workhorse.task.signal_processed"
  | "workhorse.task.human_wait_processed"
  | "workhorse.task.wait_processed"
  | "workhorse.tasks.promoted"
  | "workhorse.tasks.redrive_processed"
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
  enqueued: lazyCounter("workhorse.tasks.enqueued", {
    description: "Tasks accepted for durable execution",
    unit: "{task}",
  }),
  enqueueOutcomes: lazyCounter("workhorse.tasks.enqueue.outcomes", {
    description: "Enqueue requests by PostgreSQL acceptance outcome",
    unit: "{request}",
  }),
  claimed: lazyCounter("workhorse.tasks.claimed", {
    description: "Tasks claimed for handler execution",
    unit: "{task}",
  }),
  completed: lazyCounter("workhorse.tasks.completed", {
    description: "Tasks completed under a valid lease",
    unit: "{task}",
  }),
  failed: lazyCounter("workhorse.tasks.failed", {
    description: "Handler failures submitted to PostgreSQL",
    unit: "{task}",
  }),
  retried: lazyCounter("workhorse.tasks.retried", {
    description: "Failed or expired tasks returned to live work",
    unit: "{task}",
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
    description: "Tasks delivered in one batch handler invocation",
    unit: "{task}",
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
  cancellations: lazyCounter("workhorse.tasks.cancellation", {
    description: "Task cancellation requests by durable result",
    unit: "{request}",
  }),
  redrives: lazyCounter("workhorse.tasks.redrive", {
    description: "Task redrive requests by durable result",
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
export type TaskExecutionOutcome =
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
  outcome: TaskExecutionOutcome,
): void {
  telemetryMetrics.handlerExecutions.add(1, {
    "workhorse.queue.name": queue,
    "workhorse.task.type": type,
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

export function taskSpanAttributes(
  task: Pick<ClaimedTask, "id" | "type" | "attempt">,
): TelemetryAttributes {
  return {
    "workhorse.task.id": task.id,
    "workhorse.task.type": task.type,
    "workhorse.task.attempt": task.attempt,
  };
}

export function taskMetricAttributes(
  task: Pick<ClaimedTask, "queue" | "type">,
): TelemetryAttributes {
  return {
    "workhorse.queue.name": task.queue,
    "workhorse.task.type": task.type,
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
    unit: "{task}",
  },
  {
    name: "workhorse.queue.oldest_ready_age",
    description: "Age of the oldest ready task",
    unit: "ms",
  },
  {
    name: "workhorse.queue.dependencies.blocked",
    description: "Tasks waiting for prerequisite policy resolution",
    unit: "{task}",
  },
  {
    name: "workhorse.queue.dependencies.pending_edges",
    description: "Unresolved prerequisite edges",
    unit: "{edge}",
  },
  {
    name: "workhorse.queue.dependencies.failed_resolutions",
    description: "Retained tasks failed by dependency policy",
    unit: "{task}",
  },
  {
    name: "workhorse.queue.dependencies.capped",
    description: "Whether dependency pressure values reached their scan limit",
    unit: "1",
  },
  {
    name: "workhorse.queue.children.waiting_parents",
    description: "Parents suspended while linked children settle",
    unit: "{task}",
  },
  {
    name: "workhorse.queue.children.pending",
    description: "Linked children without a terminal outcome",
    unit: "{task}",
  },
  {
    name: "workhorse.queue.children.unjoined_results",
    description: "Successful child results not yet consumed by their parent",
    unit: "{result}",
  },
  {
    name: "workhorse.queue.children.failed_parents",
    description: "Retained parents failed by linked child policy",
    unit: "{task}",
  },
  {
    name: "workhorse.queue.children.canceled_parents",
    description: "Retained parents canceled by linked child policy",
    unit: "{task}",
  },
  {
    name: "workhorse.queue.children.capped",
    description: "Whether child orchestration values reached their scan limit",
    unit: "1",
  },
  {
    name: "workhorse.queue.concurrency.limit",
    description: "Configured queue concurrency limit",
    unit: "{task}",
  },
  {
    name: "workhorse.queue.concurrency.active",
    description: "Unexpired active tasks counted by queue concurrency admission",
    unit: "{task}",
  },
  {
    name: "workhorse.queue.concurrency.blocked_ready",
    description: "Bounded ready depth blocked by queue concurrency policy",
    unit: "{task}",
  },
  {
    name: "workhorse.queue.rate_limit.configured",
    description: "Configured sustained queue start rate",
    unit: "{task}/s",
  },
  {
    name: "workhorse.queue.rate_limit.available_tokens",
    description: "Refilled queue start tokens available now",
    unit: "{token}",
  },
  {
    name: "workhorse.queue.rate_limit.throttled_ready",
    description: "Bounded ready depth waiting for rate-limit tokens",
    unit: "{task}",
  },
  {
    name: "workhorse.queue.rate_limit.next_eligible_delay",
    description: "Delay until the earliest sampled throttled task can start",
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
      observe("workhorse.queue.depth", value, { ...queueAttribute, "workhorse.task.state": state });
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
