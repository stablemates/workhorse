import type { DashboardWorkersPage } from "@stablemates/workhorse-dashboard-server/wire";
import {
  Alert,
  Badge,
  Box,
  Code,
  Group,
  Paper,
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
                  <Table.Th>Queues</Table.Th>
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
                        {worker.queues.length > 0 ? worker.queues.join(", ") : "—"}
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
        sets capacity, and the dashboard cannot change it. A draining worker stops after its active
        handlers finish. If a worker stops registering, Workhorse marks it offline and later removes
        it from the fleet.
      </Text>
    </Stack>
  );
}
