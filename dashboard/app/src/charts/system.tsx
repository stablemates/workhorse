import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Code,
  Divider,
  Group,
  Paper,
  ScrollArea,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Tooltip,
} from "@mantine/core";
import type {
  DashboardSystemPage,
  DashboardSystemRetryBucket,
  DashboardSystemWindow,
} from "@workhorse/dashboard-server/wire";
import {
  ArrowCounterClockwise,
  ArrowClockwise,
  Clock,
  FunnelSimple,
  Info,
  Lightning,
  ListChecks,
  Pulse,
  UserFocus,
  WarningCircle,
} from "@phosphor-icons/react";
import { type ReactNode } from "react";
import {
  concurrencyCappedFootnote,
  describeConcurrencyBlocked,
  describeConcurrencyLimit,
} from "../concurrency-policy.js";
import { describeRateLimit, describeRateThrottle, rateLimitCappedFootnote } from "../rate-limit.js";
import { displayTimeZone, formatDuration, getDateTimeFormatter } from "../preferences.js";
import {
  systemErrorRateCaution,
  systemErrorRateWarning,
  systemOldestReadyWarningMs,
} from "../core.js";
import { taskDisplayName } from "../components/task-list.js";

export function formatRate(value: number): string {
  if (value === 0) return "0";
  if (Math.abs(value) < 0.1) return "<0.1";
  return value.toFixed(1);
}
export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(value < 0.01 ? 1 : 0)}%`;
}
export function MiniTrend({ series }: { series: Array<{ values: number[]; color: string }> }) {
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
export function RetryBars({ buckets }: { buckets: DashboardSystemRetryBucket[] }) {
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
export function HelpButton({ label, help }: { label: string; help: string }) {
  return (
    <Tooltip label={help} multiline w={280} withArrow>
      <ActionIcon
        className="task-drawer__help"
        aria-label={`${label}: ${help}`}
        color="gray"
        size="sm"
        variant="subtle"
      >
        <Info size={14} />
      </ActionIcon>
    </Tooltip>
  );
}
export function HealthKpi({
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
export function systemBucketLabel(value: string, window: DashboardSystemWindow): string {
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
    // The numeric columns need the wider two-thirds column; narrower viewports scroll the table
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
        <Table highlightOnHover verticalSpacing={6} horizontalSpacing="sm" miw={1180}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Queue</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th ta="right">Ready</Table.Th>
              <Table.Th ta="right">Oldest</Table.Th>
              <Table.Th>Ready by priority</Table.Th>
              <Table.Th ta="right">Due in 5m</Table.Th>
              <Table.Th ta="right">Active</Table.Th>
              <Table.Th ta="right">
                <Group gap={4} justify="flex-end" wrap="nowrap">
                  <span>Admission</span>
                  <HelpButton
                    label="Admission"
                    help="Concurrency caps simultaneous active work, while a token bucket caps how quickly work starts. Blocked and throttled counts are bounded lower bounds."
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
              const ratePolicy = queue.rateLimitPolicy ?? null;
              const rate = describeRateLimit(ratePolicy);
              const throttled = describeRateThrottle(ratePolicy);
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
                  <Table.Td>
                    {queue.priorityBacklog.length === 0 ? (
                      <Text size="sm" c="dimmed">
                        —
                      </Text>
                    ) : (
                      <Stack gap={1}>
                        {queue.priorityBacklog.map((lane) => (
                          <Text key={lane.priority} size="xs" style={{ whiteSpace: "nowrap" }}>
                            <Text component="span" fw={650} inherit>
                              P{lane.priority}
                            </Text>{" "}
                            · {lane.ready} ready · oldest {formatDuration(lane.oldestReadyMs)}
                          </Text>
                        ))}
                      </Stack>
                    )}
                  </Table.Td>
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
                    {ratePolicy === null ? null : (
                      <Text
                        c={throttled.throttling ? "yellow.8" : "dimmed"}
                        size="xs"
                        fw={throttled.throttling ? 650 : undefined}
                        title={throttled.title}
                      >
                        {rate.label}
                        {throttled.throttling ? ` · ${throttled.label} throttled` : ""}
                      </Text>
                    )}
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
      {data.rateLimitPoliciesCapped ? (
        <Text c="dimmed" size="xs" px="md" pb="md">
          {rateLimitCappedFootnote}
        </Text>
      ) : null}
    </Paper>
  );
}
export function SystemKpiList({
  data,
  navigate,
}: {
  data: DashboardSystemPage;
  navigate: (href: string) => void;
}) {
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
      <HealthKpi
        divided
        title="Blocked dependencies"
        value={
          <Group gap={6} wrap="nowrap" style={{ flexShrink: 0 }}>
            <Button
              aria-label="View blocked tasks"
              size="compact-xs"
              variant="subtle"
              onClick={() => navigate("/tasks?filter=blocked")}
            >
              View blocked tasks
            </Button>
            <Text fw={750} fz={17} lh={1.2} ta="right">
              {data.kpis.dependencies.blockedJobs}
            </Text>
          </Group>
        }
        detail={`${data.kpis.dependencies.pendingEdges} pending edges · ${data.kpis.dependencies.failedResolutions} failed resolutions${data.kpis.dependencies.retentionPruneStarved ? " · retention is blocked" : ""}${data.kpis.dependencies.capped ? " · Counts reached the scan limit" : ""}`}
        help="These tasks are waiting for prerequisite outcomes. Failed resolutions need attention, while a blocked retention pass means dependency evidence is holding expired task history."
        scope="now"
        color={
          data.kpis.dependencies.failedResolutions > 0 ||
          data.kpis.dependencies.retentionPruneStarved
            ? "orange"
            : data.kpis.dependencies.blockedJobs > 0
              ? "yellow"
              : "teal"
        }
        icon={<FunnelSimple size={16} />}
      />
      <HealthKpi
        divided
        title="Waiting parents"
        value={data.kpis.children.waitingParents}
        detail={`${data.kpis.children.pendingChildren} pending children · ${data.kpis.children.unjoinedResults} unjoined results · ${data.kpis.children.failedParents} failed parents · ${data.kpis.children.canceledParents} canceled parents${data.kpis.children.capped ? " · Counts reached the scan limit" : ""}`}
        help="These parent tasks are waiting for child work. Unjoined results remain available until the parent collects them."
        scope="now"
        color={
          data.kpis.children.failedParents > 0 || data.kpis.children.canceledParents > 0
            ? "orange"
            : data.kpis.children.waitingParents > 0 || data.kpis.children.unjoinedResults > 0
              ? "yellow"
              : "teal"
        }
        icon={<UserFocus size={16} />}
      />
      <HealthKpi
        divided
        title="Pending external waits"
        value={
          <Group gap={6} wrap="nowrap" style={{ flexShrink: 0 }}>
            <Button
              aria-label="Review waiting tasks"
              size="compact-xs"
              variant="subtle"
              onClick={() => navigate("/tasks?filter=waiting")}
            >
              Review waiting tasks
            </Button>
            <Text fw={750} fz={17} lh={1.2} ta="right">
              {data.kpis.externalWaits.pendingSignals +
                data.kpis.externalWaits.pendingHumanDecisions}
            </Text>
          </Group>
        }
        detail={`${data.kpis.externalWaits.pendingSignals} signals · ${data.kpis.externalWaits.pendingHumanDecisions} human decisions · ${data.kpis.externalWaits.overdue} overdue · oldest ${formatDuration(data.kpis.externalWaits.oldestPendingAgeMs)} · ${data.kpis.externalWaits.rejectedDeliveries} rejected deliveries/24h${data.kpis.externalWaits.capped ? " · Counts reached the scan limit" : ""}`}
        help="These handlers are suspended for a signal or human decision. Overdue waits remain critical until deadline maintenance resolves them."
        scope="now"
        color={data.kpis.externalWaits.overdue > 0 ? "red" : "teal"}
        icon={<Lightning size={16} />}
      />
    </Paper>
  );
}
export function ExternalWaitAlert({
  externalWaits,
  navigate,
}: {
  externalWaits: DashboardSystemPage["kpis"]["externalWaits"];
  navigate: (href: string) => void;
}) {
  if (externalWaits.overdue === 0) return null;

  return (
    <Alert color="red" icon={<WarningCircle size={18} />} title="External waits are overdue">
      <Group justify="space-between" align="center">
        <Text size="sm">
          A signal or human decision passed its deadline. Deadline maintenance will resolve the
          suspended task; review pending decisions that an operator can complete now.
        </Text>
        <Button color="red" variant="light" onClick={() => navigate("/tasks?filter=waiting")}>
          Review waiting tasks
        </Button>
      </Group>
    </Alert>
  );
}
export function RetryStorm({ data }: { data: DashboardSystemPage }) {
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
