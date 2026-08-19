import type { DashboardCronPage } from "@workhorse/dashboard-server/wire";
import { Code, Paper, ScrollArea, Stack, Switch, Table, Text } from "@mantine/core";
import { StatusBadge } from "../status-badge.js";
import { EmptyState, PageHeader } from "../components/task-list.js";
import { formatExact, formatRelative } from "../preferences.js";

export function CronPage({
  data,
  togglingSchedule,
  setScheduleEnabled,
}: {
  data: DashboardCronPage;
  togglingSchedule: string | null;
  setScheduleEnabled: (namespace: string, name: string, enabled: boolean) => void;
}) {
  return (
    <Stack gap="xl">
      <PageHeader
        title="Schedules"
        description="See when recurring tasks run and where Workhorse sends them."
      />
      {data.schedules.length === 0 ? (
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
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Last run</Table.Th>
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
                        <Text size="sm" c="dimmed">
                          {schedule.queue ?? "system"}
                          {schedule.priority === null ? "" : ` · Priority ${schedule.priority}`}
                        </Text>
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
                        <Text size="sm" c="dimmed" title={formatExact(schedule.lastFiredAt)}>
                          {schedule.lastFiredAt ? formatRelative(schedule.lastFiredAt) : "never"}
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
