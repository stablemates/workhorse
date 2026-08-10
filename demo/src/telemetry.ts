import { metrics } from "@opentelemetry/api";
import type { WorkerMaintenanceTelemetry } from "@workhorse/core";

const meter = metrics.getMeter("@workhorse/demo");
const maintenanceRuns = meter.createCounter("workhorse.maintenance.runs", {
  description: "Workhorse maintenance phase executions",
  unit: "{run}",
});
const maintenanceRows = meter.createCounter("workhorse.maintenance.rows", {
  description: "Rows affected by Workhorse maintenance phases",
  unit: "{row}",
});
const maintenanceDuration = meter.createHistogram("workhorse.maintenance.duration", {
  description: "Workhorse maintenance phase duration",
  unit: "ms",
});
const maintenanceErrors = meter.createCounter("workhorse.maintenance.errors", {
  description: "Workhorse maintenance phase failures",
  unit: "{error}",
});

/** Export the worker's bounded, low-cardinality maintenance telemetry through OpenTelemetry. */
export function recordMaintenanceTelemetry(event: WorkerMaintenanceTelemetry): void {
  const attributes = {
    "workhorse.maintenance.loop": event.loop,
    "workhorse.maintenance.phase": event.phase,
    "workhorse.maintenance.skipped_lock": event.skippedLock,
  };
  maintenanceRuns.add(1, attributes);
  maintenanceRows.add(event.rowsAffected, attributes);
  maintenanceDuration.record(event.durationMs, attributes);
  if (event.error !== null) maintenanceErrors.add(1, attributes);
}
