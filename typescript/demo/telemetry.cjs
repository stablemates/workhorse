"use strict";

// OpenTelemetry must initialize before Hono, pg, or the worker runtime loads. Keeping this as a
// CommonJS preload makes that ordering explicit for both the TypeScript watcher and compiled app.
const { OTLPLogExporter } = require("@opentelemetry/exporter-logs-otlp-http");
const { BatchLogRecordProcessor } = require("@opentelemetry/sdk-logs");
const { NodeSDK, resources } = require("@opentelemetry/sdk-node");
const { RotatingFileLogExporter, demoLogFile } = require("./file-log-exporter.cjs");

const telemetryEnabled = process.env.WORKHORSE_DEMO_TELEMETRY === "true";
const serviceName = process.env.WORKHORSE_DEMO_SERVICE_NAME ?? "workhorse-demo";
const environment = process.env.WORKHORSE_DEMO_ENV ?? "development";

process.env.OTEL_SERVICE_NAME ??= serviceName;
process.env.OTEL_TRACES_EXPORTER ??= telemetryEnabled ? "otlp" : "none";
process.env.OTEL_METRICS_EXPORTER ??= telemetryEnabled ? "otlp" : "none";
process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??= "http://127.0.0.1:4318";
process.env.OTEL_EXPORTER_OTLP_PROTOCOL ??= "http/protobuf";
process.env.OTEL_METRIC_EXPORT_INTERVAL ??= "10000";
process.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE ??= "delta";
process.env.OTEL_NODE_RESOURCE_DETECTORS ??= "env,host,os,process,serviceinstance";
process.env.OTEL_RESOURCE_ATTRIBUTES ??= `deployment.environment.name=${environment},deployment.environment=${environment}`;

const logFile = demoLogFile(serviceName, environment, ".ndjson");
const logRecordProcessors = [
  new BatchLogRecordProcessor({
    exporter: new RotatingFileLogExporter(logFile),
  }),
];
if (telemetryEnabled) {
  logRecordProcessors.push(new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() }));
}

// The auto-instrumentations package loads every instrumentation it bundles, about a quarter of a
// second of CPU per process, and each of the demo's Node processes pays it at startup (SM-859).
// Production runs with telemetry off, so load it only when telemetry is on or a configured
// resource detector needs it. The five local detectors come from the SDK, in the same order.
const localResourceDetectors = new Map([
  ["env", resources.envDetector],
  ["host", resources.hostDetector],
  ["os", resources.osDetector],
  ["process", resources.processDetector],
  ["serviceinstance", resources.serviceInstanceIdDetector],
]);
const configuredDetectors = process.env.OTEL_NODE_RESOURCE_DETECTORS.split(",");
const autoInstrumentations =
  telemetryEnabled || !configuredDetectors.every((name) => localResourceDetectors.has(name))
    ? require("@opentelemetry/auto-instrumentations-node")
    : undefined;

const sdk = new NodeSDK({
  instrumentations: telemetryEnabled ? [autoInstrumentations.getNodeAutoInstrumentations()] : [],
  resourceDetectors: autoInstrumentations
    ? autoInstrumentations.getResourceDetectors()
    : configuredDetectors.map((name) => localResourceDetectors.get(name)),
  logRecordProcessors,
});
sdk.start();
// `telemetry-register.mjs` registers the Workhorse provider on the ESM instance of the SDK.

let shuttingDown;
function shutdown() {
  globalThis[Symbol.for("workhorse.demo.unregisterOpenTelemetry")]?.();
  shuttingDown ??= sdk.shutdown();
  return shuttingDown;
}

process.once("beforeExit", () => void shutdown());
