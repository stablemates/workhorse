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
  type Histogram,
  type MetricOptions,
  type Span,
  type TextMapGetter,
  type TextMapSetter,
} from "@opentelemetry/api";
import { SeverityNumber, logs, type LogAttributes, type Logger } from "@opentelemetry/api-logs";
import type { ClaimedJob, TraceContext } from "./types.js";

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
  | "workhorse.handler.finished"
  | "workhorse.handler.registered"
  | "workhorse.handler.started"
  | "workhorse.job.cancellation_acknowledged"
  | "workhorse.job.cancellation_processed"
  | "workhorse.job.checkpoint_saved"
  | "workhorse.job.claimed"
  | "workhorse.job.completed"
  | "workhorse.job.completion_rejected"
  | "workhorse.job.enqueue_replayed"
  | "workhorse.job.enqueued"
  | "workhorse.job.execution_finished"
  | "workhorse.job.failure_processed"
  | "workhorse.job.heartbeat_accepted"
  | "workhorse.job.heartbeat_rejected"
  | "workhorse.job.ownership_expired"
  | "workhorse.job.progress_updated"
  | "workhorse.job.redrive_processed"
  | "workhorse.job.run_now_requested"
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
  severityText: "DEBUG" | "INFO",
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
  maintenanceDrift: lazyHistogram("workhorse.maintenance.drift", {
    description: "Delay beyond a worker maintenance loop's configured cadence",
    unit: "ms",
  }),
};

export function jobSpanAttributes(
  job: Pick<ClaimedJob<unknown>, "id" | "type" | "attempt">,
): Attributes {
  return {
    "workhorse.job.id": job.id,
    "workhorse.job.type": job.type,
    "workhorse.job.attempt": job.attempt,
  };
}

export function jobMetricAttributes(job: Pick<ClaimedJob<unknown>, "queue" | "type">): Attributes {
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
  oldestReadyAgeMs: number | null;
  concurrencyLimit: number | null;
  concurrencyActive: number;
  blockedReadyDepth: number;
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
  const instruments = [
    queueDepth,
    oldestReadyAge,
    concurrencyLimit,
    concurrencyActive,
    concurrencyBlocked,
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
      if (snapshot.concurrencyLimit !== null) {
        result.observe(concurrencyLimit, snapshot.concurrencyLimit, queueAttribute);
        result.observe(concurrencyActive, snapshot.concurrencyActive, queueAttribute);
        result.observe(concurrencyBlocked, snapshot.blockedReadyDepth, queueAttribute);
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
