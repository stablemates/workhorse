import type {
  DashboardSystemPage,
  DashboardSystemRetention,
  DashboardSystemStorage,
  DashboardSystemWindow,
} from "@stablemates/workhorse-dashboard-server/wire";
import {
  Badge,
  Box,
  Center,
  Divider,
  Grid,
  Group,
  Loader,
  ScrollArea,
  SegmentedControl,
  Stack,
  Table,
  Text,
} from "@mantine/core";
import { Suspense, type ReactNode } from "react";
import {
  ExternalWaitAlert,
  QueueActivity,
  QueuePressure,
  RetryStorm,
  SystemKpiList,
  SystemWindowKpis,
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
import { BudgetsTable, budgetCappedFootnote } from "../budgets-table.js";
import { HelpButton } from "../components/help-button.js";
import { EmptyState } from "../components/empty-state.js";
import { Page, PageHeader, PageSection } from "../components/page-header.js";
import { dangerTextColor, warningTextColor } from "../status-colors.js";
import { StatusLabel } from "../status-badge.js";
import { SystemHealthChecks } from "../components/system-health-checks.js";
import { taskDisplayName } from "../components/task-list.js";
import { presentStorageRelation, retentionCategoryLabels } from "../presentation-policy.js";
import { formatCount } from "../count-format.js";
import { PendingResults, usePagePending } from "../pending-results.js";

export function SystemPage({
  data,
  requestedWindow = data.window,
  setWindow,
  navigate,
}: {
  data: DashboardSystemPage;
  /**
   * The window that the control names. It can differ from `data.window` while the new window
   * loads, so the control moves on the click and the metrics follow when they arrive.
   */
  requestedWindow?: DashboardSystemWindow;
  setWindow: (window: DashboardSystemWindow) => void;
  navigate: (href: string) => void;
}) {
  const pending = usePagePending() && requestedWindow !== data.window;
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
    retention.defaultHistoryRows.taskEvents + retention.defaultHistoryRows.attemptHistory;
  const eligiblePartitions =
    retention.eligibleHistoryPartitions.taskEvents +
    retention.eligibleHistoryPartitions.attemptHistory;
  const enabledRetention = retention.categories.filter((row) => row.retentionDays !== null);
  const retentionDetail =
    enabledRetention.length === 0
      ? "No category is set to delete history, so nothing can fall behind."
      : enabledRetention
          .map(
            (row) =>
              `${retentionCategoryLabels[row.category]}: keeps ${row.retentionDays} days, ${
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
  const retentionBehind = data.status.reasons.some((reason) => reason.code === "retention-lag");

  return (
    <Page>
      <PageHeader
        title="System health"
        titleAside={
          <HelpButton
            label="System health"
            help="Each check reports whether work or maintenance needs attention. Rate limits, concurrency limits, and shared budgets protect capacity as configured."
          />
        }
        description={
          data.pausedQueues.length > 0 ? (
            <Group component="span" gap={6}>
              <span>Paused queues:</span>
              {data.pausedQueues.map((queue) => (
                <Badge key={queue} color="yellow" variant="light" size="sm" tt="none">
                  {queue}
                </Badge>
              ))}
            </Group>
          ) : undefined
        }
        actions={
          <Text c="dimmed" size="sm" title={formatExact(data.capturedAt)}>
            Captured {formatRelative(data.capturedAt)}
          </Text>
        }
      />

      <SystemHealthChecks reasons={data.status.reasons} />

      <ExternalWaitAlert externalWaits={data.kpis.externalWaits} navigate={navigate} />

      <PageSection
        id="system-activity-title"
        title="Activity over time"
        description="Metrics in this section use the selected time range. They include full-tier and fast-tier queues."
        actions={
          <SegmentedControl
            aria-label="Activity time range"
            aria-controls="system-activity-metrics"
            size="xs"
            value={requestedWindow}
            onChange={(value) => setWindow(value as DashboardSystemWindow)}
            data={systemWindows.map((value) => ({ value, label: value }))}
          />
        }
      >
        <PendingResults pending={pending}>
          <Stack id="system-activity-metrics" gap="lg">
            <Grid gap="lg">
              <Grid.Col span={{ base: 12, lg: 4 }}>
                <SystemWindowKpis data={data} />
              </Grid.Col>
              <Grid.Col span={{ base: 12, lg: 8 }}>
                {/* A flex column lets the chart absorb whatever height the measures column sets,
              so the panel never shows dead space under the plot. */}
                <Box
                  className="panel panel--padded"
                  h="100%"
                  style={{ display: "flex", flexDirection: "column" }}
                >
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
                  </Group>
                  <Box mih={320} style={{ flex: 1 }}>
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
                </Box>
              </Grid.Col>
            </Grid>

            <QueueActivity data={data} navigate={navigate} />

            <Box className="panel data-table__panel">
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
                <EmptyState framed={false} title="No failed attempts">
                  No attempt failed in the last {data.window}. Choose a longer time range to look
                  further back.
                </EmptyState>
              ) : (
                <ScrollArea
                  type="auto"
                  offsetScrollbars="x"
                  viewportProps={{
                    tabIndex: 0,
                    role: "region",
                    "aria-label": "Task types with failures table",
                  }}
                >
                  <Table highlightOnHover className="data-table" miw={760}>
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
                          <Table.Td ta="right">{formatCount(type.attempts)}</Table.Td>
                          <Table.Td ta="right">
                            <Text
                              c={type.errorRate >= 0.05 ? dangerTextColor : warningTextColor}
                              size="sm"
                            >
                              {formatPercent(type.errorRate)}
                            </Text>
                          </Table.Td>
                          <Table.Td ta="right">{formatCount(type.terminalFailures)}</Table.Td>
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
            </Box>
          </Stack>
        </PendingResults>
      </PageSection>

      <PageSection
        id="system-current-title"
        title="Current operations"
        description="A snapshot at the latest refresh. Queue state, retries, maintenance, and storage are independent of the time range."
      >
        <SystemKpiList data={data} navigate={navigate} />
        <QueuePressure data={data} navigate={navigate} />
        {data.budgets.length === 0 ? null : <BudgetsTable budgets={data.budgets} />}
        {data.budgetsCapped ? <p className="page-footnote">{budgetCappedFootnote}</p> : null}

        {/* The retry outlook and the maintenance checks both answer "what happens next". */}
        <Grid gap="lg">
          <Grid.Col span={{ base: 12, lg: 5 }}>
            <RetryStorm data={data} />
          </Grid.Col>
          <Grid.Col span={{ base: 12, lg: 7 }}>
            <Box className="panel" p="md" h="100%">
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
                <MeasuredValue tone={data.integrity.dueButUnpromoted > 0 ? "danger" : null}>
                  {formatCount(data.integrity.dueButUnpromoted)}
                </MeasuredValue>
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
                        <StatusLabel
                          state={partition.eventExists ? "succeeded" : "failed"}
                          text={partition.eventExists ? "Ready" : "Missing"}
                          label={`Task events: ${partition.eventExists ? "ready" : "missing"}`}
                        />
                      </Table.Td>
                      <Table.Td ta="center">
                        <StatusLabel
                          state={partition.attemptExists ? "succeeded" : "failed"}
                          text={partition.attemptExists ? "Ready" : "Missing"}
                          label={`Attempt history: ${partition.attemptExists ? "ready" : "missing"}`}
                        />
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
                              )?.category
                                ? retentionCategoryLabels[retention.maxLagCategory!]
                                : retention.maxLagCategory
                            }`}
                    </Text>
                  </Box>
                  <MeasuredValue tone={retentionBehind ? "warning" : null} title={retentionDetail}>
                    {enabledRetention.length === 0
                      ? "Not applicable"
                      : retention.maxLagMs === null || retention.maxLagMs === 0
                        ? "On time"
                        : `${formatSpan(retention.maxLagMs)} behind`}
                  </MeasuredValue>
                </Group>
                <Group justify="space-between" wrap="nowrap" align="flex-start">
                  <Box>
                    <Text size="sm" fw={600}>
                      Oldest retained
                    </Text>
                    <Text c="dimmed" size="xs">
                      {oldestRetained
                        ? retentionCategoryLabels[oldestRetained.category]
                        : "No history retained yet"}
                    </Text>
                  </Box>
                  <MeasuredValue title={formatExact(retention.oldestRetainedAt ?? undefined)}>
                    {retention.oldestRetainedAt === null
                      ? "—"
                      : formatRelative(retention.oldestRetainedAt)}
                  </MeasuredValue>
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
                  <MeasuredValue
                    tone={eligiblePartitions > 0 ? "warning" : null}
                    title={`${formatCount(retention.eligibleHistoryPartitions.taskEvents)} task-event days, ${formatCount(retention.eligibleHistoryPartitions.attemptHistory)} attempt-history days`}
                  >
                    {formatCount(retention.eligibleHistoryPartitions.taskEvents)} events ·{" "}
                    {formatCount(retention.eligibleHistoryPartitions.attemptHistory)} attempts
                  </MeasuredValue>
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
                  <MeasuredValue tone={defaultSpill > 0 ? "warning" : null}>
                    {formatCount(retention.defaultHistoryRows.taskEvents)}
                    {retention.defaultHistoryRowsCapped.taskEvents ? "+" : ""} events ·{" "}
                    {formatCount(retention.defaultHistoryRows.attemptHistory)}
                    {retention.defaultHistoryRowsCapped.attemptHistory ? "+" : ""} attempts
                  </MeasuredValue>
                </Group>
              </Stack>
            </Box>
          </Grid.Col>
        </Grid>

        <StoragePanel storage={data.integrity.storage} retention={retention} />
      </PageSection>
    </Page>
  );
}
/**
 * A measured value beside its label, such as "On time" or "1.6 MB". It is plain text, not a badge.
 * Only a value that needs attention takes a status color.
 */
function MeasuredValue({
  tone = null,
  title,
  children,
}: {
  tone?: "warning" | "danger" | null;
  title?: string;
  children: ReactNode;
}) {
  return (
    <Text
      component="span"
      size="sm"
      fw={500}
      c={tone === "danger" ? dangerTextColor : tone === "warning" ? warningTextColor : undefined}
      title={title}
      style={{ flexShrink: 0, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}
    >
      {children}
    </Text>
  );
}

export const storageGroupLabels: Record<"tasks" | "history" | "statistics", string> = {
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
    <Box className="panel" p="md">
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
      {/* The rollup summary sits above the table as label-and-badge rows. The block keeps a
          reading width instead of stretching to the panel, so a badge never drifts far from
          the label it measures. */}
      <Stack gap="md" maw={440} mb="lg">
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
          <MeasuredValue
            tone={rollup.stalled ? "warning" : null}
            title={`Summarized through ${formatExact(rollup.rolledUpThrough)}`}
          >
            {rollup.stalled ? `${formatSpan(rollup.lagMs)} behind` : "Up to date"}
          </MeasuredValue>
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
          <MeasuredValue>{formatRows(rollup.buckets)}</MeasuredValue>
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
          <MeasuredValue>
            {statisticsRetention?.retentionDays === null ||
            statisticsRetention?.retentionDays === undefined
              ? "Forever"
              : `${statisticsRetention.retentionDays} days`}
          </MeasuredValue>
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
          <MeasuredValue>{formatBytes(storage.totalBytes)}</MeasuredValue>
        </Group>
      </Stack>
      <Divider mb="md" />
      <Table verticalSpacing={6} horizontalSpacing="xs" captionSide="top">
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
          {storage.relations.map((rawRow) => {
            const row = presentStorageRelation(rawRow);
            return (
              <Table.Tr key={row.relation}>
                <Table.Th scope="row" fw={400}>
                  <Text size="xs" title={row.relation}>
                    {row.label}
                  </Text>
                  {row.partitions > 0 ? (
                    <Text c="dimmed" fz={10}>
                      {formatCount(row.partitions)} daily {row.partitions === 1 ? "part" : "parts"}
                    </Text>
                  ) : null}
                </Table.Th>
                <Table.Td>
                  <Text c="dimmed" size="xs">
                    {storageGroupLabels[row.group]}
                  </Text>
                </Table.Td>
                <Table.Td ta="right">
                  <Text size="xs" title={`${row.tableBytes} B table, ${row.indexBytes} B index`}>
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
            );
          })}
        </Table.Tbody>
      </Table>
    </Box>
  );
}
