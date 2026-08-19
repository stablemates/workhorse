import type { DashboardSettingsPage } from "@workhorse/dashboard-server/wire";
import type {
  MaintenancePolicyDefinition,
  MaintenancePolicySetting,
  RetentionPolicySetting,
} from "@workhorse/core";
import {
  Accordion,
  Alert,
  Badge,
  Box,
  Button,
  Divider,
  Grid,
  Group,
  Paper,
  Stack,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import { useEffect, useState } from "react";
import { dashboardRefreshBlockers, useRefreshBlocker } from "../../refresh-blockers.js";
import { Select } from "../../dropdown-activity.js";
import {
  currentTimeZoneValue,
  formatDuration,
  formatExact,
  setDisplayTimeZone,
} from "../../preferences.js";
import { PageHeader } from "../../components/task-list.js";

/** Common timezones plus the browser default; stored values are IANA zone names. */
export const timeZoneOptions: Array<{ value: string; label: string }> = [
  {
    value: "system",
    label: `System (${Intl.DateTimeFormat().resolvedOptions().timeZone})`,
  },
  { value: "UTC", label: "UTC" },
  { value: "America/New_York", label: "America/New_York" },
  { value: "America/Chicago", label: "America/Chicago" },
  { value: "America/Denver", label: "America/Denver" },
  { value: "America/Los_Angeles", label: "America/Los_Angeles" },
  { value: "Europe/London", label: "Europe/London" },
  { value: "Europe/Berlin", label: "Europe/Berlin" },
  { value: "Europe/Kyiv", label: "Europe/Kyiv" },
  { value: "Asia/Dubai", label: "Asia/Dubai" },
  { value: "Asia/Kolkata", label: "Asia/Kolkata" },
  { value: "Asia/Singapore", label: "Asia/Singapore" },
  { value: "Asia/Tokyo", label: "Asia/Tokyo" },
  { value: "Australia/Sydney", label: "Australia/Sydney" },
];
export const supportedMaintenanceTimeZoneOptions = Array.from(
  new Set([
    "UTC",
    ...(typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : timeZoneOptions.filter(({ value }) => value !== "system").map(({ value }) => value)),
  ]),
).map((value) => ({ value, label: value }));
export interface SettingsPageProps {
  data: DashboardSettingsPage;
  saving: boolean;
  onSaveMaintenance(definition: Partial<MaintenancePolicyDefinition>): Promise<void>;
  onRevertMaintenance(setting: MaintenancePolicySetting): Promise<void>;
}
export function OperatorOverride({
  revert,
  disabled = false,
}: {
  revert?: () => void;
  disabled?: boolean;
}) {
  return (
    <Group gap="xs">
      <Badge color="violet" variant="light">
        Operator override
      </Badge>
      {revert ? (
        <Button
          size="compact-xs"
          variant="subtle"
          disabled={disabled}
          title={disabled ? "Save or discard this section's changes before reverting" : undefined}
          onClick={revert}
        >
          Revert
        </Button>
      ) : null}
    </Group>
  );
}
export type RetentionField = {
  key: RetentionPolicySetting;
  label: string;
  suffix: string;
};
export const retentionWindowFields: RetentionField[] = [
  { key: "jobIdentityRetentionDays", label: "Task identity", suffix: " days" },
  {
    key: "terminalOutcomeRetentionDays",
    label: "Finished outcomes",
    suffix: " days",
  },
  { key: "jobEventRetentionDays", label: "Task events", suffix: " days" },
  {
    key: "attemptHistoryRetentionDays",
    label: "Attempt history",
    suffix: " days",
  },
  {
    key: "scheduleOccurrenceRetentionDays",
    label: "Schedule occurrences",
    suffix: " days",
  },
  {
    key: "statisticsRetentionDays",
    label: "Rolling statistics",
    suffix: " days",
  },
];
export const retentionCleanupFields: RetentionField[] = [
  {
    key: "terminalJobPruneLimit",
    label: "Finished tasks per cleanup pass",
    suffix: " rows",
  },
  {
    key: "historyPartitionsPerPass",
    label: "History partitions per pass",
    suffix: " partitions",
  },
  {
    key: "defaultPartitionRowsPerPass",
    label: "Fallback history rows per pass",
    suffix: " rows",
  },
  {
    key: "occurrenceRowsPerPass",
    label: "Schedule occurrences per pass",
    suffix: " rows",
  },
  {
    key: "statisticsRowsPerPass",
    label: "Statistics rows per pass",
    suffix: " rows",
  },
];
export function formatMaintenanceInterval(milliseconds: number): string {
  const day = 24 * 60 * 60_000;
  const hour = 60 * 60_000;
  if (milliseconds % day === 0) {
    const days = milliseconds / day;
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  if (milliseconds % hour === 0) {
    const hours = milliseconds / hour;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  if (milliseconds % 60_000 === 0) {
    const minutes = milliseconds / 60_000;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return formatDuration(milliseconds);
}
export function formatRetentionDefault(value: number | null, suffix: string): string {
  return value === null ? "indefinitely" : `${value.toLocaleString()}${suffix}`;
}
export function formatStatisticsRollupInterval(milliseconds: number): string {
  return milliseconds === 0 ? "Opted out" : formatMaintenanceInterval(milliseconds);
}
export function SettingsPage({
  data,
  saving,
  onSaveMaintenance,
  onRevertMaintenance,
}: SettingsPageProps) {
  const [timeZone, setTimeZone] = useState(currentTimeZoneValue);
  const [maintenance, setMaintenance] = useState(() => ({
    timezone: data.maintenance.timezone,
    historyRetentionLocalTime: data.maintenance.historyRetentionLocalTime,
  }));
  const changeTimeZone = (value: string | null) => {
    const next = value ?? "system";
    setDisplayTimeZone(next === "system" ? null : next);
    setTimeZone(next);
  };
  const maintenanceChanges: Partial<MaintenancePolicyDefinition> = {};
  if (maintenance.timezone !== data.maintenance.timezone)
    maintenanceChanges.timezone = maintenance.timezone;
  if (maintenance.historyRetentionLocalTime !== data.maintenance.historyRetentionLocalTime) {
    maintenanceChanges.historyRetentionLocalTime = maintenance.historyRetentionLocalTime;
  }
  const maintenanceChanged = Object.keys(maintenanceChanges).length > 0;
  useRefreshBlocker(maintenanceChanged, dashboardRefreshBlockers.dirtySettings);
  useEffect(() => {
    setMaintenance({
      timezone: data.maintenance.timezone,
      historyRetentionLocalTime: data.maintenance.historyRetentionLocalTime,
    });
  }, [data]);
  const maintenanceTimeZoneOptions = supportedMaintenanceTimeZoneOptions.concat(
    supportedMaintenanceTimeZoneOptions.some(({ value }) => value === maintenance.timezone)
      ? []
      : [{ value: maintenance.timezone, label: maintenance.timezone }],
  );
  const now = new Date().toISOString();
  const retentionPolicyRows = (fields: RetentionField[]) =>
    fields.map(({ key, label, suffix }) => (
      <Table.Tr key={key}>
        <Table.Td>
          <Text size="sm" fw={500}>
            {label}
          </Text>
        </Table.Td>
        <Table.Td w={180}>
          <Text size="sm">Effective: {formatRetentionDefault(data.retention[key], suffix)}</Text>
        </Table.Td>
        <Table.Td w={220}>
          <Stack gap={4} align="flex-start">
            <Text c="dimmed" size="xs">
              Default:{" "}
              {formatRetentionDefault(data.retention.provenance[key].applicationDefault, suffix)}
            </Text>
            {data.retention.provenance[key].source === "operator" ? (
              <Badge color="violet" variant="light">
                Operator override
              </Badge>
            ) : null}
          </Stack>
        </Table.Td>
      </Table.Tr>
    ));
  return (
    <Stack gap="xl">
      <PageHeader
        title="Settings"
        description="Manage this browser's display preferences and review Workhorse configuration."
      />
      <Paper withBorder p="lg" maw={480}>
        <Stack gap="sm">
          <Box>
            <Text fw={650}>Your preferences</Text>
            <Text c="dimmed" size="sm">
              These settings affect only this browser.
            </Text>
          </Box>
          <Select
            label="Browser display timezone"
            description="Changes how timestamps appear. Workhorse stores every timestamp in UTC."
            value={timeZone}
            onChange={changeTimeZone}
            data={timeZoneOptions}
            searchable
            allowDeselect={false}
          />
          <Text c="dimmed" size="xs">
            Now: {formatExact(now)}
          </Text>
        </Stack>
      </Paper>
      <Box>
        <Text fw={650} size="lg">
          Workhorse settings
        </Text>
        <Text c="dimmed" size="sm">
          These values control database-wide policy or report configuration from running workers.
        </Text>
      </Box>
      <Paper withBorder p="lg">
        <Stack gap="md">
          <Box>
            <Text fw={650}>Database-wide settings</Text>
            <Text c="dimmed" size="sm">
              Maintenance schedule changes apply to every worker. Retention and cleanup policy
              values are shown here for diagnosis.
            </Text>
          </Box>
          {!data.editable ? (
            <Alert color="yellow" title="Read-only dashboard">
              The connected host did not authorize settings changes.
            </Alert>
          ) : null}
          {data.recommendations.map((recommendation) => (
            <Alert
              key={recommendation.id}
              color={recommendation.severity === "warning" ? "orange" : "blue"}
              title={
                recommendation.severity === "warning"
                  ? "Measured pressure on current settings"
                  : "Configuration note"
              }
            >
              {recommendation.summary}
            </Alert>
          ))}
          <Box>
            <Text fw={600}>Maintenance schedule</Text>
            <Text c="dimmed" size="xs">
              Choose when database-wide cleanup runs. These settings apply once across the fleet,
              regardless of how many workers are active.
            </Text>
          </Box>
          <Grid>
            <Grid.Col span={{ base: 12, md: 6 }}>
              <Stack gap={4} align="stretch">
                <Select
                  label="Maintenance timezone"
                  description={`Controls the local date and daylight-saving rules used by daily retention. Default: ${data.maintenance.provenance.timezone.applicationDefault}.`}
                  value={maintenance.timezone}
                  data={maintenanceTimeZoneOptions}
                  searchable
                  allowDeselect={false}
                  disabled={!data.editable}
                  onChange={(value) =>
                    value &&
                    setMaintenance((current) => ({
                      ...current,
                      timezone: value,
                    }))
                  }
                />
                {data.maintenance.provenance.timezone.source === "operator" ? (
                  <Box>
                    <OperatorOverride
                      disabled={maintenanceChanged}
                      revert={
                        data.editable ? () => void onRevertMaintenance("timezone") : undefined
                      }
                    />
                  </Box>
                ) : null}
              </Stack>
            </Grid.Col>
            <Grid.Col span={{ base: 12, md: 6 }}>
              <TextInput
                type="time"
                label="Daily retention time"
                description={`Runs once per local date in ${maintenance.timezone || "the selected timezone"}. Default: ${data.maintenance.provenance.historyRetentionLocalTime.applicationDefault}.`}
                value={maintenance.historyRetentionLocalTime}
                disabled={!data.editable}
                onChange={(event) =>
                  setMaintenance((current) => ({
                    ...current,
                    historyRetentionLocalTime: event.currentTarget.value,
                  }))
                }
                rightSection={
                  data.maintenance.provenance.historyRetentionLocalTime.source === "operator" ? (
                    <OperatorOverride
                      disabled={maintenanceChanged}
                      revert={
                        data.editable
                          ? () => void onRevertMaintenance("historyRetentionLocalTime")
                          : undefined
                      }
                    />
                  ) : undefined
                }
                rightSectionWidth={190}
              />
            </Grid.Col>
          </Grid>
          <Accordion variant="contained">
            <Accordion.Item value="advanced-maintenance">
              <Accordion.Control>
                <Text fw={600} size="sm">
                  Advanced maintenance
                </Text>
                <Text c="dimmed" size="xs">
                  Review the internal cadences Workhorse uses to prepare storage and remove finished
                  tasks.
                </Text>
              </Accordion.Control>
              <Accordion.Panel>
                <Grid>
                  {[
                    {
                      label: "Partition preparation interval",
                      description:
                        "How often Workhorse checks that upcoming history partitions exist.",
                      effective: data.maintenance.partitionPreparationIntervalMs,
                      provenance: data.maintenance.provenance.partitionPreparationIntervalMs,
                      format: formatMaintenanceInterval,
                    },
                    {
                      label: "Terminal cleanup interval",
                      description:
                        "How often Workhorse removes finished tasks after their retention windows elapse.",
                      effective: data.maintenance.terminalCleanupIntervalMs,
                      provenance: data.maintenance.provenance.terminalCleanupIntervalMs,
                      format: formatMaintenanceInterval,
                    },
                    {
                      label: "Statistics rollup interval",
                      description:
                        "How often Workhorse summarizes finished work into per-minute statistics.",
                      effective: data.maintenance.statisticsRollupIntervalMs,
                      provenance: data.maintenance.provenance.statisticsRollupIntervalMs,
                      format: formatStatisticsRollupInterval,
                    },
                    {
                      label: "Statistics group limit",
                      description:
                        "Distinct queue and task-type pairs kept per statistics minute before overflow.",
                      effective: data.maintenance.statisticsGroupLimit,
                      provenance: data.maintenance.provenance.statisticsGroupLimit,
                      format: (value: number) => `${value.toLocaleString()} groups`,
                    },
                    {
                      label: "Statistics recompute window",
                      description:
                        "Closed minutes rewritten behind the rollup watermark to absorb late history.",
                      effective: data.maintenance.statisticsRecomputeBuckets,
                      provenance: data.maintenance.provenance.statisticsRecomputeBuckets,
                      format: (value: number) => `${value.toLocaleString()} minutes`,
                    },
                  ].map((setting) => (
                    <Grid.Col key={setting.label} span={{ base: 12, md: 6 }}>
                      <Stack gap={4}>
                        <Text fw={500} size="sm">
                          {setting.label}
                        </Text>
                        <Text c="dimmed" size="xs">
                          {setting.description}
                        </Text>
                        <Text size="sm">Effective: {setting.format(setting.effective)}</Text>
                        <Text c="dimmed" size="xs">
                          Default: {setting.format(setting.provenance.applicationDefault)}
                        </Text>
                        {setting.provenance.source === "operator" ? (
                          <Box>
                            <Badge color="violet" variant="light">
                              Operator override
                            </Badge>
                          </Box>
                        ) : null}
                      </Stack>
                    </Grid.Col>
                  ))}
                </Grid>
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion>
          <Group justify="flex-end">
            <Button
              disabled={!data.editable || !maintenanceChanged}
              loading={saving}
              onClick={() => void onSaveMaintenance(maintenanceChanges)}
            >
              Save maintenance policy
            </Button>
          </Group>
          <Divider />
          <Box>
            <Text fw={600}>Retention windows</Text>
            <Text c="dimmed" size="xs">
              These effective values are read-only here because shortening them can permanently
              delete stored history.
            </Text>
          </Box>
          <Table verticalSpacing="sm">
            <Table.Tbody>{retentionPolicyRows(retentionWindowFields)}</Table.Tbody>
          </Table>
          <Divider />
          <Box>
            <Text fw={600}>Cleanup limits</Text>
            <Text c="dimmed" size="xs">
              These read-only limits cap how much work each cleanup pass can perform. Lower limits
              reduce database load, but large backlogs take longer to clear.
            </Text>
          </Box>
          <Table verticalSpacing="sm">
            <Table.Tbody>{retentionPolicyRows(retentionCleanupFields)}</Table.Tbody>
          </Table>
        </Stack>
      </Paper>
      <Paper withBorder p="lg">
        <Stack gap="md">
          <Box>
            <Text fw={650}>Set at deploy</Text>
            <Text c="dimmed" size="sm">
              Workers report these process-owned values. Change them in worker configuration and
              deploy again.
            </Text>
          </Box>
          {data.workers.length === 0 ? (
            <Text c="dimmed" size="sm">
              No live workers are reporting deployment settings.
            </Text>
          ) : (
            <Table.ScrollContainer minWidth={900}>
              <Table>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Worker</Table.Th>
                    <Table.Th>Queue</Table.Th>
                    <Table.Th>Concurrency</Table.Th>
                    <Table.Th>Lease</Table.Th>
                    <Table.Th>Heartbeat</Table.Th>
                    <Table.Th>Poll</Table.Th>
                    <Table.Th>Maintenance loop</Table.Th>
                    <Table.Th>Maintenance checks</Table.Th>
                    <Table.Th>Registry refresh</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {data.workers.map((worker) => (
                    <Table.Tr key={worker.id}>
                      <Table.Td>{worker.id}</Table.Td>
                      <Table.Td>{worker.queue}</Table.Td>
                      <Table.Td>{worker.concurrency}</Table.Td>
                      <Table.Td>{formatDuration(worker.leaseMs)} lease</Table.Td>
                      <Table.Td>{formatDuration(worker.heartbeatMs)}</Table.Td>
                      <Table.Td>{formatDuration(worker.pollMs)}</Table.Td>
                      <Table.Td>{formatDuration(worker.maintenanceIntervalMs)}</Table.Td>
                      <Table.Td>{formatDuration(worker.maintenanceTaskPollMs)}</Table.Td>
                      <Table.Td>{formatDuration(worker.registryIntervalMs)}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
        </Stack>
      </Paper>
    </Stack>
  );
}
