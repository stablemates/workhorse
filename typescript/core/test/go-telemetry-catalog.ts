import { metrics } from "@opentelemetry/api";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";

import {
  jobMetricAttributes,
  recordHandlerExecution,
  recordHeartbeatFailure,
  telemetryMetrics,
} from "../src/telemetry.js";

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

const job = { queue: "typescript-catalog", type: "catalog-job" };
const jobAttributes = jobMetricAttributes(job);
const handlerAttributes = {
  ...jobAttributes,
  "workhorse.handler.outcome": "succeeded",
};
const batchAttributes = {
  ...jobAttributes,
  "workhorse.handler.batch.full": true,
};

telemetryMetrics.claimed.add(1, jobAttributes);
telemetryMetrics.completed.add(1, jobAttributes);
telemetryMetrics.failed.add(1, {
  ...jobAttributes,
  "workhorse.attempt.outcome": "failed",
});
telemetryMetrics.retried.add(1, jobAttributes);
telemetryMetrics.expiredLeases.add(1);
telemetryMetrics.claimDuration.record(1, {
  "workhorse.queue.name": job.queue,
  "workhorse.claim.result": "claimed",
});
telemetryMetrics.handlerDuration.record(1, handlerAttributes);
telemetryMetrics.handlerRuntime.add(1, jobAttributes);
recordHandlerExecution(job.queue, job.type, "succeeded");
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
        ].sort(),
      },
    ]),
);
process.stdout.write(JSON.stringify(catalog));

await provider.shutdown();
metrics.disable();
