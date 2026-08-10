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
import type { ClaimedJob, TraceContext } from "./types.js";

const INSTRUMENTATION_NAME = "@workhorse/core";

export const MAX_TRACE_CONTEXT_BYTES = 1_024;
/** Maximum span attributes Workhorse emits on any one span. */
export const TRACE_ATTRIBUTE_COUNT_LIMIT = 8;
/** Upper bound applications should configure on each SDK metric stream. */
export const METRIC_ATTRIBUTE_CARDINALITY_LIMIT = 32;

const tracer = trace.getTracer(INSTRUMENTATION_NAME);

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

export interface QueueMetricSource {
  health(): Promise<{
    readyDepth: number;
    scheduledDepth: number;
    activeLeases: number;
    oldestReadyAgeMs: number | null;
  }>;
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
  const instruments = [queueDepth, oldestReadyAge];
  const callback: BatchObservableCallback = async (result) => {
    const health = await source.health();
    result.observe(queueDepth, health.readyDepth, { "workhorse.job.state": "ready" });
    result.observe(queueDepth, health.scheduledDepth, { "workhorse.job.state": "scheduled" });
    result.observe(queueDepth, health.activeLeases, { "workhorse.job.state": "active" });
    if (health.oldestReadyAgeMs !== null) {
      result.observe(oldestReadyAge, health.oldestReadyAgeMs);
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
