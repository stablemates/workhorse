/**
 * How the dashboard decides to re-read.
 *
 * `live` is not an interval: it subscribes to the host's server-sent refresh stream and refetches
 * when PostgreSQL says something changed, which is why its `ms` is null. Keeping it in the same
 * list as the timed options means one control, one stored preference, and one place where "the
 * page is not updating on a timer" is expressed.
 */
export const dashboardRefreshIntervals = [
  { value: "live", label: "Live", ms: null },
  { value: "off", label: "Manual refresh only", ms: null },
  { value: "5s", label: "Every 5s", ms: 5_000 },
  { value: "15s", label: "Every 15s", ms: 15_000 },
  { value: "30s", label: "Every 30s", ms: 30_000 },
  { value: "1m", label: "Every minute", ms: 60_000 },
  { value: "5m", label: "Every 5 minutes", ms: 300_000 },
] as const;

export type DashboardRefreshIntervalValue = (typeof dashboardRefreshIntervals)[number]["value"];

export const defaultDashboardRefreshInterval: DashboardRefreshIntervalValue = "live";

/** True when this setting refreshes from the event stream rather than a timer. */
export function dashboardRefreshIsLive(value: DashboardRefreshIntervalValue): boolean {
  return value === "live";
}

export function dashboardRefreshIntervalMs(value: DashboardRefreshIntervalValue): number | null {
  return dashboardRefreshIntervals.find((option) => option.value === value)?.ms ?? null;
}

export function startDashboardPolling(intervalMs: number | null, refresh: () => void): () => void {
  if (intervalMs === null) return () => undefined;
  const timer = setInterval(refresh, intervalMs);
  return () => clearInterval(timer);
}
