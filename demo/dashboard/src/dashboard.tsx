import {
  AppShell,
  Badge,
  Box,
  Burger,
  Button,
  Card,
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
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  ThemeIcon,
  Title,
  Tooltip,
} from "@mantine/core";
import { BarChart } from "@mantine/charts";
import { useDisclosure } from "@mantine/hooks";
import {
  ActivityIcon,
  ArrowCounterClockwise,
  ArrowClockwise,
  CalendarDots,
  CheckCircle,
  Clock,
  GearSix,
  ListDashes,
  ListChecks,
  MagnifyingGlass,
  PlayCircle,
  Pulse,
  Robot,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {
  DashboardCronPage,
  DashboardJobDetail,
  DashboardJobRow,
  DashboardQueuesPage,
  DashboardSystemPage,
  DashboardSystemRetryBucket,
  DashboardSystemWindow,
  DashboardTaskCounts,
  DashboardTaskFilter,
  DashboardTasksPage,
  DashboardWorkersPage,
} from "../../src/dashboard";
import { rpcClient } from "../lib/rpc";
import {
  parseTaskLocation,
  taskLocationHref,
  taskPageSizes,
  type TaskLocationState,
  type TaskPageSize,
} from "./task-location";

type ActivityPeriod = "15m" | "1h" | "6h" | "24h" | "7d";
const activityPeriods: ActivityPeriod[] = ["15m", "1h", "6h", "24h", "7d"];

const systemWindows: DashboardSystemWindow[] = ["15m", "1h", "24h"];
const systemWindowStorageKey = "workhorse-system-window";
// Demo defaults, make configurable later.
const systemOldestReadyWarningMs = 60_000;
const systemErrorRateWarning = 0.05;
const systemErrorRateCaution = 0.01;

function readStoredSystemWindow(): DashboardSystemWindow {
  const stored = localStorage.getItem(systemWindowStorageKey) as DashboardSystemWindow | null;
  return stored && systemWindows.includes(stored) ? stored : "1h";
}

type ActivityGroupBy = "queue" | "worker" | "task";
const activityGroupings: Array<{ value: ActivityGroupBy; label: string }> = [
  { value: "queue", label: "Queue" },
  { value: "worker", label: "Worker" },
  { value: "task", label: "Task" },
];

interface ActivityData {
  period: ActivityPeriod;
  groupBy: ActivityGroupBy;
  bucketSeconds: number;
  groups: string[];
  buckets: Array<{ bucketStart: string; counts: Record<string, number> }>;
}

const activitySeriesColors = [
  "teal.6",
  "indigo.6",
  "orange.6",
  "grape.6",
  "cyan.6",
  "lime.6",
  "red.6",
  "yellow.6",
  "blue.6",
  "pink.6",
];

// Recharts treats dots in dataKey as nested paths (task types like "demo.failure").
function activityChartKey(group: string): string {
  return group.replaceAll(".", "_");
}

type PageRoute = "/tasks" | "/cron" | "/queues" | "/system" | "/workers" | "/settings";
type DemoJobKind = "success" | "retry" | "failure" | "long-running";
type PageData =
  | { route: "/tasks"; value: DashboardTasksPage }
  | { route: "/cron"; value: DashboardCronPage }
  | { route: "/queues"; value: DashboardQueuesPage }
  | { route: "/system"; value: DashboardSystemPage }
  | { route: "/workers"; value: DashboardWorkersPage }
  | { route: "/settings"; value: null };
type LoadState =
  | { status: "loading"; data: PageData | null; error: null }
  | { status: "ready"; data: PageData; error: null }
  | { status: "error"; data: PageData | null; error: string };

const pageRoutes = new Set<PageRoute>([
  "/tasks",
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
];
const healthyStates = new Set(["succeeded", "ready", "active", "busy"]);
const failureStates = new Set(["failed", "discarded"]);
const warningStates = new Set(["scheduled", "retryable", "recent"]);

/** Header badge color for the deployment environment label. */
function environmentColor(environment: string): string {
  const normalized = environment.toLowerCase();
  if (normalized.startsWith("prod")) return "red";
  if (normalized.startsWith("stag")) return "orange";
  if (normalized.startsWith("test") || normalized === "ci") return "grape";
  return "blue";
}

function readLocation(): {
  route: PageRoute;
} & TaskLocationState {
  const route = pageRoutes.has(window.location.pathname as PageRoute)
    ? (window.location.pathname as PageRoute)
    : "/tasks";
  const storedPeriod = localStorage.getItem("workhorse-activity-period") as ActivityPeriod | null;
  const storedGroup = localStorage.getItem("workhorse-activity-group") as ActivityGroupBy | null;
  return {
    route,
    ...parseTaskLocation(window.location.search, {
      period: storedPeriod && activityPeriods.includes(storedPeriod) ? storedPeriod : "1h",
      group:
        storedGroup && activityGroupings.some(({ value }) => value === storedGroup)
          ? storedGroup
          : "queue",
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
let displayTimeZone: string | null = readStoredTimeZone();
const timeZoneListeners = new Set<() => void>();

function readStoredTimeZone(): string | null {
  const stored = localStorage.getItem(timeZoneStorageKey);
  if (!stored || stored === "system") return null;
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: stored }).resolvedOptions().timeZone;
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
  return new Intl.DateTimeFormat(undefined, {
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

/** Trim a `queue.` prefix from a task type since the queue has its own column. */
function taskDisplayName(type: string, queue: string): string {
  return type.startsWith(`${queue}.`) ? type.slice(queue.length + 1) : type;
}

function statusColor(state: string): string {
  if (healthyStates.has(state)) return "teal";
  if (failureStates.has(state) || state === "unhealthy" || state === "offline") return "red";
  if (warningStates.has(state)) return "yellow";
  return "gray";
}

function StatusBadge({ state }: { state: string }) {
  return (
    <Badge color={statusColor(state)} variant="light" tt="capitalize">
      {state}
    </Badge>
  );
}

/** One-line, state-specific context so a row explains itself without opening the drawer. */
function TaskStatusDetail({ job }: { job: DashboardJobRow }) {
  let detail: string | null = null;
  let exactTime: string | null = null;
  if (job.state === "scheduled" && job.runAt) {
    detail = `runs ${formatRelative(job.runAt)}`;
    exactTime = formatExact(job.runAt);
  } else if (job.state === "active" && job.workerId) detail = `on ${job.workerId}`;
  else if (job.state === "failed" && job.errorMessage) detail = job.errorMessage;
  else if (job.state === "succeeded" && job.finishedAt) {
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
          <Text fw={600}>Nothing to show</Text>
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
      : "queue";
    localStorage.setItem("workhorse-activity-group", next);
    updateLocation({ group: next });
  };

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      void rpcClient.dashboard
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
  }, [filter, period, groupBy, tags, queue, worker]);

  const labelFormat = (value: string): string => {
    const date = new Date(value);
    if (period === "7d" || period === "24h") {
      return new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        timeZone: displayTimeZone ?? undefined,
      }).format(date);
    }
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: displayTimeZone ?? undefined,
    }).format(date);
  };
  const groups = activity?.groups ?? [];
  const chartData = (activity?.buckets ?? []).map((bucket) => {
    const point: Record<string, string | number> = { bucket: labelFormat(bucket.bucketStart) };
    for (const group of groups) point[activityChartKey(group)] = bucket.counts[group] ?? 0;
    return point;
  });
  const series = groups.map((group, index) => ({
    name: activityChartKey(group),
    label: group,
    color:
      group === "other" ? "gray.5" : activitySeriesColors[index % activitySeriesColors.length]!,
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
            data={activityGroupings.map(({ value, label }) => ({ value, label }))}
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
        h={260}
        data={chartData}
        dataKey="bucket"
        type="stacked"
        series={series}
        withLegend={series.length > 1}
        legendProps={{
          layout: "vertical",
          align: "left",
          verticalAlign: "middle",
          width: 170,
          wrapperStyle: { paddingRight: 16, textAlign: "left" },
        }}
        styles={{
          legend: {
            justifyContent: "flex-start",
            flexDirection: "column",
            alignItems: "flex-start",
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

function TasksPage({
  data,
  navigate,
  runDemoJob,
  runningDemoJob,
  actionError,
  inspectJob,
  replace,
  taskLocation,
}: {
  data: DashboardTasksPage;
  navigate: (href: string) => void;
  replace: (href: string) => void;
  taskLocation: TaskLocationState;
  runDemoJob: (kind: DemoJobKind) => Promise<void>;
  runningDemoJob: DemoJobKind | null;
  actionError: string | null;
  inspectJob: (id: string) => void;
}) {
  const [fullArgs, setFullArgs] = useState(
    () => localStorage.getItem("workhorse-full-args") === "true",
  );
  const [searchInput, setSearchInput] = useState(taskLocation.search ?? "");
  useEffect(() => setSearchInput(taskLocation.search ?? ""), [taskLocation.search]);
  const locationState: TaskLocationState = taskLocation;
  const updateLocation = (updates: Partial<TaskLocationState>, useReplace = false) => {
    const href = taskHref({ ...locationState, page: 1, ...updates });
    if (useReplace) replace(href);
    else navigate(href);
  };
  useEffect(() => {
    const timer = setTimeout(() => {
      const search = searchInput.trim() || null;
      if (search !== taskLocation.search) updateLocation({ search }, true);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput, taskLocation.search]);
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
          <Group gap="xs" wrap="nowrap">
            <TextInput
              size="xs"
              value={searchInput}
              onChange={(event) => setSearchInput(event.currentTarget.value)}
              leftSection={<MagnifyingGlass size={14} />}
              placeholder="Search tasks (* wildcard)"
              aria-label="Search tasks"
              style={{ flex: "1 1 220px" }}
            />
            <MultiSelect
              size="xs"
              data={data.facets.tags}
              value={data.tags}
              onChange={(tags) => updateLocation({ tags })}
              placeholder="Tags"
              searchable
              clearable
              maxDropdownHeight={240}
              style={{ flex: "1 1 220px" }}
            />
            {(
              [
                ["Queue", data.queue, data.facets.queues, "queue"],
                ["Worker", data.worker, data.facets.workers, "worker"],
                ["Task type", data.jobType, data.facets.jobTypes, "jobType"],
              ] as const
            ).map(([placeholder, value, values, key]) => (
              <Select
                key={key}
                size="xs"
                data={values}
                value={value}
                onChange={(next) => updateLocation({ [key]: next })}
                placeholder={placeholder}
                searchable
                clearable
                style={{ flex: "1 1 150px" }}
              />
            ))}
          </Group>
          <Group justify="space-between">
            <Switch
              size="xs"
              label="Full args"
              checked={fullArgs}
              onChange={(event) => toggleFullArgs(event.currentTarget.checked)}
            />
            <Group gap="xs">
              <Menu position="bottom-start" withinPortal>
                <Menu.Target>
                  <Button
                    variant="default"
                    size="xs"
                    radius="xl"
                    leftSection={<PlayCircle size={16} />}
                    loading={runningDemoJob !== null}
                  >
                    enqueue test job
                  </Button>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Label>Execution path</Menu.Label>
                  <Menu.Item
                    leftSection={<CheckCircle size={16} />}
                    onClick={() => void runDemoJob("success")}
                  >
                    Successful job
                  </Menu.Item>
                  <Menu.Item
                    leftSection={<ArrowCounterClockwise size={16} />}
                    onClick={() => void runDemoJob("retry")}
                  >
                    Retry once
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
              <Select
                size="xs"
                w={76}
                value={String(data.pageSize)}
                data={taskPageSizes.map((size) => ({ value: String(size), label: String(size) }))}
                onChange={(value) =>
                  updateLocation({ pageSize: Number(value ?? 50) as TaskPageSize })
                }
                allowDeselect={false}
                aria-label="Tasks per page"
              />
              {pagination}
            </Group>
          </Group>
        </Stack>
        {actionError ? (
          <>
            <Divider />
            <Text c="red" size="sm" px="md" py="sm">
              {actionError}
            </Text>
          </>
        ) : null}
        <Divider />
        <ScrollArea>
          <Table
            striped
            highlightOnHover
            verticalSpacing={6}
            horizontalSpacing="sm"
            miw={fullArgs ? 960 : 840}
          >
            <Table.Thead>
              <Table.Tr>
                <Table.Th>ID</Table.Th>
                <Table.Th>Task</Table.Th>
                <Table.Th>Queue</Table.Th>
                <Table.Th>Args</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th ta="right">Attempt</Table.Th>
                <Table.Th ta="right">Duration</Table.Th>
                <Table.Th ta="right">Updated</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {data.jobs.length === 0 ? (
                <Table.Tr>
                  <Table.Td colSpan={8}>
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
                        style={{ background: "transparent", paddingBlock: 0, paddingInline: 0 }}
                      >
                        {job.id.slice(0, 8)}
                      </Code>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4} wrap="nowrap">
                        <Text fw={600} size="sm" lh={1.3} title={job.type}>
                          {taskDisplayName(job.type, job.queue)}
                        </Text>
                        {job.tags.map((tag) => (
                          <Badge key={tag} size="xs" variant="light" color="gray" tt="none">
                            {tag}
                          </Badge>
                        ))}
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
                        <TaskStatusDetail job={job} />
                      </Group>
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
  actionError,
  setScheduleEnabled,
}: {
  data: DashboardCronPage;
  togglingSchedule: string | null;
  actionError: string | null;
  setScheduleEnabled: (namespace: string, name: string, enabled: boolean) => void;
}) {
  return (
    <Stack gap="xl">
      <PageHeader
        title="Schedules"
        description="Recurring application and system schedules registered with Workhorse."
      />
      {actionError ? (
        <Text c="red" size="sm">
          {actionError}
        </Text>
      ) : null}
      {data.schedules.length === 0 ? (
        <EmptyState>No recurring schedules are registered.</EmptyState>
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
                  <Table.Th>Last fired</Table.Th>
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
                          style={{ background: "transparent", paddingBlock: 0, paddingInline: 0 }}
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
                            styles={{ label: { fontSize: "var(--mantine-font-size-xs)" } }}
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
                          <StatusBadge state={schedule.active ? "active" : "disabled"} />
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c="dimmed" title={formatExact(schedule.lastFiredAt)}>
                          {schedule.lastFiredAt ? formatRelative(schedule.lastFiredAt) : "never"}
                        </Text>
                      </Table.Td>
                      <Table.Td ta="right">{schedule.occurrenceCount}</Table.Td>
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

function QueuesPage({
  data,
  togglingQueue,
  purgingQueue,
  confirmingQueue,
  actionError,
  actionFeedback,
  setQueuePaused,
  setConfirmingQueue,
  purgeQueue,
}: {
  data: DashboardQueuesPage;
  togglingQueue: string | null;
  purgingQueue: string | null;
  confirmingQueue: string | null;
  actionError: string | null;
  actionFeedback: string | null;
  setQueuePaused: (queue: string, paused: boolean) => void;
  setConfirmingQueue: (queue: string | null) => void;
  purgeQueue: (queue: string) => void;
}) {
  return (
    <Stack gap="xl">
      <PageHeader
        title="Queues"
        description="Pause dispatch, inspect queue-level task counts, or clear waiting work."
      />
      {actionError ? (
        <Text c="red" size="sm">
          {actionError}
        </Text>
      ) : actionFeedback ? (
        <Text c="teal" size="sm">
          {actionFeedback}
        </Text>
      ) : null}
      {data.queues.length === 0 ? (
        <EmptyState>No queues have accepted work yet.</EmptyState>
      ) : (
        <Paper withBorder>
          <ScrollArea>
            <Table highlightOnHover verticalSpacing={6} horizontalSpacing="md" miw={980}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Queue</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th ta="right">Scheduled</Table.Th>
                  <Table.Th ta="right">Ready</Table.Th>
                  <Table.Th ta="right">Active</Table.Th>
                  <Table.Th ta="right">Succeeded</Table.Th>
                  <Table.Th ta="right">Failed</Table.Th>
                  <Table.Th ta="right">Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data.queues.map((queue) => {
                  const approximatePrefix = queue.terminalCountsApproximate ? "~" : "";
                  return (
                    <Table.Tr key={queue.queue}>
                      <Table.Td>
                        <Code
                          fz="xs"
                          style={{ background: "transparent", paddingBlock: 0, paddingInline: 0 }}
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
                          styles={{ label: { fontSize: "var(--mantine-font-size-xs)" } }}
                          aria-label={`${queue.paused ? "Resume" : "Pause"} ${queue.queue}`}
                          onChange={(event) =>
                            setQueuePaused(queue.queue, !event.currentTarget.checked)
                          }
                        />
                      </Table.Td>
                      <Table.Td ta="right">{queue.scheduled}</Table.Td>
                      <Table.Td ta="right">{queue.ready}</Table.Td>
                      <Table.Td ta="right">{queue.active}</Table.Td>
                      <Table.Td
                        ta="right"
                        title={queue.terminalCountsApproximate ? "Planner estimate" : undefined}
                      >
                        {approximatePrefix}
                        {queue.succeeded}
                      </Table.Td>
                      <Table.Td
                        ta="right"
                        title={queue.terminalCountsApproximate ? "Planner estimate" : undefined}
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
        Clear removes scheduled and ready tasks only. Active tasks keep their current ownership.
      </Text>
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

function HealthKpi({
  title,
  value,
  detail,
  color = "blue",
  icon,
  children,
}: {
  title: string;
  value: ReactNode;
  detail: ReactNode;
  color?: string;
  icon: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Card withBorder padding="md" mih={154}>
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Box>
          <Text c="dimmed" fw={600} size="xs" tt="uppercase" lts={0.4}>
            {title}
          </Text>
          <Text fw={750} fz={26} lh={1.2} mt={7}>
            {value}
          </Text>
        </Box>
        <ThemeIcon variant="light" color={color} size="lg">
          {icon}
        </ThemeIcon>
      </Group>
      <Text c="dimmed" size="xs" mt={5} mih={18}>
        {detail}
      </Text>
      {children ? <Box mt="sm">{children}</Box> : null}
    </Card>
  );
}

function systemBucketLabel(value: string, window: DashboardSystemWindow): string {
  const date = new Date(value);
  return new Intl.DateTimeFormat(undefined, {
    month: window === "24h" ? "short" : undefined,
    day: window === "24h" ? "numeric" : undefined,
    hour: "2-digit",
    minute: "2-digit",
    timeZone: displayTimeZone ?? undefined,
  }).format(date);
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
  const systemStatusColor = data.status.level === "critical" ? "red" : "teal";
  const errorColor =
    data.kpis.errorRate.current >= systemErrorRateWarning
      ? "red"
      : data.kpis.errorRate.current >= systemErrorRateCaution
        ? "yellow"
        : "teal";
  const backlogColor =
    (data.kpis.backlog.oldestReadyMs ?? 0) > systemOldestReadyWarningMs ? "yellow" : "blue";
  const outcomeChartData = data.outcomes.map((bucket) => ({
    bucket: systemBucketLabel(bucket.bucketStart, data.window),
    enqueued: bucket.enqueued,
    succeeded: bucket.succeeded,
    failed: bucket.failed,
    retry: bucket.retry,
    leaseExpired: bucket.leaseExpired,
  }));
  const recentOutcomes = data.outcomes.slice(-30);
  const defaultSpill = data.integrity.defaultEventRows + data.integrity.defaultAttemptRows;

  return (
    <Stack gap="xl">
      <Group justify="space-between" align="flex-start">
        <Box>
          <Group gap="sm" mb={4}>
            <Title order={1}>System Health</Title>
            <Badge color={systemStatusColor} variant="light" size="lg" tt="capitalize">
              {data.status.level}
            </Badge>
          </Group>
          <Group gap="xs">
            {data.status.checks.slice(0, 3).map((check) => (
              <Text
                key={check}
                c={systemStatusColor === "teal" ? "dimmed" : `${systemStatusColor}.7`}
                size="sm"
              >
                {check}
              </Text>
            ))}
            {data.status.checks.length === 0 ? (
              <Text c="dimmed" size="sm">
                No operator checks need attention.
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

      <SimpleGrid cols={{ base: 1, sm: 2, lg: 3, xl: 6 }} spacing="sm">
        <HealthKpi
          title="Drain balance"
          value={`${formatRate(data.kpis.drain.completedPerMinute)}/min`}
          detail={`${formatRate(data.kpis.drain.enqueuedPerMinute)} enqueued · net ${data.kpis.drain.netPerMinute >= 0 ? "+" : ""}${formatRate(data.kpis.drain.netPerMinute)}/min`}
          color={data.kpis.drain.netPerMinute < 0 ? "yellow" : "teal"}
          icon={<ArrowClockwise size={18} />}
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
          title="Backlog risk"
          value={data.kpis.backlog.ready}
          detail={`Oldest ready ${formatDuration(data.kpis.backlog.oldestReadyMs)} · 60s demo default`}
          color={backlogColor}
          icon={<ListChecks size={18} />}
        />
        <HealthKpi
          title="Attempt error rate"
          value={formatPercent(data.kpis.errorRate.current)}
          detail={`${data.kpis.errorRate.delta >= 0 ? "+" : ""}${formatPercent(data.kpis.errorRate.delta)} vs prior · 1%/5% defaults`}
          color={errorColor}
          icon={<WarningCircle size={18} />}
        />
        <HealthKpi
          title="First-attempt wait p95"
          value={formatDuration(data.kpis.queueWait.p95Ms)}
          detail="Enqueue to first claim"
          color="indigo"
          icon={<Clock size={18} />}
        >
          <Tooltip
            label={`p50 ${formatDuration(data.kpis.queueWait.p50Ms)} · p99 ${formatDuration(data.kpis.queueWait.p99Ms)}`}
          >
            <Text c="dimmed" size="xs" td="underline" style={{ cursor: "help" }}>
              p50 and p99
            </Text>
          </Tooltip>
        </HealthKpi>
        <HealthKpi
          title="Retry pressure"
          value={data.kpis.retry.backoff}
          detail={`${data.kpis.retry.dueSoon} due within 5 minutes`}
          color={data.kpis.retry.dueSoon > 0 ? "orange" : "blue"}
          icon={<ArrowCounterClockwise size={18} />}
        >
          <RetryBars buckets={data.kpis.retry.buckets} />
        </HealthKpi>
        <HealthKpi
          title="Lease danger"
          value={data.kpis.lease.expired}
          detail={`${data.kpis.lease.expiringSoon} expiring ≤30s · ${data.kpis.lease.recovered} recovered`}
          color={data.kpis.lease.expired > 0 ? "red" : "teal"}
          icon={<Pulse size={18} />}
        />
      </SimpleGrid>

      <Paper withBorder p="md">
        <Group justify="space-between" mb="sm">
          <Box>
            <Text fw={650}>Outcome rate</Text>
            <Text c="dimmed" size="xs">
              Minute buckets · enqueued line over closed-attempt outcomes
            </Text>
          </Box>
          <Badge variant="light" color="gray">
            {data.window}
          </Badge>
        </Group>
        <Box h={300}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={outcomeChartData}
              margin={{ top: 12, right: 12, bottom: 0, left: -12 }}
            >
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
              <Line
                dataKey="enqueued"
                type="monotone"
                stroke="var(--mantine-color-blue-7)"
                strokeWidth={2}
                dot={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </Box>
      </Paper>

      <Grid gutter="xl">
        <Grid.Col span={{ base: 12, lg: 8 }}>
          <Paper withBorder h="100%">
            <Group justify="space-between" p="md">
              <Box>
                <Text fw={650}>Queue pressure</Text>
                <Text c="dimmed" size="xs">
                  Worst queues first · select a row to inspect its tasks
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
              <Table highlightOnHover verticalSpacing={6} horizontalSpacing="sm" miw={920}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Queue</Table.Th>
                    <Table.Th>Status</Table.Th>
                    <Table.Th ta="right">Ready</Table.Th>
                    <Table.Th ta="right">Oldest</Table.Th>
                    <Table.Th ta="right">Due ≤5m</Table.Th>
                    <Table.Th ta="right">Active</Table.Th>
                    <Table.Th ta="right">Retrying</Table.Th>
                    <Table.Th ta="right">Enq/min</Table.Th>
                    <Table.Th ta="right">Done/min</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {data.queues.map((queue) => (
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
                      <Table.Td ta="right">{queue.retrying}</Table.Td>
                      <Table.Td ta="right">{formatRate(queue.enqueuedPerMinute)}</Table.Td>
                      <Table.Td ta="right">{formatRate(queue.completedPerMinute)}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </ScrollArea>
          </Paper>
        </Grid.Col>
        <Grid.Col span={{ base: 12, lg: 4 }}>
          <Paper withBorder p="md" h="100%">
            <Text fw={650}>Retry storm</Text>
            <Text c="dimmed" size="xs" mb="lg">
              Scheduled retries arriving next
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
        </Grid.Col>
      </Grid>

      <Grid gutter="xl">
        <Grid.Col span={{ base: 12, lg: 7 }}>
          <Paper withBorder h="100%">
            <Box p="md">
              <Text fw={650}>Top failing job types</Text>
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
                      <Table.Th>Queue / type</Table.Th>
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
            <Text fw={650}>Integrity</Text>
            <Text c="dimmed" size="xs" mb="lg">
              Tick proxy and weekly history coverage
            </Text>
            <Group justify="space-between" mb="lg">
              <Box>
                <Text size="sm" fw={600}>
                  Due but unpromoted
                </Text>
                <Text c="dimmed" size="xs">
                  Scheduled more than 10s overdue
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
            <Table verticalSpacing={6} horizontalSpacing="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Week</Table.Th>
                  <Table.Th ta="center">Events</Table.Th>
                  <Table.Th ta="center">Attempts</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data.integrity.partitions.map((partition) => (
                  <Table.Tr key={partition.week}>
                    <Table.Td>
                      <Text size="xs" title={formatExact(partition.startsAt)}>
                        {partition.week}
                      </Text>
                    </Table.Td>
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
            <Group justify="space-between">
              <Text size="sm" fw={600}>
                Default partition spill
              </Text>
              <Badge color={defaultSpill > 0 ? "yellow" : "teal"} variant="light">
                {data.integrity.defaultEventRows} events · {data.integrity.defaultAttemptRows}{" "}
                attempts
              </Badge>
            </Group>
          </Paper>
        </Grid.Col>
      </Grid>
    </Stack>
  );
}

function WorkersPage({
  data,
  togglingWorker,
  actionError,
  setWorkerPaused,
}: {
  data: DashboardWorkersPage;
  togglingWorker: string | null;
  actionError: string | null;
  setWorkerPaused: (workerId: string, paused: boolean) => void;
}) {
  return (
    <Stack gap="xl">
      <PageHeader
        title="Workers"
        description="Live claim state and one-hour execution throughput for this demo process."
      />
      {actionError ? (
        <Text c="red" size="sm">
          {actionError}
        </Text>
      ) : null}
      {data.workers.length === 0 ? (
        <EmptyState>No workers have reported activity.</EmptyState>
      ) : (
        <Paper withBorder>
          <ScrollArea>
            <Table highlightOnHover verticalSpacing={6} horizontalSpacing="md" miw={980}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Worker</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Claims</Table.Th>
                  <Table.Th ta="right">Current jobs</Table.Th>
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
                      <Code
                        fz="xs"
                        style={{ background: "transparent", paddingBlock: 0, paddingInline: 0 }}
                      >
                        {worker.id}
                      </Code>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={6} wrap="nowrap">
                        <StatusBadge state={worker.status} />
                        {worker.paused ? (
                          <Badge color="yellow" variant="light">
                            Paused
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
        Pause stops new claims only. Active jobs keep heartbeating until they finish. Worker pause
        state is held in this server process and clears on restart.
      </Text>
    </Stack>
  );
}

/** Common timezones plus the browser default; stored values are IANA zone names. */
const timeZoneOptions: Array<{ value: string; label: string }> = [
  { value: "system", label: `System (${Intl.DateTimeFormat().resolvedOptions().timeZone})` },
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

function SettingsPage() {
  const [timeZone, setTimeZone] = useState(currentTimeZoneValue);
  const changeTimeZone = (value: string | null) => {
    const next = value ?? "system";
    setDisplayTimeZone(next === "system" ? null : next);
    setTimeZone(next);
  };
  const now = new Date().toISOString();
  return (
    <Stack gap="xl">
      <PageHeader title="Settings" description="Dashboard display preferences for this browser." />
      <Paper withBorder p="lg" maw={480}>
        <Stack gap="sm">
          <Box>
            <Text fw={600} size="sm">
              Display timezone
            </Text>
            <Text c="dimmed" size="xs">
              All timestamps are stored in UTC; this only changes how they are shown. Saved in this
              browser.
            </Text>
          </Box>
          <Select
            value={timeZone}
            onChange={changeTimeZone}
            data={timeZoneOptions}
            searchable
            allowDeselect={false}
            aria-label="Display timezone"
          />
          <Text c="dimmed" size="xs">
            Now: {formatExact(now)}
          </Text>
        </Stack>
      </Paper>
    </Stack>
  );
}

/** Auto refresh cadence for the whole dashboard; "off" relies on SSE pushes only. */
const refreshIntervals = [
  { value: "off", label: "Auto refresh off", ms: null },
  { value: "5s", label: "Every 5s", ms: 5_000 },
  { value: "15s", label: "Every 15s", ms: 15_000 },
  { value: "30s", label: "Every 30s", ms: 30_000 },
  { value: "1m", label: "Every minute", ms: 60_000 },
  { value: "5m", label: "Every 5 minutes", ms: 300_000 },
] as const;
type RefreshIntervalValue = (typeof refreshIntervals)[number]["value"];
const refreshStorageKey = "workhorse-auto-refresh";

function readStoredRefreshInterval(): RefreshIntervalValue {
  const stored = localStorage.getItem(refreshStorageKey);
  return refreshIntervals.some((option) => option.value === stored)
    ? (stored as RefreshIntervalValue)
    : "30s";
}

function routeTitle(route: PageRoute): string {
  if (route === "/cron") return "schedules";
  if (route === "/queues") return "queues";
  if (route === "/system") return "system health";
  if (route === "/workers") return "workers";
  if (route === "/settings") return "settings";
  return "current tasks";
}

export function Dashboard() {
  const [navbarOpened, { toggle: toggleNavbar, close: closeNavbar }] = useDisclosure();
  // Timestamps format through module-level displayTimeZone; re-render everything on change.
  const [, setTimeZoneTick] = useState(0);
  useEffect(() => subscribeTimeZone(() => setTimeZoneTick((tick) => tick + 1)), []);
  const [location, setLocation] = useState(readLocation);
  const [loadState, setLoadState] = useState<LoadState>({
    status: "loading",
    data: null,
    error: null,
  });
  const [taskCounts, setTaskCounts] = useState<DashboardTaskCounts | null>(null);
  const [environment, setEnvironment] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void rpcClient.dashboard
      .meta()
      .then((meta) => {
        if (!cancelled) setEnvironment(meta.environment);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const [runningDemoJob, setRunningDemoJob] = useState<DemoJobKind | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [togglingSchedule, setTogglingSchedule] = useState<string | null>(null);
  const [scheduleActionError, setScheduleActionError] = useState<string | null>(null);
  const [togglingQueue, setTogglingQueue] = useState<string | null>(null);
  const [purgingQueue, setPurgingQueue] = useState<string | null>(null);
  const [confirmingQueue, setConfirmingQueue] = useState<string | null>(null);
  const [queueActionError, setQueueActionError] = useState<string | null>(null);
  const [queueActionFeedback, setQueueActionFeedback] = useState<string | null>(null);
  const [togglingWorker, setTogglingWorker] = useState<string | null>(null);
  const [workerActionError, setWorkerActionError] = useState<string | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [selectedJob, setSelectedJob] = useState<DashboardJobDetail | null>(null);
  const [jobDetailError, setJobDetailError] = useState<string | null>(null);
  const [refreshInterval, setRefreshInterval] =
    useState<RefreshIntervalValue>(readStoredRefreshInterval);
  const [systemWindow, setSystemWindow] = useState<DashboardSystemWindow>(() => {
    const initial = readLocation();
    return initial.route === "/system" &&
      systemWindows.includes(initial.period as DashboardSystemWindow)
      ? (initial.period as DashboardSystemWindow)
      : readStoredSystemWindow();
  });
  const changeSystemWindow = useCallback((nextWindow: DashboardSystemWindow) => {
    setSystemWindow(nextWindow);
    localStorage.setItem(systemWindowStorageKey, nextWindow);
    const parameters = new URLSearchParams(window.location.search);
    if (nextWindow === "1h") parameters.delete("period");
    else parameters.set("period", nextWindow);
    const query = parameters.toString();
    window.history.pushState(null, "", query ? `/system?${query}` : "/system");
    setLocation(readLocation());
  }, []);
  const changeRefreshInterval = useCallback((value: RefreshIntervalValue) => {
    setRefreshInterval(value);
    localStorage.setItem(refreshStorageKey, value);
  }, []);
  const requestId = useRef(0);

  const navigate = useCallback(
    (href: string) => {
      window.history.pushState(null, "", href);
      setLocation(readLocation());
      closeNavbar();
    },
    [closeNavbar],
  );
  const replace = useCallback((href: string) => {
    window.history.replaceState(null, "", href);
    setLocation(readLocation());
  }, []);

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

  const loadPage = useCallback(async () => {
    const activeRequest = ++requestId.current;
    setLoadState((current) => ({
      status: "loading",
      data: current.data,
      error: null,
    }));
    try {
      let data: PageData;
      if (location.route === "/tasks") {
        data = {
          route: "/tasks",
          value: await rpcClient.dashboard.tasks({
            filter: location.filter,
            queue: location.queue,
            worker: location.worker,
            jobType: location.jobType,
            tags: location.tags,
            search: location.search ?? undefined,
            page: location.page,
            pageSize: location.pageSize,
          }),
        };
      } else if (location.route === "/cron") {
        data = { route: "/cron", value: await rpcClient.dashboard.cron() };
      } else if (location.route === "/queues") {
        data = { route: "/queues", value: await rpcClient.dashboard.queues() };
      } else if (location.route === "/system") {
        data = {
          route: "/system",
          value: await rpcClient.dashboard.system({ window: systemWindow }),
        };
      } else if (location.route === "/settings") {
        data = { route: "/settings", value: null };
      } else {
        data = {
          route: "/workers",
          value: await rpcClient.dashboard.workers(),
        };
      }
      if (activeRequest === requestId.current) {
        if (data.route === "/tasks") setTaskCounts(data.value.counts);
        setLoadState({ status: "ready", data, error: null });
      }
    } catch (cause) {
      if (activeRequest === requestId.current) {
        setLoadState((current) => ({
          status: "error",
          data: current.data,
          error: cause instanceof Error ? cause.message : "Unable to load dashboard page",
        }));
      }
    }
  }, [location, systemWindow]);

  const loadTaskCounts = useCallback(async () => {
    try {
      setTaskCounts(await rpcClient.dashboard.taskCounts());
    } catch {
      // The active page owns the connection state; keep the last navigation counts on failure.
    }
  }, []);

  const runDemoJob = useCallback(
    async (kind: DemoJobKind) => {
      setRunningDemoJob(kind);
      setActionError(null);
      try {
        await rpcClient.dashboard.enqueueTest({
          kind,
          audit: {
            actor: "local-demo",
            reason: `Demonstrate the ${kind} execution path`,
            requestId: crypto.randomUUID(),
          },
        });
        if (location.filter !== "all" || location.page !== 1) navigate("/tasks");
        await loadPage();
      } catch (cause) {
        setActionError(cause instanceof Error ? cause.message : "Unable to enqueue the demo job");
      } finally {
        setRunningDemoJob(null);
      }
    },
    [loadPage, location.filter, location.page, navigate],
  );

  const toggleSchedule = useCallback(
    async (namespace: string, name: string, enabled: boolean) => {
      const scheduleKey = `${namespace}:${name}`;
      setTogglingSchedule(scheduleKey);
      setScheduleActionError(null);
      try {
        await rpcClient.dashboard.setScheduleEnabled({
          kind: "user",
          namespace,
          name,
          enabled,
          audit: {
            actor: "local-demo",
            reason: `${enabled ? "Enable" : "Disable"} ${namespace}/${name} from the dashboard`,
            requestId: crypto.randomUUID(),
          },
        });
        await loadPage();
      } catch (cause) {
        setScheduleActionError(
          cause instanceof Error ? cause.message : "Unable to update the schedule",
        );
      } finally {
        setTogglingSchedule(null);
      }
    },
    [loadPage],
  );

  const toggleQueue = useCallback(
    async (queue: string, paused: boolean) => {
      setTogglingQueue(queue);
      setQueueActionError(null);
      setQueueActionFeedback(null);
      try {
        await rpcClient.dashboard.setQueuePaused({
          queue,
          paused,
          audit: {
            actor: "local-demo",
            reason: `${paused ? "Pause" : "Resume"} ${queue} from the dashboard`,
            requestId: crypto.randomUUID(),
          },
        });
        await loadPage();
      } catch (cause) {
        setQueueActionError(cause instanceof Error ? cause.message : "Unable to update the queue");
      } finally {
        setTogglingQueue(null);
      }
    },
    [loadPage],
  );

  const clearQueue = useCallback(
    async (queue: string) => {
      setPurgingQueue(queue);
      setQueueActionError(null);
      setQueueActionFeedback(null);
      try {
        const result = await rpcClient.dashboard.purgeQueue({
          queue,
          audit: {
            actor: "local-demo",
            reason: `Clear waiting work from ${queue} from the dashboard`,
            requestId: crypto.randomUUID(),
          },
        });
        setConfirmingQueue(null);
        setQueueActionFeedback(
          `Cleared ${result.deletedCount} waiting ${result.deletedCount === 1 ? "task" : "tasks"} from ${queue}.`,
        );
        await loadPage();
      } catch (cause) {
        setQueueActionError(cause instanceof Error ? cause.message : "Unable to clear the queue");
      } finally {
        setPurgingQueue(null);
      }
    },
    [loadPage],
  );

  const toggleWorker = useCallback(
    async (workerId: string, paused: boolean) => {
      setTogglingWorker(workerId);
      setWorkerActionError(null);
      try {
        await rpcClient.dashboard.setWorkerPaused({
          workerId,
          paused,
          audit: {
            actor: "local-demo",
            reason: `${paused ? "Pause" : "Resume"} ${workerId} from the dashboard`,
            requestId: crypto.randomUUID(),
          },
        });
        await loadPage();
      } catch (cause) {
        setWorkerActionError(
          cause instanceof Error ? cause.message : "Unable to update the worker",
        );
      } finally {
        setTogglingWorker(null);
      }
    },
    [loadPage],
  );

  const inspectJob = useCallback(async (id: string) => {
    setSelectedJobId(id);
    setSelectedJob(null);
    setJobDetailError(null);
    try {
      setSelectedJob(await rpcClient.dashboard.jobDetail({ id }));
    } catch (cause) {
      setJobDetailError(cause instanceof Error ? cause.message : "Unable to load the task");
    }
  }, []);

  useEffect(() => {
    const onPopState = () => {
      const next = readLocation();
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

  useEffect(() => {
    const events = new EventSource("/dashboard/events");
    events.addEventListener("refresh", () => {
      void loadPage();
      if (location.route !== "/tasks") void loadTaskCounts();
      if (selectedJobId) {
        void rpcClient.dashboard
          .jobDetail({ id: selectedJobId })
          .then(setSelectedJob)
          .catch(() => undefined);
      }
    });
    return () => events.close();
  }, [loadPage, loadTaskCounts, location.route, selectedJobId]);

  useEffect(() => {
    const intervalMs = refreshIntervals.find((option) => option.value === refreshInterval)?.ms;
    if (!intervalMs) return;
    const timer = setInterval(() => {
      void loadPage();
      if (location.route !== "/tasks") void loadTaskCounts();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [refreshInterval, loadPage, loadTaskCounts, location.route]);

  const connected = loadState.status !== "error" && loadState.data !== null;
  const loading = loadState.status === "loading";

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
          <Text fw={600}>This page could not connect.</Text>
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
        runDemoJob={runDemoJob}
        runningDemoJob={runningDemoJob}
        actionError={actionError}
        inspectJob={(id) => void inspectJob(id)}
      />
    );
  } else if (loadState.data?.route === "/cron") {
    content = (
      <CronPage
        data={loadState.data.value}
        togglingSchedule={togglingSchedule}
        actionError={scheduleActionError}
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
        actionError={queueActionError}
        actionFeedback={queueActionFeedback}
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
        actionError={workerActionError}
        setWorkerPaused={(workerId, paused) => void toggleWorker(workerId, paused)}
      />
    );
  } else if (loadState.data?.route === "/settings") {
    content = <SettingsPage />;
  } else {
    content = null;
  }

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
              aria-label="Toggle navigation"
            />
            <ThemeIcon size="lg" radius="md" color="dark">
              <ActivityIcon size={20} weight="bold" />
            </ThemeIcon>
            <Box>
              <Text fw={750} lh={1.1}>
                Workhorse
              </Text>
              <Text c="dimmed" size="xs">
                Live queue demo
              </Text>
            </Box>
          </Group>
          <Group gap="sm" wrap="nowrap">
            {environment ? (
              <Badge
                color={environmentColor(environment)}
                variant="light"
                visibleFrom="xs"
                title="Deployment environment (WORKHORSE_ENV)"
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
                    aria-label="Auto refresh interval"
                  >
                    {refreshInterval === "off" ? "manual" : refreshInterval}
                  </Button>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Label>Auto refresh</Menu.Label>
                  {refreshIntervals.map((option) => (
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
              const href = taskHref({ ...location, filter: filter.value, page: 1 });
              const count = taskCounts?.[filter.value];
              const Icon = filter.icon;
              return (
                <NavLink
                  key={filter.value}
                  component="a"
                  href={href}
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
              href="/cron"
              active={location.route === "/cron"}
              label="Schedules"
              leftSection={<CalendarDots size={18} />}
              variant="light"
              onClick={(event) => handleLink(event, "/cron")}
            />
            <NavLink
              component="a"
              href="/queues"
              active={location.route === "/queues"}
              label="Queues"
              leftSection={<ListDashes size={18} />}
              variant="light"
              onClick={(event) => handleLink(event, "/queues")}
            />
            <NavLink
              component="a"
              href="/system"
              active={location.route === "/system"}
              label="System Health"
              leftSection={<Pulse size={18} />}
              variant="light"
              onClick={(event) => handleLink(event, "/system")}
            />
            <NavLink
              component="a"
              href="/workers"
              active={location.route === "/workers"}
              label="Workers"
              leftSection={<Robot size={18} />}
              variant="light"
              onClick={(event) => handleLink(event, "/workers")}
            />
            <NavLink
              component="a"
              href="/settings"
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
        opened={selectedJobId !== null}
        onClose={() => {
          setSelectedJobId(null);
          setSelectedJob(null);
          setJobDetailError(null);
        }}
        title="Task details"
        position="right"
        size="lg"
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
            </Box>
            <Box>
              <Text fw={600} size="sm" mb="xs">
                Payload
              </Text>
              <Code block>{JSON.stringify(selectedJob.payload, null, 2)}</Code>
            </Box>
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
                      <Text c="dimmed" size="xs" mt={4}>
                        {attempt.workerId} · {formatDuration(attempt.durationMs)}
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
    </AppShell>
  );
}
