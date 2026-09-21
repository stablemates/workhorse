import type { DashboardWorkersPage } from "@stablemates/workhorse-dashboard-server/wire";
import {
  ActionIcon,
  Anchor,
  Badge,
  Box,
  Code,
  Collapse,
  Group,
  HoverCard,
  List,
  Paper,
  Popover,
  ScrollArea,
  Stack,
  Switch,
  Table,
  Text,
  Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { CalendarBlank } from "@phosphor-icons/react";
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
function MetricHeader({
  label,
  title,
  windowLabel,
}: {
  label: string;
  title?: string;
  windowLabel?: string;
}) {
  return (
    <span className="dashboard-table__metric-header" title={title}>
      {label}
      {windowLabel === undefined ? null : (
        <Text c="dimmed" display="block" fw={500} fz={10} lh={1.3} span>
          {windowLabel}
        </Text>
      )}
    </span>
  );
}

/** The longest worker name the identity cell shows whole. */
const WORKER_NAME_LIMIT = 20;

/**
 * Shortens a long worker name from the middle.
 *
 * A generated name usually ends in the part that tells two workers apart, and a configured name
 * usually starts with it, so both ends stay and the dots replace the middle.
 */
function abbreviateWorkerName(id: string, limit = WORKER_NAME_LIMIT): string {
  if (id.length <= limit) return id;
  const tail = Math.floor((limit - 1) / 3);
  const head = limit - 1 - tail;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}

/**
 * The row identity: a worker name shortened from the middle with the full form in its title, and
 * the schedule namespaces the worker offers behind a calendar icon.
 *
 * A worker name is a stable configured string or a generated one, and either can run long. The
 * cell shortens it so the table fits a laptop viewport, and the title shows the full name.
 * Placement is reported separately from identity, so a worker with a stable configured name still
 * says which host and process it is.
 */
function WorkerIdentity({ worker }: { worker: DashboardWorkersPage["workers"][number] }) {
  const namespaces = worker.scheduleNamespaces;
  const placement = worker.hostname ? `${worker.hostname} · pid ${worker.pid}` : null;
  return (
    <Stack className="workers-table__identity" gap={2}>
      <Box className="workers-table__name" title={worker.id}>
        <Code
          fz="xs"
          style={{
            background: "transparent",
            paddingBlock: 0,
            paddingInline: 0,
          }}
        >
          {abbreviateWorkerName(worker.id)}
        </Code>
      </Box>
      {/* The placement line also carries the schedule icon and the pause badge, so the name line
        stays a name. The badge never shrinks; the placement text gives way instead. */}
      {placement === null && namespaces.length === 0 && !worker.paused ? null : (
        <Group gap={4} wrap="nowrap">
          {placement === null ? null : (
            <Text c="dimmed" fz="xs" style={{ minWidth: 0 }} title={placement} truncate>
              {placement}
            </Text>
          )}
          {namespaces.length === 0 ? null : (
            <HoverCard width={320} position="bottom-start" withArrow shadow="md">
              <HoverCard.Target>
                <ActionIcon
                  aria-label={`${worker.id} offers ${namespaces.join(", ")}`}
                  color="gray"
                  size="xs"
                  style={{ flexShrink: 0 }}
                  variant="subtle"
                >
                  <CalendarBlank size={13} />
                </ActionIcon>
              </HoverCard.Target>
              <HoverCard.Dropdown>
                <Text fw={600} size="sm">
                  Schedules
                </Text>
                <Text mt={4} size="sm" style={{ overflowWrap: "anywhere" }}>
                  {namespaces.join(", ")}
                </Text>
                <Text c="dimmed" mt={4} size="xs">
                  These are the schedule namespaces this worker offers. Several workers can offer
                  the same namespace safely because PostgreSQL creates each occurrence once.
                </Text>
              </HoverCard.Dropdown>
            </HoverCard>
          )}
          {worker.paused ? (
            <HoverCard width={300} position="bottom-start" withArrow shadow="md">
              <HoverCard.Target>
                <Badge
                  aria-label={`${worker.id} is paused: it finishes active tasks and accepts no new ones`}
                  color="yellow"
                  size="xs"
                  style={{ flexShrink: 0 }}
                  variant="light"
                >
                  Paused
                </Badge>
              </HoverCard.Target>
              <HoverCard.Dropdown>
                <Text fw={600} size="sm">
                  This worker accepts no new tasks
                </Text>
                <Text c="dimmed" mt={4} size="xs">
                  Someone paused this worker instance from the Claims toggle. It finishes the tasks
                  it already holds and claims nothing new. A restart, or a deploy that replaces it,
                  clears the pause. If work must stay paused, pause the queue instead.
                </Text>
              </HoverCard.Dropdown>
            </HoverCard>
          ) : null}
        </Group>
      )}
    </Stack>
  );
}

/** The page notes, shown when the link at the end of the page description is open. */
function ReadingNotes({ opened }: { opened: boolean }) {
  return (
    <Collapse expanded={opened} keepMountedMode="display-none">
      <List c="dimmed" size="sm" spacing="xs">
        <List.Item>
          This page covers the whole fleet because workers register with Workhorse.
        </List.Item>
        <List.Item>
          A worker reports busy slots, while Workhorse counts active tasks, so the values can differ
          briefly.
        </List.Item>
        <List.Item>Startup sets capacity, and the dashboard cannot change it.</List.Item>
        <List.Item>
          A Claims pause applies to this worker instance; a restart or deploy that replaces it
          clears the pause. Pause the queue when work must stay paused.
        </List.Item>
        <List.Item>A draining worker stops after its active handlers finish.</List.Item>
        <List.Item>
          If a worker stops registering, Workhorse marks it offline and later removes it from the
          fleet.
        </List.Item>
        <List.Item>
          During a deploy, the Started column separates a replacement worker from the instance it
          sunsets.
        </List.Item>
      </List>
    </Collapse>
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
  const [notesOpened, { toggle: toggleNotes }] = useDisclosure(false);
  return (
    <Stack gap="xl">
      <Stack gap="xs">
        <PageHeader
          title="Workers"
          description={
            <>
              See each worker's capacity, current claims, and recent attempt results.{" "}
              <Anchor
                component="button"
                type="button"
                fz="inherit"
                underline="always"
                aria-expanded={notesOpened}
                onClick={toggleNotes}
              >
                {notesOpened ? "Hide the reading notes" : "How to read this page"}
              </Anchor>
            </>
          }
        />
        <ReadingNotes opened={notesOpened} />
      </Stack>
      <Stack gap="xs">
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
                miw={880}
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
                    <Table.Th>Status</Table.Th>
                    <Table.Th>Claims</Table.Th>
                    <Table.Th ta="right">
                      <MetricHeader label="Busy slots" />
                    </Table.Th>
                    <Table.Th ta="right">
                      <MetricHeader label="Active" title="Active tasks Workhorse counts" />
                    </Table.Th>
                    <Table.Th ta="right">
                      <MetricHeader label="Attempts" windowLabel="1h" />
                    </Table.Th>
                    <Table.Th ta="right">
                      <MetricHeader label="Failures" windowLabel="1h" />
                    </Table.Th>
                    <Table.Th ta="right">
                      <MetricHeader
                        label="Avg exec"
                        title="Average execution time over the last hour"
                        windowLabel="1h"
                      />
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
                          <WorkerIdentity worker={worker} />
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
                          {worker.queues.length === 0 ? (
                            "—"
                          ) : (
                            <Stack gap={0}>
                              {worker.queues.map((queue) => (
                                <Text key={queue} size="sm">
                                  {queue}
                                </Text>
                              ))}
                            </Stack>
                          )}
                        </Table.Td>
                        <Table.Td>
                          <Group gap={6} wrap="nowrap">
                            <StatusBadge state={status} />
                            {worker.draining ? (
                              <Badge color="orange" style={{ flexShrink: 0 }} variant="light">
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
      </Stack>
    </Stack>
  );
}
