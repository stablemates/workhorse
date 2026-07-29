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
  Group,
  Loader,
  Menu,
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
  PlayCircle,
  Pulse,
  Robot,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import type {
  DashboardCronPage,
  DashboardJobDetail,
  DashboardJobRow,
  DashboardQueuesPage,
  DashboardSystemPage,
  DashboardTaskCounts,
  DashboardTaskFilter,
  DashboardTasksPage,
  DashboardWorkersPage,
} from "../../src/dashboard";
import { rpcClient } from "../lib/rpc";

type ActivityPeriod = "15m" | "1h" | "6h" | "24h" | "7d";
const activityPeriods: ActivityPeriod[] = ["15m", "1h", "6h", "24h", "7d"];

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

const tasksPerPage = 10;
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
const taskFilterSet = new Set<DashboardTaskFilter>(taskFilters.map(({ value }) => value));
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
  filter: DashboardTaskFilter;
  page: number;
} {
  const route = pageRoutes.has(window.location.pathname as PageRoute)
    ? (window.location.pathname as PageRoute)
    : "/tasks";
  const parameters = new URLSearchParams(window.location.search);
  const requestedFilter = parameters.get("filter") as DashboardTaskFilter | null;
  const filter = requestedFilter && taskFilterSet.has(requestedFilter) ? requestedFilter : "all";
  const requestedPage = Number(parameters.get("page") ?? "1");
  const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  return { route, filter, page };
}

function taskHref(filter: DashboardTaskFilter, page = 1): string {
  const parameters = new URLSearchParams();
  if (filter !== "all") parameters.set("filter", filter);
  if (page > 1) parameters.set("page", String(page));
  const query = parameters.toString();
  return query ? `/tasks?${query}` : "/tasks";
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
function TasksActivityChart({ filter }: { filter: DashboardTaskFilter }) {
  const [period, setPeriod] = useState<ActivityPeriod>(
    () => (localStorage.getItem("workhorse-activity-period") as ActivityPeriod) ?? "1h",
  );
  const [groupBy, setGroupBy] = useState<ActivityGroupBy>(() => {
    const stored = localStorage.getItem("workhorse-activity-group") as ActivityGroupBy | null;
    return stored !== null && activityGroupings.some((g) => g.value === stored) ? stored : "queue";
  });
  const [activity, setActivity] = useState<ActivityData | null>(null);
  const changePeriod = (value: string) => {
    const next = activityPeriods.includes(value as ActivityPeriod)
      ? (value as ActivityPeriod)
      : "1h";
    setPeriod(next);
    localStorage.setItem("workhorse-activity-period", next);
  };
  const changeGroupBy = (value: string) => {
    const next = activityGroupings.some((g) => g.value === value)
      ? (value as ActivityGroupBy)
      : "queue";
    setGroupBy(next);
    localStorage.setItem("workhorse-activity-group", next);
  };

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      void rpcClient.dashboard
        .activity({ filter, period, groupBy })
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
  }, [filter, period, groupBy]);

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
  // Recharts treats dots in dataKey as nested paths (task types like "demo.failure"),
  // which breaks legend hover highlighting, so chart keys replace dots and labels keep them.
  const chartKey = (group: string) => group.replaceAll(".", "_");
  const chartData = (activity?.buckets ?? []).map((bucket) => {
    const point: Record<string, string | number> = { bucket: labelFormat(bucket.bucketStart) };
    for (const group of groups) point[chartKey(group)] = bucket.counts[group] ?? 0;
    return point;
  });
  const series = groups.map((group, index) => ({
    name: chartKey(group),
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
          legend: { justifyContent: "flex-start", flexDirection: "column", alignItems: "flex-start" },
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
}: {
  data: DashboardTasksPage;
  navigate: (href: string) => void;
  runDemoJob: (kind: DemoJobKind) => Promise<void>;
  runningDemoJob: DemoJobKind | null;
  actionError: string | null;
  inspectJob: (id: string) => void;
}) {
  const [fullArgs, setFullArgs] = useState(
    () => localStorage.getItem("workhorse-full-args") === "true",
  );
  const toggleFullArgs = (checked: boolean) => {
    setFullArgs(checked);
    localStorage.setItem("workhorse-full-args", String(checked));
  };
  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const pagination = (
    <Pagination
      value={Math.min(data.page, totalPages)}
      onChange={(page) => navigate(taskHref(data.filter, page))}
      total={totalPages}
      size="xs"
      aria-label="Tasks pagination"
    />
  );

  return (
    <Stack gap="xl">
      <TasksActivityChart filter={data.filter} />
      <Paper withBorder>
        <Group justify="space-between" p="md">
          <Switch
            size="xs"
            label="Full args"
            checked={fullArgs}
            onChange={(event) => toggleFullArgs(event.currentTarget.checked)}
          />
          <Group>
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
            {pagination}
          </Group>
        </Group>
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
                      <Text fw={600} size="sm" lh={1.3} title={job.type}>
                        {taskDisplayName(job.type, job.queue)}
                      </Text>
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

function SystemPage({ data }: { data: DashboardSystemPage }) {
  return (
    <Stack gap="xl">
      <PageHeader
        title="System Health"
        description="Queue depth, task age, and the backend health report."
      />
      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <Card withBorder padding="lg">
          <Group justify="space-between" mb="lg">
            <Box>
              <Text fw={700}>Queues</Text>
              <Text c="dimmed" size="sm">
                Current work grouped by queue and state
              </Text>
            </Box>
            <ThemeIcon variant="light" color="blue">
              <ListChecks size={18} />
            </ThemeIcon>
          </Group>
          {data.queues.length === 0 ? (
            <Text c="dimmed" size="sm">
              No queued work.
            </Text>
          ) : (
            <Stack gap="sm">
              {data.queues.map((queue) => (
                <Group key={`${queue.queue}:${queue.state}`} justify="space-between">
                  <Box>
                    <Text fw={600} size="sm">
                      {queue.queue}
                    </Text>
                    <Text c="dimmed" size="xs">
                      Oldest: {formatDuration(queue.oldestMs)}
                    </Text>
                  </Box>
                  <Group gap="xs">
                    <Text fw={700}>{queue.count}</Text>
                    <StatusBadge state={queue.state} />
                  </Group>
                </Group>
              ))}
            </Stack>
          )}
        </Card>
        <Card withBorder padding="lg">
          <Group justify="space-between" mb="lg">
            <Box>
              <Text fw={700}>Backend report</Text>
              <Text c="dimmed" size="sm">
                Health data returned by the queue API
              </Text>
            </Box>
            <ThemeIcon variant="light" color="teal">
              <Pulse size={18} />
            </ThemeIcon>
          </Group>
          <Code block>{JSON.stringify(data.health, null, 2)}</Code>
        </Card>
      </SimpleGrid>
      <Card withBorder padding="lg">
        <Group justify="space-between">
          <Box>
            <Text fw={700}>Recent failures</Text>
            <Text c="dimmed" size="sm">
              Terminal failures retained in this page response
            </Text>
          </Box>
          <Badge color={data.failures.length > 0 ? "red" : "teal"} variant="light" size="lg">
            {data.failures.length}
          </Badge>
        </Group>
      </Card>
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
            page: location.page,
            pageSize: tasksPerPage,
          }),
        };
      } else if (location.route === "/cron") {
        data = { route: "/cron", value: await rpcClient.dashboard.cron() };
      } else if (location.route === "/queues") {
        data = { route: "/queues", value: await rpcClient.dashboard.queues() };
      } else if (location.route === "/system") {
        data = { route: "/system", value: await rpcClient.dashboard.system() };
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
  }, [location]);

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
      setLocation(readLocation());
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
    content = <SystemPage data={loadState.data.value} />;
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
              const href = taskHref(filter.value);
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
