import { metrics } from "@opentelemetry/api";
import { registerOpenTelemetry } from "@stablemates/workhorse-otel";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";

import {
  taskMetricAttributes,
  recordHandlerExecution,
  recordHeartbeatFailure,
  telemetryMetrics,
} from "../src/telemetry.js";

registerOpenTelemetry();

const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const provider = new MeterProvider({
  readers: [
    new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: 60_000,
    }),
  ],
});
metrics.setGlobalMeterProvider(provider);

const task = { queue: "typescript-catalog", type: "catalog-task" };
const taskAttributes = taskMetricAttributes(task);
const handlerAttributes = {
  ...taskAttributes,
  "workhorse.handler.outcome": "succeeded",
};
const batchAttributes = {
  ...taskAttributes,
  "workhorse.handler.batch.full": true,
};

telemetryMetrics.claimed.add(1, taskAttributes);
telemetryMetrics.completed.add(1, taskAttributes);
telemetryMetrics.failed.add(1, {
  ...taskAttributes,
  "workhorse.attempt.outcome": "failed",
});
telemetryMetrics.retried.add(1, taskAttributes);
telemetryMetrics.expiredLeases.add(1);
telemetryMetrics.claimDuration.record(1, {
  "workhorse.queue.name": task.queue,
  "workhorse.claim.result": "claimed",
});
telemetryMetrics.handlerDuration.record(1, handlerAttributes);
telemetryMetrics.handlerRuntime.add(1, taskAttributes);
recordHandlerExecution(task.queue, task.type, "succeeded");
telemetryMetrics.handlerBatchSize.record(1, batchAttributes);
telemetryMetrics.handlerBatchLinger.record(1, batchAttributes);
recordHeartbeatFailure("stale");

await provider.forceFlush();
const catalog = Object.fromEntries(
  exporter
    .getMetrics()
    .flatMap((resource) => resource.scopeMetrics)
    .flatMap((scope) => scope.metrics)
    .map((metric) => [
      metric.descriptor.name,
      {
        unit: metric.descriptor.unit,
        attributes: [
          ...new Set(metric.dataPoints.flatMap((point) => Object.keys(point.attributes))),
        ].toSorted(),
      },
    ]),
);
process.stdout.write(JSON.stringify(catalog));

await provider.shutdown();
metrics.disable();
