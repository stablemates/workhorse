import { WorkhorseMetricsObserver, type Queryable } from "@workhorse/core";

/** Start the single database-wide observer only for the OpenTelemetry demo command. */
export function startDemoMetricsObserver(
  database: Queryable,
): WorkhorseMetricsObserver | undefined {
  if (process.env.WORKHORSE_DEMO_TELEMETRY !== "true") return undefined;
  return new WorkhorseMetricsObserver(database, {
    onError: (error) => console.error("Workhorse metrics collection failed", error),
  }).start();
}
