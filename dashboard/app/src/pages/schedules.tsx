import type { DashboardCronPage } from "@stablemates/workhorse-dashboard-server/wire";
import { ArrowSquareOut } from "@phosphor-icons/react";
import {
  Anchor,
  Badge,
  Button,
  Code,
  Group,
  Modal,
  Paper,
  ScrollArea,
  Stack,
  Table,
  Text,
  Tooltip,
} from "@mantine/core";
import { Fragment, useState } from "react";
import { useConfirmationActivity } from "../dropdown-activity.js";
import { statusColor } from "../status-colors.js";
import { HelpButton } from "../charts/system.js";
import { EmptyState, PageHeader } from "../components/task-list.js";
import { formatDuration, formatExact, formatRelative } from "../preferences.js";
import { presentSchedules } from "../presentation-policy.js";

export const resumeScheduleWarnings = {
  skip: "Workhorse will skip occurrences missed while this schedule was paused. The next occurrence will fire on schedule. Tasks already enqueued are unchanged.",
  latest:
    "Workhorse may enqueue the most recent missed occurrence as soon as a worker evaluates this schedule. Earlier missed occurrences will be skipped. Tasks already enqueued are unchanged.",
  all: "Workhorse may enqueue missed occurrences in bounded batches as soon as a worker evaluates this schedule. It will continue until the schedule catches up. Tasks already enqueued are unchanged.",
} as const;

export function MaintenanceRunHistory({
  runs,
}: {
  runs: NonNullable<ReturnType<typeof presentSchedules>[number]["maintenance"]>["runs"];
}) {
  return (
    <Stack gap="xs" p="sm">
      {runs.map((run) => (
        <Paper key={run.id} withBorder p="sm">
          <Group justify="space-between" align="flex-start" wrap="wrap" gap="xs">
            <Group gap="xs">
              <Badge
                color={
                  run.outcome === "succeeded"
                    ? "green"
                    : run.outcome === "failed"
                      ? "red"
                      : "yellow"
                }
                variant="light"
              >
                {run.outcome}
              </Badge>
              <Text size="sm" title={formatExact(run.startedAt)}>
                {formatRelative(run.startedAt)}
              </Text>
            </Group>
            <Text c="dimmed" size="xs">
              {formatDuration(run.durationMs)} · {run.rowsAffected} rows affected
            </Text>
          </Group>
          <Group gap="xs" mt="xs" wrap="wrap">
            {run.phases.map((phase) => (
              <Code key={phase.phase} fz="xs">
                {phase.phase.replaceAll("_", " ")} · {phase.rowsAffected} rows ·{" "}
                {formatDuration(phase.durationMs)}
              </Code>
            ))}
          </Group>
          {run.phases.map((phase) =>
            phase.error === null ? null : (
              <Text key={`${phase.phase}-error`} c="red" size="xs" mt="xs">
                {phase.phase.replaceAll("_", " ")}: {phase.error.message} ({phase.error.code})
              </Text>
            ),
          )}
        </Paper>
      ))}
    </Stack>
  );
}

export function CronPage({
  data,
  togglingSchedule,
  setSchedulePaused,
  taskTypeHref,
}: {
  data: DashboardCronPage;
  togglingSchedule: string | null;
  setSchedulePaused: (namespace: string, name: string, paused: boolean) => void;
  taskTypeHref: (taskType: string) => string;
}) {
  const schedules = presentSchedules(data);
  const [expandedMaintenance, setExpandedMaintenance] = useState<string | null>(null);
  const [confirmingResume, setConfirmingResume] = useState<{
    namespace: string;
    name: string;
    catchupPolicy: "skip" | "latest" | "all";
  } | null>(null);
  useConfirmationActivity(confirmingResume !== null);
  return (
    <Stack gap="xl">
      <Modal
        opened={confirmingResume !== null}
        onClose={() => setConfirmingResume(null)}
        title="Resume schedule?"
        centered
      >
        <Text size="sm">{resumeScheduleWarnings[confirmingResume?.catchupPolicy ?? "skip"]}</Text>
        {confirmingResume ? (
          <Code block mt="sm">
            {confirmingResume.namespace}/{confirmingResume.name}
          </Code>
        ) : null}
        <Group justify="flex-end" mt="lg">
          <Button variant="default" onClick={() => setConfirmingResume(null)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (!confirmingResume) return;
              setSchedulePaused(confirmingResume.namespace, confirmingResume.name, false);
              setConfirmingResume(null);
            }}
          >
            Resume schedule
          </Button>
        </Group>
      </Modal>
      <PageHeader
        title="Schedules"
        description="See when recurring tasks run and where Workhorse sends them."
      />
      {schedules.length === 0 ? (
        <EmptyState>Workhorse has no recurring schedules.</EmptyState>
      ) : (
        <Paper withBorder>
          <ScrollArea
            type="auto"
            offsetScrollbars="x"
            viewportProps={{ tabIndex: 0, role: "region", "aria-label": "Schedules table" }}
          >
            <Table
              highlightOnHover
              verticalSpacing={6}
              horizontalSpacing="xs"
              className="dashboard-table dashboard-table--schedules"
              miw={800}
            >
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Schedule</Table.Th>
                  <Table.Th>Expression</Table.Th>
                  <Table.Th>Destination</Table.Th>
                  <Table.Th>
                    <Group gap={4} wrap="nowrap">
                      <span>Evaluators</span>
                      <HelpButton
                        label="Evaluators"
                        help="Live workers that offer this schedule namespace. Several evaluators are safe; if none are live, the schedule waits until one returns."
                      />
                    </Group>
                  </Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Last run</Table.Th>
                  <Table.Th ta="right">Runs</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {schedules.map((schedule) => {
                  const scheduleKey = `${schedule.namespace}:${schedule.name}`;
                  const recordedRunCount = schedule.maintenance?.recordedRunCount ?? 0;
                  const runsExpanded = expandedMaintenance === scheduleKey;
                  const maintenanceStatus = schedule.maintenance?.status ?? "scheduled";
                  const lastRunAt =
                    schedule.maintenance?.lastCompletedAt ??
                    schedule.maintenance?.lastStartedAt ??
                    schedule.lastFiredAt;
                  return (
                    <Fragment key={scheduleKey}>
                      <Table.Tr>
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
                          <Tooltip
                            label={
                              schedule.kind === "system"
                                ? "Workers offer this maintenance directly to PostgreSQL. It is not sent to a queue and does not need a handler."
                                : `Tasks of type ${schedule.type} go to the ${schedule.queue} queue at priority ${schedule.priority}.`
                            }
                            multiline
                            maw={360}
                            withArrow
                            events={{ hover: true, focus: true, touch: true }}
                          >
                            <Text
                              component="span"
                              tabIndex={0}
                              size="sm"
                              c="dimmed"
                              aria-label={
                                schedule.kind === "system"
                                  ? "Maintenance: Workers offer this maintenance directly to PostgreSQL. It is not sent to a queue and does not need a handler."
                                  : `Destination: ${schedule.queue}, priority ${schedule.priority}, task type ${schedule.type}`
                              }
                            >
                              {schedule.kind === "system" ? "Maintenance" : schedule.queue}
                            </Text>
                          </Tooltip>
                        </Table.Td>
                        <Table.Td>
                          {schedule.kind === "system" ? (
                            <Tooltip
                              label="Every worker can offer this PostgreSQL maintenance routine. Advisory locks and persisted due state coordinate concurrent offers."
                              multiline
                              maw={360}
                              withArrow
                              events={{ hover: true, focus: true, touch: true }}
                            >
                              <Text
                                component="span"
                                c="dimmed"
                                size="sm"
                                tabIndex={0}
                                aria-label="All workers can offer this maintenance routine"
                              >
                                All
                              </Text>
                            </Tooltip>
                          ) : (
                            <Tooltip
                              label={
                                schedule.evaluatorCount === 0
                                  ? "No live workers offer this schedule namespace."
                                  : `${schedule.evaluatorCount} live ${schedule.evaluatorCount === 1 ? "worker offers" : "workers offer"} this schedule namespace.`
                              }
                              withArrow
                              events={{ hover: true, focus: true, touch: true }}
                            >
                              <Badge
                                color={schedule.evaluatorCount === 0 ? "red" : "gray"}
                                variant="light"
                                tabIndex={0}
                                aria-label={
                                  schedule.evaluatorCount === 0
                                    ? "No workers"
                                    : `${schedule.evaluatorCount} ${schedule.evaluatorCount === 1 ? "worker" : "workers"}`
                                }
                              >
                                {schedule.evaluatorCount === 0 ? "None" : schedule.evaluatorCount}
                              </Badge>
                            </Tooltip>
                          )}
                        </Table.Td>
                        <Table.Td>
                          {schedule.kind === "user" ? (
                            !schedule.configuredEnabled && !schedule.paused ? (
                              <Tooltip
                                label="Disabled by deployment configuration. Change the schedule definition and deploy to activate it."
                                multiline
                                maw={320}
                                withArrow
                              >
                                <Badge color="gray" variant="light" tabIndex={0}>
                                  Config off
                                </Badge>
                              </Tooltip>
                            ) : (
                              <Tooltip
                                label={
                                  schedule.paused
                                    ? `Paused by ${schedule.pausedBy ?? "an operator"}. This pause survives deploys until an operator resumes it.`
                                    : "Pause this schedule until an operator resumes it. The pause survives deploys."
                                }
                                multiline
                                maw={320}
                                withArrow
                              >
                                <Button
                                  size="compact-xs"
                                  variant={schedule.paused ? "light" : "subtle"}
                                  color={schedule.paused ? "yellow" : "gray"}
                                  loading={togglingSchedule === scheduleKey}
                                  aria-label={`${schedule.paused ? "Resume" : "Pause"} ${schedule.name}`}
                                  onClick={() => {
                                    if (schedule.paused) {
                                      setConfirmingResume({
                                        namespace: schedule.namespace,
                                        name: schedule.name,
                                        catchupPolicy: schedule.catchupPolicy,
                                      });
                                    } else {
                                      setSchedulePaused(schedule.namespace, schedule.name, true);
                                    }
                                  }}
                                >
                                  {schedule.paused ? "Resume" : "Pause"}
                                </Button>
                              </Tooltip>
                            )
                          ) : (
                            <Tooltip
                              label={
                                maintenanceStatus === "scheduled"
                                  ? "The routine completed normally and is not due yet."
                                  : maintenanceStatus === "incomplete"
                                    ? "The last bounded pass left eligible work for a later run."
                                    : "The routine is eligible to run when a worker next offers it."
                              }
                              multiline
                              maw={320}
                              withArrow
                              events={{ hover: true, focus: true, touch: true }}
                            >
                              <Badge
                                color={
                                  maintenanceStatus === "scheduled"
                                    ? "green"
                                    : statusColor(maintenanceStatus)
                                }
                                variant="light"
                                role="status"
                                tabIndex={0}
                                aria-label={`Status: ${maintenanceStatus}`}
                              >
                                {maintenanceStatus === "scheduled"
                                  ? "OK"
                                  : maintenanceStatus === "incomplete"
                                    ? "Partial"
                                    : "Due"}
                              </Badge>
                            </Tooltip>
                          )}
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm" c="dimmed" title={formatExact(lastRunAt)}>
                            {lastRunAt ? formatRelative(lastRunAt) : "never"}
                          </Text>
                        </Table.Td>
                        <Table.Td ta="right">
                          {schedule.kind === "system" ? (
                            recordedRunCount === 0 ? (
                              "—"
                            ) : (
                              <Button
                                size="compact-xs"
                                variant="subtle"
                                aria-expanded={runsExpanded}
                                onClick={() =>
                                  setExpandedMaintenance(runsExpanded ? null : scheduleKey)
                                }
                              >
                                {recordedRunCount} retained
                              </Button>
                            )
                          ) : (
                            <Anchor
                              href={taskTypeHref(schedule.type)}
                              target="_blank"
                              rel="noopener noreferrer"
                              size="sm"
                              fw={600}
                              td="underline"
                              aria-label={`View tasks of type ${schedule.type} in a new window`}
                            >
                              <Group component="span" gap={4} wrap="nowrap" justify="flex-end">
                                <span>{schedule.occurrenceCount ?? 0}</span>
                                <ArrowSquareOut size={13} aria-hidden />
                              </Group>
                            </Anchor>
                          )}
                        </Table.Td>
                      </Table.Tr>
                      {runsExpanded && schedule.maintenance !== null ? (
                        <Table.Tr>
                          <Table.Td colSpan={7} p={0} bg="var(--mantine-color-default-hover)">
                            <Text c="dimmed" size="xs" px="sm" pt="sm">
                              Showing the latest {schedule.maintenance.runs.length} of{" "}
                              {schedule.maintenance.recordedRunCount} retained runs.{" "}
                              {schedule.name === "tick"
                                ? "Successful task-changing ticks are sampled at most once per minute; tick errors are recorded immediately."
                                : "Every eligible run is recorded."}
                            </Text>
                            <MaintenanceRunHistory runs={schedule.maintenance.runs} />
                          </Table.Td>
                        </Table.Tr>
                      ) : null}
                    </Fragment>
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
