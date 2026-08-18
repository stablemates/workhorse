"use strict";

// OpenTelemetry must initialize before Hono, pg, or the worker runtime loads. Keeping this as a
// CommonJS preload makes that ordering explicit for both the TypeScript watcher and compiled app.
const { resolve } = require("node:path");
const {
  getNodeAutoInstrumentations,
  getResourceDetectors,
} = require("@opentelemetry/auto-instrumentations-node");
const { OTLPLogExporter } = require("@opentelemetry/exporter-logs-otlp-http");
const { BatchLogRecordProcessor } = require("@opentelemetry/sdk-logs");
const { NodeSDK } = require("@opentelemetry/sdk-node");
const { RotatingFileLogExporter } = require("./file-log-exporter.cjs");

const telemetryEnabled = process.env.WORKHORSE_DEMO_TELEMETRY === "true";
const serviceName = process.env.WORKHORSE_DEMO_SERVICE_NAME ?? "workhorse-demo";
const environment = process.env.WORKHORSE_ENV ?? process.env.WORKHORSE_DEMO_MODE ?? "development";

process.env.OTEL_SERVICE_NAME ??= serviceName;
process.env.OTEL_TRACES_EXPORTER ??= telemetryEnabled ? "otlp" : "none";
process.env.OTEL_METRICS_EXPORTER ??= telemetryEnabled ? "otlp" : "none";
process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??= "http://127.0.0.1:4318";
process.env.OTEL_EXPORTER_OTLP_PROTOCOL ??= "http/protobuf";
process.env.OTEL_METRIC_EXPORT_INTERVAL ??= "10000";
process.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE ??= "delta";
process.env.OTEL_NODE_RESOURCE_DETECTORS ??= "env,host,os,process,serviceinstance";
process.env.OTEL_RESOURCE_ATTRIBUTES ??= `deployment.environment.name=${environment},deployment.environment=${environment}`;

function safePathSegment(value) {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "unknown";
}

function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

// The default root is the repository's `logs/` directory, two levels above this file. Resolving
// from `__dirname` rather than the working directory keeps the destination stable no matter which
// directory spawned the process.
const logRoot = process.env.WORKHORSE_DEMO_LOG_DIRECTORY
  ? resolve(process.env.WORKHORSE_DEMO_LOG_DIRECTORY)
  : resolve(__dirname, "..", "..", "logs");
const logPath = resolve(
  logRoot,
  safePathSegment(environment),
  `${safePathSegment(serviceName)}.ndjson`,
);
const maxLogBytes = positiveInteger(
  process.env.WORKHORSE_DEMO_LOG_MAX_BYTES,
  10 * 1_024 * 1_024,
  "WORKHORSE_DEMO_LOG_MAX_BYTES",
);
const retainedLogArchives = positiveInteger(
  process.env.WORKHORSE_DEMO_LOG_ARCHIVES,
  5,
  "WORKHORSE_DEMO_LOG_ARCHIVES",
);
const logRecordProcessors = [
  new BatchLogRecordProcessor({
    exporter: new RotatingFileLogExporter({
      path: logPath,
      maxBytes: maxLogBytes,
      archives: retainedLogArchives,
    }),
  }),
];
if (telemetryEnabled) {
  logRecordProcessors.push(new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() }));
}

const sdk = new NodeSDK({
  instrumentations: telemetryEnabled ? [getNodeAutoInstrumentations()] : [],
  resourceDetectors: getResourceDetectors(),
  logRecordProcessors,
});
sdk.start();

let shuttingDown;
function shutdown() {
  shuttingDown ??= sdk.shutdown();
  return shuttingDown;
}

process.once("beforeExit", () => void shutdown());
