import {
  Accordion,
  ActionIcon,
  Alert,
  AppShell,
  Badge,
  Box,
  Burger,
  Button,
  Center,
  Code,
  Divider,
  Drawer,
  Grid,
  Group,
  Loader,
  Menu,
  MultiSelect,
  NavLink,
  Pagination,
  Paper,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Stepper,
  Switch,
  Table,
  Text,
  TextInput,
  ThemeIcon,
  Title,
  Tooltip,
  VisuallyHidden,
} from "@mantine/core";
import { BarChart } from "@mantine/charts";
import { useDisclosure } from "@mantine/hooks";
import {
  ArrowCounterClockwise,
  ArrowClockwise,
  CalendarDots,
  CheckCircle,
  Clock,
  Copy,
  DotsThreeVertical,
  FunnelSimple,
  GearSix,
  Info,
  Lightning,
  ListDashes,
  ListChecks,
  MagnifyingGlass,
  PlayCircle,
  Prohibit,
  Pulse,
  Robot,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";
import {
  createContext,
  Fragment,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import type {
  MaintenancePolicyDefinition,
  MaintenancePolicySetting,
  RetentionPolicySetting,
  RetryPolicy,
} from "@workhorse/core";
import {
  dashboardAttemptOutcomes,
  dashboardJobEventTypes,
  describeCancellationRequest,
  describeCancelOutcome,
  describeIdempotency,
  describeRetryEventSource,
  describeRetryPolicy,
  formatRetryDelay,
  idempotencyEvidenceLine,
  isTerminalTaskState,
  readIdempotencyEvidence,
  taskRowActionGroups,
} from "./model.js";
import { describeDurableBoundary, readTaskResultEvidence, type TaskResultState } from "./model.js";
import type {
  DashboardCancellationRequest,
  DashboardCronPage,
  DashboardEventDetail,
  DashboardEventRow,
  DashboardEventsPage,
  DashboardEventsWindow,
  DashboardJobDetail,
  DashboardJobRow,
  DashboardQueuesPage,
  DashboardStorageRelation,
  DashboardSystemPage,
  DashboardSystemRetention,
  DashboardSystemRetryBucket,
  DashboardSystemStorage,
  DashboardSystemWindow,
  DashboardTaskFacets,
  DashboardTaskCounts,
  DashboardTaskFilter,
  DashboardTasksPage,
  DashboardWorkersPage,
  DashboardSettingsPage,
  TaskRowActionCapabilities,
  TaskRowActionId,
} from "./model.js";
import type { DashboardClient, DashboardDemoTools } from "./client.js";
import { requestRunNow, type RunNowFeedback } from "./run-now.js";
import { notifyCancel, notifyDashboard, notifyFailure, notifyRunNow } from "./notifications.js";
import { WorkhorseBrand } from "./brand.js";
import {
  dashboardPollingIntervalMs,
  dashboardRefreshIntervals,
  defaultDashboardRefreshInterval,
  discardBackgroundSettingsRefresh,
  startDashboardPolling,
  type DashboardRefreshIntervalValue,
} from "./refresh-policy.js";
import {
  eventsListingKey,
  eventsLocationHref,
  parseEventsLocation,
  type EventsLocationState,
} from "./events-location.js";
import {
  parseTaskLocation,
  taskDetailNavigation,
  taskListingKey,
  taskLocationHref,
  taskPageSizes,
  type TaskLocationState,
  type TaskPageSize,
} from "./task-location.js";
import {
  cancelResultAppliesTo,
  clearPendingCancel,
  createLatestRequestGuard,
  taskDrawerModelessProps,
  taskDrawerOpened,
  taskDrawerSync,
} from "./task-drawer.js";
import {
  concurrencyCappedFootnote,
  describeConcurrencyBlocked,
  describeConcurrencyKeys,
  describeConcurrencyLimit,
  describeTaskConcurrency,
} from "./concurrency-policy.js";
import { ThemeSchemeSwitch } from "./theme.js";

const DashboardClientContext = createContext<DashboardClient | null>(null);

function useDashboardClient(): DashboardClient {
  const client = useContext(DashboardClientContext);
  if (!client) throw new Error("Dashboard must receive a client");
  return client;
}

type ActivityPeriod = "15m" | "1h" | "6h" | "24h" | "7d";
const activityPeriods: ActivityPeriod[] = ["15m", "1h", "6h", "24h", "7d"];

const systemWindows: DashboardSystemWindow[] = ["15m", "1h", "24h"];
const systemWindowStorageKey = "workhorse-system-window";
// Demo defaults, make configurable later.
const systemOldestReadyWarningMs = 60_000;
const systemErrorRateWarning = 0.05;
const systemErrorRateCaution = 0.01;

interface SystemOutcomeChartPoint {
  bucket: string;
  enqueued: number;
  succeeded: number;
  failed: number;
  retry: number;
  leaseExpired: number;
  canceled: number;
}

const SystemOutcomeChart = lazy(async () => {
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

function readStoredSystemWindow(): DashboardSystemWindow {
  const stored = localStorage.getItem(systemWindowStorageKey) as DashboardSystemWindow | null;
  return stored && systemWindows.includes(stored) ? stored : "1h";
}

type ActivityGroupBy = "queue" | "worker" | "task" | "status";
const activityGroupings: Array<{ value: ActivityGroupBy; label: string }> = [
  { value: "queue", label: "Queue" },
  { value: "worker", label: "Worker" },
  { value: "task", label: "Task" },
  { value: "status", label: "Status" },
];

interface ActivityData {
  period: ActivityPeriod;
  groupBy: ActivityGroupBy;
  bucketSeconds: number;
  groups: string[];
  buckets: Array<{ bucketStart: string; counts: Record<string, number> }>;
}

const activitySeriesColors = [
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

// Recharts treats dots in dataKey as nested paths (task types like "demo.failure").
function activityChartKey(group: string): string {
  return group.replaceAll(".", "_");
}

type PageRoute = "/tasks" | "/events" | "/cron" | "/queues" | "/system" | "/workers" | "/settings";
type DemoJobKind =
  | "success"
  | "retry"
  | "durable"
  | "timer"
  | "failure"
  | "idempotent"
  | "long-running";
type DurableDemoScenario = "order-fulfillment" | "customer-onboarding" | "report-publication";
type PageData =
  | { route: "/tasks"; value: DashboardTasksPage }
  | { route: "/events"; value: DashboardEventsPage }
  | { route: "/cron"; value: DashboardCronPage }
  | { route: "/queues"; value: DashboardQueuesPage }
  | { route: "/system"; value: DashboardSystemPage }
  | { route: "/workers"; value: DashboardWorkersPage }
  | { route: "/settings"; value: DashboardSettingsPage };
type LoadState =
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
const taskFilters: ReadonlyArray<{
  value: DashboardTaskFilter;
  label: string;
  icon: typeof ListChecks;
}> = [
  { value: "all", label: "All tasks", icon: ListChecks },
  { value: "scheduled", label: "Scheduled", icon: Clock },
  { value: "retried", label: "Retried", icon: ArrowCounterClockwise },
  { value: "queued", label: "Queued", icon: ListDashes },
  { value: "running", label: "Running", icon: PlayCircle },
  { value: "completed", label: "Completed", icon: CheckCircle },
  { value: "discarded", label: "Discarded", icon: XCircle },
  // Cancellation is a distinct terminal state, never folded into discarded work.
  { value: "canceled", label: "Canceled", icon: Prohibit },
];
const healthyStates = new Set(["succeeded", "ready", "active", "busy"]);
const failureStates = new Set(["failed", "discarded", "incomplete"]);
const warningStates = new Set(["scheduled", "retryable", "recent", "due"]);
/**
 * Cancellation is neither success nor failure, so it gets its own neutral treatment. Colour is
 * decoration only; the badge text still says "Canceled" on its own.
 */
const canceledStates = new Set(["canceled", "cancel_requested"]);

/** Header badge color for the deployment environment label. */
function environmentColor(environment: string): string {
  const normalized = environment.toLowerCase();
  if (normalized.startsWith("prod")) return "red";
  if (normalized.startsWith("stag")) return "orange";
  if (normalized.startsWith("test") || normalized === "ci") return "grape";
  return "blue";
}

function normalizeBasePath(basePath: string): string {
  const normalized = `/${basePath}`.replaceAll(/\/+/g, "/").replace(/\/$/, "");
  return normalized === "/" ? "" : normalized;
}

function mountedHref(basePath: string, href: string): string {
  return `${basePath}${href}` || "/";
}

function readLocation(basePath = ""): {
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

function taskHref(state: TaskLocationState): string {
  return taskLocationHref(state);
}

/**
 * Display timezone preference. Timestamps are stored and transported as UTC ISO
 * strings; this only affects rendering. "system" means the browser's own zone.
 */
const timeZoneStorageKey = "workhorse-timezone";
const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();
const createDateTimeFormatter = Intl.DateTimeFormat;
let displayTimeZone: string | null = readStoredTimeZone();
const timeZoneListeners = new Set<() => void>();

function getDateTimeFormatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(options);
  const cached = dateTimeFormatters.get(key);
  if (cached) return cached;
  const formatter = new createDateTimeFormatter(undefined, options);
  dateTimeFormatters.set(key, formatter);
  return formatter;
}

function readStoredTimeZone(): string | null {
  const stored = localStorage.getItem(timeZoneStorageKey);
  if (!stored || stored === "system") return null;
  try {
    return getDateTimeFormatter({ timeZone: stored }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

function setDisplayTimeZone(zone: string | null): void {
  displayTimeZone = zone;
  localStorage.setItem(timeZoneStorageKey, zone ?? "system");
  for (const listener of timeZoneListeners) listener();
}

function subscribeTimeZone(listener: () => void): () => void {
  timeZoneListeners.add(listener);
  return () => timeZoneListeners.delete(listener);
}

function currentTimeZoneValue(): string {
  return displayTimeZone ?? "system";
}

function formatExact(value: string | null | undefined): string {
  if (!value) return "never";
  return getDateTimeFormatter({
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: displayTimeZone ?? undefined,
    timeZoneName: "short",
  }).format(new Date(value));
}

function formatRelative(value: string | null | undefined): string {
  if (!value) return "never";
  const deltaMs = Date.now() - new Date(value).getTime();
  const future = deltaMs < 0;
  const seconds = Math.round(Math.abs(deltaMs) / 1_000);
  const phrase =
    seconds < 5
      ? "now"
      : seconds < 60
        ? `${seconds}s`
        : seconds < 3_600
          ? `${Math.floor(seconds / 60)}m`
          : seconds < 86_400
            ? `${Math.floor(seconds / 3_600)}h`
            : `${Math.floor(seconds / 86_400)}d`;
  if (phrase === "now") return future ? "in a moment" : "just now";
  return future ? `in ${phrase}` : `${phrase} ago`;
}

function formatDuration(milliseconds: number | null | undefined): string {
  if (milliseconds === null || milliseconds === undefined) return "—";
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)} s`;
  return `${Math.round(milliseconds / 60_000)} min`;
}

/** Wall-clock time of day, used when a date alone would be too long for a table row. */
function formatClock(value: string | null | undefined): string {
  if (!value) return "—";
  return getDateTimeFormatter({
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: displayTimeZone ?? undefined,
  }).format(new Date(value));
}

/** Calendar day without a time, so a daily boundary reads plainly. */
function formatDay(value: string | null | undefined): string {
  if (!value) return "—";
  return getDateTimeFormatter({
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: displayTimeZone ?? undefined,
  }).format(new Date(value));
}

/**
 * Coarse span for retention ages, which run to days rather than the milliseconds and minutes
 * `formatDuration` targets. Rounds down so a reported span never overstates the real lag.
 */
function formatSpan(milliseconds: number | null | undefined): string {
  if (milliseconds === null || milliseconds === undefined) return "—";
  if (milliseconds < 60_000) return "under a minute";
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hr`;
  return `${Math.floor(hours / 24)} days`;
}

/** Relation size in the units an operator reads storage dashboards in. */
function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Row counts come from PostgreSQL statistics, so they are estimates and read better abbreviated. */
function formatRows(rows: number): string {
  if (rows < 1_000) return String(rows);
  if (rows < 1_000_000) return `${(rows / 1_000).toFixed(rows < 10_000 ? 1 : 0)}k`;
  return `${(rows / 1_000_000).toFixed(rows < 10_000_000 ? 1 : 0)}M`;
}

/**
 * Remaining time until a target, clamped at zero. A durable wait target that has
 * passed is not negative time; the task is simply eligible to be claimed again.
 */
function formatCountdown(targetIso: string, nowMs: number): string {
  const remainingMs = Math.max(0, new Date(targetIso).getTime() - nowMs);
  if (remainingMs < 1_000) return "0s";
  const totalSeconds = Math.floor(remainingMs / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** True once the target has passed; re-renders once at the target instead of ticking. */
function useElapsed(targetIso: string | null): boolean {
  const [elapsed, setElapsed] = useState(
    () => targetIso !== null && new Date(targetIso).getTime() <= Date.now(),
  );
  useEffect(() => {
    if (targetIso === null) return;
    const remainingMs = new Date(targetIso).getTime() - Date.now();
    if (remainingMs <= 0) {
      setElapsed(true);
      return;
    }
    setElapsed(false);
    const timer = setTimeout(() => setElapsed(true), remainingMs);
    return () => clearTimeout(timer);
  }, [targetIso]);
  return elapsed;
}

/** Ticking clock for countdowns. Pass `false` to stop ticking when nothing counts down. */
function useNow(active: boolean, intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}

function checkpointOutput(value: unknown): string {
  if (value && typeof value === "object" && "output" in value) {
    const output = (value as { output?: unknown }).output;
    if (typeof output === "string") return output;
  }
  return JSON.stringify(value);
}

/** SQL NULL and missing values both mean there is no inspectable JSON evidence. */
function hasStoredValue(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "";
}

const clipboardUnavailable =
  "Copying is not available in this browser. Open the task to select the text instead.";

/** Resolves to null on success, or to the sentence to show the operator when copying failed. */
async function copyToClipboard(text: string): Promise<string | null> {
  if (!navigator.clipboard) return clipboardUnavailable;
  try {
    await navigator.clipboard.writeText(text);
    return null;
  } catch {
    return clipboardUnavailable;
  }
}

/**
 * Bounded viewer for one stored JSON value.
 *
 * Every stored value in this drawer is operator evidence, so it is shown in full rather than
 * truncated, but its height is capped and it scrolls inside its own box so one large payload
 * cannot push the rest of the drawer off screen. The copy action carries the exact bytes, because
 * a value an operator can read but not extract is not usable evidence.
 *
 * When nothing is stored, `emptyLabel` is shown instead. No placeholder value is ever invented.
 */
function JsonValue({
  label,
  value,
  emptyLabel,
  copyLabel,
  maxHeight = 220,
}: {
  label: string;
  value: unknown;
  emptyLabel: string;
  /** What to name this value to a screen reader on the copy control. */
  copyLabel: string;
  maxHeight?: number;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const present = hasStoredValue(value);
  const text = present ? formatJson(value) : "";
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = useCallback(() => {
    setCopyError(null);
    if (!navigator.clipboard) {
      setCopyError("Copying is not available in this browser. Select the text to copy it.");
      return;
    }
    void navigator.clipboard.writeText(text).then(
      () => setCopied(true),
      () => setCopyError("Copying is not available in this browser. Select the text to copy it."),
    );
  }, [text]);
  return (
    <Box>
      <Group justify="space-between" align="center" mb={4} wrap="nowrap">
        <Text fw={600} size="xs">
          {label}
        </Text>
        {present ? (
          <Tooltip label={copied ? "Copied" : `Copy ${copyLabel}`} withArrow>
            <ActionIcon
              size="sm"
              variant="subtle"
              color={copied ? "teal" : "gray"}
              aria-label={copied ? `${copyLabel} copied to the clipboard` : `Copy ${copyLabel}`}
              onClick={copy}
            >
              {copied ? <CheckCircle size={14} weight="bold" /> : <Copy size={14} />}
            </ActionIcon>
          </Tooltip>
        ) : null}
      </Group>
      {present ? (
        <>
          <ScrollArea.Autosize mah={maxHeight} type="auto">
            <Code block fz="xs">
              {text}
            </Code>
          </ScrollArea.Autosize>
          {/* Copy feedback is announced, not only coloured, so the result is never icon-only. */}
          <Box role="status" aria-live="polite">
            {copyError ? (
              <Text c="red" size="xs" mt={4}>
                {copyError}
              </Text>
            ) : copied ? (
              <Text c="dimmed" size="xs" mt={4}>
                Copied {copyLabel} to the clipboard.
              </Text>
            ) : null}
          </Box>
        </>
      ) : (
        <Text c="dimmed" size="xs">
          {emptyLabel}
        </Text>
      )}
    </Box>
  );
}

const outcomeStateColor: Record<TaskResultState, string> = {
  succeeded: "teal",
  failed: "red",
  canceled: "gray",
  pending: "yellow",
};

/**
 * Final outcome of one task, stated before any interim evidence.
 *
 * An operator opening this drawer is usually asking "did this finish, and what did it produce?".
 * That question is answered from the stored terminal row alone: a task that has not finished says
 * so instead of showing an empty result, and a retrying task's latest error is labelled as an
 * attempt error so it is never mistaken for a terminal one.
 */
function TaskOutcome({ job }: { job: DashboardJobDetail }) {
  const outcome = job.current.outcome;
  const evidence = readTaskResultEvidence({
    state: job.identity.state,
    outcome,
    runtimeError: job.current.runtime?.error,
    currentError: job.current.error,
    blockedByPersistentFailure: job.durability?.persistentFailure != null,
  });
  const described = evidence.description;
  return (
    <Box component="section" aria-labelledby="task-outcome-heading">
      <Group justify="space-between" align="center" mb={4} wrap="nowrap">
        <Text id="task-outcome-heading" component="h3" fw={600} size="sm" my={0}>
          Outcome
        </Text>
        <Badge
          variant="light"
          color={outcomeStateColor[described.state]}
          tt="none"
          title={outcome ? `Finished ${formatExact(outcome.finishedAt)}` : described.summary}
        >
          {described.label}
        </Badge>
      </Group>
      <Text c="dimmed" size="xs" mb="xs">
        {described.summary}
      </Text>
      {outcome ? (
        <Text c="dimmed" size="xs" mb="xs" title={formatExact(outcome.finishedAt)}>
          Attempt {outcome.attempt} finished {formatRelative(outcome.finishedAt)}
        </Text>
      ) : null}
      <JsonValue
        label={described.valueLabel ?? "Final result"}
        value={evidence.value}
        emptyLabel={described.emptyLabel ?? "Nothing was stored."}
        copyLabel={(described.valueLabel ?? "final result").toLowerCase()}
      />
    </Box>
  );
}

function plannedStepDescription(
  job: DashboardJobDetail,
  checkpoint: DashboardJobDetail["checkpoints"][number] | undefined,
  stepIndex: number,
  activeStep: number,
) {
  const boundary = describeDurableBoundary({
    stepIndex,
    hasCheckpoint: checkpoint !== undefined,
    persistentFailureAfterStepIndex: job.durability?.persistentFailure?.afterStepIndex ?? null,
  });
  if (checkpoint) {
    return (
      <Stack gap={2} mt={2}>
        <Text c="dimmed" size="xs">
          Attempt {checkpoint.attempt} · {checkpoint.workerId} · fence {checkpoint.fenceToken}
        </Text>
        <Code fz="xs" title={JSON.stringify(checkpoint.value)}>
          {checkpointOutput(checkpoint.value)}
        </Code>
        {boundary.state === "blocked" ? (
          <Text c="dimmed" size="xs">
            {boundary.label}. {boundary.summary}
          </Text>
        ) : null}
      </Stack>
    );
  }
  // A stage past a declared persistent failure can never run again, so it is reported as never
  // reached rather than as waiting its turn.
  if (boundary.state === "not-reached") return `${boundary.label}. ${boundary.summary}`;
  if (stepIndex !== activeStep) return "An earlier stage must finish first";
  if (job.identity.state === "active")
    return "The stage is running, but Workhorse has not saved a checkpoint yet";
  if (job.identity.state === "ready") return "The task is ready for a worker";
  if (job.identity.state === "scheduled")
    return "The task is scheduled, so this stage has not started";
  if (job.identity.state === "failed") return "The task failed before it reached this stage";
  return "Workhorse did not record a checkpoint";
}

function PlannedDurability({ job }: { job: DashboardJobDetail }) {
  const plan = job.durability!;
  const checkpoints = new Map(job.checkpoints.map((checkpoint) => [checkpoint.name, checkpoint]));
  const planNames = new Set(plan.steps.map((step) => step.name));
  const completedPlanSteps = plan.steps.filter((step) => checkpoints.has(step.name)).length;
  const unmatchedCheckpoints = job.checkpoints.filter(
    (checkpoint) => !planNames.has(checkpoint.name),
  );
  const activeStep = plan.steps.findIndex((step) => !checkpoints.has(step.name));
  const resolvedActiveStep = activeStep === -1 ? plan.steps.length : activeStep;
  const persistentFailure = plan.persistentFailure;
  const hasEvidencePastPersistentBoundary =
    persistentFailure !== null &&
    plan.steps.some(
      (step, stepIndex) =>
        stepIndex > persistentFailure.afterStepIndex && checkpoints.has(step.name),
    );
  return (
    <Box>
      <Group justify="space-between" align="flex-start" mb="sm">
        <Box>
          <Text fw={600} size="sm">
            {plan.label}
          </Text>
          <Text c="dimmed" size="xs">
            {plan.description}
          </Text>
        </Box>
        <Badge variant="light" color="violet">
          {completedPlanSteps}/{plan.steps.length} durable
        </Badge>
      </Group>
      {persistentFailure ? (
        /* State is carried by the heading text and the icon, never by colour alone. */
        <Paper withBorder p="xs" mb="sm">
          <Group gap={6} align="center" wrap="nowrap" mb={2}>
            <Prohibit size={13} weight="bold" aria-hidden />
            <Text fw={600} size="xs">
              {hasEvidencePastPersistentBoundary
                ? "Earlier demo evidence detected"
                : "Intentionally blocked between stages"}
            </Text>
          </Group>
          <Text c="dimmed" size="xs">
            {hasEvidencePastPersistentBoundary
              ? "An earlier demo saved checkpoints after the current failure boundary. Workhorse keeps that evidence below. "
              : "Workhorse keeps the interim results that it already saved. "}
            {persistentFailure.reason}
          </Text>
        </Paper>
      ) : null}
      <Stepper
        active={resolvedActiveStep}
        orientation="vertical"
        size="xs"
        color="violet"
        iconSize={28}
        allowNextStepsSelect={false}
        completedIcon={<CheckCircle size={15} weight="bold" />}
        progressIcon={
          // A blocked task is not waiting for anything, so it never shows a waiting clock.
          persistentFailure && !hasEvidencePastPersistentBoundary ? (
            <Prohibit size={14} weight="bold" style={{ display: "block" }} />
          ) : (
            <Clock size={14} weight="bold" style={{ display: "block" }} />
          )
        }
      >
        {plan.steps.map((step, stepIndex) => {
          const checkpoint = checkpoints.get(step.name);
          const boundary = describeDurableBoundary({
            stepIndex,
            hasCheckpoint: checkpoint !== undefined,
            persistentFailureAfterStepIndex: persistentFailure?.afterStepIndex ?? null,
          });
          return (
            <Stepper.Step
              key={step.name}
              label={step.label}
              description={plannedStepDescription(job, checkpoint, stepIndex, resolvedActiveStep)}
              loading={
                !persistentFailure &&
                job.identity.state === "active" &&
                stepIndex === resolvedActiveStep
              }
              allowStepSelect={false}
              aria-label={`${step.label}: ${boundary.label}. ${boundary.summary}`}
            />
          );
        })}
        <Stepper.Completed>
          {persistentFailure && !hasEvidencePastPersistentBoundary ? (
            <Text c="dimmed" fw={600} size="sm" mt="xs">
              Workhorse saved every reachable boundary. This demo blocks the task before it can
              produce a final result.
            </Text>
          ) : (
            <Text
              c={job.identity.state === "succeeded" ? "teal" : "violet"}
              fw={600}
              size="sm"
              mt="xs"
            >
              {job.identity.state === "succeeded"
                ? "Workhorse saved every declared boundary, and the task finished."
                : "Workhorse saved every declared boundary, but the current attempt is still running."}
            </Text>
          )}
        </Stepper.Completed>
      </Stepper>
      <Text c="dimmed" size="xs" mt="sm">
        This demo defines the stage plan. Workhorse stores checkpoint and wait records, not the
        plan.
      </Text>
      {unmatchedCheckpoints.length > 0 ? (
        <Box mt="md">
          <Text fw={600} size="xs" mb={4}>
            Additional interim results
          </Text>
          <Stack gap="xs">
            {unmatchedCheckpoints.map((checkpoint) => (
              <Paper key={checkpoint.name} withBorder p="xs">
                <JsonValue
                  label={checkpoint.name}
                  value={checkpoint.value}
                  emptyLabel="This checkpoint stored no value."
                  copyLabel={`the ${checkpoint.name} interim result`}
                  maxHeight={160}
                />
              </Paper>
            ))}
          </Stack>
        </Box>
      ) : null}
    </Box>
  );
}

function JobCheckpoints({ job }: { job: DashboardJobDetail }) {
  const currentAttempt = job.current.outcome?.attempt ?? job.current.runtime?.attempt ?? 1;
  return (
    <Box component="section" aria-labelledby="interim-results-heading">
      <Group justify="space-between" mb="xs">
        <Text id="interim-results-heading" component="h3" fw={600} size="sm" my={0}>
          Interim results
        </Text>
        <Badge variant="light" color={job.checkpoints.length > 0 ? "teal" : "gray"}>
          {job.checkpoints.length}
        </Badge>
      </Group>
      {/* Named once, here, so the rest of the section never has to re-explain what it is showing. */}
      <Text c="dimmed" size="xs" mb="sm">
        Interim results show completed work rather than current progress. Workhorse saves each
        result at a named restart boundary, and later attempts reuse it.
      </Text>
      {job.durability ? (
        <PlannedDurability job={job} />
      ) : job.checkpoints.length === 0 ? (
        <Text c="dimmed" size="sm">
          This task has not reached a named restart boundary.
        </Text>
      ) : (
        <Stack gap="sm">
          {job.checkpoints.map((checkpoint) => {
            const persistedAcrossRetry = currentAttempt > checkpoint.attempt;
            return (
              <Paper key={checkpoint.name} withBorder p="sm">
                <Group justify="space-between" align="flex-start">
                  <Box>
                    <Text fw={600} size="sm">
                      {checkpoint.name}
                    </Text>
                    <Text c="dimmed" size="xs" title={formatExact(checkpoint.createdAt)}>
                      Attempt {checkpoint.attempt} · {checkpoint.workerId}
                    </Text>
                    <Text c="dimmed" size="xs" title={formatExact(checkpoint.createdAt)}>
                      Fence {checkpoint.fenceToken} · {formatRelative(checkpoint.createdAt)}
                    </Text>
                  </Box>
                  <Badge variant="light" color={persistedAcrossRetry ? "violet" : "teal"}>
                    {persistedAcrossRetry ? "Persisted across retry" : "Saved"}
                  </Badge>
                </Group>
                <Box mt="sm">
                  <JsonValue
                    label="Checkpoint output"
                    value={checkpoint.value}
                    emptyLabel="This checkpoint stored no value."
                    copyLabel={`the ${checkpoint.name} interim result`}
                  />
                </Box>
              </Paper>
            );
          })}
        </Stack>
      )}
    </Box>
  );
}

function JobProgress({ job }: { job: DashboardJobDetail }) {
  const progress = job.progress;
  return (
    <Box component="section" aria-labelledby="job-progress-heading">
      <Group justify="space-between" mb="xs">
        <Text id="job-progress-heading" component="h3" fw={600} size="sm" my={0}>
          Latest progress
        </Text>
        <Badge variant="light" color={progress ? "blue" : "gray"}>
          {progress ? `Revision ${progress.revision}` : "Not reported"}
        </Badge>
      </Group>
      {progress ? (
        <Paper withBorder p="sm">
          <Text c="dimmed" size="xs" mb="sm" title={formatExact(progress.updatedAt)}>
            Attempt {progress.attempt} · {progress.workerId} · fence {progress.fenceToken} · updated{" "}
            {formatRelative(progress.updatedAt)}
          </Text>
          <JsonValue
            label="Mutable progress"
            value={progress.value}
            emptyLabel="The worker reported JSON null as its latest progress."
            copyLabel="the latest task progress"
          />
        </Paper>
      ) : (
        <Text c="dimmed" size="sm">
          This task has not reported mutable progress.
        </Text>
      )}
    </Box>
  );
}

type DurableWait = DashboardJobDetail["waits"][number];
type JobEvent = DashboardJobDetail["events"][number];
type WaitPhase = "sleeping" | "waking" | "resumed";

const waitPhaseLabel: Record<WaitPhase, string> = {
  sleeping: "Sleeping",
  waking: "Waking",
  resumed: "Resumed",
};
const waitPhaseColor: Record<WaitPhase, string> = {
  sleeping: "indigo",
  waking: "cyan",
  resumed: "teal",
};

/** Exact replay wording for a durable wait boundary; kept verbatim on purpose. */
const waitReplayWording =
  "After the target time, the next claim restarts the handler from its entry point in the same attempt.";

/**
 * Phase of one stored wait. Only the runtime row currently marked with this wait
 * name is still suspended; anything else means the handler already restarted.
 */
function waitPhaseFor(job: DashboardJobDetail, wait: DurableWait, nowMs: number): WaitPhase {
  const runtime = job.current.runtime;
  if (!runtime || runtime.waitName !== wait.name) return "resumed";
  return new Date(wait.wakeAt).getTime() > nowMs ? "sleeping" : "waking";
}

function eventDetail(event: JobEvent, key: string): string | null {
  const details = event.details;
  if (!details || typeof details !== "object") return null;
  const value = (details as Record<string, unknown>)[key];
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

const boundaryEventTypes = new Set([
  "enqueued",
  "wait_scheduled",
  "wait_elapsed",
  "wait_replayed",
  "claimed",
  "checkpoint_saved",
  "progress_updated",
  "retry_scheduled",
  "cancel_requested",
  "succeeded",
  "failed",
  "canceled",
]);

const boundaryEventLabels: Record<string, string> = {
  enqueued: "Enqueued",
  wait_scheduled: "Wait scheduled",
  wait_elapsed: "Wait elapsed",
  wait_replayed: "Wait replayed",
  claimed: "Claimed",
  checkpoint_saved: "Checkpoint saved",
  progress_updated: "Progress updated",
  retry_scheduled: "Retry scheduled",
  cancel_requested: "Cancellation requested",
  succeeded: "Succeeded",
  failed: "Failed",
  canceled: "Canceled",
};

const boundaryEventColors: Record<string, string> = {
  enqueued: "violet",
  wait_scheduled: "indigo",
  wait_elapsed: "cyan",
  wait_replayed: "grape",
  claimed: "blue",
  checkpoint_saved: "teal",
  progress_updated: "blue",
  retry_scheduled: "orange",
  succeeded: "green",
  failed: "red",
  // Neutral, not red: an operator stopped this task, it did not break.
  cancel_requested: "gray",
  canceled: "gray",
};

/**
 * How one recorded cancellation boundary reads.
 *
 * `cancel_requested` is only a request. `canceled` is final, and its `source` says how it became
 * final: `immediate` when PostgreSQL removed a task that had not started, `acknowledged` when the
 * running handler observed the signal and stopped, and `recovered` when the lease expired after a
 * request. None of these claim that external effects were undone.
 */
function cancelEventDescription(event: JobEvent): { text: string; title: string } | null {
  if (event.type !== "cancel_requested" && event.type !== "canceled") return null;
  const source = eventDetail(event, "source");
  if (event.type === "cancel_requested") {
    const described = describeCancelOutcome("cancel_requested");
    return { text: "awaiting handler", title: described.exact };
  }
  if (source === "acknowledged") {
    return {
      text: "handler observed the signal",
      title:
        "The running handler observed the cancellation signal and stopped, and PostgreSQL recorded " +
        "an immutable canceled outcome. External effects the handler had already started are not " +
        "undone by cancellation.",
    };
  }
  if (source === "recovered") {
    return {
      text: "lease expired after the request",
      title:
        "The lease expired before the handler acknowledged the request, so recovery finalized the " +
        "cancellation instead of retrying. Whatever the lost handler had already done externally " +
        "is not undone by cancellation.",
    };
  }
  const described = describeCancelOutcome("canceled");
  return { text: "before any handler ran", title: described.exact };
}

/**
 * Accepted deduplication evidence for one task, if PostgreSQL recorded any.
 *
 * Everything shown here comes from the safe metadata on the single initial `enqueued` event. The
 * raw key is not stored there and is therefore never available to render.
 */
function idempotencyEvidenceFor(job: DashboardJobDetail) {
  for (const event of job.events) {
    const evidence = readIdempotencyEvidence(event);
    if (evidence !== null) return evidence;
  }
  return null;
}

/**
 * Deduplication evidence for one task. Rendered only for a keyed task, so an unkeyed task keeps
 * exactly the drawer it had before. Colour is decoration; the label and wording carry the meaning.
 */
function IdempotencySection({ job }: { job: DashboardJobDetail }) {
  const evidence = idempotencyEvidenceFor(job);
  if (evidence === null) return null;
  const described = describeIdempotency(evidence);
  return (
    <Box>
      <Group gap="xs" mb="xs" align="baseline">
        <Text fw={600} size="sm">
          Idempotency
        </Text>
        <Badge size="xs" variant="light" color="violet" tt="none" title={described.exact}>
          {described.label}
        </Badge>
      </Group>
      <Text c="dimmed" size="xs" title={described.exact}>
        {described.summary}.
      </Text>
      <Text c="dimmed" size="xs" mt={4} title={described.exact}>
        {idempotencyEvidenceLine(evidence)}
      </Text>
      <Text c="dimmed" size="xs" mt={4}>
        The raw key is never recorded with the task, so it is never shown here.
      </Text>
    </Box>
  );
}

/**
 * Retry evidence recorded with one `retry_scheduled` event. The stored policy, chosen delay, and
 * delay source travel together, so an override reads differently from the job's persisted policy.
 */
function retryEventDescription(event: JobEvent): { text: string; title: string } | null {
  if (event.type !== "retry_scheduled") return null;
  const details = (event.details ?? {}) as Record<string, unknown>;
  const rawPolicy = details.retry_policy;
  const policy = (rawPolicy ?? null) as RetryPolicy | null;
  const source = typeof details.retry_delay_source === "string" ? details.retry_delay_source : null;
  const delayMs = typeof details.retry_delay_ms === "number" ? details.retry_delay_ms : null;
  const described = describeRetryEventSource(source, policy);
  const text =
    delayMs === null ? described.label : `${described.label} · ${formatRetryDelay(delayMs)} delay`;
  const title =
    delayMs === null
      ? `${described.exact} ${described.summary}.`
      : `${described.exact} Chosen delay ${delayMs} ms. ${described.summary}.`;
  return { text, title };
}

/** The lifecycle states an operator may cancel. Everything else is terminal or unknown. */
function canCancelTask(job: DashboardJobDetail): boolean {
  const runtime = job.current.runtime;
  if (runtime === null) return false;
  if (isTerminalTaskState(job.identity.state)) return false;
  // A scheduled task covers both a plain future run and a suspended durable wait, which the demo
  // shows as "waiting". Both are cancelable because neither is executing right now.
  return runtime.state === "scheduled" || runtime.state === "ready" || runtime.state === "active";
}

/**
 * Audited cancellation for one task.
 *
 * The action is a two-step confirmation with an optional reason. Cancellation is irreversible: a
 * canceled outcome is immutable and there is no uncancel. Wording changes with
 * the task's state, and for a running task it says plainly that cancellation is cooperative and
 * that external effects can continue until the handler observes the signal. Nothing here claims
 * force, immediacy, or that anything already done externally is undone.
 */
function CancelTaskPanel({
  job,
  confirming,
  setConfirming,
  reason,
  setReason,
  pending,
  cancelTask,
}: {
  job: DashboardJobDetail;
  confirming: boolean;
  setConfirming: (confirming: boolean) => void;
  reason: string;
  setReason: (reason: string) => void;
  pending: boolean;
  cancelTask: (id: string, reason: string) => void;
}) {
  const reasonRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (confirming) reasonRef.current?.focus();
  }, [confirming]);

  const cancellation = job.current.runtime?.cancellation ?? null;
  const requested = describeCancellationRequest(cancellation);
  const cancelable = canCancelTask(job);
  const running = job.current.runtime?.state === "active";
  const waiting =
    job.current.runtime?.state === "scheduled" && job.current.runtime.waitName !== null;
  const trimmedReason = reason.trim();

  // Everything an assistive technology needs is in text: the heading and the current state
  // sentence. What a cancellation reported is announced by the notification it raises, which
  // outlives this panel, because closing the drawer must not take the answer with it.
  return (
    <Box>
      <Group gap="xs" mb="xs" align="baseline">
        <Text fw={600} size="sm">
          Cancellation
        </Text>
        {requested === null ? null : (
          <Badge size="xs" variant="light" color="gray" tt="none" title={requested.exact}>
            {requested.label}
          </Badge>
        )}
      </Group>
      {requested === null ? null : (
        <Text c="dimmed" size="xs" mb="xs" title={requested.exact}>
          {requested.summary}.{" "}
          {cancellation === null ? null : (
            <span title={formatExact(cancellation.requestedAt)}>
              Requested {formatRelative(cancellation.requestedAt)}
              {cancellation.requestedBy === null ? "" : ` by ${cancellation.requestedBy}`}
              {cancellation.reason === null ? "" : ` · ${cancellation.reason}`}.
            </span>
          )}
        </Text>
      )}
      {cancelable ? (
        confirming ? (
          <Stack gap="xs">
            <Text size="xs" c="dimmed">
              {running
                ? "Workhorse asks the handler to stop, but it cannot force the handler. Until the " +
                  "handler checks the signal, external effects that it started can continue."
                : waiting
                  ? "This task is at a durable wait. Workhorse closes its attempt without resuming " +
                    "the handler, but it cannot undo earlier external work."
                  : "This task has not started. Workhorse can cancel it before any handler runs."}{" "}
              You cannot undo a cancellation.
            </Text>
            <TextInput
              ref={reasonRef}
              size="xs"
              label="Reason (optional)"
              description="Workhorse records this reason in the audit trail."
              placeholder="Why are you canceling this task?"
              value={reason}
              disabled={pending}
              onChange={(event) => setReason(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && !pending) setConfirming(false);
              }}
            />
            <Group gap="xs">
              <Button
                size="xs"
                color="red"
                variant="light"
                loading={pending}
                disabled={pending}
                onClick={() => cancelTask(job.identity.id, trimmedReason)}
              >
                {running ? "Request cancellation" : "Cancel task"}
              </Button>
              <Button
                size="xs"
                variant="default"
                disabled={pending}
                onClick={() => setConfirming(false)}
              >
                Keep running
              </Button>
            </Group>
          </Stack>
        ) : (
          <Button
            size="xs"
            variant="default"
            leftSection={<Prohibit size={14} />}
            disabled={pending}
            onClick={() => setConfirming(true)}
          >
            Cancel task
          </Button>
        )
      ) : (
        <Text c="dimmed" size="xs">
          {isTerminalTaskState(job.identity.state)
            ? `Because this task finished as ${job.identity.state}, Workhorse cannot change its outcome.`
            : "Workhorse cannot cancel this task because it has no live runtime."}
        </Text>
      )}
    </Box>
  );
}

/**
 * Persisted retry scheduling for one task. The policy is stated in words, never as a raw stored
 * kind, and an exhausted attempt budget is called out because a stored policy stops scheduling
 * once the final attempt has been used. Colour is decoration only; the label carries the meaning.
 */
function RetryPolicyLine({ job }: { job: DashboardJobDetail }) {
  const policy = describeRetryPolicy(job.identity.retryPolicy);
  const attempt = job.current.runtime?.attempt ?? job.current.outcome?.attempt ?? null;
  const exhausted = attempt !== null && attempt >= job.identity.maxAttempts;
  const budget =
    attempt === null
      ? `${job.identity.maxAttempts} attempt budget`
      : `attempt ${attempt} of ${job.identity.maxAttempts}`;
  const title = `${policy.exact}. ${
    exhausted
      ? "The attempt budget is exhausted, so no further retry will be scheduled."
      : "Retries remain within the attempt budget."
  }`;
  return (
    <Group gap="xs" mt="sm" align="baseline">
      <Text c="dimmed" size="xs" fw={600}>
        Retry policy
      </Text>
      <Badge size="xs" variant="light" color="orange" title={title} tt="none">
        {policy.label}
      </Badge>
      <Text c="dimmed" size="xs" title={title}>
        {policy.summary} · {budget}
        {exhausted ? " · budget exhausted, no further retry is scheduled" : ""}
      </Text>
    </Group>
  );
}

/**
 * Fleet-wide admission context for a task that can still be admitted.
 *
 * Shown only while the task is ready or active, because a finished task no longer competes for
 * the budget and repeating it under a terminal outcome would only add noise.
 */
export function ConcurrencyPolicyLine({ job }: { job: DashboardJobDetail }) {
  const described = describeTaskConcurrency(job);
  if (described === null) return null;
  return (
    <Group gap="xs" mt="sm" align="baseline">
      <Text c="dimmed" size="xs" fw={600}>
        Concurrency
      </Text>
      {described.concurrencyKey === null ? null : (
        <Badge
          size="xs"
          variant="light"
          color="grape"
          tt="none"
          title={described.title}
          aria-label={`Concurrency key ${described.concurrencyKey}`}
        >
          {described.concurrencyKey}
        </Badge>
      )}
      <Text c="dimmed" size="xs" title={described.title} aria-label={described.title}>
        {described.summary}
      </Text>
    </Group>
  );
}

/** Absolute lifetime and per-attempt execution limits persisted with the job definition. */
function TimingPolicyLine({ job }: { job: DashboardJobDetail }) {
  const deadlineAt = job.identity.deadlineAt ?? null;
  const executionTimeoutMs = job.identity.executionTimeoutMs ?? null;
  if (deadlineAt === null && executionTimeoutMs === null) return null;
  const runtimeTimeoutAt = job.current.runtime?.attemptTimeoutAt ?? null;
  const parts = [
    deadlineAt === null ? null : `deadline ${formatExact(deadlineAt)}`,
    executionTimeoutMs === null
      ? null
      : `${formatDuration(executionTimeoutMs)} active execution per attempt`,
    runtimeTimeoutAt === null ? null : `current timeout target ${formatExact(runtimeTimeoutAt)}`,
  ].filter((part): part is string => part !== null);
  return (
    <Group gap="xs" mt="xs" align="baseline">
      <Text c="dimmed" size="xs" fw={600}>
        Time limits
      </Text>
      <Text c="dimmed" size="xs" title={parts.join("; ")}>
        {parts.join(" · ")}
      </Text>
    </Group>
  );
}

/**
 * Compact ordered view of the recorded boundary events for this task. Repeated
 * claims inside one attempt are called out, because a durable wait releases
 * ownership without closing the logical attempt.
 */
function BoundaryTimeline({ job }: { job: DashboardJobDetail }) {
  // Acceptance is a boundary worth showing only when it deduplicated something. An unkeyed task
  // keeps exactly the timeline it had before this feature existed.
  const events = job.events.filter(
    (event) =>
      boundaryEventTypes.has(event.type) &&
      (event.type !== "enqueued" || readIdempotencyEvidence(event) !== null),
  );
  if (events.length === 0) return null;
  const claimsPerAttempt = new Map<number | null, number>();
  const claimOrdinals = new Map<string, number>();
  for (const event of events) {
    if (event.type !== "claimed") continue;
    const ordinal = (claimsPerAttempt.get(event.attempt) ?? 0) + 1;
    claimsPerAttempt.set(event.attempt, ordinal);
    claimOrdinals.set(event.id, ordinal);
  }
  const repeatedClaimAttempts: Array<number | null> = [];
  for (const [attempt, count] of claimsPerAttempt) {
    if (count > 1) repeatedClaimAttempts.push(attempt);
  }
  return (
    <Box mt="md">
      <Text fw={600} size="xs" mb={6}>
        Boundary timeline
      </Text>
      <Stack gap={4}>
        {events.map((event) => {
          const claimIndex = claimOrdinals.get(event.id) ?? null;
          const name = eventDetail(event, "name");
          const fence = eventDetail(event, "fence_token");
          const worker = eventDetail(event, "worker_id");
          const reason = eventDetail(event, "reason");
          const retry = retryEventDescription(event);
          const cancel = cancelEventDescription(event);
          const parts = [
            name,
            worker,
            fence === null ? null : `fence ${fence}`,
            reason === null ? null : `reason ${reason}`,
            retry?.text ?? null,
            cancel?.text ?? null,
          ].filter((part): part is string => part !== null);
          return (
            <Group key={event.id} gap="xs" wrap="nowrap" align="flex-start">
              <Badge
                size="xs"
                variant="light"
                color={boundaryEventColors[event.type] ?? "gray"}
                tt="none"
                miw={116}
                styles={{ root: { justifyContent: "start" } }}
              >
                {boundaryEventLabels[event.type] ?? event.type}
              </Badge>
              <Text
                c="dimmed"
                size="xs"
                style={{ flex: 1, minWidth: 0 }}
                lineClamp={1}
                title={cancel?.title ?? retry?.title}
              >
                {event.attempt === null ? "no attempt" : `attempt ${event.attempt}`}
                {claimIndex === null ? "" : ` · claim ${claimIndex}`}
                {parts.length > 0 ? ` · ${parts.join(" · ")}` : ""}
              </Text>
              <Text c="dimmed" size="xs" title={formatExact(event.occurredAt)} ta="right">
                {formatClock(event.occurredAt)}
              </Text>
            </Group>
          );
        })}
      </Stack>
      {repeatedClaimAttempts.length > 0 ? (
        <Text c="dimmed" size="xs" mt={6}>
          {repeatedClaimAttempts.length === 1
            ? `Attempt ${repeatedClaimAttempts[0]} has ${claimsPerAttempt.get(repeatedClaimAttempts[0]!)} claims.`
            : `Attempts ${repeatedClaimAttempts.join(", ")} each have more than one claim.`}{" "}
          A durable wait releases ownership without closing the logical attempt, so one attempt can
          hold several claims with different fence tokens.
        </Text>
      ) : null}
    </Box>
  );
}

/** One stored wait row rendered with its release proof and immutable provenance. */
function DurableWaitCard({
  job,
  wait,
  nowMs,
}: {
  job: DashboardJobDetail;
  wait: DurableWait;
  nowMs: number;
}) {
  const phase = waitPhaseFor(job, wait, nowMs);
  const runtime = job.current.runtime;
  const suspended = phase !== "resumed" && runtime !== null;
  return (
    <Paper withBorder p="sm">
      <Group justify="space-between" align="flex-start">
        <Box style={{ minWidth: 0 }}>
          <Text fw={600} size="sm">
            {wait.name}
          </Text>
          <Text c="dimmed" size="xs">
            {wait.mode === "relative"
              ? `Relative · requested ${formatDuration(wait.durationMs)}`
              : `Absolute · requested ${formatExact(wait.requestedWakeAt)}`}
          </Text>
        </Box>
        <Badge variant="light" color={waitPhaseColor[phase]} tt="none">
          {waitPhaseLabel[phase]}
        </Badge>
      </Group>
      <Divider my="sm" />
      <Stack gap={4}>
        <Group justify="space-between" gap="xs" wrap="nowrap">
          <Text c="dimmed" size="xs">
            Not before
          </Text>
          <Text size="xs" ta="right">
            {formatExact(wait.wakeAt)}
          </Text>
        </Group>
        <Group justify="space-between" gap="xs" wrap="nowrap">
          <Text c="dimmed" size="xs">
            {phase === "resumed" ? "Target passed" : "Time remaining"}
          </Text>
          <Text size="xs" ta="right">
            {phase === "resumed"
              ? formatRelative(wait.wakeAt)
              : formatCountdown(wait.wakeAt, nowMs)}
          </Text>
        </Group>
      </Stack>
      <Divider my="sm" />
      <Text fw={600} size="xs" mb={4}>
        {suspended ? "Ownership released while scheduled" : "Ownership at this boundary"}
      </Text>
      {suspended ? (
        <Stack gap={2}>
          <Text c="dimmed" size="xs">
            Worker {runtime.workerId === null ? "null" : runtime.workerId} · fence{" "}
            {runtime.fenceToken}
          </Text>
          <Text c="dimmed" size="xs">
            Lease expiry {runtime.expiresAt === null ? "null" : formatExact(runtime.expiresAt)} ·
            heartbeat {runtime.heartbeatAt === null ? "null" : formatExact(runtime.heartbeatAt)}
          </Text>
          <Text c="dimmed" size="xs">
            Runtime state {runtime.state} · wait marker{" "}
            {runtime.waitName === null ? "null" : runtime.waitName}
          </Text>
        </Stack>
      ) : (
        <Text c="dimmed" size="xs">
          This wait is no longer active. Its events below record how Workhorse released it.
        </Text>
      )}
      <Divider my="sm" />
      <Text fw={600} size="xs" mb={4}>
        Attempt preserved across the wait
      </Text>
      <Stack gap={2}>
        <Text c="dimmed" size="xs">
          Wait recorded on attempt {wait.attempt}
          {runtime ? ` · runtime attempt ${runtime.attempt}` : ""}
        </Text>
        {runtime?.attemptStartedAt ? (
          <Text c="dimmed" size="xs" title={formatExact(runtime.attemptStartedAt)}>
            Logical attempt started {formatRelative(runtime.attemptStartedAt)}
          </Text>
        ) : null}
      </Stack>
      <Divider my="sm" />
      <Text fw={600} size="xs" mb={4}>
        Immutable wait provenance
      </Text>
      <Text c="dimmed" size="xs" title={formatExact(wait.createdAt)}>
        Authorized by {wait.workerId} · fence {wait.fenceToken} · attempt {wait.attempt} ·{" "}
        {formatRelative(wait.createdAt)}
      </Text>
    </Paper>
  );
}

/**
 * Durable wait evidence for one task. Waits are stored rows, not a workflow graph,
 * so this panel reports only what Workhorse recorded.
 */
function DurableWaits({ job }: { job: DashboardJobDetail }) {
  const runtimeWaitName = job.current.runtime?.waitName ?? null;
  const nowMs = useNow(runtimeWaitName !== null);
  // A task can record retry and claim boundaries without ever suspending on a durable wait, so the
  // timeline stands alone rather than disappearing with the wait panel.
  if (job.waits.length === 0) return <BoundaryTimeline job={job} />;
  const planNames = new Set((job.durability?.steps ?? []).map((step) => step.name));
  const unmatchedWaits = job.waits.filter((wait) => !planNames.has(wait.name));
  const matchedWaits = job.waits.filter((wait) => planNames.has(wait.name));
  return (
    <Box>
      <Group justify="space-between" mb="xs">
        <Text fw={600} size="sm">
          Durable wait
        </Text>
        <Badge variant="light" color="indigo">
          {job.waits.length}
        </Badge>
      </Group>
      <Stack gap="sm">
        {matchedWaits.map((wait) => (
          <DurableWaitCard key={wait.name} job={job} wait={wait} nowMs={nowMs} />
        ))}
      </Stack>
      {unmatchedWaits.length > 0 ? (
        <Box mt={matchedWaits.length > 0 ? "md" : undefined}>
          {matchedWaits.length > 0 ? (
            <Text fw={600} size="xs" mb={4}>
              Additional wait evidence
            </Text>
          ) : null}
          <Stack gap="sm">
            {unmatchedWaits.map((wait) => (
              <DurableWaitCard key={wait.name} job={job} wait={wait} nowMs={nowMs} />
            ))}
          </Stack>
        </Box>
      ) : null}
      <Text c="dimmed" size="xs" mt="sm">
        The target is the earliest wake time. If a queue is paused, or a worker or database is
        unavailable, the task can wake later. {waitReplayWording}
      </Text>
      <Text c="dimmed" size="xs" mt={6}>
        Workhorse stores checkpoint and wait records, not a workflow graph.
      </Text>
      <BoundaryTimeline job={job} />
    </Box>
  );
}

function DurableProgressBadge({ job }: { job: DashboardJobRow }) {
  if (!job.durability) {
    return (
      <Text size="sm" c="dimmed">
        —
      </Text>
    );
  }
  return (
    <Badge
      size="xs"
      variant="light"
      color="violet"
      tt="none"
      title={`${job.durability.completedSteps} of ${job.durability.totalSteps} durable steps completed`}
    >
      {job.durability.completedSteps}/{job.durability.totalSteps}
    </Badge>
  );
}

/** Trim a `queue.` prefix from a task type since the queue has its own column. */
function taskDisplayName(type: string, queue: string): string {
  return type.startsWith(`${queue}.`) ? type.slice(queue.length + 1) : type;
}

function statusColor(state: string): string {
  if (healthyStates.has(state)) return "teal";
  if (failureStates.has(state) || state === "unhealthy" || state === "offline") return "red";
  if (canceledStates.has(state)) return "gray";
  if (warningStates.has(state)) return "yellow";
  return "gray";
}

const activityStatusColors: Record<string, string> = {
  scheduled: "yellow.6",
  ready: "cyan.6",
  active: "blue.6",
  succeeded: "teal.6",
  failed: "red.6",
  canceled: "gray.6",
};

function StatusBadge({ state }: { state: string }) {
  return (
    <Badge color={statusColor(state)} variant="light" tt="capitalize" style={{ flexShrink: 0 }}>
      {state}
    </Badge>
  );
}

/**
 * Pending cooperative cancellation on a live task.
 *
 * The wording never promises the handler stopped: it says the request was made and that the task
 * is still running until the handler observes the signal. The badge text carries that meaning on
 * its own, so the neutral colour is decoration.
 */
function CancelRequestedBadge({
  cancellation,
}: {
  cancellation: DashboardCancellationRequest | null;
}) {
  const described = describeCancellationRequest(cancellation);
  if (described === null || cancellation === null) return null;
  return (
    <Badge
      size="sm"
      variant="light"
      color="gray"
      leftSection={<Prohibit size={11} weight="bold" />}
      tt="none"
      title={`${described.exact} Requested ${formatExact(cancellation.requestedAt)}.`}
      style={{ flexShrink: 0 }}
    >
      Cancellation requested
    </Badge>
  );
}

/** One-line, state-specific context so a row explains itself without opening the drawer. */
function TaskStatusDetail({ job }: { job: DashboardJobRow }) {
  let detail: string | null = null;
  let exactTime: string | null = null;
  if (job.state === "scheduled" && job.wait) {
    // A durable wait is a scheduled restart boundary, not an owned execution.
    detail = `sleeping until ${formatClock(job.wait.wakeAt)} · ${job.wait.name}`;
    exactTime = formatExact(job.wait.wakeAt);
  } else if (job.state === "scheduled" && job.runAt) {
    detail = `runs ${formatRelative(job.runAt)}`;
    exactTime = formatExact(job.runAt);
    if (job.attempt > 1) detail += ` · ${describeRetryPolicy(job.retryPolicy).label}`;
  } else if (job.state === "active" && job.workerId) detail = `on ${job.workerId}`;
  else if (job.state === "failed" && job.errorMessage) detail = job.errorMessage;
  else if (job.state === "canceled" && job.finishedAt) {
    // Canceled work reads as a deliberate stop, never as an error, even though the stored
    // cancellation envelope lives in the same column a failure would use.
    detail = `canceled ${formatRelative(job.finishedAt)}`;
    exactTime = formatExact(job.finishedAt);
  } else if (job.state === "succeeded" && job.finishedAt) {
    detail = `finished ${formatRelative(job.finishedAt)}`;
    exactTime = formatExact(job.finishedAt);
  }
  if (!detail) return null;
  return (
    <Text
      c={job.state === "failed" ? "red.7" : "dimmed"}
      size="xs"
      lineClamp={1}
      style={{ wordBreak: "break-all" }}
      title={exactTime ?? detail}
    >
      {detail}
    </Text>
  );
}

/**
 * Badge for a scheduled durable wait. "Waking" means the stored target has passed
 * and the task is eligible for promotion and a fresh claim, not that a worker holds it.
 */
function TaskWaitBadge({ job }: { job: DashboardJobRow }) {
  const scheduledWait = job.state === "scheduled" ? job.wait : null;
  const due = useElapsed(scheduledWait?.wakeAt ?? null);
  if (!scheduledWait) return null;
  return (
    <Badge
      size="sm"
      variant="light"
      color={due ? "cyan" : "indigo"}
      leftSection={<Clock size={11} weight="bold" />}
      tt="none"
      title={`Durable wait ${scheduledWait.name} · not before ${formatExact(scheduledWait.wakeAt)}`}
      style={{ flexShrink: 0 }}
    >
      {due ? "Waking" : "Sleeping"}
    </Badge>
  );
}

/** Render a payload as one collapsed `key: value` line, or full pretty JSON when expanded. */
function CollapsedArgs({ payload, expanded }: { payload: unknown; expanded: boolean }) {
  if (payload === null || payload === undefined) return <Text c="dimmed">—</Text>;
  const full = JSON.stringify(payload, null, 1);
  if (expanded) {
    return (
      <Code
        fz="xs"
        title={full}
        style={{
          display: "inline-block",
          maxWidth: 340,
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          verticalAlign: "middle",
          lineHeight: 1.4,
          background: "transparent",
          paddingBlock: 0,
          paddingInline: 0,
        }}
      >
        {JSON.stringify(payload)}
      </Code>
    );
  }
  let preview: string;
  if (typeof payload === "object" && !Array.isArray(payload)) {
    const entries = Object.entries(payload as Record<string, unknown>);
    if (entries.length === 0) return <Text c="dimmed">—</Text>;
    preview = entries.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(", ");
  } else {
    preview = JSON.stringify(payload);
  }
  return (
    <Code
      fz="xs"
      title={full}
      style={{
        display: "inline-block",
        maxWidth: 220,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        verticalAlign: "middle",
        lineHeight: 1.4,
        background: "transparent",
        paddingBlock: 0,
        paddingInline: 0,
      }}
    >
      {preview}
    </Code>
  );
}

/** Wall-clock time from enqueue to terminal outcome, only shown once the job finished. */
function taskDuration(job: DashboardJobRow): string | null {
  if (!job.finishedAt) return null;
  const elapsed = new Date(job.finishedAt).getTime() - new Date(job.createdAt).getTime();
  return elapsed >= 0 ? formatDuration(elapsed) : null;
}

function PageHeader({ title, description }: { title: string; description: string }) {
  return (
    <Box>
      <Title order={1}>{title}</Title>
      <Text c="dimmed" mt={4}>
        {description}
      </Text>
    </Box>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <Paper withBorder p="xl">
      <Center mih={180}>
        <Stack align="center" gap="xs">
          <ThemeIcon variant="light" color="gray" size="xl" radius="xl">
            <CheckCircle size={22} />
          </ThemeIcon>
          <Text fw={600}>No results</Text>
          <Text c="dimmed" size="sm">
            {children}
          </Text>
        </Stack>
      </Center>
    </Paper>
  );
}

/** Full-width stacked bar chart of task activity with switchable period and grouping. */
function TasksActivityChart({
  filter,
  period,
  groupBy,
  tags,
  queue,
  worker,
  updateLocation,
}: {
  filter: DashboardTaskFilter;
  period: ActivityPeriod;
  groupBy: ActivityGroupBy;
  tags: string[];
  queue: string | null;
  worker: string | null;
  updateLocation: (updates: Partial<TaskLocationState>) => void;
}) {
  const client = useDashboardClient();
  const [activity, setActivity] = useState<ActivityData | null>(null);
  const changePeriod = (value: string) => {
    const next = activityPeriods.includes(value as ActivityPeriod)
      ? (value as ActivityPeriod)
      : "1h";
    localStorage.setItem("workhorse-activity-period", next);
    updateLocation({ period: next });
  };
  const changeGroupBy = (value: string) => {
    const next = activityGroupings.some((g) => g.value === value)
      ? (value as ActivityGroupBy)
      : "task";
    localStorage.setItem("workhorse-activity-group", next);
    updateLocation({ group: next });
  };

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      void client
        .activity({ filter, period, groupBy, tags, queue, worker })
        .then((page) => {
          if (!cancelled) setActivity(page);
        })
        .catch(() => undefined);
    load();
    const timer = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, filter, period, groupBy, tags, queue, worker]);

  const labelFormat = (value: string): string => {
    const date = new Date(value);
    if (period === "7d" || period === "24h") {
      return getDateTimeFormatter({
        month: "short",
        day: "numeric",
        hour: "2-digit",
        timeZone: displayTimeZone ?? undefined,
      }).format(date);
    }
    return getDateTimeFormatter({
      hour: "2-digit",
      minute: "2-digit",
      timeZone: displayTimeZone ?? undefined,
    }).format(date);
  };
  const groups = activity?.groups ?? [];
  const chartData = (activity?.buckets ?? []).map((bucket) => {
    const point: Record<string, string | number> = {
      bucket: labelFormat(bucket.bucketStart),
    };
    for (const group of groups) point[activityChartKey(group)] = bucket.counts[group] ?? 0;
    return point;
  });
  const series = groups.map((group, index) => ({
    name: activityChartKey(group),
    label: group,
    color:
      group === "other"
        ? "gray.5"
        : groupBy === "status"
          ? (activityStatusColors[group] ?? "gray.6")
          : activitySeriesColors[index % activitySeriesColors.length]!,
  }));

  return (
    <Paper withBorder p="md">
      <Group justify="space-between" mb="sm">
        <Text fw={600} size="sm">
          Activity
          <Text span c="dimmed" size="sm">
            {" "}
            · {filter === "all" ? "all tasks" : filter}
          </Text>
        </Text>
        <Group gap="xs">
          <SegmentedControl
            size="xs"
            value={groupBy}
            onChange={changeGroupBy}
            data={activityGroupings.map(({ value, label }) => ({
              value,
              label,
            }))}
          />
          <SegmentedControl
            size="xs"
            value={period}
            onChange={changePeriod}
            data={activityPeriods.map((value) => ({ value, label: value }))}
          />
        </Group>
      </Group>
      <BarChart
        h={320}
        data={chartData}
        dataKey="bucket"
        type="stacked"
        series={series}
        withLegend={series.length > 1}
        legendProps={{
          layout: "vertical",
          align: "left",
          verticalAlign: "middle",
          width: 280,
          wrapperStyle: { paddingRight: 16, textAlign: "left" },
        }}
        styles={{
          legend: {
            justifyContent: "flex-start",
            flexDirection: "column",
            alignItems: "flex-start",
          },
          legendItem: { width: "100%", minWidth: 0 },
          legendItemName: {
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          },
        }}
        gridAxis="xy"
        tickLine="y"
        withYAxis
        withTooltip
        barProps={{ radius: 2 }}
        yAxisProps={{ allowDecimals: false, width: 36 }}
        xAxisProps={{ interval: "preserveStartEnd", minTickGap: 24 }}
      />
    </Paper>
  );
}

function includeSelectedOption(values: string[], selected: string | null): string[] {
  return selected && !values.includes(selected) ? [selected, ...values] : values;
}

function includeSelectedOptions(values: string[], selected: readonly string[]): string[] {
  const available = new Set(values);
  const missing = selected.filter((value) => !available.has(value));
  return missing.length > 0 ? [...missing, ...values] : values;
}

function useTaskFacets({
  queue,
  worker,
  jobType,
  tags,
}: Pick<DashboardTasksPage, "queue" | "worker" | "jobType" | "tags">) {
  const client = useDashboardClient();
  const [facets, setFacets] = useState<DashboardTaskFacets | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<Promise<void> | null>(null);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );
  const load = useCallback(() => {
    if (facets || request.current) return;
    const activeGeneration = generation.current;
    setLoading(true);
    setError(null);
    request.current = client
      .taskFacets()
      .then((nextFacets) => {
        if (generation.current === activeGeneration) setFacets(nextFacets);
      })
      .catch(() => {
        if (generation.current === activeGeneration) {
          setError("Workhorse could not load the filters. Reopen this menu to try again.");
        }
      })
      .finally(() => {
        if (generation.current === activeGeneration) {
          request.current = null;
          setLoading(false);
        }
      });
  }, [client, facets]);
  const values = facets ?? { queues: [], workers: [], jobTypes: [], tags: [] };
  return {
    facets: {
      queues: includeSelectedOption(values.queues, queue),
      workers: includeSelectedOption(values.workers, worker),
      jobTypes: includeSelectedOption(values.jobTypes, jobType),
      tags: includeSelectedOptions(values.tags, tags),
    },
    loading,
    error,
    load,
  };
}

function TaskListingFilters({
  data,
  searchInput,
  setSearchInput,
  taskFacets,
  updateLocation,
}: {
  data: DashboardTasksPage;
  searchInput: string;
  setSearchInput: (value: string) => void;
  taskFacets: ReturnType<typeof useTaskFacets>;
  updateLocation: (updates: Partial<TaskLocationState>) => void;
}) {
  const nothingFoundMessage = taskFacets.loading ? "Loading filters…" : taskFacets.error;
  return (
    <Group gap="xs" wrap="nowrap">
      <TextInput
        size="xs"
        value={searchInput}
        onChange={(event) => setSearchInput(event.currentTarget.value)}
        leftSection={<MagnifyingGlass size={14} />}
        placeholder="Search tasks. Use * as a wildcard."
        aria-label="Search tasks"
        style={{ flex: "1 1 220px" }}
      />
      <MultiSelect
        size="xs"
        data={taskFacets.facets.tags}
        value={data.tags}
        onChange={(tags) => updateLocation({ tags })}
        onDropdownOpen={taskFacets.load}
        placeholder="Any tag"
        searchable
        clearable
        rightSection={taskFacets.loading ? <Loader size={14} /> : undefined}
        nothingFoundMessage={nothingFoundMessage ?? "No tags found"}
        maxDropdownHeight={240}
        style={{ flex: "1 1 220px" }}
      />
      {(
        [
          ["Queue", data.queue, taskFacets.facets.queues, "queue"],
          ["Worker", data.worker, taskFacets.facets.workers, "worker"],
          ["Task type", data.jobType, taskFacets.facets.jobTypes, "jobType"],
        ] as const
      ).map(([placeholder, value, values, key]) => (
        <Select
          key={key}
          size="xs"
          data={values}
          value={value}
          onChange={(next) => updateLocation({ [key]: next })}
          onDropdownOpen={taskFacets.load}
          placeholder={placeholder}
          searchable
          clearable
          rightSection={taskFacets.loading ? <Loader size={14} /> : undefined}
          nothingFoundMessage={nothingFoundMessage ?? `No ${placeholder.toLowerCase()} found`}
          style={{ flex: "1 1 150px" }}
        />
      ))}
    </Group>
  );
}

function taskRowActionIcon(id: TaskRowActionId): ReactNode {
  if (id === "inspect") return <Info size={16} />;
  if (id === "copy-id" || id === "copy-args") return <Copy size={16} />;
  if (id === "cancel") return <Prohibit size={16} />;
  if (id === "run-now") return <PlayCircle size={16} />;
  return <FunnelSimple size={16} />;
}

/**
 * The per-row action menu for one task.
 *
 * Which actions apply is decided by `taskRowActionGroups` from the row's own state, so the list and
 * the drawer can never disagree about whether a task is cancelable. An action that does not apply
 * stays in the menu, disabled, with the reason written underneath it: an operator finds out why a
 * finished task cannot be canceled in the place they went to cancel it, rather than from a menu
 * that quietly changes shape from row to row.
 *
 * Cancellation is never applied from here. It opens the task drawer with the confirmation armed,
 * because cancellation is irreversible and its reason belongs in the audit trail. Running a
 * scheduled task now is applied in place instead: it deliberately releases the task early, shows
 * the mutation in flight, and reports the durable result without claiming the handler ran inline.
 */
function TaskRowActions({
  job,
  onAction,
  capabilities,
  pendingAction,
}: {
  job: DashboardJobRow;
  onAction: (id: TaskRowActionId, job: DashboardJobRow) => void;
  capabilities: TaskRowActionCapabilities;
  /** The action currently in flight for this row, so its item can show it rather than look idle. */
  pendingAction: TaskRowActionId | null;
}) {
  const groups = taskRowActionGroups(job, capabilities);
  return (
    <Menu position="bottom-end" withinPortal shadow="md" width={280}>
      <Menu.Target>
        <ActionIcon
          size="sm"
          variant="subtle"
          color="gray"
          aria-label={`Actions for task ${job.id}`}
          loading={pendingAction !== null}
          // The row itself opens the drawer on click, which is not what opening this menu means.
          onClick={(event) => event.stopPropagation()}
        >
          <DotsThreeVertical size={16} weight="bold" />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown onClick={(event) => event.stopPropagation()}>
        {groups.map((group, index) => (
          <Fragment key={group.label}>
            {index > 0 ? <Menu.Divider /> : null}
            <Menu.Label>{group.label}</Menu.Label>
            {group.actions.map((action) => {
              const pending = pendingAction === action.id;
              return (
                <Menu.Item
                  key={action.id}
                  leftSection={pending ? <Loader size={14} /> : taskRowActionIcon(action.id)}
                  color={action.destructive && action.unavailable === null ? "red" : undefined}
                  disabled={action.unavailable !== null || pendingAction !== null}
                  onClick={() => onAction(action.id, job)}
                >
                  <Text size="sm" lh={1.3}>
                    {action.label}
                  </Text>
                  {action.unavailable === null ? null : (
                    <Text size="xs" c="dimmed" lh={1.3} mt={2} style={{ whiteSpace: "normal" }}>
                      {action.unavailable}
                    </Text>
                  )}
                </Menu.Item>
              );
            })}
          </Fragment>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}

function TasksPage({
  data,
  navigate,
  runDemoJob,
  runningDemoJob,
  inspectJob,
  replace,
  taskLocation,
  runTaskNow,
}: {
  data: DashboardTasksPage;
  navigate: (href: string) => void;
  replace: (href: string) => void;
  taskLocation: TaskLocationState;
  runDemoJob: ((kind: DemoJobKind, scenario?: DurableDemoScenario) => Promise<void>) | null;
  runningDemoJob: DemoJobKind | null;
  inspectJob: (id: string, options?: { confirmCancel?: boolean }) => void;
  /**
   * Release one scheduled task, or null when the host cannot. Null is passed through to the menu
   * as a stated reason rather than removing the item.
   */
  runTaskNow: ((id: string) => Promise<RunNowFeedback>) | null;
}) {
  const [fullArgs, setFullArgs] = useState(
    () => localStorage.getItem("workhorse-full-args") === "true",
  );
  const [searchDraft, setSearchDraft] = useState<string | null>(null);
  // The one row action that is applied here rather than in the drawer. What it reported goes to
  // the notification system, so only the in-flight row is state this page has to hold.
  const [runningNowJobId, setRunningNowJobId] = useState<string | null>(null);
  const searchInput = searchDraft ?? taskLocation.search ?? "";
  const taskFacets = useTaskFacets(data);
  const locationState: TaskLocationState = taskLocation;
  const updateLocation = useCallback(
    (updates: Partial<TaskLocationState>, useReplace = false) => {
      const href = taskHref({ ...locationState, page: 1, ...updates });
      if (useReplace) replace(href);
      else navigate(href);
    },
    [locationState, navigate, replace],
  );
  useEffect(() => {
    if (searchDraft === null) return;
    const timer = setTimeout(() => {
      const search = searchDraft.trim() || null;
      if (search !== taskLocation.search) updateLocation({ search }, true);
      setSearchDraft(null);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchDraft, taskLocation.search, updateLocation]);
  /**
   * Apply one row action.
   *
   * Only the two clipboard actions finish here. Filtering goes through the same location update the
   * filter controls use, so the URL stays the single description of what this list is showing, and
   * cancellation opens the drawer instead of acting, because an irreversible action is confirmed
   * with a reason before it is applied.
   */
  const runRowAction = useCallback(
    (id: TaskRowActionId, job: DashboardJobRow) => {
      if (id === "inspect") return inspectJob(job.id);
      if (id === "cancel") return inspectJob(job.id, { confirmCancel: true });
      if (id === "run-now") {
        if (runTaskNow === null || runningNowJobId !== null) return;
        setRunningNowJobId(job.id);
        void runTaskNow(job.id)
          .then((feedback) => notifyRunNow(feedback, { openTask: inspectJob }))
          .finally(() => setRunningNowJobId(null));
        return;
      }
      if (id === "filter-type") return updateLocation({ jobType: job.type });
      if (id === "filter-queue") return updateLocation({ queue: job.queue });
      if (id === "filter-worker") {
        const worker = job.workerId ?? job.lastWorkerId;
        if (worker !== null) updateLocation({ worker });
        return;
      }
      const copying = id === "copy-id" ? "Task ID" : "Input";
      void copyToClipboard(id === "copy-id" ? job.id : formatJson(job.payload)).then((failure) =>
        notifyDashboard({
          // One id for both clipboard actions: copying twice is one running answer, not a stack.
          id: "workhorse-task-clipboard",
          title: failure ? `${copying} not copied` : `${copying} copied`,
          message: failure ?? `${copying} copied to the clipboard.`,
          tone: failure ? "failure" : "neutral",
        }),
      );
    },
    [inspectJob, runTaskNow, runningNowJobId, updateLocation],
  );
  const toggleFullArgs = (checked: boolean) => {
    setFullArgs(checked);
    localStorage.setItem("workhorse-full-args", String(checked));
  };
  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const pagination = (
    <Pagination
      value={Math.min(data.page, totalPages)}
      onChange={(page) => navigate(taskHref({ ...locationState, page }))}
      total={totalPages}
      size="xs"
      aria-label="Tasks pagination"
    />
  );

  return (
    <Stack gap="xl">
      <TasksActivityChart
        filter={data.filter}
        period={locationState.period}
        groupBy={locationState.group}
        tags={data.tags}
        queue={data.queue}
        worker={data.worker}
        updateLocation={updateLocation}
      />
      <Paper withBorder>
        <Stack gap="xs" p="md">
          <TaskListingFilters
            data={data}
            searchInput={searchInput}
            setSearchInput={setSearchDraft}
            taskFacets={taskFacets}
            updateLocation={updateLocation}
          />
          <Group justify="space-between">
            <Switch
              size="xs"
              label="Show full input"
              checked={fullArgs}
              onChange={(event) => toggleFullArgs(event.currentTarget.checked)}
            />
            <Group gap="xs">
              {runDemoJob ? (
                <Menu position="bottom-start" withinPortal>
                  <Menu.Target>
                    <Button
                      variant="default"
                      size="xs"
                      radius="xl"
                      leftSection={<PlayCircle size={16} />}
                      loading={runningDemoJob !== null}
                    >
                      Enqueue test task
                    </Button>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Label>Test outcome</Menu.Label>
                    <Menu.Item
                      leftSection={<CheckCircle size={16} />}
                      onClick={() => void runDemoJob("success")}
                    >
                      Succeed
                    </Menu.Item>
                    <Menu.Item
                      leftSection={<ArrowCounterClockwise size={16} />}
                      onClick={() => void runDemoJob("retry")}
                    >
                      Fail once, then retry
                    </Menu.Item>
                    <Menu.Item
                      leftSection={<CheckCircle size={16} />}
                      onClick={() => void runDemoJob("idempotent")}
                    >
                      Reuse one task for repeat requests
                    </Menu.Item>
                    <Menu.Item
                      leftSection={<ListChecks size={16} />}
                      onClick={() => void runDemoJob("durable", "order-fulfillment")}
                    >
                      Durable · order fulfillment · 4 steps
                    </Menu.Item>
                    <Menu.Item
                      leftSection={<ListChecks size={16} />}
                      onClick={() => void runDemoJob("durable", "customer-onboarding")}
                    >
                      Durable · customer onboarding · 3 steps
                    </Menu.Item>
                    <Menu.Item
                      leftSection={<ListChecks size={16} />}
                      onClick={() => void runDemoJob("durable", "report-publication")}
                    >
                      Durable · report publication · 3 steps
                    </Menu.Item>
                    <Menu.Item
                      leftSection={<Clock size={16} />}
                      onClick={() => void runDemoJob("timer")}
                    >
                      Durable wait · named timer boundary
                    </Menu.Item>
                    <Menu.Item
                      leftSection={<XCircle size={16} />}
                      color="red"
                      onClick={() => void runDemoJob("failure")}
                    >
                      Terminal failure
                    </Menu.Item>
                    <Menu.Item
                      leftSection={<Clock size={16} />}
                      onClick={() => void runDemoJob("long-running")}
                    >
                      Long-running · 20s
                    </Menu.Item>
                  </Menu.Dropdown>
                </Menu>
              ) : null}
              <Select
                size="xs"
                w={76}
                value={String(data.pageSize)}
                data={taskPageSizes.map((size) => ({
                  value: String(size),
                  label: String(size),
                }))}
                onChange={(value) =>
                  updateLocation({
                    pageSize: Number(value ?? 50) as TaskPageSize,
                  })
                }
                allowDeselect={false}
                aria-label="Tasks per page"
              />
              {pagination}
            </Group>
          </Group>
        </Stack>
        <Divider />
        <ScrollArea>
          <Table
            striped
            highlightOnHover
            verticalSpacing={6}
            horizontalSpacing="sm"
            miw={fullArgs ? 1064 : 944}
          >
            <Table.Thead>
              <Table.Tr>
                <Table.Th>ID</Table.Th>
                <Table.Th>Task</Table.Th>
                <Table.Th>Queue</Table.Th>
                <Table.Th>Input</Table.Th>
                <Table.Th miw={280}>Status</Table.Th>
                <Table.Th ta="right">Steps</Table.Th>
                <Table.Th ta="right">Attempt</Table.Th>
                <Table.Th ta="right">Duration</Table.Th>
                <Table.Th ta="right">Updated</Table.Th>
                <Table.Th w={44}>
                  <VisuallyHidden>Actions</VisuallyHidden>
                </Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {data.jobs.length === 0 ? (
                <Table.Tr>
                  <Table.Td colSpan={10}>
                    <Center mih={120}>
                      <Text c="dimmed" size="sm">
                        No tasks match this filter.
                      </Text>
                    </Center>
                  </Table.Td>
                </Table.Tr>
              ) : (
                data.jobs.map((job) => (
                  <Table.Tr
                    key={job.id}
                    onClick={() => inspectJob(job.id)}
                    style={{ cursor: "pointer" }}
                  >
                    <Table.Td>
                      <Code
                        fz="xs"
                        title={job.id}
                        style={{
                          background: "transparent",
                          paddingBlock: 0,
                          paddingInline: 0,
                        }}
                      >
                        {job.id.slice(0, 8)}
                      </Code>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4} wrap="nowrap">
                        <Text fw={600} size="sm" lh={1.3} title={job.type}>
                          {taskDisplayName(job.type, job.queue)}
                        </Text>
                        {job.keyed ? (
                          <Badge
                            size="xs"
                            variant="light"
                            color="violet"
                            tt="none"
                            title="Workhorse accepted this task with an idempotency key. If the same request repeats during retention, Workhorse returns this task again."
                          >
                            Keyed
                          </Badge>
                        ) : null}
                        {job.tags.map((tag) =>
                          tag === "durable-checkpoint" ? null : (
                            <Badge key={tag} size="xs" variant="light" color="gray" tt="none">
                              {tag}
                            </Badge>
                          ),
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {job.queue}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <CollapsedArgs payload={job.payload} expanded={fullArgs} />
                    </Table.Td>
                    <Table.Td>
                      <Group gap="xs" wrap="nowrap">
                        <StatusBadge state={job.state} />
                        <CancelRequestedBadge cancellation={job.cancellation} />
                        <TaskWaitBadge job={job} />
                        <TaskStatusDetail job={job} />
                      </Group>
                    </Table.Td>
                    <Table.Td ta="right">
                      <DurableProgressBadge job={job} />
                    </Table.Td>
                    <Table.Td ta="right">
                      <Text
                        size="sm"
                        c={job.attempt > 1 ? "yellow.8" : undefined}
                        fw={job.attempt > 1 ? 600 : undefined}
                      >
                        {job.attempt}/{job.maxAttempts}
                      </Text>
                    </Table.Td>
                    <Table.Td ta="right">
                      <Text size="sm" c="dimmed">
                        {taskDuration(job) ?? "—"}
                      </Text>
                    </Table.Td>
                    <Table.Td ta="right">
                      <Text size="sm" title={formatExact(job.updatedAt)} c="dimmed">
                        {formatRelative(job.updatedAt)}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <TaskRowActions
                        job={job}
                        onAction={runRowAction}
                        capabilities={{ runNow: runTaskNow !== null }}
                        pendingAction={runningNowJobId === job.id ? "run-now" : null}
                      />
                    </Table.Td>
                  </Table.Tr>
                ))
              )}
            </Table.Tbody>
          </Table>
        </ScrollArea>
        <Divider />
        <Group justify="flex-end" p="md">
          {pagination}
        </Group>
      </Paper>
    </Stack>
  );
}

function CronPage({
  data,
  togglingSchedule,
  setScheduleEnabled,
}: {
  data: DashboardCronPage;
  togglingSchedule: string | null;
  setScheduleEnabled: (namespace: string, name: string, enabled: boolean) => void;
}) {
  return (
    <Stack gap="xl">
      <PageHeader
        title="Schedules"
        description="See when recurring tasks run and where Workhorse sends them."
      />
      {data.schedules.length === 0 ? (
        <EmptyState>Workhorse has no recurring schedules.</EmptyState>
      ) : (
        <Paper withBorder>
          <ScrollArea>
            <Table highlightOnHover verticalSpacing={6} horizontalSpacing="md" miw={800}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Schedule</Table.Th>
                  <Table.Th>Expression</Table.Th>
                  <Table.Th>Destination</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Last run</Table.Th>
                  <Table.Th ta="right">Runs</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data.schedules.map((schedule) => {
                  const scheduleKey = `${schedule.namespace}:${schedule.name}`;
                  return (
                    <Table.Tr key={scheduleKey}>
                      <Table.Td maw={340}>
                        <Text
                          fw={600}
                          size="sm"
                          lh={1.3}
                          title={`${schedule.kind} · ${schedule.namespace}`}
                        >
                          {schedule.name}
                        </Text>
                        {schedule.description ? (
                          <Text c="dimmed" size="xs" lh={1.3} lineClamp={1}>
                            {schedule.description}
                          </Text>
                        ) : null}
                      </Table.Td>
                      <Table.Td>
                        <Code
                          fz="xs"
                          style={{
                            background: "transparent",
                            paddingBlock: 0,
                            paddingInline: 0,
                          }}
                        >
                          {schedule.cron}
                        </Code>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c="dimmed">
                          {schedule.queue ?? "system"}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        {schedule.kind === "user" ? (
                          <Switch
                            size="sm"
                            checked={schedule.enabled}
                            disabled={togglingSchedule === scheduleKey}
                            label={schedule.enabled ? "Enabled" : "Disabled"}
                            styles={{
                              label: {
                                fontSize: "var(--mantine-font-size-xs)",
                              },
                            }}
                            aria-label={`${schedule.enabled ? "Disable" : "Enable"} ${schedule.name}`}
                            onChange={(event) =>
                              setScheduleEnabled(
                                schedule.namespace,
                                schedule.name,
                                event.currentTarget.checked,
                              )
                            }
                          />
                        ) : (
                          <StatusBadge state={schedule.maintenance?.status ?? "scheduled"} />
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c="dimmed" title={formatExact(schedule.lastFiredAt)}>
                          {schedule.lastFiredAt ? formatRelative(schedule.lastFiredAt) : "never"}
                        </Text>
                      </Table.Td>
                      <Table.Td ta="right">{schedule.occurrenceCount ?? "—"}</Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        </Paper>
      )}
    </Stack>
  );
}

export function QueuesPage({
  data,
  togglingQueue,
  purgingQueue,
  confirmingQueue,
  setQueuePaused,
  setConfirmingQueue,
  purgeQueue,
}: {
  data: DashboardQueuesPage;
  togglingQueue: string | null;
  purgingQueue: string | null;
  confirmingQueue: string | null;
  setQueuePaused: (queue: string, paused: boolean) => void;
  setConfirmingQueue: (queue: string | null) => void;
  purgeQueue: (queue: string) => void;
}) {
  return (
    <Stack gap="xl">
      <PageHeader
        title="Queues"
        description="Pause new claims, compare task counts and fleet-wide limits, or clear tasks that have not started."
      />
      {data.queues.length === 0 ? (
        <EmptyState>No queue has accepted a task yet.</EmptyState>
      ) : (
        <Paper withBorder>
          <ScrollArea>
            <Table highlightOnHover verticalSpacing={6} horizontalSpacing="md" miw={1140}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Queue</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th ta="right">Scheduled</Table.Th>
                  <Table.Th ta="right">Ready</Table.Th>
                  <Table.Th ta="right">Active</Table.Th>
                  <Table.Th ta="right">
                    <Group gap={4} justify="flex-end" wrap="nowrap">
                      <span>Limit</span>
                      <HelpButton
                        label="Limit"
                        help="A limit is a fleet-wide budget: it caps how many of this queue's tasks run at once across every worker sharing this database. Worker slots limit one process instead, and pausing is separate."
                      />
                    </Group>
                  </Table.Th>
                  <Table.Th ta="right">
                    <Group gap={4} justify="flex-end" wrap="nowrap">
                      <span>Blocked</span>
                      <HelpButton
                        label="Blocked"
                        help="Ready tasks that cannot start because the limit is full. Workhorse scans a bounded window of each queue, so this is a lower bound rather than the whole backlog."
                      />
                    </Group>
                  </Table.Th>
                  <Table.Th ta="right">Succeeded</Table.Th>
                  <Table.Th ta="right">Failed</Table.Th>
                  <Table.Th ta="right">Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data.queues.map((queue) => {
                  const approximatePrefix = queue.terminalCountsApproximate ? "~" : "";
                  const policy = queue.concurrencyPolicy;
                  const limit = describeConcurrencyLimit(policy);
                  const keys = describeConcurrencyKeys(policy);
                  const blocked = describeConcurrencyBlocked(policy);
                  return (
                    <Table.Tr key={queue.queue}>
                      <Table.Td>
                        <Code
                          fz="xs"
                          style={{
                            background: "transparent",
                            paddingBlock: 0,
                            paddingInline: 0,
                          }}
                        >
                          {queue.queue}
                        </Code>
                      </Table.Td>
                      <Table.Td>
                        <Switch
                          size="sm"
                          checked={!queue.paused}
                          disabled={togglingQueue === queue.queue}
                          label={queue.paused ? "Paused" : "Running"}
                          styles={{
                            label: { fontSize: "var(--mantine-font-size-xs)" },
                          }}
                          aria-label={`${queue.paused ? "Resume" : "Pause"} ${queue.queue}`}
                          onChange={(event) =>
                            setQueuePaused(queue.queue, !event.currentTarget.checked)
                          }
                        />
                      </Table.Td>
                      <Table.Td ta="right">{queue.scheduled}</Table.Td>
                      <Table.Td ta="right">{queue.ready}</Table.Td>
                      <Table.Td ta="right">{queue.active}</Table.Td>
                      <Table.Td ta="right">
                        <Text size="sm" title={limit.title} aria-label={`Limit: ${limit.title}`}>
                          {limit.label}
                        </Text>
                        {keys.label === null ? null : (
                          <Text
                            c={keys.saturated ? "yellow.8" : "dimmed"}
                            size="xs"
                            title={keys.title}
                            aria-label={`Per key: ${keys.title}`}
                          >
                            {keys.label}
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td ta="right">
                        <Text
                          size="sm"
                          c={blocked.blocking ? "yellow.8" : undefined}
                          fw={blocked.blocking ? 650 : undefined}
                          title={blocked.title}
                          aria-label={`Blocked: ${blocked.title}`}
                        >
                          {blocked.label}
                        </Text>
                      </Table.Td>
                      <Table.Td
                        ta="right"
                        title={queue.terminalCountsApproximate ? "PostgreSQL estimate" : undefined}
                      >
                        {approximatePrefix}
                        {queue.succeeded}
                      </Table.Td>
                      <Table.Td
                        ta="right"
                        title={queue.terminalCountsApproximate ? "PostgreSQL estimate" : undefined}
                      >
                        {approximatePrefix}
                        {queue.failed}
                      </Table.Td>
                      <Table.Td ta="right">
                        {confirmingQueue === queue.queue ? (
                          <Group gap={4} justify="flex-end" wrap="nowrap">
                            <Button
                              color="red"
                              size="compact-xs"
                              loading={purgingQueue === queue.queue}
                              onClick={() => purgeQueue(queue.queue)}
                            >
                              Confirm clear
                            </Button>
                            <Button
                              variant="subtle"
                              color="gray"
                              size="compact-xs"
                              disabled={purgingQueue === queue.queue}
                              onClick={() => setConfirmingQueue(null)}
                            >
                              Cancel
                            </Button>
                          </Group>
                        ) : (
                          <Button
                            variant="light"
                            color="red"
                            size="compact-xs"
                            onClick={() => setConfirmingQueue(queue.queue)}
                          >
                            Clear
                          </Button>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        </Paper>
      )}
      <Text c="dimmed" size="xs">
        Clear removes tasks that are scheduled or ready. It does not interrupt active tasks.
      </Text>
      {data.concurrencyPoliciesCapped ? (
        <Text c="dimmed" size="xs">
          {concurrencyCappedFootnote}
        </Text>
      ) : null}
    </Stack>
  );
}

function formatRate(value: number): string {
  if (value === 0) return "0";
  if (Math.abs(value) < 0.1) return "<0.1";
  return value.toFixed(1);
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(value < 0.01 ? 1 : 0)}%`;
}

function MiniTrend({ series }: { series: Array<{ values: number[]; color: string }> }) {
  const values = series.flatMap((item) => item.values);
  const maximum = Math.max(1, ...values);
  const width = 132;
  const height = 34;
  return (
    <Box component="svg" viewBox={`0 0 ${width} ${height}`} w="100%" h={height} aria-hidden>
      {series.map((item, seriesIndex) => {
        const points = item.values
          .map((value, index) => {
            const x = item.values.length <= 1 ? 0 : (index / (item.values.length - 1)) * width;
            const y = height - (value / maximum) * (height - 3) - 1.5;
            return `${x},${y}`;
          })
          .join(" ");
        return (
          <polyline
            key={`${item.color}:${seriesIndex}`}
            points={points}
            fill="none"
            stroke={item.color}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        );
      })}
    </Box>
  );
}

function RetryBars({ buckets }: { buckets: DashboardSystemRetryBucket[] }) {
  const maximum = Math.max(1, ...buckets.map((bucket) => bucket.count));
  return (
    <Stack gap={6}>
      {buckets.map((bucket) => (
        <Group key={bucket.label} gap="xs" wrap="nowrap">
          <Text c="dimmed" size="xs" w={34} ta="right">
            {bucket.label}
          </Text>
          <Box bg="var(--mantine-color-default-hover)" h={7} style={{ flex: 1, borderRadius: 8 }}>
            <Box
              bg="var(--mantine-color-orange-6)"
              h="100%"
              w={`${(bucket.count / maximum) * 100}%`}
              style={{ borderRadius: 8 }}
            />
          </Box>
          <Text size="xs" fw={650} w={24} ta="right">
            {bucket.count}
          </Text>
        </Group>
      ))}
    </Stack>
  );
}

function HelpButton({ label, help }: { label: string; help: string }) {
  return (
    <Tooltip label={help} multiline w={280} withArrow>
      <ActionIcon aria-label={`${label}: ${help}`} color="gray" size="sm" variant="subtle">
        <Info size={14} />
      </ActionIcon>
    </Tooltip>
  );
}

function HealthKpi({
  title,
  value,
  detail,
  help,
  scope,
  color = "blue",
  icon,
  children,
  divided = false,
}: {
  title: string;
  value: ReactNode;
  detail: ReactNode;
  help: string;
  scope: string;
  color?: string;
  icon: ReactNode;
  children?: ReactNode;
  divided?: boolean;
}) {
  return (
    // A compact two-line row: the measures stack into one narrow column beside the queue
    // table, so vertical space is the scarce resource and every row keeps the same rhythm.
    <Box
      px="sm"
      py={9}
      style={divided ? { borderTop: "1px solid var(--mantine-color-default-border)" } : undefined}
    >
      <Group justify="space-between" align="center" gap="xs" wrap="nowrap">
        <Group gap={8} wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
          <ThemeIcon variant="light" color={color} size="sm" style={{ flexShrink: 0 }}>
            {icon}
          </ThemeIcon>
          <Box style={{ minWidth: 0 }}>
            <Group gap={5} wrap="nowrap">
              <Tooltip
                label={help}
                multiline
                w={280}
                withArrow
                position="top-start"
                openDelay={150}
                closeDelay={80}
                events={{ hover: true, focus: true, touch: true }}
              >
                <Text
                  fw={600}
                  fz={13}
                  lh={1.25}
                  tabIndex={0}
                  style={{
                    cursor: "help",
                    textDecoration: "underline dotted",
                    textUnderlineOffset: 3,
                    whiteSpace: "nowrap",
                  }}
                >
                  {title}
                </Text>
              </Tooltip>
              <Text c="dimmed" fz={9} fw={600} lh={1} tt="uppercase" style={{ flexShrink: 0 }}>
                {scope}
              </Text>
            </Group>
            <Text c="dimmed" fz={11} lh={1.3} lineClamp={1}>
              {detail}
            </Text>
          </Box>
        </Group>
        {children ? (
          <Box visibleFrom="md" w={72} style={{ flexShrink: 0 }}>
            {children}
          </Box>
        ) : null}
        {typeof value === "string" || typeof value === "number" ? (
          <Text fw={750} fz={17} lh={1.2} ta="right" style={{ flexShrink: 0 }}>
            {value}
          </Text>
        ) : (
          value
        )}
      </Group>
    </Box>
  );
}

function systemBucketLabel(value: string, window: DashboardSystemWindow): string {
  const date = new Date(value);
  return getDateTimeFormatter({
    month: window === "24h" ? "short" : undefined,
    day: window === "24h" ? "numeric" : undefined,
    hour: "2-digit",
    minute: "2-digit",
    timeZone: displayTimeZone ?? undefined,
  }).format(date);
}

export function QueuePressure({
  data,
  navigate,
}: {
  data: DashboardSystemPage;
  navigate: (href: string) => void;
}) {
  return (
    // Nine numeric columns need the wider two-thirds column; narrower viewports scroll the table
    // horizontally rather than dropping any of them.
    <Paper withBorder h="100%">
      <Group justify="space-between" p="md">
        <Box>
          <Group gap={4} wrap="nowrap">
            <Text fw={650}>Queue backlog</Text>
            <HelpButton
              label="Queue backlog"
              help="This table ranks queues by their current backlog. Rates cover the selected window. Select a row to see its tasks."
            />
          </Group>
          <Text c="dimmed" size="xs">
            Largest risk first · select a queue to see its tasks
          </Text>
        </Box>
        <Badge
          variant="light"
          color={data.queues.some((queue) => queue.paused) ? "yellow" : "gray"}
        >
          {data.queues.length} queues
        </Badge>
      </Group>
      <ScrollArea>
        <Table highlightOnHover verticalSpacing={6} horizontalSpacing="sm" miw={1020}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Queue</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th ta="right">Ready</Table.Th>
              <Table.Th ta="right">Oldest</Table.Th>
              <Table.Th ta="right">Due in 5m</Table.Th>
              <Table.Th ta="right">Active</Table.Th>
              <Table.Th ta="right">
                <Group gap={4} justify="flex-end" wrap="nowrap">
                  <span>Limit</span>
                  <HelpButton
                    label="Limit"
                    help="A limit is a fleet-wide budget: it caps how many of this queue's tasks run at once across every worker sharing this database. Blocked ready tasks are counted from a bounded window, so they are a lower bound."
                  />
                </Group>
              </Table.Th>
              <Table.Th ta="right">Retrying</Table.Th>
              <Table.Th ta="right">Added/min</Table.Th>
              <Table.Th ta="right">Finished/min</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {data.queues.map((queue) => {
              const limit = describeConcurrencyLimit(queue.concurrencyPolicy);
              const blocked = describeConcurrencyBlocked(queue.concurrencyPolicy);
              return (
                <Table.Tr
                  key={queue.queue}
                  tabIndex={0}
                  style={{ cursor: "pointer" }}
                  onClick={() => navigate(`/tasks?queue=${encodeURIComponent(queue.queue)}`)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      navigate(`/tasks?queue=${encodeURIComponent(queue.queue)}`);
                    }
                  }}
                >
                  <Table.Td>
                    <Code fz="xs" style={{ background: "transparent", padding: 0 }}>
                      {queue.queue}
                    </Code>
                  </Table.Td>
                  <Table.Td>
                    <Badge color={queue.paused ? "yellow" : "teal"} variant="light" size="sm">
                      {queue.paused ? "Paused" : "Running"}
                    </Badge>
                  </Table.Td>
                  <Table.Td ta="right">{queue.ready}</Table.Td>
                  <Table.Td ta="right">{formatDuration(queue.oldestReadyMs)}</Table.Td>
                  <Table.Td ta="right">{queue.dueSoon}</Table.Td>
                  <Table.Td ta="right">{queue.active}</Table.Td>
                  <Table.Td ta="right">
                    <Text size="sm" title={limit.title} aria-label={`Limit: ${limit.title}`}>
                      {limit.label}
                    </Text>
                    {blocked.blocking ? (
                      <Text
                        c="yellow.8"
                        size="xs"
                        fw={650}
                        title={blocked.title}
                        aria-label={`Blocked: ${blocked.title}`}
                      >
                        {blocked.label} blocked
                      </Text>
                    ) : null}
                  </Table.Td>
                  <Table.Td ta="right">{queue.retrying}</Table.Td>
                  <Table.Td ta="right">{formatRate(queue.enqueuedPerMinute)}</Table.Td>
                  <Table.Td ta="right">{formatRate(queue.completedPerMinute)}</Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </ScrollArea>
      {data.concurrencyPoliciesCapped ? (
        <Text c="dimmed" size="xs" px="md" pb="md">
          {concurrencyCappedFootnote}
        </Text>
      ) : null}
    </Paper>
  );
}

function SystemKpiList({ data }: { data: DashboardSystemPage }) {
  const errorColor =
    data.kpis.errorRate.current >= systemErrorRateWarning
      ? "red"
      : data.kpis.errorRate.current >= systemErrorRateCaution
        ? "yellow"
        : "teal";
  const backlogColor =
    (data.kpis.backlog.oldestReadyMs ?? 0) > systemOldestReadyWarningMs ? "yellow" : "blue";
  const recentOutcomes = data.outcomes.slice(-30);
  const queueWaitPercentiles = [
    { label: "p50", duration: data.kpis.queueWait.p50Ms },
    { label: "p95", duration: data.kpis.queueWait.p95Ms },
    { label: "p99", duration: data.kpis.queueWait.p99Ms },
  ];
  const deadline = data.kpis.deadline ?? {
    pending: 0,
    overdue: 0,
    dueWithinMinute: 0,
    earliestAt: null,
    activeTimeouts: 0,
    overdueTimeouts: 0,
  };

  return (
    // One panel of hairline-separated rows, sized to sit beside the queue table.
    <Paper withBorder h="100%">
      <HealthKpi
        title="Completion rate"
        value={`${formatRate(data.kpis.drain.completedPerMinute)}/min`}
        detail={`${formatRate(data.kpis.drain.enqueuedPerMinute)} added · net ${data.kpis.drain.netPerMinute >= 0 ? "+" : ""}${formatRate(data.kpis.drain.netPerMinute)}/min`}
        help="This rate compares finished tasks with new tasks during the selected window. A negative net means tasks arrived faster than workers finished them."
        scope={data.window}
        color={data.kpis.drain.netPerMinute < 0 ? "yellow" : "teal"}
        icon={<ArrowClockwise size={16} />}
      >
        <MiniTrend
          series={[
            {
              values: recentOutcomes.map((bucket) => bucket.enqueued),
              color: "var(--mantine-color-blue-6)",
            },
            {
              values: recentOutcomes.map((bucket) => bucket.succeeded + bucket.failed),
              color: "var(--mantine-color-teal-6)",
            },
          ]}
        />
      </HealthKpi>
      <HealthKpi
        divided
        title="Ready backlog"
        value={data.kpis.backlog.ready}
        detail={`Oldest task ${formatDuration(data.kpis.backlog.oldestReadyMs)}`}
        help="This count shows tasks that are ready for workers. An older task can mean that its queue is draining slowly."
        scope="now"
        color={backlogColor}
        icon={<ListChecks size={16} />}
      />
      <HealthKpi
        divided
        title="Failed attempts"
        value={formatPercent(data.kpis.errorRate.current)}
        detail={`${data.kpis.errorRate.delta >= 0 ? "+" : ""}${formatPercent(data.kpis.errorRate.delta)} vs prior ${data.window}`}
        help="This is the share of attempts that did not succeed. The comparison uses the previous window of the same length."
        scope={data.window}
        color={errorColor}
        icon={<WarningCircle size={16} />}
      />
      <HealthKpi
        divided
        title="Wait for first claim"
        value={
          <Group gap={10} wrap="nowrap" style={{ flexShrink: 0 }}>
            {queueWaitPercentiles.map((percentile) => (
              <Box key={percentile.label} ta="right">
                <Text c="dimmed" fz={9} fw={600} lh={1} tt="uppercase">
                  {percentile.label}
                </Text>
                <Text fw={700} fz={13} lh={1.3}>
                  {formatDuration(percentile.duration)}
                </Text>
              </Box>
            ))}
          </Group>
        }
        detail="From enqueue to first claim"
        help="These percentiles measure the time between enqueue and first claim during the selected window."
        scope={data.window}
        color="indigo"
        icon={<Clock size={16} />}
      />
      <HealthKpi
        divided
        title="Retries in backoff"
        value={data.kpis.retry.backoff}
        detail={`${data.kpis.retry.dueSoon} due in the next 5m`}
        help="This count shows tasks in backoff before another attempt. The second count shows how many become ready within five minutes."
        scope="now"
        color={data.kpis.retry.dueSoon > 0 ? "orange" : "blue"}
        icon={<ArrowCounterClockwise size={16} />}
      />
      <HealthKpi
        divided
        title="Expired leases"
        value={data.kpis.lease.expired}
        detail={`${data.kpis.lease.expiringSoon} expire in 30s · ${data.kpis.lease.recovered} recovered/${data.window}`}
        help="This count shows active tasks whose leases expired. It also shows leases nearing expiry and tasks recovered during the selected window."
        scope="now"
        color={data.kpis.lease.expired > 0 ? "red" : "teal"}
        icon={<Pulse size={16} />}
      />
      <HealthKpi
        divided
        title="Overdue tasks"
        value={deadline.overdue}
        detail={`${deadline.dueWithinMinute} due in 1m · ${deadline.overdueTimeouts} timed-out attempts awaiting reap`}
        help="This count shows live tasks past their deadline. It also shows approaching deadlines and attempts whose execution time has expired."
        scope="now"
        color={
          deadline.overdue > 0 || deadline.overdueTimeouts > 0
            ? "red"
            : deadline.dueWithinMinute > 0
              ? "orange"
              : "teal"
        }
        icon={<Clock size={16} />}
      />
    </Paper>
  );
}

function RetryStorm({ data }: { data: DashboardSystemPage }) {
  return (
    <Paper withBorder p="md" h="100%">
      <Group gap={4} wrap="nowrap">
        <Text fw={650}>Upcoming retries</Text>
        <HelpButton
          label="Upcoming retries"
          help="These tasks are in backoff before another attempt. The bars group them by ready time, and the list shows the largest task types."
        />
      </Group>
      <Text c="dimmed" size="xs" mb="lg">
        Tasks grouped by their next retry time
      </Text>
      <RetryBars buckets={data.retryStorm.buckets} />
      <Divider my="lg" />
      <Text c="dimmed" fw={600} size="xs" tt="uppercase" mb="xs">
        Top contributors
      </Text>
      {data.retryStorm.topTypes.length === 0 ? (
        <Text c="dimmed" size="sm">
          No retries are in backoff.
        </Text>
      ) : (
        <Stack gap="xs">
          {data.retryStorm.topTypes.map((type) => (
            <Group key={`${type.queue}:${type.type}`} justify="space-between" wrap="nowrap">
              <Box style={{ minWidth: 0 }}>
                <Text size="sm" fw={600} truncate>
                  {taskDisplayName(type.type, type.queue)}
                </Text>
                <Text c="dimmed" size="xs">
                  {type.queue}
                </Text>
              </Box>
              <Badge color="orange" variant="light">
                {type.count}
              </Badge>
            </Group>
          ))}
        </Stack>
      )}
    </Paper>
  );
}

function SystemPage({
  data,
  setWindow,
  navigate,
}: {
  data: DashboardSystemPage;
  setWindow: (window: DashboardSystemWindow) => void;
  navigate: (href: string) => void;
}) {
  // Level is also spelled out in the badge text so status never depends on color alone.
  const systemStatusColor =
    data.status.level === "critical" ? "red" : data.status.level === "degraded" ? "yellow" : "teal";
  const outcomeChartData = data.outcomes.map((bucket) => ({
    bucket: systemBucketLabel(bucket.bucketStart, data.window),
    enqueued: bucket.enqueued,
    succeeded: bucket.succeeded,
    failed: bucket.failed,
    retry: bucket.retry,
    leaseExpired: bucket.leaseExpired,
    canceled: bucket.canceled,
  }));
  const retention = data.integrity.retention;
  const defaultSpill =
    retention.defaultHistoryRows.jobEvents + retention.defaultHistoryRows.attemptHistory;
  const eligiblePartitions =
    retention.eligibleHistoryPartitions.jobEvents +
    retention.eligibleHistoryPartitions.attemptHistory;
  const enabledRetention = retention.categories.filter((row) => row.retentionDays !== null);
  const retentionDetail =
    enabledRetention.length === 0
      ? "No category is set to delete history, so nothing can fall behind."
      : enabledRetention
          .map(
            (row) =>
              `${row.label}: keeps ${row.retentionDays} days, ${
                row.lagMs === null
                  ? "nothing retained yet"
                  : row.lagMs === 0
                    ? "inside the window"
                    : `${formatSpan(row.lagMs)} past cutoff`
              }${
                row.oldestRetainedAt === null
                  ? ""
                  : ` (oldest ${formatExact(row.oldestRetainedAt)})`
              }`,
          )
          .join(" · ");
  const oldestRetained = retention.categories.find(
    (row) => row.category === retention.oldestRetainedCategory,
  );
  // Only a lag check should tint the lag badge; spill and expired days have their own rows.
  const retentionBehind = data.status.degradedChecks.some((check) =>
    check.startsWith("Retention cleanup is late"),
  );

  return (
    <Stack gap="xl">
      <Group justify="space-between" align="flex-start">
        <Box>
          <Group gap="sm" mb={4}>
            <Title order={1}>System health</Title>
            <HelpButton
              label="System health"
              help="Critical checks mean Workhorse may stop or lose work. Degraded checks mean retained history is using more storage than its policy allows."
            />
            <Badge color={systemStatusColor} variant="light" size="lg" tt="capitalize">
              {data.status.level}
            </Badge>
          </Group>
          <Group gap="xs">
            {data.status.checks.slice(0, 3).map((check) => {
              // Each check keeps its own severity so a degraded note is not painted as critical.
              const isCritical = data.status.criticalChecks.includes(check);
              return (
                <Text key={check} c={isCritical ? "red.7" : "yellow.8"} size="sm">
                  {isCritical ? "Critical" : "Degraded"}: {check}
                </Text>
              );
            })}
            {data.status.checks.length === 0 ? (
              <Text c="dimmed" size="sm">
                All checks pass.
              </Text>
            ) : null}
          </Group>
          {data.pausedQueues.length > 0 ? (
            <Group gap={6} mt="xs">
              <Text c="dimmed" size="xs">
                Paused
              </Text>
              {data.pausedQueues.map((queue) => (
                <Badge key={queue} color="yellow" variant="light" size="sm">
                  {queue}
                </Badge>
              ))}
            </Group>
          ) : null}
        </Box>
        <Stack gap={6} align="flex-end">
          <SegmentedControl
            size="xs"
            value={data.window}
            onChange={(value) => setWindow(value as DashboardSystemWindow)}
            data={systemWindows.map((value) => ({ value, label: value }))}
          />
          <Text c="dimmed" size="xs" title={formatExact(data.capturedAt)}>
            Captured {formatRelative(data.capturedAt)}
          </Text>
        </Stack>
      </Group>

      {/* Current pressure leads the page: the queue table and the condensed measures share one
          row, so the numbers sit next to the queues they describe. The measures come first in
          source order to read first on a phone, where the columns stack. */}
      <Grid gutter="xl">
        <Grid.Col span={{ base: 12, lg: 4 }} order={{ base: 1, lg: 1 }}>
          <SystemKpiList data={data} />
        </Grid.Col>
        <Grid.Col span={{ base: 12, lg: 8 }} order={{ base: 2, lg: 2 }}>
          <QueuePressure data={data} navigate={navigate} />
        </Grid.Col>
      </Grid>

      {/* The chart and the retry outlook answer the same question — what is arriving next — so
          they sit side by side instead of stacking a wide chart over a narrow column. */}
      <Grid gutter="xl">
        <Grid.Col span={{ base: 12, lg: 8 }}>
          <Paper withBorder p="md" h="100%">
            <Group justify="space-between" mb="sm">
              <Box>
                <Group gap={4} wrap="nowrap">
                  <Text fw={650}>Task activity</Text>
                  <HelpButton
                    label="Task activity"
                    help="Each bar shows attempt outcomes for one minute. The line shows tasks added during that minute."
                  />
                </Group>
                <Text c="dimmed" size="xs">
                  Tasks added and attempts finished each minute
                </Text>
              </Box>
              <Badge variant="light" color="gray">
                {data.window}
              </Badge>
            </Group>
            <Box h={320}>
              <Suspense
                fallback={
                  <Center h="100%">
                    <Loader size="sm" />
                  </Center>
                }
              >
                <SystemOutcomeChart data={outcomeChartData} />
              </Suspense>
            </Box>
          </Paper>
        </Grid.Col>
        <Grid.Col span={{ base: 12, lg: 4 }}>
          <RetryStorm data={data} />
        </Grid.Col>
      </Grid>

      <Grid gutter="xl">
        <Grid.Col span={{ base: 12, lg: 7 }}>
          <Paper withBorder h="100%">
            <Box p="md">
              <Group gap={4} wrap="nowrap">
                <Text fw={650}>Task types with failures</Text>
                <HelpButton
                  label="Task types with failures"
                  help="This table ranks task types by failed attempts in the selected window. The last columns describe the newest matching attempt."
                />
              </Group>
              <Text c="dimmed" size="xs">
                Closed attempts in the selected window
              </Text>
            </Box>
            {data.failingTypes.length === 0 ? (
              <Center mih={180}>
                <Text c="dimmed" size="sm">
                  No failed attempts in this window.
                </Text>
              </Center>
            ) : (
              <ScrollArea>
                <Table highlightOnHover verticalSpacing={6} horizontalSpacing="sm" miw={760}>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Queue and task type</Table.Th>
                      <Table.Th ta="right">Attempts</Table.Th>
                      <Table.Th ta="right">Error %</Table.Th>
                      <Table.Th ta="right">Terminal</Table.Th>
                      <Table.Th>Last error</Table.Th>
                      <Table.Th>Last seen</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {data.failingTypes.map((type) => (
                      <Table.Tr key={`${type.queue}:${type.type}`}>
                        <Table.Td>
                          <Text size="sm" fw={600}>
                            {taskDisplayName(type.type, type.queue)}
                          </Text>
                          <Text c="dimmed" size="xs">
                            {type.queue}
                          </Text>
                        </Table.Td>
                        <Table.Td ta="right">{type.attempts}</Table.Td>
                        <Table.Td ta="right">
                          <Text c={type.errorRate >= 0.05 ? "red.7" : "yellow.8"} size="sm">
                            {formatPercent(type.errorRate)}
                          </Text>
                        </Table.Td>
                        <Table.Td ta="right">{type.terminalFailures}</Table.Td>
                        <Table.Td maw={220}>
                          <Text size="xs" lineClamp={1} title={type.lastError ?? undefined}>
                            {type.lastError ?? "—"}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Text c="dimmed" size="xs" title={formatExact(type.lastSeenAt)}>
                            {formatRelative(type.lastSeenAt)}
                          </Text>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </ScrollArea>
            )}
          </Paper>
        </Grid.Col>
        <Grid.Col span={{ base: 12, lg: 5 }}>
          <Paper withBorder p="md" h="100%">
            <Group gap={4} wrap="nowrap">
              <Text fw={650}>Background maintenance</Text>
              <HelpButton
                label="Background maintenance"
                help="These checks cover due tasks, prepared history storage, and retention cleanup. The counts show the current database state and ignore the window selector."
              />
            </Group>
            <Text c="dimmed" size="xs" mb="lg">
              Checks that keep tasks moving and history bounded
            </Text>
            <Group justify="space-between" mb="lg">
              <Box>
                <Text size="sm" fw={600}>
                  Overdue scheduled tasks
                </Text>
                <Text c="dimmed" size="xs">
                  Still scheduled after their start time
                </Text>
              </Box>
              <Badge
                color={data.integrity.dueButUnpromoted > 0 ? "red" : "teal"}
                variant="light"
                size="lg"
              >
                {data.integrity.dueButUnpromoted}
              </Badge>
            </Group>
            <Table verticalSpacing={6} horizontalSpacing="xs" captionSide="top">
              <Table.Caption ta="left" c="dimmed" fz="xs" mt={0} mb={4}>
                Daily storage prepared for history
              </Table.Caption>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th scope="col">Day</Table.Th>
                  <Table.Th scope="col" ta="center">
                    Task events
                  </Table.Th>
                  <Table.Th scope="col" ta="center">
                    Attempt history
                  </Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data.integrity.partitions.map((partition) => (
                  <Table.Tr key={partition.day}>
                    <Table.Th scope="row" fw={400}>
                      <Text
                        size="xs"
                        title={`${partition.day} · ${formatExact(partition.startsAt)}`}
                      >
                        {formatDay(partition.startsAt)}
                      </Text>
                    </Table.Th>
                    <Table.Td ta="center">
                      <Badge color={partition.eventExists ? "teal" : "red"} variant="dot" size="sm">
                        {partition.eventExists ? "Ready" : "Missing"}
                      </Badge>
                    </Table.Td>
                    <Table.Td ta="center">
                      <Badge
                        color={partition.attemptExists ? "teal" : "red"}
                        variant="dot"
                        size="sm"
                      >
                        {partition.attemptExists ? "Ready" : "Missing"}
                      </Badge>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
            <Divider my="md" />
            <Stack gap="md">
              <Group justify="space-between" wrap="nowrap" align="flex-start">
                <Box>
                  <Group gap={4} wrap="nowrap">
                    <Text size="sm" fw={600}>
                      Retention cleanup
                    </Text>
                    <HelpButton label="Retention cleanup" help={retentionDetail} />
                  </Group>
                  <Text c="dimmed" size="xs">
                    {enabledRetention.length === 0
                      ? "No category deletes history"
                      : retention.maxLagMs === null || retention.maxLagMs === 0
                        ? "Every category is inside its keep-for window"
                        : `Furthest behind: ${
                            retention.categories.find(
                              (row) => row.category === retention.maxLagCategory,
                            )?.label ?? retention.maxLagCategory
                          }`}
                  </Text>
                </Box>
                <Badge
                  color={retentionBehind ? "yellow" : "teal"}
                  variant="light"
                  title={retentionDetail}
                >
                  {enabledRetention.length === 0
                    ? "Not applicable"
                    : retention.maxLagMs === null || retention.maxLagMs === 0
                      ? "On time"
                      : `${formatSpan(retention.maxLagMs)} behind`}
                </Badge>
              </Group>
              <Group justify="space-between" wrap="nowrap" align="flex-start">
                <Box>
                  <Text size="sm" fw={600}>
                    Oldest retained
                  </Text>
                  <Text c="dimmed" size="xs">
                    {oldestRetained ? oldestRetained.label : "No history retained yet"}
                  </Text>
                </Box>
                <Badge
                  color="gray"
                  variant="light"
                  title={formatExact(retention.oldestRetainedAt ?? undefined)}
                >
                  {retention.oldestRetainedAt === null
                    ? "—"
                    : formatRelative(retention.oldestRetainedAt)}
                </Badge>
              </Group>
              <Group justify="space-between" wrap="nowrap" align="flex-start">
                <Box>
                  <Group gap={4} wrap="nowrap">
                    <Text size="sm" fw={600}>
                      History days awaiting deletion
                    </Text>
                    <HelpButton
                      label="History days awaiting deletion"
                      help="These UTC days are older than their retention period. Cleanup deletes a limited number each time it runs."
                    />
                  </Group>
                  <Text c="dimmed" size="xs">
                    Current total, not windowed
                  </Text>
                </Box>
                <Badge
                  color={eligiblePartitions > 0 ? "yellow" : "teal"}
                  variant="light"
                  title={`${retention.eligibleHistoryPartitions.jobEvents} task-event days, ${retention.eligibleHistoryPartitions.attemptHistory} attempt-history days`}
                >
                  {retention.eligibleHistoryPartitions.jobEvents} events ·{" "}
                  {retention.eligibleHistoryPartitions.attemptHistory} attempts
                </Badge>
              </Group>
              <Group justify="space-between" wrap="nowrap" align="flex-start">
                <Box>
                  <Group gap={4} wrap="nowrap">
                    <Text size="sm" fw={600}>
                      Rows in fallback storage
                    </Text>
                    <HelpButton
                      label="Rows in fallback storage"
                      help="These rows had no daily storage for their timestamp. If a plus sign appears, the bounded scan found at least this many rows."
                    />
                  </Group>
                  <Text c="dimmed" size="xs">
                    Database-wide, not windowed
                  </Text>
                </Box>
                <Badge color={defaultSpill > 0 ? "yellow" : "teal"} variant="light">
                  {retention.defaultHistoryRows.jobEvents}
                  {retention.defaultHistoryRowsCapped.jobEvents ? "+" : ""} events ·{" "}
                  {retention.defaultHistoryRows.attemptHistory}
                  {retention.defaultHistoryRowsCapped.attemptHistory ? "+" : ""} attempts
                </Badge>
              </Group>
            </Stack>
          </Paper>
        </Grid.Col>
        <Grid.Col span={12}>
          <StoragePanel storage={data.integrity.storage} retention={retention} />
        </Grid.Col>
      </Grid>
    </Stack>
  );
}

const storageGroupLabels: Record<DashboardStorageRelation["group"], string> = {
  tasks: "Tasks",
  history: "History",
  statistics: "Statistics",
};

/**
 * What the history and statistics tables hold, and whether the pass that reclaims them is running.
 *
 * These two questions belong together. Rolled-up statistics are derived from history, and history
 * retention deliberately refuses to delete anything the rollup has not summarized yet — so a
 * stalled rollup shows up first as history that stops shrinking, which is impossible to diagnose
 * from a size number alone.
 */
function StoragePanel({
  storage,
  retention,
}: {
  storage: DashboardSystemStorage;
  retention: DashboardSystemRetention;
}) {
  const rollup = storage.rollup;
  const statisticsRetention = retention.categories.find((row) => row.category === "statistics");
  const coveredMs =
    rollup.oldestBucketAt === null || rollup.newestBucketAt === null
      ? null
      : new Date(rollup.newestBucketAt).getTime() - new Date(rollup.oldestBucketAt).getTime();
  return (
    <Paper withBorder p="md">
      <Group gap={4} wrap="nowrap">
        <Text fw={650}>Storage</Text>
        <HelpButton
          label="Storage"
          help="These are current PostgreSQL estimates for tables that Workhorse owns. Cleanup keeps history until the statistics rollup has summarized it."
        />
      </Group>
      <Text c="dimmed" size="xs" mb="lg">
        Current table sizes and progress of the statistics rollup
      </Text>
      <Grid gutter="lg">
        <Grid.Col span={{ base: 12, md: 5 }}>
          <Stack gap="md">
            <Group justify="space-between" wrap="nowrap" align="flex-start">
              <Box>
                <Text size="sm" fw={600}>
                  Statistics summary
                </Text>
                <Text c="dimmed" size="xs">
                  {rollup.lastRunAt === null
                    ? "Has not run yet"
                    : `Last pass ${formatRelative(rollup.lastRunAt)}`}
                </Text>
              </Box>
              <Badge
                color={rollup.stalled ? "yellow" : "teal"}
                variant="light"
                title={`Summarized through ${formatExact(rollup.rolledUpThrough)}`}
              >
                {rollup.stalled ? `${formatSpan(rollup.lagMs)} behind` : "Up to date"}
              </Badge>
            </Group>
            <Group justify="space-between" wrap="nowrap" align="flex-start">
              <Box>
                <Text size="sm" fw={600}>
                  Minutes summarized
                </Text>
                <Text c="dimmed" size="xs">
                  {coveredMs === null
                    ? "No minutes summarized yet"
                    : `Covering ${formatSpan(coveredMs)}`}
                </Text>
              </Box>
              <Badge color="gray" variant="light">
                {formatRows(rollup.buckets)}
              </Badge>
            </Group>
            <Group justify="space-between" wrap="nowrap" align="flex-start">
              <Box>
                <Text size="sm" fw={600}>
                  Keep statistics for
                </Text>
                <Text c="dimmed" size="xs">
                  Independent of history retention
                </Text>
              </Box>
              <Badge color="gray" variant="light">
                {statisticsRetention?.retentionDays === null ||
                statisticsRetention?.retentionDays === undefined
                  ? "Forever"
                  : `${statisticsRetention.retentionDays} days`}
              </Badge>
            </Group>
            <Group justify="space-between" wrap="nowrap" align="flex-start">
              <Box>
                <Text size="sm" fw={600}>
                  Total Workhorse storage
                </Text>
                <Text c="dimmed" size="xs">
                  Tables and indexes together
                </Text>
              </Box>
              <Badge color="gray" variant="light">
                {formatBytes(storage.totalBytes)}
              </Badge>
            </Group>
          </Stack>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 7 }}>
          <ScrollArea.Autosize mah={320} type="auto">
            <Table verticalSpacing={6} horizontalSpacing="xs" captionSide="top" stickyHeader>
              <Table.Caption ta="left" c="dimmed" fz="xs" mt={0} mb={4}>
                Largest tables first. PostgreSQL estimates the row counts.
              </Table.Caption>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th scope="col">Table</Table.Th>
                  <Table.Th scope="col">Holds</Table.Th>
                  <Table.Th scope="col" ta="right">
                    Size
                  </Table.Th>
                  <Table.Th scope="col" ta="right">
                    Rows
                  </Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {storage.relations.map((row) => (
                  <Table.Tr key={row.relation}>
                    <Table.Th scope="row" fw={400}>
                      <Text size="xs" title={row.relation}>
                        {row.label}
                      </Text>
                      {row.partitions > 0 ? (
                        <Text c="dimmed" fz={10}>
                          {row.partitions} daily {row.partitions === 1 ? "part" : "parts"}
                        </Text>
                      ) : null}
                    </Table.Th>
                    <Table.Td>
                      <Badge color="gray" variant="light" size="sm">
                        {storageGroupLabels[row.group]}
                      </Badge>
                    </Table.Td>
                    <Table.Td ta="right">
                      <Text
                        size="xs"
                        title={`${row.tableBytes} B table, ${row.indexBytes} B index`}
                      >
                        {formatBytes(row.totalBytes)}
                      </Text>
                    </Table.Td>
                    <Table.Td ta="right">
                      <Text size="xs">{formatRows(row.rows)}</Text>
                      {row.deadRows > 0 ? (
                        <Text
                          c="dimmed"
                          fz={10}
                          title="PostgreSQL has not reclaimed these deleted rows yet"
                        >
                          {formatRows(row.deadRows)} dead
                        </Text>
                      ) : null}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea.Autosize>
        </Grid.Col>
      </Grid>
    </Paper>
  );
}

const eventsWindowOptions: ReadonlyArray<{
  value: DashboardEventsWindow;
  label: string;
}> = [
  { value: "15m", label: "15m" },
  { value: "1h", label: "1h" },
  { value: "6h", label: "6h" },
  { value: "24h", label: "24h" },
];

const eventsKindOptions = [
  { value: "all", label: "All" },
  { value: "event", label: "Lifecycle" },
  { value: "attempt", label: "Attempts" },
];

/**
 * Colour for one history row, keyed on what the row says happened.
 *
 * `succeeded` and `failed` name both a lifecycle event and an attempt outcome, which is why this
 * reads the type alone and not the source table.
 */
function eventTypeColor(type: string): string {
  if (type === "succeeded") return "teal";
  if (
    ["failed", "lease_expired", "execution_timed_out", "deadline_exceeded", "timeout"].includes(
      type,
    )
  ) {
    return "red";
  }
  if (["retry", "retry_scheduled", "redriven", "redrive_created"].includes(type)) return "orange";
  if (["canceled"].includes(type)) return "gray";
  if (["enqueued", "promoted", "wait_elapsed"].includes(type)) return "yellow";
  if (type === "claimed") return "blue";
  return "gray";
}

/** One-line rendering of an event payload, for a table cell that cannot hold formatted JSON. */
function eventDetailSummary(details: unknown): string | null {
  if (details === null || details === undefined) return null;
  if (typeof details !== "object") return String(details);
  const entries = Object.entries(details as Record<string, unknown>);
  if (entries.length === 0) return null;
  return entries
    .map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : value}`)
    .join(" · ");
}

function uniqueSorted(values: Array<string | null>): string[] {
  // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
  return [...new Set(values.filter((value): value is string => value !== null))].sort();
}

/**
 * The fleet-wide feed of durable lifecycle history.
 *
 * Rows come from `job_event` and `attempt_history`, never from the PostgreSQL notification
 * channels. Those channels carry only a queue name, are coalesced by both the worker and the
 * dashboard's listener, and are dropped while nothing is listening — a feed built from them would
 * be both uninformative and quietly incomplete.
 *
 * The feed is a window, not a paginated log. It updates in place while an operator watches, and a
 * cursor walking backwards through a list whose head keeps moving is not something anyone should
 * have to reason about. One task's complete history is in its own timeline in the task drawer.
 */
function EventsPage({
  data,
  query,
  setQuery,
  inspectEvent,
}: {
  data: DashboardEventsPage;
  query: EventsLocationState;
  setQuery: (next: EventsLocationState) => void;
  inspectEvent: (event: DashboardEventRow) => void;
}) {
  const eventFacets = useTaskFacets({
    queue: query.queue,
    worker: null,
    jobType: query.jobType,
    tags: [],
  });
  const queueOptions = includeSelectedOption(eventFacets.facets.queues, query.queue);
  const typeOptions = includeSelectedOption(eventFacets.facets.jobTypes, query.jobType);
  const eventTypeOptions = includeSelectedOptions(
    uniqueSorted([...dashboardJobEventTypes, ...dashboardAttemptOutcomes]),
    query.types,
  );
  const retentionNote = [
    data.retention.jobEventDays === null
      ? "lifecycle events are retained indefinitely"
      : `lifecycle events are retained for ${data.retention.jobEventDays} days`,
    data.retention.attemptHistoryDays === null
      ? "attempt history is retained indefinitely"
      : `attempt history is retained for ${data.retention.attemptHistoryDays} days`,
  ].join(", ");
  // Any change to what is being asked for returns to the first page: page 4 of the old filter
  // addresses nothing in the new result set.
  const filter = (next: Partial<EventsLocationState>) =>
    setQuery({ ...query, ...next, page: 1, eventId: null });
  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const facetMessage = eventFacets.loading ? "Loading filters…" : eventFacets.error;

  return (
    <Stack gap="xl">
      <PageHeader
        title="Events"
        description="See what happened across all tasks, with the newest records first."
      />
      <Paper withBorder p="md">
        <Group gap="md" align="flex-end" wrap="wrap">
          <Box>
            <Text c="dimmed" fw={600} size="xs" mb={4}>
              Window
            </Text>
            <SegmentedControl
              size="xs"
              value={query.window}
              data={[...eventsWindowOptions]}
              onChange={(value) => filter({ window: value as DashboardEventsWindow })}
            />
          </Box>
          <Box>
            <Text c="dimmed" fw={600} size="xs" mb={4}>
              Source
            </Text>
            <SegmentedControl
              size="xs"
              value={query.kind}
              data={eventsKindOptions}
              onChange={(value) => filter({ kind: value as EventsLocationState["kind"] })}
            />
          </Box>
          <Select
            size="xs"
            label="Queue"
            placeholder="Any queue"
            clearable
            searchable
            w={180}
            data={queueOptions}
            value={query.queue}
            onChange={(value) => filter({ queue: value })}
            onDropdownOpen={eventFacets.load}
            rightSection={eventFacets.loading ? <Loader size={14} /> : undefined}
            nothingFoundMessage={facetMessage ?? "No queues found"}
          />
          <Select
            size="xs"
            label="Task type"
            placeholder="Any type"
            clearable
            searchable
            w={200}
            data={typeOptions}
            value={query.jobType}
            onChange={(value) => filter({ jobType: value })}
            onDropdownOpen={eventFacets.load}
            rightSection={eventFacets.loading ? <Loader size={14} /> : undefined}
            nothingFoundMessage={facetMessage ?? "No task types found"}
          />
          <MultiSelect
            size="xs"
            label="Event"
            placeholder={query.types.length === 0 ? "Any event" : undefined}
            clearable
            searchable
            w={260}
            data={eventTypeOptions}
            value={query.types}
            onChange={(value) => filter({ types: value })}
          />
          <Select
            size="xs"
            label="Rows"
            w={100}
            allowDeselect={false}
            data={["25", "50", "100"]}
            value={String(query.pageSize)}
            onChange={(value) =>
              filter({
                pageSize: Number(value ?? 50) as EventsLocationState["pageSize"],
              })
            }
          />
        </Group>
      </Paper>
      {/* Queue and task filters are matched against the job a history row points at. History
          outlives the job it describes, so rows whose job has already been retained away can only
          be reached with those filters cleared. */}
      {data.events.length === 0 ? (
        <EmptyState>
          Workhorse recorded no matching events in the last {query.window}. Retention limits
          available history: {retentionNote}.
        </EmptyState>
      ) : (
        <Paper withBorder>
          <ScrollArea>
            <Table highlightOnHover verticalSpacing={6} horizontalSpacing="md" miw={1100}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={150} style={{ whiteSpace: "nowrap" }}>
                    When
                  </Table.Th>
                  <Table.Th w={190} style={{ whiteSpace: "nowrap" }}>
                    Event
                  </Table.Th>
                  <Table.Th w={90} style={{ whiteSpace: "nowrap" }}>
                    ID
                  </Table.Th>
                  <Table.Th style={{ whiteSpace: "nowrap" }}>Task</Table.Th>
                  <Table.Th w={140} style={{ whiteSpace: "nowrap" }}>
                    Queue
                  </Table.Th>
                  <Table.Th w={80} ta="right" style={{ whiteSpace: "nowrap" }}>
                    Attempt
                  </Table.Th>
                  <Table.Th w={160} style={{ whiteSpace: "nowrap" }}>
                    Worker
                  </Table.Th>
                  <Table.Th w={110} ta="right" style={{ whiteSpace: "nowrap" }}>
                    Duration
                  </Table.Th>
                  <Table.Th w={280}>Detail</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data.events.map((event) => (
                  <EventRow key={event.id} event={event} inspectEvent={inspectEvent} />
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        </Paper>
      )}
      {totalPages > 1 ? (
        <Group justify="space-between" wrap="wrap" gap="xs">
          <Pagination
            value={Math.min(data.page, totalPages)}
            onChange={(page) => setQuery({ ...query, page, eventId: null })}
            total={totalPages}
            size="xs"
            aria-label="Events pagination"
          />
          {/* Pages are offsets into a list whose head keeps moving, so say so rather than let an
              operator wonder why a row they were reading moved down a page. */}
          {data.page > 1 ? (
            <Text c="dimmed" size="xs">
              When the dashboard refreshes, new events can move rows between pages.
            </Text>
          ) : null}
        </Group>
      ) : null}
      <Text c="dimmed" size="xs">
        This feed stays complete when notifications are missed because Workhorse reads durable
        history. Retention limits its depth: {retentionNote}. Open a task to see its complete
        timeline.
      </Text>
    </Stack>
  );
}

function EventRow({
  event,
  inspectEvent,
}: {
  event: DashboardEventRow;
  inspectEvent: (event: DashboardEventRow) => void;
}) {
  const detail = event.errorMessage ?? eventDetailSummary(event.details);
  return (
    <Table.Tr
      onClick={() => inspectEvent(event)}
      onKeyDown={(keyboardEvent) => {
        if (keyboardEvent.key === "Enter" || keyboardEvent.key === " ") {
          keyboardEvent.preventDefault();
          inspectEvent(event);
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={`Inspect ${event.type.replaceAll("_", " ")} event for ${event.jobType ?? event.jobId}`}
      style={{ cursor: "pointer" }}
    >
      <Table.Td style={{ whiteSpace: "nowrap" }}>
        <Tooltip label={formatExact(event.occurredAt)} withArrow>
          <Text size="sm">{formatRelative(event.occurredAt)}</Text>
        </Tooltip>
      </Table.Td>
      <Table.Td style={{ whiteSpace: "nowrap" }}>
        <Group gap={6} wrap="nowrap">
          <Badge color={eventTypeColor(event.type)} variant="light" style={{ flexShrink: 0 }}>
            {event.type.replaceAll("_", " ")}
          </Badge>
          {/* Which table the row came from is worth stating: an attempt row is a closed attempt
              with a measured duration, a lifecycle row is a transition the queue recorded. */}
          {event.kind === "attempt" ? (
            <Badge color="gray" variant="outline" size="xs" style={{ flexShrink: 0 }}>
              attempt
            </Badge>
          ) : null}
        </Group>
      </Table.Td>
      {/* The identifier is abbreviated to the prefix a person actually reads, with the whole value
          on the title so it stays copyable in full from the drawer the click opens. */}
      <Table.Td style={{ whiteSpace: "nowrap" }}>
        <Code
          fz="xs"
          c="blue"
          title={event.jobId}
          style={{
            background: "transparent",
            paddingBlock: 0,
            paddingInline: 0,
          }}
        >
          {event.jobId.slice(0, 8)}
        </Code>
      </Table.Td>
      <Table.Td style={{ whiteSpace: "nowrap" }}>
        <Text size="sm">{event.jobType ?? "—"}</Text>
      </Table.Td>
      <Table.Td style={{ whiteSpace: "nowrap" }}>
        <Text size="sm">
          {event.queue ?? (
            <Text component="span" c="dimmed" fz="xs">
              Task deleted
            </Text>
          )}
        </Text>
      </Table.Td>
      <Table.Td ta="right" style={{ whiteSpace: "nowrap" }}>
        <Text size="sm">{event.attempt ?? "—"}</Text>
      </Table.Td>
      <Table.Td style={{ whiteSpace: "nowrap", maxWidth: 160 }}>
        <Text size="sm" truncate>
          {event.workerId ?? "—"}
        </Text>
      </Table.Td>
      <Table.Td ta="right" style={{ whiteSpace: "nowrap" }}>
        <Text size="sm">{formatDuration(event.durationMs)}</Text>
      </Table.Td>
      <Table.Td style={{ maxWidth: 280 }}>
        {detail ? (
          <Tooltip label={detail} withArrow multiline maw={480}>
            <Text size="xs" c={event.errorMessage ? "red" : "dimmed"} truncate>
              {detail}
            </Text>
          </Tooltip>
        ) : (
          <Text c="dimmed" fz="xs">
            —
          </Text>
        )}
      </Table.Td>
    </Table.Tr>
  );
}

function EventDetails({ event }: { event: DashboardEventDetail }) {
  const fields: Array<[string, ReactNode]> = [
    ["Event", event.type.replaceAll("_", " ")],
    ["Source", event.kind === "event" ? "Lifecycle" : "Attempt history"],
    ["Occurred", formatExact(event.occurredAt)],
    ["Task", event.jobType ?? "Retained away"],
    ["Task ID", <Code key="job-id">{event.jobId}</Code>],
    ["Queue", event.queue ?? "Retained away"],
    ["Attempt", event.attempt ?? "—"],
    ["Worker", event.workerId ?? "—"],
    ["Fence token", event.fenceToken ?? "—"],
    ["Started", event.startedAt ? formatExact(event.startedAt) : "—"],
    ["Claimed", event.claimedAt ? formatExact(event.claimedAt) : "—"],
    ["Finished", event.finishedAt ? formatExact(event.finishedAt) : "—"],
    ["Duration", formatDuration(event.durationMs)],
    ["Record ID", <Code key="record-id">{event.recordId}</Code>],
  ];
  return (
    <Stack gap="lg">
      <Stack gap={8}>
        {fields.map(([label, value]) => (
          <Group key={label} justify="space-between" align="flex-start" wrap="nowrap">
            <Text c="dimmed" size="sm">
              {label}
            </Text>
            <Text component="div" size="sm" ta="right" style={{ overflowWrap: "anywhere" }}>
              {value}
            </Text>
          </Group>
        ))}
      </Stack>
      {event.error !== null ? (
        <JsonValue
          label="Error"
          value={event.error}
          emptyLabel="This attempt finished without an error."
          copyLabel="the attempt error"
        />
      ) : null}
      <JsonValue
        label="Details"
        value={event.details}
        emptyLabel="This event was recorded without details."
        copyLabel="the event details"
      />
    </Stack>
  );
}

function WorkersPage({
  data,
  togglingWorker,
  setWorkerPaused,
}: {
  data: DashboardWorkersPage;
  togglingWorker: string | null;
  setWorkerPaused: (workerId: string, paused: boolean) => void;
}) {
  return (
    <Stack gap="xl">
      <PageHeader
        title="Workers"
        description="See each worker's capacity, current claims, and recent attempt results."
      />
      {data.canManageWorkers ? (
        // Pause is easy to misread as a durable setting, so the surface that offers it says plainly
        // what it is scoped to. Operators should reach for queue pause when they mean "stop this
        // work" rather than "quiet this process".
        <Alert color="blue" variant="light" title="Pausing a worker affects only this process">
          A paused worker finishes active tasks but accepts no new ones. If the process restarts, it
          resumes automatically. If work must stay paused, pause the queue instead.
        </Alert>
      ) : null}
      {data.workers.length === 0 ? (
        <EmptyState>No worker has reported activity.</EmptyState>
      ) : (
        <Paper withBorder>
          <ScrollArea>
            <Table highlightOnHover verticalSpacing={6} horizontalSpacing="md" miw={1080}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Worker</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Claims</Table.Th>
                  <Table.Th ta="right">Busy slots</Table.Th>
                  <Table.Th ta="right">Active tasks</Table.Th>
                  <Table.Th ta="right">Attempts · 1h</Table.Th>
                  <Table.Th ta="right">Failures · 1h</Table.Th>
                  <Table.Th ta="right">Avg execution · 1h</Table.Th>
                  <Table.Th>Last seen</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data.workers.map((worker) => (
                  <Table.Tr key={worker.id}>
                    <Table.Td>
                      <Stack gap={2}>
                        <Code
                          fz="xs"
                          style={{
                            background: "transparent",
                            paddingBlock: 0,
                            paddingInline: 0,
                          }}
                        >
                          {worker.id}
                        </Code>
                        {/* Placement is reported separately from identity, so a worker with a
                            stable configured name still says which host and process it is. */}
                        {worker.hostname ? (
                          <Text c="dimmed" fz="xs">
                            {worker.hostname} · pid {worker.pid}
                          </Text>
                        ) : null}
                      </Stack>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={6} wrap="nowrap">
                        <StatusBadge state={worker.status} />
                        {worker.paused ? (
                          <Badge color="yellow" variant="light">
                            Paused
                          </Badge>
                        ) : null}
                        {worker.draining ? (
                          <Badge color="orange" variant="light">
                            Draining
                          </Badge>
                        ) : null}
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Tooltip
                        label="Worker controls are unavailable in read-only mode"
                        disabled={data.canManageWorkers}
                      >
                        <Box component="span" display="inline-block">
                          <Switch
                            size="sm"
                            checked={!worker.paused}
                            disabled={!data.canManageWorkers || togglingWorker === worker.id}
                            aria-label={`${worker.paused ? "Resume" : "Pause"} ${worker.id}`}
                            onChange={(event) =>
                              setWorkerPaused(worker.id, !event.currentTarget.checked)
                            }
                          />
                        </Box>
                      </Tooltip>
                    </Table.Td>
                    <Table.Td
                      ta="right"
                      // The compact "2 / 3" reading is ambiguous out of column context, so the cell
                      // carries the spelled-out meaning for assistive technology.
                      aria-label={
                        worker.concurrency === null
                          ? `${worker.id} slot use is unknown because it has never registered`
                          : `${worker.id} is using ${worker.activeSlots ?? 0} of ${worker.concurrency} configured execution slots`
                      }
                    >
                      {worker.concurrency === null ? (
                        <Text
                          c="dimmed"
                          size="sm"
                          title="This worker has never registered, so its declared capacity is unknown"
                        >
                          —
                        </Text>
                      ) : (
                        <Text
                          size="sm"
                          title={`${worker.id} uses ${worker.activeSlots ?? 0} of ${worker.concurrency} execution slots`}
                        >
                          {worker.activeSlots ?? 0} / {worker.concurrency}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td ta="right">{worker.activeJobs}</Table.Td>
                    <Table.Td ta="right">{worker.completedAttempts}</Table.Td>
                    <Table.Td ta="right">
                      <Text c={worker.failedAttempts > 0 ? "red.7" : undefined} size="sm">
                        {worker.failedAttempts}
                      </Text>
                    </Table.Td>
                    <Table.Td ta="right">{formatDuration(worker.averageExecutionMs)}</Table.Td>
                    <Table.Td>
                      <Text c="dimmed" size="xs" title={formatExact(worker.lastSeenAt)}>
                        {formatRelative(worker.lastSeenAt)}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        </Paper>
      )}
      <Text c="dimmed" size="xs">
        This page covers the whole fleet because workers register in PostgreSQL. A worker reports
        busy slots, while PostgreSQL counts active tasks, so the values can differ briefly. Startup
        sets capacity, and the dashboard cannot change it. A draining worker stops after its active
        handlers finish. If a worker stops registering, Workhorse marks it offline and later removes
        it from the fleet.
      </Text>
    </Stack>
  );
}

/** Common timezones plus the browser default; stored values are IANA zone names. */
const timeZoneOptions: Array<{ value: string; label: string }> = [
  {
    value: "system",
    label: `System (${Intl.DateTimeFormat().resolvedOptions().timeZone})`,
  },
  { value: "UTC", label: "UTC" },
  { value: "America/New_York", label: "America/New_York" },
  { value: "America/Chicago", label: "America/Chicago" },
  { value: "America/Denver", label: "America/Denver" },
  { value: "America/Los_Angeles", label: "America/Los_Angeles" },
  { value: "Europe/London", label: "Europe/London" },
  { value: "Europe/Berlin", label: "Europe/Berlin" },
  { value: "Europe/Kyiv", label: "Europe/Kyiv" },
  { value: "Asia/Dubai", label: "Asia/Dubai" },
  { value: "Asia/Kolkata", label: "Asia/Kolkata" },
  { value: "Asia/Singapore", label: "Asia/Singapore" },
  { value: "Asia/Tokyo", label: "Asia/Tokyo" },
  { value: "Australia/Sydney", label: "Australia/Sydney" },
];

const supportedMaintenanceTimeZoneOptions = Array.from(
  new Set([
    "UTC",
    ...(typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : timeZoneOptions.filter(({ value }) => value !== "system").map(({ value }) => value)),
  ]),
).map((value) => ({ value, label: value }));

export interface SettingsPageProps {
  data: DashboardSettingsPage;
  saving: boolean;
  onSaveMaintenance(definition: Partial<MaintenancePolicyDefinition>): Promise<void>;
  onRevertMaintenance(setting: MaintenancePolicySetting): Promise<void>;
  onDirtyChange(dirty: boolean): void;
}

function OperatorOverride({
  revert,
  disabled = false,
}: {
  revert?: () => void;
  disabled?: boolean;
}) {
  return (
    <Group gap="xs">
      <Badge color="violet" variant="light">
        Operator override
      </Badge>
      {revert ? (
        <Button
          size="compact-xs"
          variant="subtle"
          disabled={disabled}
          title={disabled ? "Save or discard this section's changes before reverting" : undefined}
          onClick={revert}
        >
          Revert
        </Button>
      ) : null}
    </Group>
  );
}

type RetentionField = {
  key: RetentionPolicySetting;
  label: string;
  suffix: string;
};

const retentionWindowFields: RetentionField[] = [
  { key: "jobIdentityRetentionDays", label: "Task identity", suffix: " days" },
  {
    key: "terminalOutcomeRetentionDays",
    label: "Finished outcomes",
    suffix: " days",
  },
  { key: "jobEventRetentionDays", label: "Task events", suffix: " days" },
  {
    key: "attemptHistoryRetentionDays",
    label: "Attempt history",
    suffix: " days",
  },
  {
    key: "scheduleOccurrenceRetentionDays",
    label: "Schedule occurrences",
    suffix: " days",
  },
  {
    key: "statisticsRetentionDays",
    label: "Rolling statistics",
    suffix: " days",
  },
];

const retentionCleanupFields: RetentionField[] = [
  {
    key: "terminalJobPruneLimit",
    label: "Finished tasks per cleanup pass",
    suffix: " rows",
  },
  {
    key: "historyPartitionsPerPass",
    label: "History partitions per pass",
    suffix: " partitions",
  },
  {
    key: "defaultPartitionRowsPerPass",
    label: "Fallback history rows per pass",
    suffix: " rows",
  },
  {
    key: "occurrenceRowsPerPass",
    label: "Schedule occurrences per pass",
    suffix: " rows",
  },
  {
    key: "statisticsRowsPerPass",
    label: "Statistics rows per pass",
    suffix: " rows",
  },
];

function formatMaintenanceInterval(milliseconds: number): string {
  const day = 24 * 60 * 60_000;
  const hour = 60 * 60_000;
  if (milliseconds % day === 0) {
    const days = milliseconds / day;
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  if (milliseconds % hour === 0) {
    const hours = milliseconds / hour;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  if (milliseconds % 60_000 === 0) {
    const minutes = milliseconds / 60_000;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return formatDuration(milliseconds);
}

function formatRetentionDefault(value: number | null, suffix: string): string {
  return value === null ? "indefinitely" : `${value.toLocaleString()}${suffix}`;
}

export function SettingsPage({
  data,
  saving,
  onSaveMaintenance,
  onRevertMaintenance,
  onDirtyChange,
}: SettingsPageProps) {
  const [timeZone, setTimeZone] = useState(currentTimeZoneValue);
  const [maintenance, setMaintenance] = useState(() => ({
    timezone: data.maintenance.timezone,
    historyRetentionLocalTime: data.maintenance.historyRetentionLocalTime,
  }));
  const changeTimeZone = (value: string | null) => {
    const next = value ?? "system";
    setDisplayTimeZone(next === "system" ? null : next);
    setTimeZone(next);
  };
  const maintenanceChanges: Partial<MaintenancePolicyDefinition> = {};
  if (maintenance.timezone !== data.maintenance.timezone)
    maintenanceChanges.timezone = maintenance.timezone;
  if (maintenance.historyRetentionLocalTime !== data.maintenance.historyRetentionLocalTime) {
    maintenanceChanges.historyRetentionLocalTime = maintenance.historyRetentionLocalTime;
  }
  const maintenanceChanged = Object.keys(maintenanceChanges).length > 0;
  useLayoutEffect(() => onDirtyChange(maintenanceChanged), [maintenanceChanged, onDirtyChange]);
  useLayoutEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => {
    setMaintenance({
      timezone: data.maintenance.timezone,
      historyRetentionLocalTime: data.maintenance.historyRetentionLocalTime,
    });
  }, [data]);
  const maintenanceTimeZoneOptions = supportedMaintenanceTimeZoneOptions.concat(
    supportedMaintenanceTimeZoneOptions.some(({ value }) => value === maintenance.timezone)
      ? []
      : [{ value: maintenance.timezone, label: maintenance.timezone }],
  );
  const now = new Date().toISOString();
  const retentionPolicyRows = (fields: RetentionField[]) =>
    fields.map(({ key, label, suffix }) => (
      <Table.Tr key={key}>
        <Table.Td>
          <Text size="sm" fw={500}>
            {label}
          </Text>
        </Table.Td>
        <Table.Td w={180}>
          <Text size="sm">Effective: {formatRetentionDefault(data.retention[key], suffix)}</Text>
        </Table.Td>
        <Table.Td w={220}>
          <Stack gap={4} align="flex-start">
            <Text c="dimmed" size="xs">
              Default:{" "}
              {formatRetentionDefault(data.retention.provenance[key].applicationDefault, suffix)}
            </Text>
            {data.retention.provenance[key].source === "operator" ? (
              <Badge color="violet" variant="light">
                Operator override
              </Badge>
            ) : null}
          </Stack>
        </Table.Td>
      </Table.Tr>
    ));
  return (
    <Stack gap="xl">
      <PageHeader
        title="Settings"
        description="Manage this browser's display preferences and review Workhorse configuration."
      />
      <Paper withBorder p="lg" maw={480}>
        <Stack gap="sm">
          <Box>
            <Text fw={650}>Your preferences</Text>
            <Text c="dimmed" size="sm">
              These settings affect only this browser.
            </Text>
          </Box>
          <Select
            label="Browser display timezone"
            description="Changes how timestamps appear. Workhorse stores every timestamp in UTC."
            value={timeZone}
            onChange={changeTimeZone}
            data={timeZoneOptions}
            searchable
            allowDeselect={false}
          />
          <Text c="dimmed" size="xs">
            Now: {formatExact(now)}
          </Text>
        </Stack>
      </Paper>
      <Box>
        <Text fw={650} size="lg">
          Workhorse settings
        </Text>
        <Text c="dimmed" size="sm">
          These values control database-wide policy or report configuration from running workers.
        </Text>
      </Box>
      <Paper withBorder p="lg">
        <Stack gap="md">
          <Box>
            <Text fw={650}>Database-wide settings</Text>
            <Text c="dimmed" size="sm">
              Maintenance schedule changes apply to every worker. Retention and cleanup policy
              values are shown here for diagnosis.
            </Text>
          </Box>
          {!data.editable ? (
            <Alert color="yellow" title="Read-only dashboard">
              The connected host did not authorize settings changes.
            </Alert>
          ) : null}
          <Box>
            <Text fw={600}>Maintenance schedule</Text>
            <Text c="dimmed" size="xs">
              Choose when database-wide cleanup runs. These settings apply once across the fleet,
              regardless of how many workers are active.
            </Text>
          </Box>
          <Grid>
            <Grid.Col span={{ base: 12, md: 6 }}>
              <Stack gap={4} align="stretch">
                <Select
                  label="Maintenance timezone"
                  description={`Controls the local date and daylight-saving rules used by daily retention. Default: ${data.maintenance.provenance.timezone.applicationDefault}.`}
                  value={maintenance.timezone}
                  data={maintenanceTimeZoneOptions}
                  searchable
                  allowDeselect={false}
                  disabled={!data.editable}
                  onChange={(value) =>
                    value &&
                    setMaintenance((current) => ({
                      ...current,
                      timezone: value,
                    }))
                  }
                />
                {data.maintenance.provenance.timezone.source === "operator" ? (
                  <Box>
                    <OperatorOverride
                      disabled={maintenanceChanged}
                      revert={
                        data.editable ? () => void onRevertMaintenance("timezone") : undefined
                      }
                    />
                  </Box>
                ) : null}
              </Stack>
            </Grid.Col>
            <Grid.Col span={{ base: 12, md: 6 }}>
              <TextInput
                type="time"
                label="Daily retention time"
                description={`Runs once per local date in ${maintenance.timezone || "the selected timezone"}. Default: ${data.maintenance.provenance.historyRetentionLocalTime.applicationDefault}.`}
                value={maintenance.historyRetentionLocalTime}
                disabled={!data.editable}
                onChange={(event) =>
                  setMaintenance((current) => ({
                    ...current,
                    historyRetentionLocalTime: event.currentTarget.value,
                  }))
                }
                rightSection={
                  data.maintenance.provenance.historyRetentionLocalTime.source === "operator" ? (
                    <OperatorOverride
                      disabled={maintenanceChanged}
                      revert={
                        data.editable
                          ? () => void onRevertMaintenance("historyRetentionLocalTime")
                          : undefined
                      }
                    />
                  ) : undefined
                }
                rightSectionWidth={190}
              />
            </Grid.Col>
          </Grid>
          <Accordion variant="contained">
            <Accordion.Item value="advanced-maintenance">
              <Accordion.Control>
                <Text fw={600} size="sm">
                  Advanced maintenance
                </Text>
                <Text c="dimmed" size="xs">
                  Review the internal cadences Workhorse uses to prepare storage and remove finished
                  tasks.
                </Text>
              </Accordion.Control>
              <Accordion.Panel>
                <Grid>
                  {[
                    {
                      label: "Partition preparation interval",
                      description:
                        "How often Workhorse checks that upcoming history partitions exist.",
                      effective: data.maintenance.partitionPreparationIntervalMs,
                      provenance: data.maintenance.provenance.partitionPreparationIntervalMs,
                    },
                    {
                      label: "Terminal cleanup interval",
                      description:
                        "How often Workhorse removes finished tasks after their retention windows elapse.",
                      effective: data.maintenance.terminalCleanupIntervalMs,
                      provenance: data.maintenance.provenance.terminalCleanupIntervalMs,
                    },
                  ].map((setting) => (
                    <Grid.Col key={setting.label} span={{ base: 12, md: 6 }}>
                      <Stack gap={4}>
                        <Text fw={500} size="sm">
                          {setting.label}
                        </Text>
                        <Text c="dimmed" size="xs">
                          {setting.description}
                        </Text>
                        <Text size="sm">
                          Effective: {formatMaintenanceInterval(setting.effective)}
                        </Text>
                        <Text c="dimmed" size="xs">
                          Default:{" "}
                          {formatMaintenanceInterval(setting.provenance.applicationDefault)}
                        </Text>
                        {setting.provenance.source === "operator" ? (
                          <Box>
                            <Badge color="violet" variant="light">
                              Operator override
                            </Badge>
                          </Box>
                        ) : null}
                      </Stack>
                    </Grid.Col>
                  ))}
                </Grid>
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion>
          <Group justify="flex-end">
            <Button
              disabled={!data.editable || !maintenanceChanged}
              loading={saving}
              onClick={() => void onSaveMaintenance(maintenanceChanges)}
            >
              Save maintenance policy
            </Button>
          </Group>
          <Divider />
          <Box>
            <Text fw={600}>Retention windows</Text>
            <Text c="dimmed" size="xs">
              These effective values are read-only here because shortening them can permanently
              delete stored history.
            </Text>
          </Box>
          <Table verticalSpacing="sm">
            <Table.Tbody>{retentionPolicyRows(retentionWindowFields)}</Table.Tbody>
          </Table>
          <Divider />
          <Box>
            <Text fw={600}>Cleanup limits</Text>
            <Text c="dimmed" size="xs">
              These read-only limits cap how much work each cleanup pass can perform. Lower limits
              reduce database load, but large backlogs take longer to clear.
            </Text>
          </Box>
          <Table verticalSpacing="sm">
            <Table.Tbody>{retentionPolicyRows(retentionCleanupFields)}</Table.Tbody>
          </Table>
        </Stack>
      </Paper>
      <Paper withBorder p="lg">
        <Stack gap="md">
          <Box>
            <Text fw={650}>Set at deploy</Text>
            <Text c="dimmed" size="sm">
              Workers report these process-owned values. Change them in worker configuration and
              deploy again.
            </Text>
          </Box>
          {data.workers.length === 0 ? (
            <Text c="dimmed" size="sm">
              No live workers are reporting deployment settings.
            </Text>
          ) : (
            <Table.ScrollContainer minWidth={900}>
              <Table>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Worker</Table.Th>
                    <Table.Th>Queue</Table.Th>
                    <Table.Th>Concurrency</Table.Th>
                    <Table.Th>Lease</Table.Th>
                    <Table.Th>Heartbeat</Table.Th>
                    <Table.Th>Poll</Table.Th>
                    <Table.Th>Maintenance loop</Table.Th>
                    <Table.Th>Maintenance checks</Table.Th>
                    <Table.Th>Registry refresh</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {data.workers.map((worker) => (
                    <Table.Tr key={worker.id}>
                      <Table.Td>{worker.id}</Table.Td>
                      <Table.Td>{worker.queue}</Table.Td>
                      <Table.Td>{worker.concurrency}</Table.Td>
                      <Table.Td>{formatDuration(worker.leaseMs)} lease</Table.Td>
                      <Table.Td>{formatDuration(worker.heartbeatMs)}</Table.Td>
                      <Table.Td>{formatDuration(worker.pollMs)}</Table.Td>
                      <Table.Td>{formatDuration(worker.maintenanceIntervalMs)}</Table.Td>
                      <Table.Td>{formatDuration(worker.maintenanceTaskPollMs)}</Table.Td>
                      <Table.Td>{formatDuration(worker.registryIntervalMs)}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
        </Stack>
      </Paper>
    </Stack>
  );
}

const refreshStorageKey = "workhorse-auto-refresh";

function readStoredRefreshInterval(): DashboardRefreshIntervalValue {
  const stored = localStorage.getItem(refreshStorageKey);
  return dashboardRefreshIntervals.some((option) => option.value === stored)
    ? (stored as DashboardRefreshIntervalValue)
    : defaultDashboardRefreshInterval;
}

function routeTitle(route: PageRoute): string {
  if (route === "/events") return "events";
  if (route === "/cron") return "schedules";
  if (route === "/queues") return "queues";
  if (route === "/system") return "system health";
  if (route === "/workers") return "workers";
  if (route === "/settings") return "settings";
  return "current tasks";
}

function useDashboardController(
  auditActor: string,
  demoTools: DashboardDemoTools | null,
  basePath: string,
) {
  const client = useDashboardClient();
  const [navbarOpened, { toggle: toggleNavbar, close: closeNavbar }] = useDisclosure();
  // Timestamps format through module-level displayTimeZone; re-render everything on change.
  const [, setTimeZoneTick] = useState(0);
  useEffect(() => subscribeTimeZone(() => setTimeZoneTick((tick) => tick + 1)), []);
  const [location, setLocation] = useState(() => readLocation(basePath));
  const [loadState, setLoadState] = useState<LoadState>({
    status: "loading",
    data: null,
    error: null,
  });
  const [taskCounts, setTaskCounts] = useState<DashboardTaskCounts | null>(null);
  const [environment, setEnvironment] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void client
      .meta()
      .then((meta) => {
        if (!cancelled) setEnvironment(meta.environment);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client]);
  const [runningDemoJob, setRunningDemoJob] = useState<DemoJobKind | null>(null);
  const [togglingSchedule, setTogglingSchedule] = useState<string | null>(null);
  const [togglingQueue, setTogglingQueue] = useState<string | null>(null);
  const [purgingQueue, setPurgingQueue] = useState<string | null>(null);
  const [confirmingQueue, setConfirmingQueue] = useState<string | null>(null);
  const [togglingWorker, setTogglingWorker] = useState<string | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const settingsDirtyRef = useRef(false);
  const changeSettingsDirty = useCallback((dirty: boolean) => {
    settingsDirtyRef.current = dirty;
    setSettingsDirty(dirty);
  }, []);
  /**
   * The open task is read from the URL rather than held beside it, so a copied or reloaded link
   * restores the same list and the same open drawer, and Back/Forward can only ever agree with
   * what is on screen.
   */
  const selectedJobId = location.route === "/tasks" ? location.taskId : null;
  const selectedEventId = location.route === "/events" ? location.events.eventId : null;
  const [inspectedEvent, setInspectedEvent] = useState<DashboardEventDetail | null>(null);
  const [eventDetailError, setEventDetailError] = useState<string | null>(null);
  const eventDetailRequests = useRef(createLatestRequestGuard());
  const selectedEventIdRef = useRef<string | null>(null);
  const [selectedJob, setSelectedJob] = useState<DashboardJobDetail | null>(null);
  const [jobDetailError, setJobDetailError] = useState<string | null>(null);
  /**
   * Which task detail load may still write to the drawer.
   *
   * Clicking task A then task B leaves two requests racing for the same panel, and the slower
   * one is not necessarily the older one, so the drawer only accepts the newest claim.
   */
  const jobDetailRequests = useRef(createLatestRequestGuard());
  /**
   * The task the drawer is showing right now, readable from an async callback.
   *
   * `selectedJobId` is what renders, but a callback that awaited the server closed over the
   * value from the render that started it, which is exactly the stale answer these guards must
   * not trust. This ref is written at the same moment the selection changes.
   */
  const selectedJobIdRef = useRef<string | null>(null);
  /**
   * The task a row's action menu asked to cancel, consumed once the drawer opens on it.
   *
   * Held outside the URL so the armed confirmation belongs to this operator's click and cannot be
   * shared, reloaded, or reached with Back.
   */
  const armCancelForJobId = useRef<string | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelingJobId, setCancelingJobId] = useState<string | null>(null);
  const [refreshInterval, setRefreshInterval] =
    useState<DashboardRefreshIntervalValue>(readStoredRefreshInterval);
  const eventsQuery = location.events;
  const [systemWindow, setSystemWindow] = useState<DashboardSystemWindow>(() => {
    const initial = readLocation(basePath);
    return initial.route === "/system" &&
      systemWindows.includes(initial.period as DashboardSystemWindow)
      ? (initial.period as DashboardSystemWindow)
      : readStoredSystemWindow();
  });
  const changeSystemWindow = useCallback(
    (nextWindow: DashboardSystemWindow) => {
      setSystemWindow(nextWindow);
      localStorage.setItem(systemWindowStorageKey, nextWindow);
      const parameters = new URLSearchParams(window.location.search);
      if (nextWindow === "1h") parameters.delete("period");
      else parameters.set("period", nextWindow);
      const query = parameters.toString();
      const href = query ? `/system?${query}` : "/system";
      window.history.pushState(null, "", mountedHref(basePath, href));
      setLocation(readLocation(basePath));
    },
    [basePath],
  );
  const changeRefreshInterval = useCallback((value: DashboardRefreshIntervalValue) => {
    setRefreshInterval(value);
    localStorage.setItem(refreshStorageKey, value);
  }, []);
  const requestId = useRef(0);

  const navigate = useCallback(
    (href: string) => {
      window.history.pushState(null, "", mountedHref(basePath, href));
      setLocation(readLocation(basePath));
      closeNavbar();
    },
    [basePath, closeNavbar],
  );
  const replace = useCallback(
    (href: string) => {
      window.history.replaceState(null, "", mountedHref(basePath, href));
      setLocation(readLocation(basePath));
    },
    [basePath],
  );
  const setEventsQuery = useCallback(
    (next: EventsLocationState) => navigate(eventsLocationHref(next)),
    [navigate],
  );

  const handleLink = useCallback(
    (event: MouseEvent<HTMLElement>, href: string) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      event.preventDefault();
      navigate(href);
    },
    [navigate],
  );

  /**
   * What the task listing request is made of, separated from the rest of the location.
   *
   * Opening, switching, and closing the drawer all rewrite the URL, and the list behind the
   * panel must not refetch or flash a loader for any of them, so the page load is keyed on the
   * listing parameters instead of on the location object.
   */
  const { route } = location;
  const listingKey = taskListingKey(location);
  const listingRef = useRef(location);
  listingRef.current = location;
  // The events feed follows the same shape as the task listing: the request is keyed on a
  // serialized copy of the filters, and the values themselves are read from a ref at send time.
  const eventsKey = eventsListingKey(eventsQuery);
  const eventsRef = useRef(eventsQuery);
  eventsRef.current = eventsQuery;

  const loadPage = useCallback(
    async ({ background = false }: { background?: boolean } = {}) => {
      if (
        discardBackgroundSettingsRefresh(
          background,
          route === "/settings",
          settingsDirtyRef.current,
        )
      ) {
        return;
      }
      const activeRequest = ++requestId.current;
      setLoadState((current) => ({
        status: "loading",
        data: current.data,
        error: null,
      }));
      try {
        let data: PageData;
        if (route === "/tasks") {
          const listing = listingRef.current;
          data = {
            route: "/tasks",
            value: await client.tasks({
              filter: listing.filter,
              queue: listing.queue,
              worker: listing.worker,
              jobType: listing.jobType,
              tags: listing.tags,
              search: listing.search ?? undefined,
              page: listing.page,
              pageSize: listing.pageSize,
            }),
          };
        } else if (route === "/events") {
          const events = eventsRef.current;
          data = {
            route: "/events",
            value: await client.events({
              window: events.window,
              page: events.page,
              pageSize: events.pageSize,
              kind: events.kind,
              queue: events.queue,
              jobType: events.jobType,
              types: events.types,
            }),
          };
        } else if (route === "/cron") {
          data = { route: "/cron", value: await client.cron() };
        } else if (route === "/queues") {
          data = { route: "/queues", value: await client.queues() };
        } else if (route === "/system") {
          data = {
            route: "/system",
            value: await client.system({ window: systemWindow }),
          };
        } else if (route === "/settings") {
          data = { route: "/settings", value: await client.settings() };
        } else {
          data = {
            route: "/workers",
            value: await client.workers(),
          };
        }
        if (activeRequest === requestId.current) {
          if (
            discardBackgroundSettingsRefresh(
              background,
              data.route === "/settings",
              settingsDirtyRef.current,
            )
          ) {
            setLoadState((current) =>
              current.data ? { status: "ready", data: current.data, error: null } : current,
            );
          } else {
            if (data.route === "/tasks") setTaskCounts(data.value.counts);
            setLoadState({ status: "ready", data, error: null });
          }
        }
      } catch (cause) {
        if (activeRequest === requestId.current) {
          if (
            discardBackgroundSettingsRefresh(
              background,
              route === "/settings",
              settingsDirtyRef.current,
            )
          ) {
            setLoadState((current) =>
              current.data ? { status: "ready", data: current.data, error: null } : current,
            );
          } else {
            setLoadState((current) => ({
              status: "error",
              data: current.data,
              error: cause instanceof Error ? cause.message : "Workhorse could not load this page",
            }));
          }
        }
      }
      // `listingKey` is the dependency the task listing actually has; the values themselves are
      // read from a ref so that a re-render for an unrelated reason cannot send a stale request.
    },
    [client, route, listingKey, systemWindow, eventsKey],
  );

  const loadTaskCounts = useCallback(async () => {
    try {
      setTaskCounts(await client.taskCounts());
    } catch {
      // The active page owns the connection state; keep the last navigation counts on failure.
    }
  }, [client]);

  const runDemoJob = useCallback(
    async (kind: DemoJobKind, scenario?: DurableDemoScenario) => {
      setRunningDemoJob(kind);
      try {
        if (!demoTools) return;
        await demoTools.enqueueTest({
          kind,
          ...(scenario ? { scenario } : {}),
          audit: {
            actor: auditActor,
            reason: `Demonstrate the ${scenario ?? kind} execution path`,
            requestId: crypto.randomUUID(),
          },
        });
        if (location.filter !== "all" || location.page !== 1) navigate("/tasks");
        await loadPage();
      } catch (cause) {
        notifyFailure("Demo task not enqueued", cause, "Workhorse could not enqueue the demo task");
      } finally {
        setRunningDemoJob(null);
      }
    },
    [auditActor, demoTools, loadPage, location.filter, location.page, navigate],
  );

  const toggleSchedule = useCallback(
    async (namespace: string, name: string, enabled: boolean) => {
      const scheduleKey = `${namespace}:${name}`;
      setTogglingSchedule(scheduleKey);
      try {
        await client.setScheduleEnabled({
          kind: "user",
          namespace,
          name,
          enabled,
          audit: {
            actor: auditActor,
            reason: `${enabled ? "Enable" : "Disable"} ${namespace}/${name} from the dashboard`,
            requestId: crypto.randomUUID(),
          },
        });
        notifyDashboard({
          title: enabled ? "Schedule enabled" : "Schedule disabled",
          message: enabled
            ? `${scheduleKey} fires again from its next occurrence.`
            : `${scheduleKey} stopped firing. Occurrences already enqueued are untouched.`,
          tone: "success",
        });
        await loadPage();
      } catch (cause) {
        notifyFailure("Schedule not updated", cause, "Workhorse could not update the schedule");
      } finally {
        setTogglingSchedule(null);
      }
    },
    [auditActor, client, loadPage],
  );

  const toggleQueue = useCallback(
    async (queue: string, paused: boolean) => {
      setTogglingQueue(queue);
      try {
        await client.setQueuePaused({
          queue,
          paused,
          audit: {
            actor: auditActor,
            reason: `${paused ? "Pause" : "Resume"} ${queue} from the dashboard`,
            requestId: crypto.randomUUID(),
          },
        });
        notifyDashboard({
          title: paused ? "Queue paused" : "Queue resumed",
          message: paused
            ? `${queue} stopped accepting tasks. Active tasks can finish.`
            : `${queue} is dispatching again.`,
          tone: "success",
        });
        await loadPage();
      } catch (cause) {
        notifyFailure("Queue not updated", cause, "Workhorse could not update the queue");
      } finally {
        setTogglingQueue(null);
      }
    },
    [auditActor, client, loadPage],
  );

  const clearQueue = useCallback(
    async (queue: string) => {
      setPurgingQueue(queue);
      try {
        const result = await client.purgeQueue({
          queue,
          audit: {
            actor: auditActor,
            reason: `Clear queued work from ${queue} from the dashboard`,
            requestId: crypto.randomUUID(),
          },
        });
        setConfirmingQueue(null);
        notifyDashboard({
          title: "Queue cleared",
          message: `Cleared ${result.deletedCount} queued ${
            result.deletedCount === 1 ? "task" : "tasks"
          } from ${queue}.`,
          tone: result.deletedCount > 0 ? "success" : "neutral",
        });
        await loadPage();
      } catch (cause) {
        notifyFailure("Queue not cleared", cause, "Workhorse could not clear the queue");
      } finally {
        setPurgingQueue(null);
      }
    },
    [auditActor, client, loadPage],
  );

  const toggleWorker = useCallback(
    async (workerId: string, paused: boolean) => {
      setTogglingWorker(workerId);
      try {
        await client.setWorkerPaused({
          workerId,
          paused,
          audit: {
            actor: auditActor,
            reason: `${paused ? "Pause" : "Resume"} ${workerId} from the dashboard`,
            requestId: crypto.randomUUID(),
          },
        });
        notifyDashboard({
          title: paused ? "Worker paused" : "Worker resumed",
          message: paused
            ? `${workerId} stopped accepting tasks but will finish active tasks. If the process restarts, it resumes automatically.`
            : `${workerId} is accepting tasks again.`,
          tone: "success",
        });
        await loadPage();
      } catch (cause) {
        notifyFailure("Worker not updated", cause, "Workhorse could not update the worker");
      } finally {
        setTogglingWorker(null);
      }
    },
    [auditActor, client, loadPage],
  );

  const saveMaintenanceSettings = useCallback(
    async (definition: Partial<MaintenancePolicyDefinition>) => {
      setSavingSettings(true);
      try {
        await client.overrideMaintenancePolicy({
          definition,
          audit: {
            actor: auditActor,
            reason: "Update maintenance policy from the dashboard",
            requestId: crypto.randomUUID(),
          },
        });
        notifyDashboard({
          title: "Maintenance policy updated",
          message: "Every worker now uses the database-owned policy.",
          tone: "success",
        });
        await loadPage();
      } catch (cause) {
        notifyFailure(
          "Maintenance policy not updated",
          cause,
          "Workhorse rejected the maintenance policy",
        );
      } finally {
        setSavingSettings(false);
      }
    },
    [auditActor, client, loadPage],
  );
  const revertMaintenanceSetting = useCallback(
    async (setting: MaintenancePolicySetting) => {
      try {
        await client.revertMaintenancePolicy({
          settings: [setting],
          audit: {
            actor: auditActor,
            reason: `Revert ${setting} to the application default`,
            requestId: crypto.randomUUID(),
          },
        });
        await loadPage();
      } catch (cause) {
        notifyFailure(
          "Setting not reverted",
          cause,
          "Workhorse could not restore the application default",
        );
      }
    },
    [auditActor, client, loadPage],
  );

  /**
   * Show one task in the drawer and load its detail.
   *
   * This is driven by the URL rather than called from the click handler, so a deep link, a
   * reload, and Back all reach the drawer through the same path as a click and cannot disagree
   * with the address bar.
   *
   * The one thing the address bar does not carry is whether the operator arrived by choosing
   * cancel in a row's action menu. That intent is held in a ref rather than the URL, because a
   * shared link should open a task, never open it with an irreversible action already confirmed.
   */
  const showJobDetail = useCallback(
    async (id: string) => {
      // Claim the drawer before the await, so a later click wins even if this request
      // resolves after it.
      const ticket = jobDetailRequests.current.begin();
      selectedJobIdRef.current = id;
      const armCancel = armCancelForJobId.current === id;
      armCancelForJobId.current = null;
      setSelectedJob(null);
      setJobDetailError(null);
      // Opening a different task must never inherit the previous task's confirmation.
      setConfirmingCancel(armCancel);
      setCancelReason("");
      try {
        const detail = await client.jobDetail({ id });
        if (!jobDetailRequests.current.current(ticket)) return;
        setSelectedJob(detail);
      } catch (cause) {
        if (!jobDetailRequests.current.current(ticket)) return;
        setJobDetailError(
          cause instanceof Error ? cause.message : "Workhorse could not load the task",
        );
      }
    },
    [client],
  );

  /**
   * Empty the drawer and abandon any detail load still in flight.
   *
   * Without dropping the claim, a request that arrives after the operator closed the panel would
   * set detail or an error and reopen it on a task they already dismissed.
   */
  const clearJobDetail = useCallback(() => {
    jobDetailRequests.current.cancel();
    selectedJobIdRef.current = null;
    setSelectedJob(null);
    setJobDetailError(null);
  }, []);

  /**
   * Move the open task into the address bar; the drawer follows from there.
   *
   * Writing the URL first, and letting one effect reconcile the drawer with it, is what makes
   * every route into the drawer behave alike: a click, a pasted link, a reload, and Back all end
   * as the same `task` parameter. Opening pushes so Back closes the panel, while swapping tasks
   * and closing replace, so history does not fill with every task the operator glanced at.
   */
  const selectTask = useCallback(
    (id: string | null) => {
      if (id === location.taskId) return;
      const href = taskHref({ ...location, taskId: id });
      if (taskDetailNavigation(location.taskId, id) === "push") navigate(href);
      else replace(href);
    },
    [location, navigate, replace],
  );

  /**
   * Open one task's drawer, optionally with its cancellation confirmation already armed.
   *
   * A row's action menu offers cancel this way rather than canceling in place, so the
   * irreversibility is still stated and the optional reason still reaches the audit trail.
   */
  const inspectJob = useCallback(
    (id: string, options: { confirmCancel?: boolean } = {}) => {
      armCancelForJobId.current = options.confirmCancel === true ? id : null;
      selectTask(id);
    },
    [selectTask],
  );
  const closeJobDetail = useCallback(() => selectTask(null), [selectTask]);
  const inspectEvent = useCallback(
    (event: DashboardEventRow) => {
      const next = { ...location.events, eventId: event.id };
      if (taskDetailNavigation(location.events.eventId, event.id) === "push") {
        navigate(eventsLocationHref(next));
      } else {
        replace(eventsLocationHref(next));
      }
    },
    [location.events, navigate, replace],
  );
  const closeEventDetail = useCallback(() => {
    eventDetailRequests.current.cancel();
    selectedEventIdRef.current = null;
    setInspectedEvent(null);
    setEventDetailError(null);
    replace(eventsLocationHref({ ...location.events, eventId: null }));
  }, [location.events, replace]);

  const showEventDetail = useCallback(
    async (id: string) => {
      const ticket = eventDetailRequests.current.begin();
      selectedEventIdRef.current = id;
      setInspectedEvent(null);
      setEventDetailError(null);
      try {
        const detail = await client.eventDetail({ id });
        if (eventDetailRequests.current.current(ticket)) setInspectedEvent(detail);
      } catch (cause) {
        if (!eventDetailRequests.current.current(ticket)) return;
        setEventDetailError(cause instanceof Error ? cause.message : "Unable to load the event");
      }
    },
    [client],
  );

  /**
   * The single reconciliation between the URL and the drawer.
   *
   * It runs for every way the address can change (click, deep link, reload, popstate) and does
   * nothing when the drawer already shows the requested task, so re-rendering for an unrelated
   * reason cannot restart a load or discard one in flight. Leaving the task list also closes the
   * drawer, because no other route carries a `task` parameter.
   *
   * It is a layout effect because the drawer contents would otherwise be one paint behind the
   * URL: clicking from task A to task B renders once with the new address and A's detail still
   * mounted, showing the operator A's payload, A's outcome, and A's cancel controls under B's
   * heading. Running before paint means no frame ever shows a task the URL no longer names.
   */
  useLayoutEffect(() => {
    const requested = location.route === "/tasks" ? location.taskId : null;
    const sync = taskDrawerSync(requested, selectedJobIdRef.current);
    if (sync === "close") clearJobDetail();
    else if (sync === "open") void showJobDetail(requested!);
  }, [location.route, location.taskId, clearJobDetail, showJobDetail]);

  useLayoutEffect(() => {
    const requested = location.route === "/events" ? location.events.eventId : null;
    const sync = taskDrawerSync(requested, selectedEventIdRef.current);
    if (sync === "close") {
      eventDetailRequests.current.cancel();
      selectedEventIdRef.current = null;
      setInspectedEvent(null);
      setEventDetailError(null);
    } else if (sync === "open") {
      void showEventDetail(requested!);
    }
  }, [location.route, location.events.eventId, showEventDetail]);

  /**
   * Request cancellation of one task and report exactly what PostgreSQL did.
   *
   * When the operator supplies a reason, it is sent as the audit reason and stored as the
   * cancellation reason, so the two can never disagree. The drawer is refreshed from the server afterwards
   * rather than optimistically edited, because whether an active task is now canceled or only
   * cancel-requested is a durable fact this dashboard does not get to guess.
   *
   * The request is sent regardless of what the operator does next, because a cancellation the
   * server accepted stays accepted. Only the drawer writes are conditional: once the operator has
   * moved to another task, this task's result, failure, and refreshed detail belong to a panel
   * that is no longer on screen, so reporting them there would attribute them to the wrong task.
   */
  const cancelTask = useCallback(
    async (id: string, reason: string) => {
      setCancelingJobId(id);
      try {
        const result = await client.cancelTask({
          id,
          audit: {
            actor: auditActor,
            reason: reason || null,
            requestId: crypto.randomUUID(),
          },
        });
        // Announced for the task that was canceled, not for whichever task the drawer now shows,
        // and offered as a link back to it so an operator who has moved on can still reach it.
        notifyCancel(
          { jobId: id, status: result.status, state: result.state },
          { openTask: inspectJob },
        );
        if (!cancelResultAppliesTo(id, selectedJobIdRef.current)) {
          // The task list still has to show the new state, even though the drawer moved on.
          await loadPage();
          return;
        }
        setConfirmingCancel(false);
        setCancelReason("");
        // Claim the drawer for this refresh, so a detail load started by a later click wins.
        const ticket = jobDetailRequests.current.begin();
        const detail = await client.jobDetail({ id }).catch(() => null);
        if (detail && jobDetailRequests.current.current(ticket)) setSelectedJob(detail);
        await loadPage();
      } catch (cause) {
        notifyFailure("Task not canceled", cause, "Workhorse could not cancel the task");
      } finally {
        // Clearing unconditionally would unstick a spinner this call never started, so only the
        // task whose cancellation is settling drops the pending flag.
        setCancelingJobId((pending) => clearPendingCancel(pending, id));
      }
    },
    [auditActor, client, inspectJob, loadPage],
  );

  /**
   * Release one scheduled task so a worker can claim it now.
   *
   * The reported status is exactly what the server did, so the list can distinguish a task that was
   * actually released from one that was already queued and from one refused because it is parked at
   * a durable wait. The list is reloaded afterwards rather than optimistically edited, because
   * whether the task is now ready is a durable fact this dashboard does not get to guess.
   *
   * Null when the host does not expose the mutation, which the row menu states as the reason the
   * action is unavailable rather than hiding the item.
   */
  const runTaskNow = useMemo(() => {
    if (!client.runTaskNow) return null;
    return async (id: string): Promise<RunNowFeedback> => {
      const feedback = await requestRunNow(client, {
        id,
        auditActor,
        requestId: crypto.randomUUID(),
      });
      // Reloaded on every outcome: a refusal is still a statement about durable state this list
      // should be showing, and a released task has already changed row.
      await loadPage();
      return feedback;
    };
  }, [auditActor, client, loadPage]);

  useEffect(() => {
    const onPopState = () => {
      const next = readLocation(basePath);
      setLocation(next);
      if (
        next.route === "/system" &&
        systemWindows.includes(next.period as DashboardSystemWindow)
      ) {
        setSystemWindow(next.period as DashboardSystemWindow);
      }
      closeNavbar();
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [closeNavbar]);

  useEffect(() => {
    void loadPage();
    if (location.route !== "/tasks") void loadTaskCounts();
  }, [loadPage, loadTaskCounts, location.route]);

  const autoRefreshPaused = location.route === "/settings" && settingsDirty;
  useEffect(() => {
    return startDashboardPolling(
      dashboardPollingIntervalMs(refreshInterval, autoRefreshPaused),
      () => {
        void loadPage({ background: true });
        if (location.route !== "/tasks") void loadTaskCounts();
      },
    );
  }, [autoRefreshPaused, refreshInterval, loadPage, loadTaskCounts, location.route]);

  const connected = loadState.status !== "error" && loadState.data !== null;
  const loading = loadState.status === "loading";
  const selectedEvent = inspectedEvent?.id === selectedEventId ? inspectedEvent : null;

  let content: ReactNode;
  if (loading && (!loadState.data || loadState.data.route !== location.route)) {
    content = (
      <Center mih="60vh">
        <Stack align="center" gap="sm">
          <Loader size="sm" />
          <Text c="dimmed" size="sm">
            Loading {routeTitle(location.route)}…
          </Text>
        </Stack>
      </Center>
    );
  } else if (loadState.status === "error") {
    content = (
      <Center mih="60vh">
        <Stack align="center" gap="sm">
          <WarningCircle size={28} color="var(--mantine-color-red-6)" />
          <Text fw={600}>Workhorse could not load this page.</Text>
          <Text c="dimmed" size="sm">
            {loadState.error}
          </Text>
          <Button variant="light" onClick={() => void loadPage()}>
            Try again
          </Button>
        </Stack>
      </Center>
    );
  } else if (loadState.data?.route === "/tasks") {
    content = (
      <TasksPage
        data={loadState.data.value}
        navigate={navigate}
        replace={replace}
        taskLocation={location}
        runDemoJob={demoTools ? runDemoJob : null}
        runningDemoJob={runningDemoJob}
        inspectJob={inspectJob}
        runTaskNow={runTaskNow}
      />
    );
  } else if (loadState.data?.route === "/events") {
    content = (
      <EventsPage
        data={loadState.data.value}
        query={eventsQuery}
        setQuery={setEventsQuery}
        inspectEvent={inspectEvent}
      />
    );
  } else if (loadState.data?.route === "/cron") {
    content = (
      <CronPage
        data={loadState.data.value}
        togglingSchedule={togglingSchedule}
        setScheduleEnabled={(namespace, name, enabled) =>
          void toggleSchedule(namespace, name, enabled)
        }
      />
    );
  } else if (loadState.data?.route === "/queues") {
    content = (
      <QueuesPage
        data={loadState.data.value}
        togglingQueue={togglingQueue}
        purgingQueue={purgingQueue}
        confirmingQueue={confirmingQueue}
        setQueuePaused={(queue, paused) => void toggleQueue(queue, paused)}
        setConfirmingQueue={setConfirmingQueue}
        purgeQueue={(queue) => void clearQueue(queue)}
      />
    );
  } else if (loadState.data?.route === "/system") {
    content = (
      <SystemPage data={loadState.data.value} setWindow={changeSystemWindow} navigate={navigate} />
    );
  } else if (loadState.data?.route === "/workers") {
    content = (
      <WorkersPage
        data={loadState.data.value}
        togglingWorker={togglingWorker}
        setWorkerPaused={(workerId, paused) => void toggleWorker(workerId, paused)}
      />
    );
  } else if (loadState.data?.route === "/settings") {
    content = (
      <SettingsPage
        data={loadState.data.value}
        saving={savingSettings}
        onSaveMaintenance={saveMaintenanceSettings}
        onRevertMaintenance={revertMaintenanceSetting}
        onDirtyChange={changeSettingsDirty}
      />
    );
  } else {
    content = null;
  }

  return {
    navbarOpened,
    toggleNavbar,
    environment,
    loadState,
    connected,
    loading,
    loadPage,
    refreshInterval,
    autoRefreshPaused,
    changeRefreshInterval,
    location,
    taskCounts,
    handleLink,
    content,
    selectedJobId,
    selectedEventId,
    selectedEvent,
    eventDetailError,
    selectedJob,
    jobDetailError,
    closeJobDetail,
    closeEventDetail,
    confirmingCancel,
    setConfirmingCancel,
    cancelReason,
    setCancelReason,
    cancelingJobId,
    cancelTask,
  };
}

function DashboardContent({
  auditActor,
  demoTools,
  basePath,
}: Required<Pick<DashboardProps, "auditActor">> & {
  demoTools: DashboardDemoTools | null;
  basePath: string;
}) {
  const controller = useDashboardController(auditActor, demoTools, basePath);
  const {
    navbarOpened,
    toggleNavbar,
    environment,
    loadState,
    connected,
    loading,
    loadPage,
    refreshInterval,
    autoRefreshPaused,
    changeRefreshInterval,
    location,
    taskCounts,
    handleLink,
    content,
    selectedJobId,
    selectedEventId,
    selectedEvent,
    eventDetailError,
    selectedJob,
    jobDetailError,
    closeJobDetail,
    closeEventDetail,
    confirmingCancel,
    setConfirmingCancel,
    cancelReason,
    setCancelReason,
    cancelingJobId,
    cancelTask,
  } = controller;

  return (
    <AppShell
      header={{ height: 64 }}
      navbar={{
        width: 256,
        breakpoint: "sm",
        collapsed: { mobile: !navbarOpened },
      }}
      padding={{ base: "md", sm: "xl" }}
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Burger
              opened={navbarOpened}
              onClick={toggleNavbar}
              hiddenFrom="sm"
              size="sm"
              aria-label="Open or close navigation"
            />
            <WorkhorseBrand />
          </Group>
          <Group gap="sm" wrap="nowrap">
            <ThemeSchemeSwitch />
            {environment ? (
              <Badge
                color={environmentColor(environment)}
                variant="light"
                visibleFrom="xs"
                title="Deployment environment from WORKHORSE_ENV"
              >
                {environment}
              </Badge>
            ) : null}
            <Badge
              color={loadState.status === "error" ? "red" : connected ? "teal" : "gray"}
              variant="light"
              leftSection={
                loadState.status === "error" ? (
                  <WarningCircle size={12} />
                ) : (
                  <CheckCircle size={12} />
                )
              }
              visibleFrom="xs"
            >
              {loadState.status === "error"
                ? "Disconnected"
                : connected
                  ? "Connected"
                  : "Connecting"}
            </Badge>
            <Group gap={0} wrap="nowrap">
              <Button
                variant="default"
                size="xs"
                leftSection={<ArrowClockwise size={14} />}
                loading={loading}
                onClick={() => void loadPage()}
                style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
              >
                Refresh
              </Button>
              <Menu position="bottom-end" withinPortal>
                <Menu.Target>
                  <Button
                    variant="default"
                    size="xs"
                    px={6}
                    style={{
                      borderTopLeftRadius: 0,
                      borderBottomLeftRadius: 0,
                      borderLeft: "none",
                    }}
                    aria-label={
                      autoRefreshPaused
                        ? "Auto refresh paused while settings have unsaved changes"
                        : "Auto refresh interval"
                    }
                  >
                    {autoRefreshPaused
                      ? "paused"
                      : refreshInterval === "off"
                        ? "manual"
                        : refreshInterval}
                  </Button>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Label>Auto refresh</Menu.Label>
                  {dashboardRefreshIntervals.map((option) => (
                    <Menu.Item
                      key={option.value}
                      onClick={() => changeRefreshInterval(option.value)}
                      rightSection={
                        refreshInterval === option.value ? <CheckCircle size={14} /> : null
                      }
                    >
                      {option.label}
                    </Menu.Item>
                  ))}
                </Menu.Dropdown>
              </Menu>
            </Group>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="md">
        <AppShell.Section grow component={ScrollArea}>
          <Stack gap={2}>
            <Text c="dimmed" fw={600} size="xs" px="sm" mb={4}>
              Tasks
            </Text>
            {taskFilters.map((filter) => {
              const href = taskHref({
                ...location,
                filter: filter.value,
                page: 1,
              });
              const count = taskCounts?.[filter.value];
              const Icon = filter.icon;
              return (
                <NavLink
                  key={filter.value}
                  component="a"
                  href={mountedHref(basePath, href)}
                  active={location.route === "/tasks" && location.filter === filter.value}
                  label={filter.label}
                  leftSection={<Icon size={18} />}
                  variant="light"
                  rightSection={
                    count === undefined ? null : (
                      <Badge variant="light" color="gray" miw={32}>
                        {count}
                      </Badge>
                    )
                  }
                  onClick={(event) => handleLink(event, href)}
                />
              );
            })}
          </Stack>
          <Divider my="sm" />
          <Stack gap={2}>
            <Text c="dimmed" fw={600} size="xs" px="sm" mb={4}>
              Operations
            </Text>
            <NavLink
              component="a"
              href={mountedHref(basePath, "/events")}
              active={location.route === "/events"}
              label="Events"
              leftSection={<Lightning size={18} />}
              variant="light"
              onClick={(event) => handleLink(event, "/events")}
            />
            <NavLink
              component="a"
              href={mountedHref(basePath, "/cron")}
              active={location.route === "/cron"}
              label="Schedules"
              leftSection={<CalendarDots size={18} />}
              variant="light"
              onClick={(event) => handleLink(event, "/cron")}
            />
            <NavLink
              component="a"
              href={mountedHref(basePath, "/queues")}
              active={location.route === "/queues"}
              label="Queues"
              leftSection={<ListDashes size={18} />}
              variant="light"
              onClick={(event) => handleLink(event, "/queues")}
            />
            <NavLink
              component="a"
              href={mountedHref(basePath, "/system")}
              active={location.route === "/system"}
              label="System health"
              leftSection={<Pulse size={18} />}
              variant="light"
              onClick={(event) => handleLink(event, "/system")}
            />
            <NavLink
              component="a"
              href={mountedHref(basePath, "/workers")}
              active={location.route === "/workers"}
              label="Workers"
              leftSection={<Robot size={18} />}
              variant="light"
              onClick={(event) => handleLink(event, "/workers")}
            />
            <NavLink
              component="a"
              href={mountedHref(basePath, "/settings")}
              active={location.route === "/settings"}
              label="Settings"
              leftSection={<GearSix size={18} />}
              variant="light"
              onClick={(event) => handleLink(event, "/settings")}
            />
          </Stack>
        </AppShell.Section>
      </AppShell.Navbar>

      <AppShell.Main>
        <Box w="100%">{content}</Box>
      </AppShell.Main>
      <Drawer
        opened={taskDrawerOpened(selectedJobId)}
        onClose={closeJobDetail}
        title={
          <Text component="h2" fw={600} size="lg" my={0}>
            Task details
          </Text>
        }
        position="right"
        size="lg"
        // The panel sits beside the task list instead of over it, so a row behind it stays
        // clickable and picking another task swaps the contents in place.
        {...taskDrawerModelessProps}
        classNames={{ content: "task-drawer__content" }}
      >
        {jobDetailError ? (
          <Text c="red" size="sm">
            {jobDetailError}
          </Text>
        ) : selectedJob ? (
          <Stack gap="lg">
            <Box>
              <Group justify="space-between">
                <Text fw={700}>{selectedJob.identity.type}</Text>
                <StatusBadge state={selectedJob.identity.state} />
              </Group>
              <Code fz="xs">{selectedJob.identity.id}</Code>
              <RetryPolicyLine job={selectedJob} />
              <TimingPolicyLine job={selectedJob} />
              <ConcurrencyPolicyLine job={selectedJob} />
            </Box>
            <Box>
              <JsonValue
                label="Input"
                value={selectedJob.payload}
                emptyLabel="This task was enqueued without input."
                copyLabel="the task input"
              />
            </Box>
            <TaskOutcome job={selectedJob} />
            <IdempotencySection job={selectedJob} />
            <CancelTaskPanel
              job={selectedJob}
              confirming={confirmingCancel}
              setConfirming={setConfirmingCancel}
              reason={cancelReason}
              setReason={setCancelReason}
              pending={cancelingJobId === selectedJob.identity.id}
              cancelTask={cancelTask}
            />
            <JobProgress job={selectedJob} />
            <JobCheckpoints job={selectedJob} />
            <DurableWaits job={selectedJob} />
            <Box>
              <Text fw={600} size="sm" mb="xs">
                Attempt history
              </Text>
              {selectedJob.attempts.length === 0 ? (
                <Text c="dimmed" size="sm">
                  No attempt has finished yet.
                </Text>
              ) : (
                <Stack gap="sm">
                  {selectedJob.attempts.map((attempt) => (
                    <Paper key={attempt.attempt} withBorder p="sm">
                      <Group justify="space-between">
                        <Text fw={600} size="sm">
                          Attempt {attempt.attempt}
                        </Text>
                        <StatusBadge state={attempt.outcome} />
                      </Group>
                      <Text c="dimmed" size="xs" mt={4} title={formatExact(attempt.startedAt)}>
                        {attempt.workerId} · executing {formatDuration(attempt.executionMs)} ·
                        elapsed {formatDuration(attempt.elapsedMs)}
                      </Text>
                      <Text c="dimmed" size="xs" title={formatExact(attempt.claimedAt)}>
                        Logical start {formatClock(attempt.startedAt)} · final claim{" "}
                        {formatClock(attempt.claimedAt)}
                      </Text>
                      {attempt.error ? (
                        <Code block mt="sm">
                          {JSON.stringify(attempt.error, null, 2)}
                        </Code>
                      ) : null}
                    </Paper>
                  ))}
                </Stack>
              )}
            </Box>
          </Stack>
        ) : (
          <Center mih={200}>
            <Loader size="sm" />
          </Center>
        )}
      </Drawer>
      <Drawer
        opened={selectedEventId !== null}
        onClose={closeEventDetail}
        title={
          <Text component="h2" fw={600} size="lg" my={0}>
            Event details
          </Text>
        }
        position="right"
        size="lg"
        {...taskDrawerModelessProps}
        classNames={{ content: "task-drawer__content" }}
      >
        {eventDetailError ? (
          <Text c="red" size="sm">
            {eventDetailError}
          </Text>
        ) : selectedEvent ? (
          <EventDetails event={selectedEvent} />
        ) : (
          <Center mih={200}>
            <Loader size="sm" />
          </Center>
        )}
      </Drawer>
    </AppShell>
  );
}

export interface DashboardProps {
  client: DashboardClient;
  /** Actor stored in audit metadata for mutations initiated by this dashboard. */
  auditActor?: string;
  /** Optional demo job seeding controls. Omit this in normal application dashboards. */
  demoTools?: DashboardDemoTools;
  /** URL namespace where the dashboard is mounted, for example `/workhorse`. */
  basePath?: string;
}

export function Dashboard({
  client,
  auditActor = "dashboard",
  demoTools = undefined,
  basePath: basePathInput = "",
}: DashboardProps) {
  const basePath = normalizeBasePath(basePathInput);
  return (
    <DashboardClientContext.Provider value={client}>
      <DashboardContent auditActor={auditActor} demoTools={demoTools ?? null} basePath={basePath} />
    </DashboardClientContext.Provider>
  );
}
