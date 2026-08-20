import type {
  DashboardEventsWindow,
  DashboardStorageRelation,
  DashboardSystemPage,
  DashboardSystemRetention,
  DashboardSystemStorage,
  DashboardSystemWindow,
} from "@workhorse-js/dashboard-server/wire";
import {
  Badge,
  Box,
  Center,
  Divider,
  Grid,
  Group,
  Loader,
  Paper,
  ScrollArea,
  SegmentedControl,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { Suspense } from "react";
import {
  ExternalWaitAlert,
  HelpButton,
  QueuePressure,
  RetryStorm,
  SystemKpiList,
  formatPercent,
  systemBucketLabel,
} from "../charts/system.js";
import {
  formatBytes,
  formatDay,
  formatExact,
  formatRelative,
  formatRows,
  formatSpan,
} from "../preferences.js";
import { SystemOutcomeChart, systemWindows } from "../core.js";
import { taskDisplayName } from "../components/task-list.js";

export function SystemPage({
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

      <ExternalWaitAlert externalWaits={data.kpis.externalWaits} navigate={navigate} />

      {/* Current pressure leads the page: the queue table and the condensed measures share one
          row, so the numbers sit next to the queues they describe. The measures come first in
          source order to read first on a phone, where the columns stack. */}
      <Grid gutter="xl">
        <Grid.Col span={{ base: 12, lg: 4 }} order={{ base: 1, lg: 1 }}>
          <SystemKpiList data={data} navigate={navigate} />
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
export const storageGroupLabels: Record<DashboardStorageRelation["group"], string> = {
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
export function StoragePanel({
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
export const eventsWindowOptions: ReadonlyArray<{
  value: DashboardEventsWindow;
  label: string;
}> = [
  { value: "15m", label: "15m" },
  { value: "1h", label: "1h" },
  { value: "6h", label: "6h" },
  { value: "24h", label: "24h" },
];
