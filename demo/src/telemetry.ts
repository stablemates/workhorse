import {
  registerQueueMetrics,
  WorkhorseMetricsObserver,
  type Queryable,
  type QueueMetricSource,
} from "@workhorse/core";

export interface DemoMetricsObserver {
  stop(): void;
}

/** Start database-wide metric observations only for the OpenTelemetry demo command. */
export function startDemoMetricsObserver(
  database: Queryable,
  queueMetrics: QueueMetricSource,
): DemoMetricsObserver | undefined {
  if (process.env.WORKHORSE_DEMO_TELEMETRY !== "true") return undefined;
  const observer = new WorkhorseMetricsObserver(database, {
    onError: (error) => console.error("Workhorse metrics collection failed", error),
  }).start();
  const unregisterQueueMetrics = registerQueueMetrics(queueMetrics);
  return {
    stop() {
      unregisterQueueMetrics();
      observer.stop();
    },
  };
}
