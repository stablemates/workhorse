import { createContext, lazy, useContext } from "react";
import type { DashboardClient } from "@workhorse-js/dashboard-server";
import type {
  DashboardCronPage,
  DashboardEventsPage,
  DashboardQueuesPage,
  DashboardSystemPage,
  DashboardSystemWindow,
  DashboardTaskFilter,
  DashboardTasksPage,
  DashboardWorkersPage,
  DashboardSettingsPage,
} from "@workhorse-js/dashboard-server/wire";
import {
  ArrowCounterClockwise,
  CheckCircle,
  Clock,
  ListDashes,
  ListChecks,
  PlayCircle,
  Prohibit,
  UserFocus,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";
import { dashboardTaskFilters } from "@workhorse-js/dashboard-server/wire";
import { parseEventsLocation, type EventsLocationState } from "./events-location.js";
import { parseTaskLocation, taskLocationHref, type TaskLocationState } from "./task-location.js";

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
export const SystemOutcomeChart = lazy(async () => {
  const {
    Bar,
    CartesianGrid,
    ComposedChart,
    Legend,
    Line,
    ResponsiveContainer,
    Tooltip: RechartsTooltip,
    XAxis,
    YAxis,
  } = await import("recharts");

  return {
    default: ({ data }: { data: SystemOutcomeChartPoint[] }) => (
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 12, right: 12, bottom: 0, left: -12 }}>
          <CartesianGrid stroke="var(--mantine-color-default-border)" strokeDasharray="3 3" />
          <XAxis
            dataKey="bucket"
            minTickGap={36}
            tick={{ fontSize: 11, fill: "var(--mantine-color-dimmed)" }}
            tickLine={false}
          />
          <YAxis
            allowDecimals={false}
            width={38}
            tick={{ fontSize: 11, fill: "var(--mantine-color-dimmed)" }}
            tickLine={false}
          />
          <RechartsTooltip />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="succeeded" stackId="outcomes" fill="var(--mantine-color-teal-6)" />
          <Bar dataKey="failed" stackId="outcomes" fill="var(--mantine-color-red-6)" />
          <Bar dataKey="retry" stackId="outcomes" fill="var(--mantine-color-orange-6)" />
          <Bar dataKey="leaseExpired" stackId="outcomes" fill="var(--mantine-color-grape-6)" />
          {/* Cancellation is deliberate operator action, so it never joins the failure series. */}
          <Bar dataKey="canceled" stackId="outcomes" fill="var(--mantine-color-gray-6)" />
          <Line
            dataKey="enqueued"
            type="monotone"
            stroke="var(--mantine-color-blue-7)"
            strokeWidth={2}
            dot={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    ),
  };
});
export function readStoredSystemWindow(): DashboardSystemWindow {
  const stored = localStorage.getItem(systemWindowStorageKey) as DashboardSystemWindow | null;
  return stored && systemWindows.includes(stored) ? stored : "1h";
}
export type ActivityGroupBy = "queue" | "worker" | "task" | "status";
export const activityGroupings: Array<{ value: ActivityGroupBy; label: string }> = [
  { value: "queue", label: "Queue" },
  { value: "worker", label: "Worker" },
  { value: "task", label: "Task" },
  { value: "status", label: "Status" },
];
export interface ActivityData {
  period: ActivityPeriod;
  groupBy: ActivityGroupBy;
  bucketSeconds: number;
  groups: string[];
  buckets: Array<{ bucketStart: string; counts: Record<string, number> }>;
}
export const activitySeriesColors = [
  "#4fa9e8",
  "#ff9a5c",
  "#45d18e",
  "#b183f0",
  "#f5c242",
  "#2fd3c4",
  "#f57bae",
  "#8199f2",
  "#a6d147",
  "#f57676",
];
export // Recharts treats dots in dataKey as nested paths (task types like "demo.failure").
function activityChartKey(group: string): string {
  return group.replaceAll(".", "_");
}
export type PageRoute =
  | "/tasks"
  | "/events"
  | "/cron"
  | "/queues"
  | "/system"
  | "/workers"
  | "/settings";
export type DemoJobKind =
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
  | { route: "/tasks"; value: DashboardTasksPage }
  | { route: "/events"; value: DashboardEventsPage }
  | { route: "/cron"; value: DashboardCronPage }
  | { route: "/queues"; value: DashboardQueuesPage }
  | { route: "/system"; value: DashboardSystemPage }
  | { route: "/workers"; value: DashboardWorkersPage }
  | { route: "/settings"; value: DashboardSettingsPage };
export type LoadState =
  | { status: "loading"; data: PageData | null; error: null }
  | { status: "ready"; data: PageData; error: null }
  | { status: "error"; data: PageData | null; error: string };
const pageRoutes = new Set<PageRoute>([
  "/tasks",
  "/events",
  "/cron",
  "/queues",
  "/system",
  "/workers",
  "/settings",
]);
const taskFilterPresentation: Record<
  DashboardTaskFilter,
  {
    label: string;
    icon: typeof ListChecks;
  }
> = {
  all: { label: "All tasks", icon: ListChecks },
  blocked: { label: "Blocked", icon: WarningCircle },
  waiting: { label: "Waiting", icon: UserFocus },
  scheduled: { label: "Scheduled", icon: Clock },
  retried: { label: "Retried", icon: ArrowCounterClockwise },
  queued: { label: "Queued", icon: ListDashes },
  running: { label: "Running", icon: PlayCircle },
  completed: { label: "Completed", icon: CheckCircle },
  discarded: { label: "Discarded", icon: XCircle },
  // Cancellation is a distinct terminal state, never folded into discarded work.
  canceled: { label: "Canceled", icon: Prohibit },
};
export const taskFilters = dashboardTaskFilters.map((value) => ({
  value,
  label: taskFilterPresentation[value].label,
  icon: taskFilterPresentation[value].icon,
}));
export const blockedTaskDescription =
  "Blocked tasks are held until their dependencies or child tasks reach the required outcomes. They are not waiting for an operator decision.";
/** Header badge color for the deployment environment label. */
export function environmentColor(environment: string): string {
  const normalized = environment.toLowerCase();
  if (normalized.startsWith("prod")) return "red";
  if (normalized.startsWith("stag")) return "orange";
  if (normalized.startsWith("test") || normalized === "ci") return "grape";
  return "blue";
}
export function normalizeBasePath(basePath: string): string {
  const normalized = `/${basePath}`.replaceAll(/\/+/g, "/").replace(/\/$/, "");
  return normalized === "/" ? "" : normalized;
}
export function mountedHref(basePath: string, href: string): string {
  return `${basePath}${href}` || "/";
}
export function readLocation(basePath = ""): {
  route: PageRoute;
  events: EventsLocationState;
} & TaskLocationState {
  const pathname =
    basePath && window.location.pathname.startsWith(`${basePath}/`)
      ? window.location.pathname.slice(basePath.length)
      : window.location.pathname === basePath
        ? "/tasks"
        : window.location.pathname;
  const route = pageRoutes.has(pathname as PageRoute) ? (pathname as PageRoute) : "/tasks";
  const storedPeriod = localStorage.getItem("workhorse-activity-period") as ActivityPeriod | null;
  const storedGroup = localStorage.getItem("workhorse-activity-group") as ActivityGroupBy | null;
  return {
    route,
    events: parseEventsLocation(window.location.search),
    ...parseTaskLocation(route === "/events" ? "" : window.location.search, {
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
