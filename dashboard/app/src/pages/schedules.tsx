import type { DashboardCronPage } from "@stablemates/workhorse-dashboard-server/wire";
import { Badge, Code, Group, Paper, ScrollArea, Stack, Switch, Table, Text } from "@mantine/core";
import { StatusBadge } from "../status-badge.js";
import { HelpButton } from "../charts/system.js";
import { EmptyState, PageHeader } from "../components/task-list.js";
import { formatExact, formatRelative } from "../preferences.js";
import { presentSchedules } from "../presentation-policy.js";

export function CronPage({
  data,
  togglingSchedule,
  setScheduleEnabled,
}: {
  data: DashboardCronPage;
  togglingSchedule: string | null;
  setScheduleEnabled: (namespace: string, name: string, enabled: boolean) => void;
}) {
  const schedules = presentSchedules(data);
  return (
    <Stack gap="xl">
      <PageHeader
        title="Schedules"
        description="See when recurring tasks run and where Workhorse sends them."
      />
      {schedules.length === 0 ? (
        <EmptyState>Workhorse has no recurring schedules.</EmptyState>
      ) : (
        <Paper withBorder>
          <ScrollArea>
            <Table highlightOnHover verticalSpacing={6} horizontalSpacing="md" miw={800}>
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
                  const lastRunAt =
                    schedule.maintenance?.lastCompletedAt ??
                    schedule.maintenance?.lastStartedAt ??
                    schedule.lastFiredAt;
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
                        <Group gap={4} wrap="nowrap">
                          <Text size="sm" c="dimmed">
                            {schedule.kind === "system" ? "Maintenance" : schedule.queue}
                            {schedule.priority === null ? "" : ` · Priority ${schedule.priority}`}
                          </Text>
                          {schedule.kind === "system" ? (
                            <HelpButton
                              label="Maintenance"
                              help="Workers offer this maintenance directly to PostgreSQL. It is not sent to a queue and does not need a handler."
                            />
                          ) : null}
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        {schedule.kind === "system" ? (
                          <Text c="dimmed" size="sm">
                            All workers
                          </Text>
                        ) : (
                          <Badge
                            color={schedule.evaluatorCount === 0 ? "red" : "gray"}
                            variant="light"
                          >
                            {schedule.evaluatorCount === 0
                              ? "None"
                              : `${schedule.evaluatorCount} ${schedule.evaluatorCount === 1 ? "worker" : "workers"}`}
                          </Badge>
                        )}
                      </Table.Td>
                      <Table.Td>
                        {schedule.kind === "user" ? (
                          <Switch
                            size="sm"
                            checked={schedule.enabled}
                            disabled={togglingSchedule === scheduleKey}
                            label={schedule.enabled ? "Enabled" : "Disabled"}
                            styles={{
                              label: {
                                fontSize: "var(--mantine-font-size-xs)",
                              },
                            }}
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
                          <StatusBadge state={schedule.maintenance?.status ?? "scheduled"} />
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c="dimmed" title={formatExact(lastRunAt)}>
                          {lastRunAt ? formatRelative(lastRunAt) : "never"}
                        </Text>
                      </Table.Td>
                      <Table.Td ta="right">{schedule.occurrenceCount ?? "—"}</Table.Td>
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
