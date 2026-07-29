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
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Text,
  ThemeIcon,
  Title,
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
  Cpu,
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
  DashboardSystemPage,
  DashboardTaskCounts,
  DashboardTaskFilter,
  DashboardTasksPage,
  DashboardWorkersPage,
} from "../../src/dashboard";
import { rpcClient } from "../lib/rpc";

type ActivityPeriod = "15m" | "1h" | "6h" | "24h" | "7d";
const activityPeriods: ActivityPeriod[] = ["15m", "1h", "6h", "24h", "7d"];

interface ActivityData {
  period: ActivityPeriod;
  bucketSeconds: number;
  queues: string[];
  buckets: Array<{ bucketStart: string; counts: Record<string, number> }>;
}

const queueSeriesColors = ["teal.6", "indigo.6", "orange.6", "grape.6", "cyan.6", "lime.6"];

type PageRoute = "/tasks" | "/cron" | "/system" | "/workers";
type DemoJobKind = "success" | "retry" | "failure" | "long-running";
type PageData =
  | { route: "/tasks"; value: DashboardTasksPage }
  | { route: "/cron"; value: DashboardCronPage }
  | { route: "/system"; value: DashboardSystemPage }
  | { route: "/workers"; value: DashboardWorkersPage };
type LoadState =
  | { status: "loading"; data: PageData | null; error: null }
  | { status: "ready"; data: PageData; error: null }
  | { status: "error"; data: PageData | null; error: string };

const tasksPerPage = 10;
const pageRoutes = new Set<PageRoute>(["/tasks", "/cron", "/system", "/workers"]);
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

function formatDate(value: string | null | undefined): string {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
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

function statusColor(state: string): string {
  if (healthyStates.has(state)) return "teal";
  if (failureStates.has(state) || state === "unhealthy") return "red";
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
  if (job.state === "scheduled" && job.runAt) detail = `runs ${formatRelative(job.runAt)}`;
  else if (job.state === "active" && job.workerId) detail = `on ${job.workerId}`;
  else if (job.state === "failed" && job.errorMessage) detail = job.errorMessage;
  else if (job.state === "succeeded" && job.finishedAt)
    detail = `finished ${formatRelative(job.finishedAt)}`;
  if (!detail) return null;
  return (
    <Text
      c={job.state === "failed" ? "red.7" : "dimmed"}
      size="xs"
      lineClamp={1}
      style={{ wordBreak: "break-all" }}
      title={detail}
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
          background: "transparent",
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
        background: "transparent",
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

/** Full-width bar chart of task activity, filtered like the list and switchable across periods. */
function TasksActivityChart({ filter }: { filter: DashboardTaskFilter }) {
  const [period, setPeriod] = useState<ActivityPeriod>(
    () => (localStorage.getItem("workhorse-activity-period") as ActivityPeriod) ?? "1h",
  );
  const [activity, setActivity] = useState<ActivityData | null>(null);
  const changePeriod = (value: string) => {
    const next = activityPeriods.includes(value as ActivityPeriod)
      ? (value as ActivityPeriod)
      : "1h";
    setPeriod(next);
    localStorage.setItem("workhorse-activity-period", next);
  };

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      void rpcClient.dashboard
        .activity({ filter, period })
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
  }, [filter, period]);

  const labelFormat = (value: string): string => {
    const date = new Date(value);
    if (period === "7d" || period === "24h") {
      return new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
      }).format(date);
    }
    return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
  };
  const queues = activity?.queues ?? [];
  const chartData = (activity?.buckets ?? []).map((bucket) => {
    const point: Record<string, string | number> = { bucket: labelFormat(bucket.bucketStart) };
    for (const queue of queues) point[queue] = bucket.counts[queue] ?? 0;
    return point;
  });
  const series = queues.map((queue, index) => ({
    name: queue,
    color: queueSeriesColors[index % queueSeriesColors.length]!,
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
        <SegmentedControl
          size="xs"
          value={period}
          onChange={changePeriod}
          data={activityPeriods.map((value) => ({ value, label: value }))}
        />
      </Group>
      <BarChart
        h={260}
        data={chartData}
        dataKey="bucket"
        type="stacked"
        series={series}
        withLegend={series.length > 1}
        legendProps={{ verticalAlign: "bottom", height: 24 }}
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
                        style={{ background: "transparent", paddingInline: 0 }}
                      >
                        {job.id.slice(0, 8)}
                      </Code>
                    </Table.Td>
                    <Table.Td>
                      <Text fw={600} size="sm" lh={1.3}>
                        {job.type}
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
                      <Text size="sm" title={formatDate(job.updatedAt)} c="dimmed">
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

function CronPage({ data }: { data: DashboardCronPage }) {
  return (
    <Stack gap="xl">
      <PageHeader
        title="Schedules"
        description="Recurring application and system schedules registered with Workhorse."
      />
      {data.schedules.length === 0 ? (
        <EmptyState>No recurring schedules are registered.</EmptyState>
      ) : (
        <Paper withBorder>
          <ScrollArea>
            <Table highlightOnHover verticalSpacing="md" horizontalSpacing="lg" miw={800}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Schedule</Table.Th>
                  <Table.Th>Expression</Table.Th>
                  <Table.Th>Destination</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Last fired</Table.Th>
                  <Table.Th>Runs</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data.schedules.map((schedule) => (
                  <Table.Tr key={`${schedule.namespace}:${schedule.name}`}>
                    <Table.Td>
                      <Text fw={600} size="sm">
                        {schedule.name}
                      </Text>
                      <Text c="dimmed" size="xs">
                        {schedule.kind} · {schedule.namespace}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Code>{schedule.cron}</Code>
                    </Table.Td>
                    <Table.Td>{schedule.queue ?? "System maintenance"}</Table.Td>
                    <Table.Td>
                      <StatusBadge state={schedule.active ? "active" : "disabled"} />
                    </Table.Td>
                    <Table.Td>{formatDate(schedule.lastFiredAt)}</Table.Td>
                    <Table.Td>{schedule.occurrenceCount}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        </Paper>
      )}
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

function WorkersPage({ data }: { data: DashboardWorkersPage }) {
  return (
    <Stack gap="xl">
      <PageHeader
        title="Workers"
        description="Configured workers and the tasks they are currently processing."
      />
      {data.workers.length === 0 ? (
        <EmptyState>No workers have reported activity.</EmptyState>
      ) : (
        <SimpleGrid cols={{ base: 1, md: 2, xl: 3 }}>
          {data.workers.map((worker) => (
            <Card key={worker.id} withBorder padding="lg">
              <Group justify="space-between" align="flex-start">
                <ThemeIcon variant="light" color={statusColor(worker.status)} size="lg">
                  <Cpu size={20} />
                </ThemeIcon>
                <StatusBadge state={worker.status} />
              </Group>
              <Text fw={700} mt="lg">
                {worker.id}
              </Text>
              <Text c="dimmed" size="sm">
                Last seen {formatDate(worker.lastSeenAt)}
              </Text>
              <Group grow mt="lg">
                <Paper bg="var(--mantine-color-default-hover)" p="sm" radius="md">
                  <Text c="dimmed" size="xs">
                    Active
                  </Text>
                  <Text fw={700}>{worker.activeJobs}</Text>
                </Paper>
                <Paper bg="var(--mantine-color-default-hover)" p="sm" radius="md">
                  <Text c="dimmed" size="xs">
                    Completed
                  </Text>
                  <Text fw={700}>{worker.completedAttempts}</Text>
                </Paper>
              </Group>
            </Card>
          ))}
        </SimpleGrid>
      )}
    </Stack>
  );
}

function routeTitle(route: PageRoute): string {
  if (route === "/cron") return "schedules";
  if (route === "/system") return "system health";
  if (route === "/workers") return "workers";
  return "current tasks";
}

export function Dashboard() {
  const [navbarOpened, { toggle: toggleNavbar, close: closeNavbar }] = useDisclosure();
  const [location, setLocation] = useState(readLocation);
  const [loadState, setLoadState] = useState<LoadState>({
    status: "loading",
    data: null,
    error: null,
  });
  const [taskCounts, setTaskCounts] = useState<DashboardTaskCounts | null>(null);
  const [runningDemoJob, setRunningDemoJob] = useState<DemoJobKind | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [selectedJob, setSelectedJob] = useState<DashboardJobDetail | null>(null);
  const [jobDetailError, setJobDetailError] = useState<string | null>(null);
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
      } else if (location.route === "/system") {
        data = { route: "/system", value: await rpcClient.dashboard.system() };
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
    content = <CronPage data={loadState.data.value} />;
  } else if (loadState.data?.route === "/system") {
    content = <SystemPage data={loadState.data.value} />;
  } else if (loadState.data?.route === "/workers") {
    content = <WorkersPage data={loadState.data.value} />;
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
            <Button
              variant="default"
              size="xs"
              leftSection={<ArrowClockwise size={14} />}
              loading={loading}
              onClick={() => void loadPage()}
            >
              Refresh
            </Button>
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
