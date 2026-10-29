import { createContext, lazy, useContext } from "react";
import type { BarShapeProps } from "recharts";
import type { DashboardClient } from "@stablemates/workhorse-dashboard-server";
import type {
  DashboardCronPage,
  DashboardEventsPage,
  DashboardQueuesPage,
  DashboardSystemPage,
  DashboardSystemWindow,
  DashboardTaskFilter,
  DashboardTasksPage,
  DashboardTasksCursorPage,
  DashboardWorkersPage,
  DashboardSettingsPage,
  DashboardTaskGroupDetail,
  DashboardTaskGroupsPage,
} from "@stablemates/workhorse-dashboard-server/wire";
import { readStoredValue } from "./browser-storage.js";
import { formatCount } from "./count-format.js";
import { dashboardTaskFilters } from "@stablemates/workhorse-dashboard-server/wire";
import { parseEventsLocation, type EventsLocationState } from "./events-location.js";
import { parseTaskLocation, taskLocationHref, type TaskLocationState } from "./task-location.js";
import { parseTaskGroupsLocation, type TaskGroupsLocationState } from "./task-groups-location.js";

export const DashboardClientContext = createContext<DashboardClient | null>(null);
export function useDashboardClient(): DashboardClient {
  const client = useContext(DashboardClientContext);
  if (!client) throw new Error("Dashboard must receive a client");
  return client;
}
export type ActivityPeriod = "15m" | "1h" | "6h" | "24h" | "7d";
export const activityPeriods: ActivityPeriod[] = ["15m", "1h", "6h", "24h", "7d"];
export const systemWindows: DashboardSystemWindow[] = ["15m", "1h", "24h"];
export const systemWindowStorageKey = "workhorse-system-window";
export // Demo defaults, make configurable later.
const systemOldestReadyWarningMs = 60_000;
export const systemErrorRateWarning = 0.05;
export const systemErrorRateCaution = 0.01;
export interface SystemOutcomeChartPoint {
  bucket: string;
  enqueued: number;
  succeeded: number;
  failed: number;
  retry: number;
  leaseExpired: number;
  canceled: number;
}
/**
 * Attempt outcomes from the baseline of a bar to its top. The dataviz palette validator chose this
 * order, so that the green and red segments never touch.
 */
const systemOutcomeSeries = [
  { id: "succeeded", label: "Succeeded", color: "var(--workhorse-chart-succeeded)" },
  { id: "leaseExpired", label: "Lease expired", color: "var(--workhorse-chart-lease-expired)" },
  { id: "retry", label: "Retry", color: "var(--workhorse-chart-retry)" },
  { id: "failed", label: "Failed", color: "var(--workhorse-chart-failed)" },
  // Cancellation is deliberate operator action, so it never joins the failure series.
  { id: "canceled", label: "Canceled", color: "var(--workhorse-chart-canceled)" },
] as const;
export const SystemOutcomeChart = lazy(async () => {
  // Destructure each dynamic import directly, so the bundler keeps only the named exports.
  const {
    Bar,
    CartesianGrid,
    ComposedChart,
    Legend,
    Line,
    Rectangle,
    ResponsiveContainer,
    Tooltip: RechartsTooltip,
    XAxis,
    YAxis,
    matchByDataKey,
  } = await import("recharts");
  const { ChartTooltip, chartRow, isTopOfStack } = await import("./charts/chart-tooltip.js");
  const { useChartSeriesAnimation } = await import("./charts/chart-motion.js");
  // The legend lists the top segment first, the same order as the stack.
  // oxlint-disable-next-line unicorn/no-array-reverse -- ES2022 lacks Array.prototype.toReversed.
  const legendOrder: string[] = [...systemOutcomeSeries].reverse().map(({ label }) => label);
  const stackIds: string[] = systemOutcomeSeries.map(({ id }) => id);
  // A bar or a point moves to the bucket with the same label, so a refresh slides each minute to
  // its new place. A bucket that only one answer holds grows or shrinks in place.
  const matchBucket = matchByDataKey("bucket");

  function OutcomeChart({ data }: { data: SystemOutcomeChartPoint[] }) {
    // A new time range or a refresh moves each bar from its previous height to the new one. The
    // first paint and reduced motion do not animate.
    const animation = useChartSeriesAnimation();
    return (
      <ResponsiveContainer width="100%" height="100%" className="chart-motion">
        <ComposedChart data={data} margin={{ top: 12, right: 12, bottom: 0, left: -12 }}>
          <CartesianGrid stroke="var(--workhorse-divider)" strokeDasharray="3 3" />
          <XAxis
            dataKey="bucket"
            minTickGap={36}
            tick={{ fontSize: 11, fill: "var(--mantine-color-dimmed)" }}
            tickLine={false}
          />
          <YAxis
            allowDecimals={false}
            width={46}
            tickFormatter={formatCount}
            tick={{ fontSize: 11, fill: "var(--mantine-color-dimmed)" }}
            tickLine={false}
          />
          <RechartsTooltip
            offset={16}
            isAnimationActive={false}
            cursor={{ fill: "var(--workhorse-neutral-3)", stroke: "none" }}
            wrapperStyle={{ zIndex: 3, pointerEvents: "none" }}
            content={({ active, payload, label }) => {
              const values = chartRow(payload?.[0]?.payload);
              if (!active || values.size === 0) return null;
              return (
                <ChartTooltip
                  title={typeof label === "string" ? label : null}
                  values={values}
                  series={systemOutcomeSeries}
                  unit={{ one: "outcome", other: "outcomes" }}
                  footer={
                    <span className="chart-key">
                      <span
                        className="chart-key__swatch"
                        style={{ background: "var(--workhorse-neutral-10)", height: 2 }}
                        aria-hidden
                      />
                      <span className="chart-key__label">Enqueued</span>
                      <span className="chart-key__count">
                        {formatCount(Number(values.get("enqueued")) || 0)}
                      </span>
                    </span>
                  }
                />
              );
            }}
          />
          {/* The swatch carries the series color. The label stays in the text color, because a
              pale series such as retry would fail text contrast. */}
          <Legend
            wrapperStyle={{ fontSize: 12 }}
            itemSorter={(item) => {
              const index = legendOrder.indexOf(String(item.value));
              return index === -1 ? legendOrder.length : index;
            }}
            formatter={(value: string) => (
              <span style={{ color: "var(--mantine-color-text)" }}>{value}</span>
            )}
          />
          {systemOutcomeSeries.map(({ id, label, color }) => (
            <Bar
              key={id}
              dataKey={id}
              name={label}
              stackId="outcomes"
              fill={color}
              className="chart-series"
              {...animation}
              animationMatchBy={matchBucket}
              shape={(props: BarShapeProps) => (
                <Rectangle
                  {...props}
                  radius={isTopOfStack(props.payload, id, stackIds) ? [3, 3, 0, 0] : 0}
                />
              )}
            />
          ))}
          <Line
            dataKey="enqueued"
            name="Enqueued"
            type="monotone"
            stroke="var(--workhorse-neutral-10)"
            strokeWidth={2}
            dot={false}
            {...animation}
            animationMatchBy={matchBucket}
          />
        </ComposedChart>
      </ResponsiveContainer>
    );
  }
  return { default: OutcomeChart };
});
export function readStoredSystemWindow(): DashboardSystemWindow {
  const stored = readStoredValue(systemWindowStorageKey) as DashboardSystemWindow | null;
  return stored && systemWindows.includes(stored) ? stored : "1h";
}
export type ActivityGroupBy = "queue" | "worker" | "task" | "status";
export const activityGroupings: Array<{ value: ActivityGroupBy; label: string }> = [
  { value: "queue", label: "Queue" },
  { value: "worker", label: "Worker" },
  { value: "task", label: "Task" },
  { value: "status", label: "Status" },
];
export type PageRoute =
  | "/tasks"
  | "/events"
  | "/groups"
  | "/cron"
  | "/queues"
  | "/system"
  | "/workers"
  | "/settings";
export type DemoTaskKind =
  | "success"
  | "retry"
  | "durable"
  | "timer"
  | "failure"
  | "idempotent"
  | "long-running"
  | "redrive"
  | "feature";
export type DurableDemoScenario =
  | "order-fulfillment"
  | "customer-onboarding"
  | "report-publication";
export type PageData =
  | { route: "/tasks"; value: DashboardTasksPage | DashboardTasksCursorPage }
  | { route: "/events"; value: DashboardEventsPage }
  | { route: "/groups"; value: TaskGroupsPageData }
  | { route: "/cron"; value: DashboardCronPage }
  | { route: "/queues"; value: DashboardQueuesPage }
  | { route: "/system"; value: DashboardSystemPage }
  | { route: "/workers"; value: DashboardWorkersPage }
  | { route: "/settings"; value: DashboardSettingsPage };
/** The task groups page shows the group list or the detail of one group. */
export type TaskGroupsPageData =
  | { kind: "list"; list: DashboardTaskGroupsPage }
  | { kind: "detail"; detail: DashboardTaskGroupDetail };
/**
 * What the page area shows.
 *
 * `stale` keeps the page after a refresh failed for the data on screen. `refreshedAt` is the time
 * of the last load that succeeded for that data, so the page can say how old the data is.
 * `error.route` is the route whose load failed, which the error screen is about.
 */
export type LoadState =
  | { status: "loading"; data: PageData | null; error: null }
  | { status: "ready"; data: PageData; error: null }
  | { status: "stale"; data: PageData; error: string; refreshedAt: string }
  | { status: "error"; data: PageData | null; error: string; route: PageRoute };
const pageRoutes = new Set<PageRoute>([
  "/tasks",
  "/events",
  "/groups",
  "/cron",
  "/queues",
  "/system",
  "/workers",
  "/settings",
]);
const taskFilterLabels: Record<DashboardTaskFilter, string> = {
  all: "All tasks",
  blocked: "Blocked",
  waiting: "Waiting",
  scheduled: "Scheduled",
  retried: "Retried",
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  discarded: "Discarded",
  // Cancellation is a distinct terminal state, never folded into discarded work.
  canceled: "Canceled",
};
export const taskFilters = dashboardTaskFilters.map((value) => ({
  value,
  label: taskFilterLabels[value],
}));
export const blockedTaskDescription =
  "Blocked tasks are held until their dependencies or child tasks reach the required outcomes. They are not waiting for an operator decision.";
export function normalizeBasePath(basePath: string): string {
  const normalized = `/${basePath}`.replaceAll(/\/+/g, "/").replace(/\/$/, "");
  return normalized === "/" ? "" : normalized;
}
export function mountedHref(basePath: string, href: string): string {
  return `${basePath}${href}` || "/";
}
export type DashboardLocation = {
  route: PageRoute;
  events: EventsLocationState;
  groups: TaskGroupsLocationState;
} & TaskLocationState;
export function readLocation(basePath = ""): DashboardLocation {
  const pathname =
    basePath && window.location.pathname.startsWith(`${basePath}/`)
      ? window.location.pathname.slice(basePath.length)
      : window.location.pathname === basePath
        ? "/tasks"
        : window.location.pathname;
  return parseLocation(pathname, window.location.search);
}
/** The location of a dashboard path, such as `/events?window=24h`, without the mount path. */
export function parseLocation(pathname: string, search: string): DashboardLocation {
  const route = pageRoutes.has(pathname as PageRoute) ? (pathname as PageRoute) : "/tasks";
  const storedPeriod = readStoredValue("workhorse-activity-period") as ActivityPeriod | null;
  const storedGroup = readStoredValue("workhorse-activity-group") as ActivityGroupBy | null;
  return {
    route,
    events: parseEventsLocation(search),
    groups: parseTaskGroupsLocation(route === "/groups" ? search : ""),
    ...parseTaskLocation(route === "/events" || route === "/groups" ? "" : search, {
      period: storedPeriod && activityPeriods.includes(storedPeriod) ? storedPeriod : "1h",
      group:
        storedGroup && activityGroupings.some(({ value }) => value === storedGroup)
          ? storedGroup
          : "task",
    }),
  };
}
export function taskHref(state: TaskLocationState): string {
  return taskLocationHref(state);
}
