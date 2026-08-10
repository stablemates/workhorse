"use strict";

// OpenTelemetry must initialize before Hono, pg, or the worker runtime loads. Keeping this as a
// CommonJS preload makes that ordering explicit for both the TypeScript watcher and compiled app.
if (process.env.WORKHORSE_DEMO_TELEMETRY !== "false") {
  process.env.OTEL_SERVICE_NAME ??= process.env.WORKHORSE_DEMO_SERVICE_NAME ?? "workhorse-demo";
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??= "http://127.0.0.1:4318";
  process.env.OTEL_EXPORTER_OTLP_PROTOCOL ??= "http/protobuf";
  process.env.OTEL_TRACES_EXPORTER ??= "otlp";
  process.env.OTEL_METRICS_EXPORTER ??= "otlp";
  process.env.OTEL_LOGS_EXPORTER ??= "none";
  process.env.OTEL_METRIC_EXPORT_INTERVAL ??= "10000";
  process.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE ??= "delta";
  process.env.OTEL_NODE_RESOURCE_DETECTORS ??= "env,host,os,process,serviceinstance";
  const environment = process.env.WORKHORSE_ENV ?? process.env.WORKHORSE_DEMO_MODE ?? "development";
  process.env.OTEL_RESOURCE_ATTRIBUTES ??= `deployment.environment.name=${environment},deployment.environment=${environment}`;

  const automaticInstrumentation = require("@opentelemetry/auto-instrumentations-node/register");
  void automaticInstrumentation;
}
