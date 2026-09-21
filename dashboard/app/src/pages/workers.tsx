import type { DashboardWorkersPage } from "@stablemates/workhorse-dashboard-server/wire";
import {
  Badge,
  Box,
  Code,
  Group,
  Paper,
  Popover,
  ScrollArea,
  Stack,
  Switch,
  Table,
  Text,
  Tooltip,
} from "@mantine/core";
import { StatusBadge } from "../status-badge.js";
import { EmptyState, PageHeader } from "../components/task-list.js";
import { formatDuration, formatExact, formatRelative } from "../preferences.js";
import { workerStatus } from "../presentation-policy.js";
import { HelpButton } from "../components/help-button.js";

/**
 * A right-aligned metric header that may wrap.
 *
 * The counts under these columns are a few characters wide, so the header decides how much width
 * the column takes. Wrapping the label and dropping the window onto its own line keeps both
 * readable while the column follows one word instead of a whole phrase.
 */
function MetricHeader({ label, windowLabel }: { label: string; windowLabel?: string }) {
  return (
    <span className="dashboard-table__metric-header">
      {label}
      {windowLabel === undefined ? null : (
        <Text c="dimmed" display="block" fw={500} fz={10} lh={1.3} span>
          {windowLabel}
        </Text>
      )}
    </span>
  );
}

export function WorkersPage({
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
      {data.workers.length === 0 ? (
        <EmptyState>No worker has reported activity.</EmptyState>
      ) : (
        <Paper withBorder>
          <ScrollArea
            type="auto"
            offsetScrollbars="x"
            viewportProps={{ tabIndex: 0, role: "region", "aria-label": "Workers table" }}
          >
            <Table
              highlightOnHover
              verticalSpacing={6}
              horizontalSpacing="md"
              className="dashboard-table dashboard-table--workers"
              miw={1080}
            >
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Worker</Table.Th>
                  <Table.Th>
                    <Group gap={4} wrap="nowrap">
                      <span>SDK</span>
                      <HelpButton
                        label="SDK"
                        help="The client library each worker reported at its last registration. A rolling deploy runs more than one build at once, so this is where a worker behaving differently from its peers first shows up."
                      />
                    </Group>
                  </Table.Th>
                  <Table.Th>Queues</Table.Th>
                  <Table.Th>
                    <Group gap={4} wrap="nowrap">
                      <span>Schedules</span>
                      <HelpButton
                        label="Schedules"
                        help="These are the schedule namespaces this worker offers. Several workers can offer the same namespace safely because PostgreSQL creates each occurrence once."
                      />
                    </Group>
                  </Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Claims</Table.Th>
                  <Table.Th ta="right">
                    <MetricHeader label="Busy slots" />
                  </Table.Th>
                  <Table.Th ta="right">
                    <MetricHeader label="Active tasks" />
                  </Table.Th>
                  <Table.Th ta="right">
                    <MetricHeader label="Attempts" windowLabel="1h" />
                  </Table.Th>
                  <Table.Th ta="right">
                    <MetricHeader label="Failures" windowLabel="1h" />
                  </Table.Th>
                  <Table.Th ta="right">
                    <MetricHeader label="Avg execution" windowLabel="1h" />
                  </Table.Th>
                  <Table.Th>
                    <Group gap={4} wrap="nowrap">
                      <span>Started</span>
                      <HelpButton
                        label="Started"
                        help="When this worker process announced itself. During a rolling deploy the replacement workers carry young start times, while the instances they sunset keep their old ones and drain or go offline."
                      />
                    </Group>
                  </Table.Th>
                  <Table.Th>Last seen</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data.workers.map((worker) => {
                  const status = workerStatus(worker, data.capturedAt);
                  return (
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
                        {/* A worker running an SDK older than these columns reports neither, which
                          is itself the answer to "which build is that". */}
                        {worker.sdkLanguage === null && worker.sdkVersion === null ? (
                          <Text c="dimmed" size="sm" title="This worker reported no SDK identity">
                            —
                          </Text>
                        ) : (
                          <Stack gap={2}>
                            <Text size="sm">{worker.sdkLanguage ?? "unknown"}</Text>
                            <Text c="dimmed" fz="xs">
                              {worker.sdkVersion ?? "unknown version"}
                            </Text>
                          </Stack>
                        )}
                      </Table.Td>
                      <Table.Td>
                        {worker.queues.length > 0 ? worker.queues.join(", ") : "—"}
                      </Table.Td>
                      {/* Almost every worker offers one namespace, so the column shows the first
                        one and counts the rest instead of reserving width for a list. The cell
                        carries the whole list, which "+2" alone does not say. */}
                      <Table.Td
                        aria-label={
                          worker.scheduleNamespaces.length === 0
                            ? `${worker.id} offers no schedule namespace`
                            : `${worker.id} offers ${worker.scheduleNamespaces.join(", ")}`
                        }
                      >
                        {worker.scheduleNamespaces.length === 0 ? (
                          <Text c="dimmed" size="sm">
                            —
                          </Text>
                        ) : (
                          <Group gap={4} title={worker.scheduleNamespaces.join(", ")} wrap="nowrap">
                            <Text size="sm" style={{ minWidth: 0 }} truncate>
                              {worker.scheduleNamespaces[0]}
                            </Text>
                            {worker.scheduleNamespaces.length > 1 ? (
                              <Text c="dimmed" fz="xs">
                                +{worker.scheduleNamespaces.length - 1}
                              </Text>
                            ) : null}
                          </Group>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Group gap={6} wrap="nowrap">
                          <StatusBadge state={status} />
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
                        {worker.draining ? (
                          <Text
                            c="dimmed"
                            size="sm"
                            title="This worker is draining, so it already accepts no new claims"
                            aria-label={`${worker.id} is draining and accepts no new claims`}
                          >
                            No new claims
                          </Text>
                        ) : status === "offline" ? (
                          <Text
                            c="dimmed"
                            size="sm"
                            title="This worker is offline, so a pause cannot reach it"
                            aria-label={`${worker.id} is offline, so claims cannot be paused`}
                          >
                            —
                          </Text>
                        ) : (
                          <Popover
                            disabled={!data.canManageWorkers}
                            width={300}
                            position="bottom"
                            withArrow
                            shadow="md"
                          >
                            <Popover.Target>
                              <Box component="span" display="inline-block">
                                <Tooltip
                                  label="Worker controls are unavailable in read-only mode"
                                  disabled={data.canManageWorkers}
                                >
                                  <Switch
                                    size="sm"
                                    checked={!worker.paused}
                                    disabled={
                                      !data.canManageWorkers || togglingWorker === worker.id
                                    }
                                    aria-label={`${worker.paused ? "Resume" : "Pause"} ${worker.id}`}
                                    onChange={(event) =>
                                      setWorkerPaused(worker.id, !event.currentTarget.checked)
                                    }
                                  />
                                </Tooltip>
                              </Box>
                            </Popover.Target>
                            <Popover.Dropdown>
                              <Text fw={600} size="sm">
                                Pausing a worker affects only this process
                              </Text>
                              <Text c="dimmed" mt={4} size="xs">
                                A paused worker finishes active tasks but accepts no new ones. If
                                the process restarts or a deploy replaces it, the new instance
                                resumes automatically. If work must stay paused, pause the queue
                                instead.
                              </Text>
                            </Popover.Dropdown>
                          </Popover>
                        )}
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
                      <Table.Td ta="right">{worker.activeTasks}</Table.Td>
                      <Table.Td ta="right">{worker.completedAttempts}</Table.Td>
                      <Table.Td ta="right">
                        <Text c={worker.failedAttempts > 0 ? "red.7" : undefined} size="sm">
                          {worker.failedAttempts}
                        </Text>
                      </Table.Td>
                      <Table.Td ta="right">{formatDuration(worker.averageExecutionMs)}</Table.Td>
                      <Table.Td>
                        {worker.startedAt === null ? (
                          <Text
                            c="dimmed"
                            size="xs"
                            title="This worker has never registered, so its start time is unknown"
                          >
                            —
                          </Text>
                        ) : (
                          <Text c="dimmed" size="xs" title={formatExact(worker.startedAt)}>
                            {formatRelative(worker.startedAt)}
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Text c="dimmed" size="xs" title={formatExact(worker.lastSeenAt)}>
                          {formatRelative(worker.lastSeenAt)}
                        </Text>
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
        This page covers the whole fleet because workers register with Workhorse. A worker reports
        busy slots, while Workhorse counts active tasks, so the values can differ briefly. Startup
        sets capacity, and the dashboard cannot change it. A Claims pause applies to this worker
        instance; a restart or deploy that replaces it clears the pause. Pause the queue when work
        must stay paused. A draining worker stops after its active handlers finish. If a worker
        stops registering, Workhorse marks it offline and later removes it from the fleet. During a
        deploy, the Started column separates a replacement worker from the instance it sunsets.
      </Text>
    </Stack>
  );
}
