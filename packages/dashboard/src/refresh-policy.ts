export const dashboardRefreshIntervals = [
  { value: "off", label: "Manual refresh only", ms: null },
  { value: "5s", label: "Every 5s", ms: 5_000 },
  { value: "15s", label: "Every 15s", ms: 15_000 },
  { value: "30s", label: "Every 30s", ms: 30_000 },
  { value: "1m", label: "Every minute", ms: 60_000 },
  { value: "5m", label: "Every 5 minutes", ms: 300_000 },
] as const;

export type DashboardRefreshIntervalValue = (typeof dashboardRefreshIntervals)[number]["value"];

export const defaultDashboardRefreshInterval: DashboardRefreshIntervalValue = "15s";

export function dashboardRefreshIntervalMs(value: DashboardRefreshIntervalValue): number | null {
  return dashboardRefreshIntervals.find((option) => option.value === value)?.ms ?? null;
}

export function startDashboardPolling(intervalMs: number | null, refresh: () => void): () => void {
  if (intervalMs === null) return () => undefined;
  const timer = setInterval(refresh, intervalMs);
  return () => clearInterval(timer);
}
