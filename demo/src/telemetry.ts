import { WorkhorseMetricsObserver, type Queryable } from "@workhorse/core";
import { demoLogger } from "./logger.js";

/** Start database-wide metric observations only for the OpenTelemetry demo command. */
export function startDemoMetricsObserver(
  database: Queryable,
): WorkhorseMetricsObserver | undefined {
  if (process.env.WORKHORSE_DEMO_TELEMETRY !== "true") return undefined;
  demoLogger.debug(
    "workhorse.demo.metrics_observer_started",
    "Database-wide metrics observer started",
  );
  return new WorkhorseMetricsObserver(database, {
    onError: (error) =>
      demoLogger.error(
        "workhorse.demo.metrics_collection_failed",
        "Workhorse metrics collection failed",
        error,
      ),
  }).start();
}
