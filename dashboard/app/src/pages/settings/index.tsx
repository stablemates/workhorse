import type { DashboardSettingsPage } from "@stablemates/workhorse-dashboard-server/wire";
import type {
  MaintenancePolicyDefinition,
  MaintenancePolicySetting,
  RetentionPolicySetting,
} from "@stablemates/workhorse";
import {
  Accordion,
  Alert,
  Badge,
  Box,
  Button,
  Grid,
  Group,
  Stack,
  Table,
  Text,
  TextInput,
  VisuallyHidden,
} from "@mantine/core";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { dashboardRefreshBlockers, useRefreshBlocker } from "../../refresh-blockers.js";
import { Select } from "../../dropdown-activity.js";
import { formatCount } from "../../count-format.js";
import {
  currentTimeZoneValue,
  formatDuration,
  formatExact,
  setDisplayTimeZone,
} from "../../preferences.js";
import { EmptyState } from "../../components/empty-state.js";
import { Page, PageHeader, PageSection, TablePanel } from "../../components/page-header.js";
import { Fieldset } from "../../ui.js";
import { keepFocusOnRemoval } from "../../components/task-filter-bar.js";
import { deriveSettingsRecommendations } from "../../presentation-policy.js";

/** The zones to offer when the browser has no `Intl.supportedValuesOf`. */
const fallbackTimeZones = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Kyiv",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
];
interface TimeZoneLister {
  supportedValuesOf?: (key: "timeZone") => string[];
}

/** Every IANA zone the browser knows, or the short list when it cannot list them. UTC is first. */
export function supportedTimeZones(intl: TimeZoneLister = Intl): string[] {
  let zones = fallbackTimeZones;
  if (typeof intl.supportedValuesOf === "function") {
    try {
      const listed = intl.supportedValuesOf("timeZone");
      if (listed.length > 0) zones = listed;
    } catch {
      // Keep the short list.
    }
  }
  return Array.from(new Set(["UTC", ...zones]));
}
const browserTimeZones = supportedTimeZones();

/**
 * The display time zone choices: System, then every supported zone. Stored values are IANA zone
 * names. A selected zone that the list does not contain, for example a zone the browser writes
 * under another name, stays as a choice so the field never shows an empty value.
 */
export function displayTimeZoneOptions(
  selected: string,
  zones: string[] = browserTimeZones,
): Array<{ value: string; label: string }> {
  const values = selected === "system" || zones.includes(selected) ? zones : [...zones, selected];
  return [
    { value: "system", label: `System (${Intl.DateTimeFormat().resolvedOptions().timeZone})` },
    ...values.map((value) => ({ value, label: value })),
  ];
}
export const supportedMaintenanceTimeZoneOptions = browserTimeZones.map((value) => ({
  value,
  label: value,
}));
export interface SettingsPageProps {
  data: DashboardSettingsPage;
  saving: boolean;
  /**
   * Save the changed maintenance settings. Call `onSaved` when Workhorse accepts them and before
   * the page reads the settings again.
   */
  onSaveMaintenance(save: {
    definition: Partial<MaintenancePolicyDefinition>;
    onSaved(): void;
  }): Promise<void>;
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
      <Badge color="violet" variant="light" tt="none">
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
  { key: "taskIdentityRetentionDays", label: "Task identity", suffix: " days" },
  {
    key: "terminalOutcomeRetentionDays",
    label: "Finished outcomes",
    suffix: " days",
  },
  { key: "taskEventRetentionDays", label: "Task events", suffix: " days" },
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
    key: "terminalTaskPruneLimit",
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
  return value === null ? "indefinitely" : `${formatCount(value)}${suffix}`;
}
export function formatStatisticsRollupInterval(milliseconds: number): string {
  return milliseconds === 0 ? "Opted out" : formatMaintenanceInterval(milliseconds);
}
/** The maintenance settings that the operator can edit on this page. */
type MaintenanceDraft = Pick<
  DashboardSettingsPage["maintenance"],
  "timezone" | "historyRetentionLocalTime"
>;
function maintenanceDraft(maintenance: DashboardSettingsPage["maintenance"]): MaintenanceDraft {
  return {
    timezone: maintenance.timezone,
    historyRetentionLocalTime: maintenance.historyRetentionLocalTime,
  };
}
/**
 * The draft after a new settings answer arrives.
 *
 * A navigation to Settings can show a cached answer and read again. If the operator edits a field
 * before that read ends, the edit must stay. Each field that the operator did not change from the
 * previous answer takes the value of the new answer.
 */
export function followMaintenanceAnswer({
  draft,
  previous,
  next,
}: {
  draft: MaintenanceDraft;
  previous: MaintenanceDraft;
  next: MaintenanceDraft;
}): MaintenanceDraft {
  const followed: MaintenanceDraft = {
    timezone: draft.timezone === previous.timezone ? next.timezone : draft.timezone,
    historyRetentionLocalTime:
      draft.historyRetentionLocalTime === previous.historyRetentionLocalTime
        ? next.historyRetentionLocalTime
        : draft.historyRetentionLocalTime,
  };
  return followed.timezone === draft.timezone &&
    followed.historyRetentionLocalTime === draft.historyRetentionLocalTime
    ? draft
    : followed;
}
/**
 * The answer that the draft follows after a save succeeds.
 *
 * The submitted values are now the stored values. If another operator changes a field before the
 * page reads the settings again, the draft must take that new value and not keep the submitted
 * value as an edit. An edit that the operator makes after the submit differs from the submitted
 * value, so it stays.
 */
export function followMaintenanceSave({
  answered,
  submitted,
}: {
  answered: MaintenanceDraft;
  submitted: Partial<MaintenanceDraft>;
}): MaintenanceDraft {
  return { ...answered, ...submitted };
}
/** The maintenance draft and the answer that it follows. An edit is a field that differs from it. */
export interface MaintenanceForm {
  answered: MaintenanceDraft;
  draft: MaintenanceDraft;
}
export type MaintenanceFormAction =
  | { kind: "answer"; answer: MaintenanceDraft }
  | { kind: "edit"; change: Partial<MaintenanceDraft> }
  | { kind: "saved"; submitted: Partial<MaintenanceDraft> }
  | { kind: "discard" };
/**
 * The maintenance form after an action.
 *
 * Discard gives the answer that the draft follows, not the last settings answer. After a save, that
 * answer holds the saved values, even when the reload after the save fails.
 */
export function updateMaintenanceForm(
  form: MaintenanceForm,
  action: MaintenanceFormAction,
): MaintenanceForm {
  switch (action.kind) {
    case "answer":
      return {
        answered: action.answer,
        draft: followMaintenanceAnswer({
          draft: form.draft,
          previous: form.answered,
          next: action.answer,
        }),
      };
    case "edit":
      return { ...form, draft: { ...form.draft, ...action.change } };
    case "saved":
      return {
        ...form,
        answered: followMaintenanceSave({ answered: form.answered, submitted: action.submitted }),
      };
    case "discard":
      return { ...form, draft: form.answered };
  }
}
/** The fields of the draft that differ from the answer that it follows. */
export function maintenanceFormChanges({
  answered,
  draft,
}: MaintenanceForm): Partial<MaintenanceDraft> {
  const changes: Partial<MaintenanceDraft> = {};
  if (draft.timezone !== answered.timezone) changes.timezone = draft.timezone;
  if (draft.historyRetentionLocalTime !== answered.historyRetentionLocalTime) {
    changes.historyRetentionLocalTime = draft.historyRetentionLocalTime;
  }
  return changes;
}
export function SettingsPage({
  data,
  saving,
  onSaveMaintenance,
  onRevertMaintenance,
}: SettingsPageProps) {
  const recommendations = deriveSettingsRecommendations(data);
  const [timeZone, setTimeZone] = useState(currentTimeZoneValue);
  const timeZoneOptions = useMemo(() => displayTimeZoneOptions(timeZone), [timeZone]);
  const [maintenanceForm, updateMaintenance] = useReducer(
    updateMaintenanceForm,
    data.maintenance,
    (answer): MaintenanceForm => ({
      answered: maintenanceDraft(answer),
      draft: maintenanceDraft(answer),
    }),
  );
  const maintenance = maintenanceForm.draft;
  // Discard leaves the page and Save stays disabled once the draft is clean, so a keyboard operator
  // continues from the retention time field. The timezone field opens its list on focus.
  const retentionTimeField = useRef<HTMLInputElement>(null);
  const changeTimeZone = (value: string | null) => {
    const next = value ?? "system";
    setDisplayTimeZone(next === "system" ? null : next);
    setTimeZone(next);
  };
  const maintenanceChanges = maintenanceFormChanges(maintenanceForm);
  const maintenanceChanged = Object.keys(maintenanceChanges).length > 0;
  useRefreshBlocker(maintenanceChanged, dashboardRefreshBlockers.dirtySettings);
  useEffect(() => {
    updateMaintenance({ kind: "answer", answer: maintenanceDraft(data.maintenance) });
  }, [data]);
  const saveMaintenance = () => {
    const submitted = maintenanceChanges;
    void onSaveMaintenance({
      definition: submitted,
      onSaved: () => updateMaintenance({ kind: "saved", submitted }),
    });
  };
  const maintenanceTimeZoneOptions = supportedMaintenanceTimeZoneOptions.concat(
    supportedMaintenanceTimeZoneOptions.some(({ value }) => value === maintenance.timezone)
      ? []
      : [{ value: maintenance.timezone, label: maintenance.timezone }],
  );
  const now = new Date().toISOString();
  const retentionPolicyTable = (label: string, fields: RetentionField[]) => (
    <TablePanel label={label}>
      <Table className="data-table settings-policy-table" miw={560}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Setting</Table.Th>
            <Table.Th>Effective</Table.Th>
            <Table.Th>Source</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {fields.map(({ key, label: fieldLabel, suffix }) => (
            <Table.Tr key={key}>
              <Table.Td>
                <Text size="sm" fw={500}>
                  {fieldLabel}
                </Text>
              </Table.Td>
              <Table.Td>
                <Text size="sm">
                  <VisuallyHidden>Effective: </VisuallyHidden>
                  {formatRetentionDefault(data.retention[key], suffix)}
                </Text>
              </Table.Td>
              <Table.Td>
                {/* The default is only worth stating when an override makes it differ from the
                    effective value; repeating an identical number on every row is noise. */}
                {data.retention.provenance[key].source === "operator" ? (
                  <Group gap="xs" wrap="wrap">
                    <Badge color="violet" variant="light" tt="none">
                      Operator override
                    </Badge>
                    <Text c="dimmed" size="xs">
                      Default:{" "}
                      {formatRetentionDefault(
                        data.retention.provenance[key].applicationDefault,
                        suffix,
                      )}
                    </Text>
                  </Group>
                ) : (
                  <Text c="dimmed" size="sm">
                    Application default
                  </Text>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </TablePanel>
  );
  return (
    <Page narrow>
      <PageHeader
        title="Settings"
        description="Manage this browser's display preferences and review Workhorse configuration."
      />
      <PageSection
        id="settings-browser"
        title="Your preferences"
        description="These settings affect only this browser."
      >
        <div className="panel panel--padded settings-form">
          <Select
            label="Browser display timezone"
            description="Changes how timestamps appear. Workhorse stores every timestamp in UTC."
            value={timeZone}
            onChange={changeTimeZone}
            data={timeZoneOptions}
            searchable
            allowDeselect={false}
          />
          <Text c="dimmed" size="xs" mt="xs">
            Now: {formatExact(now)}
          </Text>
        </div>
      </PageSection>

      <PageSection
        id="settings-workhorse"
        title="Workhorse settings"
        description="These values control database-wide policy or report configuration from running workers."
      >
        <div className="panel panel--padded settings-panel">
          <Box>
            <h3 className="settings-panel__title">Database-wide settings</h3>
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
          {recommendations.map((recommendation) => (
            <Alert
              key={recommendation.id}
              color={recommendation.severity === "warning" ? "orange" : "gray"}
              title={
                recommendation.severity === "warning"
                  ? "Measured pressure on current settings"
                  : "Configuration note"
              }
            >
              {recommendation.summary}
            </Alert>
          ))}
          <Fieldset.Root className="settings-fieldset">
            <Fieldset.Legend className="settings-fieldset__legend">
              Maintenance schedule
            </Fieldset.Legend>
            <Text c="dimmed" size="xs">
              Choose when database-wide cleanup runs. These settings apply once across the fleet,
              regardless of how many workers are active.
            </Text>
            <Grid gap="md">
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
                      value && updateMaintenance({ kind: "edit", change: { timezone: value } })
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
                <Stack gap={4} align="stretch">
                  <TextInput
                    type="time"
                    label="Daily retention time"
                    description={`Runs once per local date in ${maintenance.timezone || "the selected timezone"}. Default: ${data.maintenance.provenance.historyRetentionLocalTime.applicationDefault}.`}
                    ref={retentionTimeField}
                    value={maintenance.historyRetentionLocalTime}
                    disabled={!data.editable}
                    onChange={(event) => {
                      // Read the value now: React clears `currentTarget` before it runs the
                      // reducer, so reading it there throws and blanks the page.
                      const historyRetentionLocalTime = event.currentTarget.value;
                      updateMaintenance({ kind: "edit", change: { historyRetentionLocalTime } });
                    }}
                  />
                  {data.maintenance.provenance.historyRetentionLocalTime.source === "operator" ? (
                    <Box>
                      <OperatorOverride
                        disabled={maintenanceChanged}
                        revert={
                          data.editable
                            ? () => void onRevertMaintenance("historyRetentionLocalTime")
                            : undefined
                        }
                      />
                    </Box>
                  ) : null}
                </Stack>
              </Grid.Col>
            </Grid>
            <Group justify="flex-end" gap="xs">
              {maintenanceChanged ? (
                <Text c="dimmed" size="xs">
                  Unsaved changes. The page does not refresh until you save or discard them.
                </Text>
              ) : null}
              {maintenanceChanged ? (
                <Button
                  variant="default"
                  disabled={saving}
                  onClick={(event) => {
                    keepFocusOnRemoval({
                      removed: event.currentTarget,
                      active: document.activeElement,
                      target: retentionTimeField.current,
                    });
                    updateMaintenance({ kind: "discard" });
                  }}
                >
                  Discard changes
                </Button>
              ) : null}
              <Button
                disabled={!data.editable || !maintenanceChanged}
                loading={saving}
                onClick={(event) => {
                  // The button is disabled while it saves, and stays disabled after a save.
                  keepFocusOnRemoval({
                    removed: event.currentTarget,
                    active: document.activeElement,
                    target: retentionTimeField.current,
                  });
                  saveMaintenance();
                }}
              >
                Save maintenance policy
              </Button>
            </Group>
          </Fieldset.Root>
          {/* Mantine 9 hides a collapsed panel with React `Activity`, which renders nothing on the
              server. The dashboard serves its first paint as server-rendered HTML, so hide the
              panel with CSS instead and keep the advanced cadences in that HTML. */}
          <Accordion variant="filled" keepMountedMode="display-none">
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
                <Grid gap="md">
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
                      format: (value: number) => `${formatCount(value)} groups`,
                    },
                    {
                      label: "Statistics recompute window",
                      description:
                        "Closed minutes rewritten behind the rollup watermark to absorb late history.",
                      effective: data.maintenance.statisticsRecomputeBuckets,
                      provenance: data.maintenance.provenance.statisticsRecomputeBuckets,
                      format: (value: number) => `${formatCount(value)} minutes`,
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
                        {setting.provenance.source === "operator" ? (
                          <Group gap="xs" wrap="wrap">
                            <Badge color="violet" variant="light" tt="none">
                              Operator override
                            </Badge>
                            <Text c="dimmed" size="xs">
                              Default: {setting.format(setting.provenance.applicationDefault)}
                            </Text>
                          </Group>
                        ) : (
                          <Text c="dimmed" size="xs">
                            Application default
                          </Text>
                        )}
                      </Stack>
                    </Grid.Col>
                  ))}
                </Grid>
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion>
        </div>

        <div className="settings-policy">
          <Box>
            <h3 className="settings-panel__title">Retention windows</h3>
            <Text c="dimmed" size="xs">
              These effective values are read-only here because shortening them can permanently
              delete stored history.
            </Text>
          </Box>
          {retentionPolicyTable("Retention windows table", retentionWindowFields)}
        </div>
        <div className="settings-policy">
          <Box>
            <h3 className="settings-panel__title">Cleanup limits</h3>
            <Text c="dimmed" size="xs">
              These read-only limits cap how much work each cleanup pass can perform. Lower limits
              reduce database load, but large backlogs take longer to clear.
            </Text>
          </Box>
          {retentionPolicyTable("Cleanup limits table", retentionCleanupFields)}
        </div>
      </PageSection>

      <PageSection
        id="settings-deploy"
        title="Set at deploy"
        description="Workers report these process-owned values. Change them in worker configuration and deploy again."
      >
        {data.workers.length === 0 ? (
          <EmptyState title="No live workers">
            No live worker is reporting deployment settings. A worker reports them when it
            registers.
          </EmptyState>
        ) : (
          <TablePanel label="Worker deployment settings table">
            <Table className="data-table" miw={900}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Worker</Table.Th>
                  <Table.Th>Queues</Table.Th>
                  <Table.Th className="data-table__metric">Concurrency</Table.Th>
                  <Table.Th className="data-table__metric">Lease</Table.Th>
                  <Table.Th className="data-table__metric">Heartbeat</Table.Th>
                  <Table.Th className="data-table__metric">Poll</Table.Th>
                  <Table.Th className="data-table__metric">Maintenance loop</Table.Th>
                  <Table.Th className="data-table__metric">Maintenance checks</Table.Th>
                  <Table.Th className="data-table__metric">Registry refresh</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data.workers.map((worker) => (
                  <Table.Tr key={worker.id}>
                    <Table.Td>{worker.id}</Table.Td>
                    <Table.Td>{worker.queues.join(", ")}</Table.Td>
                    <Table.Td className="data-table__metric">
                      {formatCount(worker.concurrency)}
                    </Table.Td>
                    <Table.Td className="data-table__metric">
                      {formatDuration(worker.leaseMs)} lease
                    </Table.Td>
                    <Table.Td className="data-table__metric">
                      {formatDuration(worker.heartbeatMs)}
                    </Table.Td>
                    <Table.Td className="data-table__metric">
                      {formatDuration(worker.pollMs)}
                    </Table.Td>
                    <Table.Td className="data-table__metric">
                      {formatDuration(worker.maintenanceIntervalMs)}
                    </Table.Td>
                    <Table.Td className="data-table__metric">
                      {formatDuration(worker.maintenanceRoutinePollMs)}
                    </Table.Td>
                    <Table.Td className="data-table__metric">
                      {formatDuration(worker.registryIntervalMs)}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </TablePanel>
        )}
      </PageSection>
    </Page>
  );
}
