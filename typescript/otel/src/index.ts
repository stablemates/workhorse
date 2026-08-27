import {
  SpanKind,
  SpanStatusCode,
  context,
  metrics,
  propagation,
  trace,
  type AttributeValue,
  type Attributes,
  type BatchObservableCallback,
  type Context,
  type Counter,
  type Gauge,
  type Histogram,
  type MetricOptions,
  type Observable,
  type Span,
  type TextMapGetter,
  type TextMapSetter,
} from "@opentelemetry/api";
import { SeverityNumber, logs, type LogAttributes, type Logger } from "@opentelemetry/api-logs";
import {
  registerTelemetryProvider,
  type TelemetryAttributes,
  type TelemetryCounter,
  type TelemetryMetricOptions,
  type TelemetryObservation,
  type TelemetryObservationDefinition,
  type TelemetryRecorder,
  type WorkhorseTelemetryProvider,
  type WorkhorseTelemetrySpan,
} from "@stablemates/workhorse";

const INSTRUMENTATION_NAME = "@stablemates/workhorse";

function attributes(value: TelemetryAttributes | undefined): Attributes | undefined {
  return value as Attributes | undefined;
}

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

function lazyMetric<TInstrument>(
  create: () => TInstrument,
  invoke: (instrument: TInstrument, value: number, attributes?: Attributes) => void,
): (value: number, attributes?: TelemetryAttributes) => void {
  let instrument: TInstrument | undefined;
  let provider = metrics.getMeterProvider();
  return (value, metricAttributes) => {
    const activeProvider = metrics.getMeterProvider();
    if (instrument === undefined || activeProvider !== provider) {
      provider = activeProvider;
      instrument = create();
    }
    invoke(instrument, value, attributes(metricAttributes));
  };
}

function counter(name: string, options: TelemetryMetricOptions): TelemetryCounter {
  return {
    add: lazyMetric(
      () => metrics.getMeter(INSTRUMENTATION_NAME).createCounter(name, options as MetricOptions),
      (instrument: Counter, value, metricAttributes) => instrument.add(value, metricAttributes),
    ),
  };
}

function recorder(
  kind: "histogram" | "gauge",
  name: string,
  options: TelemetryMetricOptions,
): TelemetryRecorder {
  return {
    record: lazyMetric(
      () => {
        const meter = metrics.getMeter(INSTRUMENTATION_NAME);
        return kind === "histogram"
          ? meter.createHistogram(name, options as MetricOptions)
          : meter.createGauge(name, options as MetricOptions);
      },
      (instrument: Histogram | Gauge, value, metricAttributes) =>
        instrument.record(value, metricAttributes),
    ),
  };
}

const carrierSetter: TextMapSetter<Record<string, string>> = {
  set(carrier, key, value) {
    carrier[key.toLowerCase()] = value;
  },
};
const carrierGetter: TextMapGetter<Record<string, string | undefined>> = {
  keys: (carrier) => Object.keys(carrier),
  get: (carrier, key) => carrier[key.toLowerCase()],
};

function spanAdapter(span: Span): WorkhorseTelemetrySpan {
  return {
    setAttribute(name, value) {
      span.setAttribute(name, value as AttributeValue);
      return this;
    },
    setAttributes(spanAttributes) {
      span.setAttributes(attributes(spanAttributes) ?? {});
      return this;
    },
    setStatus(status) {
      span.setStatus({ code: status === "error" ? SpanStatusCode.ERROR : SpanStatusCode.UNSET });
      return this;
    },
    recordException(error) {
      span.recordException(error instanceof Error ? error : String(error));
    },
  };
}

function registerObservations(
  definitions: readonly TelemetryObservationDefinition[],
  collect: () => Promise<readonly TelemetryObservation[]>,
): () => void {
  const meter = metrics.getMeter(INSTRUMENTATION_NAME);
  const instruments = new Map<string, Observable>();
  for (const definition of definitions) {
    instruments.set(
      definition.name,
      meter.createObservableGauge(definition.name, {
        description: definition.description,
        unit: definition.unit,
      }),
    );
  }
  const observableInstruments = [...instruments.values()];
  const callback: BatchObservableCallback = async (result) => {
    for (const observation of await collect()) {
      const instrument = instruments.get(observation.name);
      if (instrument)
        result.observe(instrument, observation.value, attributes(observation.attributes));
    }
  };
  meter.addBatchObservableCallback(callback, observableInstruments);
  return () => meter.removeBatchObservableCallback(callback, observableInstruments);
}

function createOpenTelemetryProvider(): WorkhorseTelemetryProvider {
  const logger = lazyLogger();
  return {
    emitLog(record) {
      const severityNumber = {
        debug: SeverityNumber.DEBUG,
        info: SeverityNumber.INFO,
        warn: SeverityNumber.WARN,
      }[record.severity];
      logger.emit({
        severityNumber,
        severityText: record.severity.toUpperCase(),
        eventName: record.eventName,
        body: record.body,
        attributes: attributes(record.attributes) as LogAttributes,
      });
    },
    createCounter: counter,
    createHistogram: (name, options) => recorder("histogram", name, options),
    createGauge: (name, options) => recorder("gauge", name, options),
    registerObservations,
    activeContext: () => context.active(),
    injectTraceContext() {
      const carrier: Record<string, string> = {};
      propagation.inject(context.active(), carrier, carrierSetter);
      return typeof carrier.traceparent === "string"
        ? {
            traceparent: carrier.traceparent,
            ...(typeof carrier.tracestate === "string" ? { tracestate: carrier.tracestate } : {}),
          }
        : null;
    },
    extractTraceContext(traceContext) {
      return traceContext === null
        ? context.active()
        : propagation.extract(
            context.active(),
            traceContext as Record<string, string | undefined>,
            carrierGetter,
          );
    },
    withSpan(name, spanAttributes, operation, parent, kind) {
      return trace.getTracer(INSTRUMENTATION_NAME).startActiveSpan(
        name,
        {
          kind: kind === "consumer" ? SpanKind.CONSUMER : SpanKind.INTERNAL,
          attributes: attributes(spanAttributes),
        },
        parent as Context,
        async (span) => {
          try {
            return await operation(spanAdapter(span));
          } finally {
            span.end();
          }
        },
      );
    },
  };
}

/** Register OpenTelemetry as the process-wide Workhorse telemetry provider. */
export function registerOpenTelemetry(): () => void {
  return registerTelemetryProvider(createOpenTelemetryProvider());
}
