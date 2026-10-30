import type {
  DashboardCronPage,
  DashboardTaskRow,
  DashboardTasksCursorPage,
} from "@stablemates/workhorse-dashboard-server/wire";
import { Cancel01Icon, LinkSquare02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Anchor, Badge, Code, Group, Loader, Table, Text, Tooltip } from "@mantine/core";
import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { StatusLabel } from "../status-badge.js";
import { HelpButton } from "../components/help-button.js";
import { EmptyState } from "../components/empty-state.js";
import { Page, PageHeader, TablePanel } from "../components/page-header.js";
import { ConfirmDialog } from "../components/confirm-dialog.js";
import { useDashboardClient } from "../core.js";
import { Button, Drawer } from "../ui.js";
import { formatDuration, formatExact, formatRelative } from "../preferences.js";
import {
  presentSchedules,
  scheduleKey,
  type PresentedScheduleRow,
} from "../presentation-policy.js";
import { formatCount } from "../count-format.js";
import { createCoalescedRead, type CoalescedRead } from "../coalesced-read.js";

export const resumeScheduleWarnings = {
  skip: "Workhorse will skip occurrences missed while this schedule was paused. The next occurrence will fire on schedule. Tasks already enqueued are unchanged.",
  latest:
    "Workhorse may enqueue the most recent missed occurrence as soon as a worker evaluates this schedule. Earlier missed occurrences will be skipped. Tasks already enqueued are unchanged.",
  all: "Workhorse may enqueue missed occurrences in bounded batches as soon as a worker evaluates this schedule. It will continue until the schedule catches up. Tasks already enqueued are unchanged.",
} as const;

const catchupPolicyLabels = {
  skip: "Skip missed occurrences",
  latest: "Run the latest missed occurrence",
  all: "Run every missed occurrence",
} as const;

// Nothing clears the skip keys after later fires, so an older skip is history, not a current gap.
const SKIP_BADGE_WINDOW_MS = 86_400_000;

/** The drawer lists this many recent tasks. The Tasks view link shows the rest. */
const RECENT_TASK_LIMIT = 8;

/**
 * The last skip of a `skip` schedule, or null before the first one and once that skip is 24 hours
 * old. A database below schema 86 returns no skip keys, so the page shows no skip there. Workhorse
 * stops the count at 10,000, so that value means 10,000 or more.
 */
export function scheduleSkipSummary(
  schedule: {
    lastSkippedAt?: string | null;
    lastSkippedCount?: number | null;
    lastSkippedThrough?: string | null;
  },
  now = Date.now(),
): { label: string; detail: string } | null {
  const skippedAt = schedule.lastSkippedAt ?? null;
  const skipped = schedule.lastSkippedCount ?? null;
  if (skippedAt === null || skipped === null) return null;
  if (now - new Date(skippedAt).getTime() >= SKIP_BADGE_WINDOW_MS) return null;
  const capped = skipped >= 10_000;
  const count = formatCount(Math.min(skipped, 10_000));
  const occurrences = skipped === 1 ? "occurrence" : "occurrences";
  return {
    label: `Skipped ${count}${capped ? "+" : ""} · ${formatRelative(skippedAt, now)}`,
    detail: `At ${formatExact(skippedAt)}, Workhorse skipped ${count}${capped ? " or more" : ""} missed ${occurrences} older than the supported delay. The newest skipped occurrence is ${formatExact(schedule.lastSkippedThrough)}.`,
  };
}

/**
 * The occurrence count of an application schedule. Workhorse stops the count at 1,000 from schema
 * 88, and `occurrenceCountCapped` then says that more occurrences are retained. A database below
 * schema 88 returns an exact count and no cap key.
 */
export function scheduleOccurrenceCount(schedule: {
  occurrenceCount: number | null;
  occurrenceCountCapped?: boolean;
}): string {
  const count = formatCount(schedule.occurrenceCount ?? 0);
  return schedule.occurrenceCountCapped === true ? `${count}+` : count;
}

export const pauseScheduleWarning =
  "Workhorse will stop enqueuing occurrences of this schedule until an operator resumes it. The pause survives deploys. Tasks already enqueued are unchanged.";

/**
 * The href of another dashboard route, from the mounted href of the task listing.
 *
 * The shell gives this page only `scheduleTasksHref`, and that href is the mounted base path, then
 * `/tasks`, then the query. The base path can itself hold `/tasks`, as in `/ops/tasks-team`, so
 * only the final `/tasks` segment of the path goes.
 */
export function siblingRouteHref(tasksHref: string, path: string): string {
  const end = tasksHref.search(/[?#]/);
  const pathname = end < 0 ? tasksHref : tasksHref.slice(0, end);
  const basePath = pathname.endsWith("/tasks") ? pathname.slice(0, -"/tasks".length) : "";
  return `${basePath}${path}`;
}

/** The Queues page, scrolled to the row of one queue. */
export function queueRowHref(tasksHref: string, queue: string): string {
  return siblingRouteHref(tasksHref, `/queues#${encodeURIComponent(queueRowId(queue))}`);
}

function queueRowId(queue: string): string {
  return `queue-${queue}`;
}

/** The task listing with one task open in the task drawer. */
export function taskDrawerHref(tasksHref: string, taskId: string): string {
  return `${tasksHref}${tasksHref.includes("?") ? "&" : "?"}task=${encodeURIComponent(taskId)}`;
}

/** The state of a user schedule as one word, and its explanation. */
export function scheduleState(schedule: PresentedScheduleRow): {
  text: string;
  state: string;
  detail: string;
} {
  if (schedule.kind === "system") {
    const status = schedule.maintenance?.status ?? "scheduled";
    if (status === "incomplete") {
      return {
        text: "Partial",
        state: "incomplete",
        detail: "The last bounded pass left eligible work for a later run.",
      };
    }
    if (status === "due") {
      return {
        text: "Due",
        state: "due",
        detail: "The routine is eligible to run when a worker next offers it.",
      };
    }
    return {
      text: "On schedule",
      state: "succeeded",
      detail: "The routine completed normally and is not due yet.",
    };
  }
  if (schedule.paused) {
    return {
      text: "Paused",
      state: "scheduled",
      detail: `Paused by ${schedule.pausedBy ?? "an operator"}${schedule.pausedAt ? ` ${formatRelative(schedule.pausedAt)}` : ""}. This pause survives deploys until an operator resumes it.`,
    };
  }
  if (!schedule.configuredEnabled) {
    return {
      text: "Config off",
      state: "canceled",
      detail:
        "Disabled by deployment configuration. Change the schedule definition and deploy to activate it.",
    };
  }
  return {
    text: "Active",
    state: "succeeded",
    detail: "Workhorse enqueues each occurrence when a worker evaluates this schedule.",
  };
}

export function MaintenanceRunHistory({
  runs,
}: {
  runs: NonNullable<ReturnType<typeof presentSchedules>[number]["maintenance"]>["runs"];
}) {
  return (
    <ol className="schedule-runs">
      {runs.map((run) => (
        <li key={run.id} className="schedule-runs__run">
          <Group justify="space-between" align="flex-start" wrap="wrap" gap="xs">
            <Group gap="xs">
              {/* Only an outcome that needs attention takes a color. */}
              <Badge
                color={
                  run.outcome === "succeeded" ? "gray" : run.outcome === "failed" ? "red" : "yellow"
                }
                variant="light"
                tt="none"
              >
                {run.outcome}
              </Badge>
              <Text size="sm" title={formatExact(run.startedAt)}>
                {formatRelative(run.startedAt)}
              </Text>
            </Group>
            <Text c="dimmed" size="xs">
              {formatDuration(run.durationMs)} · {formatCount(run.rowsAffected)} rows affected
            </Text>
          </Group>
          <Group gap="xs" mt={4} wrap="wrap">
            {run.phases.map((phase) => (
              <Code key={phase.phase} fz="xs">
                {phase.phase.replaceAll("_", " ")} · {formatCount(phase.rowsAffected)} rows ·{" "}
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
        </li>
      ))}
    </ol>
  );
}

type ConfirmingToggle = {
  pause: boolean;
  namespace: string;
  name: string;
  catchupPolicy: "skip" | "latest" | "all";
};

/** A click on a control inside a row acts on that control and does not open the drawer. */
function clickedControl(event: MouseEvent<HTMLElement>): boolean {
  const target = event.target as HTMLElement;
  return target.closest("a, button, input, label, [role='switch'], .explained-value") !== null;
}

export function CronPage({
  data,
  togglingSchedule,
  setSchedulePaused,
  scheduleTasksHref,
}: {
  data: DashboardCronPage;
  togglingSchedule: string | null;
  setSchedulePaused: (namespace: string, name: string, paused: boolean) => void;
  /** The task listing has no schedule filter, so the link narrows by destination queue and type. */
  scheduleTasksHref: (queue: string | null, taskType: string) => string;
}) {
  const schedules = presentSchedules(data);
  const [expandedMaintenance, setExpandedMaintenance] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<ConfirmingToggle | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // The drawer gives focus back to the name button of the row that opened it.
  const drawerTrigger = useRef<HTMLElement | null>(null);
  const selected =
    selectedKey === null
      ? null
      : (schedules.find((schedule) => scheduleKey(schedule.identity) === selectedKey) ?? null);

  const openSchedule = (key: string, trigger: HTMLElement | null) => {
    drawerTrigger.current = trigger;
    setSelectedKey(key);
  };
  const requestToggle = (schedule: PresentedScheduleRow) =>
    setConfirming({
      pause: !schedule.paused,
      namespace: schedule.namespace,
      name: schedule.name,
      catchupPolicy: schedule.catchupPolicy,
    });

  // A confirmation opened from the drawer renders inside it, so the two dialogs nest: Escape
  // closes the confirmation first, and focus returns into the drawer.
  const confirmDialog = (
    <ConfirmDialog
      open={confirming !== null}
      title={confirming?.pause ? "Pause schedule?" : "Resume schedule?"}
      confirmLabel={confirming?.pause ? "Pause schedule" : "Resume schedule"}
      onCancel={() => setConfirming(null)}
      onConfirm={() => {
        if (!confirming) return;
        setSchedulePaused(confirming.namespace, confirming.name, confirming.pause);
        setConfirming(null);
      }}
    >
      <p>
        {confirming?.pause
          ? pauseScheduleWarning
          : resumeScheduleWarnings[confirming?.catchupPolicy ?? "skip"]}
      </p>
      {confirming ? (
        <Code block>
          {confirming.namespace}/{confirming.name}
        </Code>
      ) : null}
    </ConfirmDialog>
  );

  return (
    <Page>
      {selected === null ? confirmDialog : null}
      <ScheduleDrawer
        schedule={selected}
        finalFocus={drawerTrigger}
        onClose={() => setSelectedKey(null)}
        toggling={selected !== null && togglingSchedule === scheduleKey(selected.identity)}
        requestToggle={requestToggle}
        scheduleTasksHref={scheduleTasksHref}
        capturedAt={data.capturedAt}
      >
        {confirmDialog}
      </ScheduleDrawer>
      <PageHeader
        title="Schedules"
        description={
          data.scheduleCount > data.schedules.length
            ? `See when recurring tasks run and where Workhorse sends them. Showing ${formatCount(data.schedules.length)} of ${formatCount(data.scheduleCount)} schedules, the first by namespace and name.`
            : "See when recurring tasks run and where Workhorse sends them."
        }
      />
      {schedules.length === 0 ? (
        <EmptyState title="No schedules">
          Workhorse has no recurring schedules. A schedule appears here after a worker registers it.
        </EmptyState>
      ) : (
        <TablePanel label="Schedules table">
          <Table highlightOnHover className="data-table schedule-table" miw={1040}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th className="schedule-table__identity">Schedule</Table.Th>
                <Table.Th>Destination</Table.Th>
                <Table.Th>Expression</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th className="data-table__metric">
                  <Group gap={4} wrap="nowrap" justify="flex-end">
                    <span>Evaluators</span>
                    <HelpButton
                      label="Evaluators"
                      help="Live workers that offer this schedule namespace. Several evaluators are safe; if none are live, the schedule waits until one returns."
                    />
                  </Group>
                </Table.Th>
                <Table.Th>Last run</Table.Th>
                <Table.Th className="data-table__metric">Runs</Table.Th>
                <Table.Th className="schedule-table__action">Action</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {schedules.map((schedule) => {
                const rowKey = scheduleKey(schedule.identity);
                const recordedRunCount = schedule.maintenance?.recordedRunCount ?? 0;
                const runsExpanded = expandedMaintenance === rowKey;
                const lastRunAt =
                  schedule.maintenance?.lastCompletedAt ??
                  schedule.maintenance?.lastStartedAt ??
                  schedule.lastFiredAt;
                const skip = scheduleSkipSummary(schedule);
                const state = scheduleState(schedule);
                const tasksHref = scheduleTasksHref(schedule.queue, schedule.type);
                return (
                  <Fragment key={rowKey}>
                    <Table.Tr
                      className="schedule-table__row"
                      data-selected={selectedKey === rowKey || undefined}
                      onClick={(event) => {
                        if (clickedControl(event)) return;
                        openSchedule(
                          rowKey,
                          event.currentTarget.querySelector<HTMLElement>(".schedule-table__open"),
                        );
                      }}
                    >
                      <Table.Td className="schedule-table__identity">
                        <button
                          type="button"
                          className="schedule-table__open"
                          aria-haspopup="dialog"
                          title={`${schedule.kind === "system" ? "Maintenance" : "Schedule"} · ${schedule.namespace}`}
                          onClick={(event) => openSchedule(rowKey, event.currentTarget)}
                        >
                          {schedule.name}
                        </button>
                        {schedule.description ? (
                          <Text c="dimmed" size="xs" lh={1.3} lineClamp={1}>
                            {schedule.description}
                          </Text>
                        ) : null}
                      </Table.Td>
                      <Table.Td>
                        {schedule.kind === "system" ? (
                          <Tooltip
                            label="Workers offer this maintenance directly to PostgreSQL. It is not sent to a queue and does not need a handler."
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
                              aria-label="Maintenance: Workers offer this maintenance directly to PostgreSQL. It is not sent to a queue and does not need a handler."
                            >
                              Maintenance
                            </Text>
                          </Tooltip>
                        ) : (
                          <>
                            <Anchor
                              href={queueRowHref(tasksHref, schedule.queue ?? "")}
                              size="sm"
                              className="schedule-table__queue"
                              aria-label={`Destination: ${schedule.queue}, priority ${schedule.priority}, task type ${schedule.type}`}
                              title={`Open the ${schedule.queue} queue`}
                            >
                              {schedule.queue}
                            </Anchor>
                            <Text c="dimmed" size="xs" lh={1.3} ff="monospace">
                              {schedule.type}
                            </Text>
                          </>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Code className="schedule-table__expression" fz="xs">
                          {schedule.cron}
                        </Code>
                      </Table.Td>
                      <Table.Td>
                        <StatusLabel
                          state={state.state}
                          text={state.text}
                          label={`Status: ${state.text}`}
                        >
                          {state.detail}
                        </StatusLabel>
                      </Table.Td>
                      <Table.Td className="data-table__metric">
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
                                : `${formatCount(schedule.evaluatorCount ?? 0)} live ${schedule.evaluatorCount === 1 ? "worker offers" : "workers offer"} this schedule namespace.`
                            }
                            withArrow
                            events={{ hover: true, focus: true, touch: true }}
                          >
                            <Text
                              component="span"
                              size="sm"
                              tabIndex={0}
                              c={schedule.evaluatorCount === 0 ? "red" : undefined}
                              fw={schedule.evaluatorCount === 0 ? 600 : undefined}
                              aria-label={
                                schedule.evaluatorCount === 0
                                  ? "No workers"
                                  : `${formatCount(schedule.evaluatorCount ?? 0)} ${schedule.evaluatorCount === 1 ? "worker" : "workers"}`
                              }
                            >
                              {schedule.evaluatorCount === 0
                                ? "None"
                                : formatCount(schedule.evaluatorCount ?? 0)}
                            </Text>
                          </Tooltip>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c="dimmed" title={formatExact(lastRunAt)}>
                          {lastRunAt ? formatRelative(lastRunAt) : "Never"}
                        </Text>
                        {skip ? (
                          <Tooltip
                            label={skip.detail}
                            multiline
                            maw={360}
                            withArrow
                            events={{ hover: true, focus: true, touch: true }}
                          >
                            <Badge
                              color="yellow"
                              variant="light"
                              size="sm"
                              tt="none"
                              tabIndex={0}
                              aria-label={`Last skip: ${skip.detail}`}
                            >
                              {skip.label}
                            </Badge>
                          </Tooltip>
                        ) : null}
                      </Table.Td>
                      <Table.Td className="data-table__metric">
                        {schedule.kind === "system" ? (
                          recordedRunCount === 0 ? (
                            <Text component="span" c="dimmed" size="sm">
                              —
                            </Text>
                          ) : (
                            <button
                              type="button"
                              className="schedule-table__runs-toggle"
                              aria-expanded={runsExpanded}
                              onClick={() => setExpandedMaintenance(runsExpanded ? null : rowKey)}
                            >
                              {formatCount(recordedRunCount)} retained
                            </button>
                          )
                        ) : (
                          <Anchor
                            href={tasksHref}
                            target="_blank"
                            rel="noopener noreferrer"
                            size="sm"
                            aria-label={`View tasks of type ${schedule.type} in the ${schedule.queue} queue in a new window`}
                          >
                            <Group component="span" gap={4} wrap="nowrap" justify="flex-end">
                              <span>{scheduleOccurrenceCount(schedule)}</span>
                              <HugeiconsIcon icon={LinkSquare02Icon} size={13} aria-hidden />
                            </Group>
                          </Anchor>
                        )}
                      </Table.Td>
                      <Table.Td className="schedule-table__action">
                        {schedule.kind === "user" &&
                        (schedule.configuredEnabled || schedule.paused) ? (
                          <ScheduleToggleButton
                            schedule={schedule}
                            pending={togglingSchedule === rowKey}
                            compact
                            onClick={() => requestToggle(schedule)}
                          />
                        ) : null}
                      </Table.Td>
                    </Table.Tr>
                    {runsExpanded && schedule.maintenance !== null ? (
                      <Table.Tr>
                        <Table.Td colSpan={8} className="schedule-table__runs">
                          <Text c="dimmed" size="xs" px="md" pt="sm">
                            Showing the latest {formatCount(schedule.maintenance.runs.length)} of{" "}
                            {formatCount(schedule.maintenance.recordedRunCount)} retained runs.{" "}
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
        </TablePanel>
      )}
    </Page>
  );
}

function ScheduleToggleButton({
  schedule,
  pending,
  onClick,
  compact = false,
}: {
  schedule: PresentedScheduleRow;
  pending: boolean;
  onClick: () => void;
  /** A table row uses the compact height, so the row keeps its height. */
  compact?: boolean;
}) {
  const verb = schedule.paused ? "Resume" : "Pause";
  return (
    <Button
      variant="secondary"
      className="schedule-toggle"
      // The theme sets the button size inline, so the compact size is inline too.
      style={compact ? { height: 28, minWidth: 76, paddingBlock: 0, paddingInline: 12 } : undefined}
      disabled={pending}
      aria-busy={pending || undefined}
      aria-label={`${verb} ${schedule.name}`}
      onClick={onClick}
    >
      {pending ? `${verb}…` : verb}
    </Button>
  );
}

/** One label and value in the drawer. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="schedule-drawer__fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * The details of one schedule in a modal side drawer.
 *
 * The drawer traps focus, Escape closes it, and focus goes back to the row that opened it. The
 * dashboard API returns no timezone, payload, metadata, or next run for a schedule, so the drawer
 * shows the expression, the destination, the state, and the tasks of the destination type.
 */
function ScheduleDrawer({
  schedule,
  finalFocus,
  onClose,
  toggling,
  requestToggle,
  scheduleTasksHref,
  capturedAt,
  children,
}: {
  schedule: PresentedScheduleRow | null;
  finalFocus: RefObject<HTMLElement | null>;
  onClose: () => void;
  toggling: boolean;
  requestToggle: (schedule: PresentedScheduleRow) => void;
  scheduleTasksHref: (queue: string | null, taskType: string) => string;
  /** The time of the page answer. Each refresh of the page reloads the recent tasks. */
  capturedAt: string;
  children: ReactNode;
}) {
  // The drawer keeps the last schedule while it animates closed.
  const [shown, setShown] = useState(schedule);
  if (schedule !== null && schedule !== shown) setShown(schedule);
  const current = schedule ?? shown;
  return (
    <Drawer.Root
      open={schedule !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      swipeDirection="right"
      modal
    >
      <Drawer.Portal>
        <Drawer.Backdrop className="schedule-drawer__backdrop" />
        <Drawer.Viewport className="schedule-drawer__viewport">
          <Drawer.Popup className="schedule-drawer" finalFocus={finalFocus}>
            {current === null ? null : (
              <ScheduleDetails
                schedule={current}
                toggling={toggling}
                requestToggle={requestToggle}
                scheduleTasksHref={scheduleTasksHref}
                capturedAt={capturedAt}
              />
            )}
            {schedule === null ? null : children}
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

function ScheduleDetails({
  schedule,
  toggling,
  requestToggle,
  scheduleTasksHref,
  capturedAt,
}: {
  schedule: PresentedScheduleRow;
  toggling: boolean;
  requestToggle: (schedule: PresentedScheduleRow) => void;
  scheduleTasksHref: (queue: string | null, taskType: string) => string;
  capturedAt: string;
}) {
  const state = scheduleState(schedule);
  const tasksHref = scheduleTasksHref(schedule.queue, schedule.type);
  const skip = scheduleSkipSummary(schedule);
  const maintenance = schedule.maintenance;
  const lastRunAt =
    maintenance?.lastCompletedAt ?? maintenance?.lastStartedAt ?? schedule.lastFiredAt;
  const canToggle = schedule.kind === "user" && (schedule.configuredEnabled || schedule.paused);
  return (
    <div className="schedule-drawer__body">
      <header className="schedule-drawer__header">
        <div className="schedule-drawer__heading">
          <Drawer.Title className="schedule-drawer__title">{schedule.name}</Drawer.Title>
          <Drawer.Description className="schedule-drawer__description">
            {schedule.description ??
              (schedule.kind === "system"
                ? "Workhorse maintenance routine"
                : `Schedule in the ${schedule.namespace} namespace`)}
          </Drawer.Description>
        </div>
        <Drawer.Close
          className="schedule-drawer__close"
          render={<Button variant="ghost" />}
          aria-label="Close schedule details"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={16} aria-hidden />
        </Drawer.Close>
      </header>

      <div className="schedule-drawer__status">
        <StatusLabel state={state.state} text={state.text} label={`Status: ${state.text}`} />
        <Text size="sm" c="dimmed" className="schedule-drawer__status-detail">
          {state.detail}
        </Text>
        {schedule.paused && schedule.pausedReason ? (
          <Text size="sm" c="dimmed">
            Reason: {schedule.pausedReason}
          </Text>
        ) : null}
        {canToggle ? (
          <div className="schedule-drawer__actions">
            <ScheduleToggleButton
              schedule={schedule}
              pending={toggling}
              onClick={() => requestToggle(schedule)}
            />
          </div>
        ) : null}
      </div>

      <section className="schedule-drawer__section" aria-labelledby="schedule-drawer-timing">
        <h3 className="schedule-drawer__section-title" id="schedule-drawer-timing">
          Timing
        </h3>
        <dl className="schedule-drawer__facts">
          <Fact label="Expression">
            <Code className="schedule-drawer__code">{schedule.cron}</Code>
          </Fact>
          {schedule.kind === "user" ? (
            <Fact label="Missed occurrences">{catchupPolicyLabels[schedule.catchupPolicy]}</Fact>
          ) : null}
          <Fact label="Last run">
            <span title={formatExact(lastRunAt)}>
              {lastRunAt ? formatRelative(lastRunAt) : "Never"}
            </span>
          </Fact>
          {skip ? <Fact label="Last skip">{skip.detail}</Fact> : null}
          {schedule.kind === "user" ? (
            <Fact label="Evaluators">
              {schedule.evaluatorCount === 0 ? (
                <Text component="span" c="red" size="sm" fw={600}>
                  None. The schedule waits until a worker offers its namespace.
                </Text>
              ) : (
                `${formatCount(schedule.evaluatorCount ?? 0)} live ${schedule.evaluatorCount === 1 ? "worker" : "workers"}`
              )}
            </Fact>
          ) : null}
        </dl>
      </section>

      {schedule.kind === "user" ? (
        <section className="schedule-drawer__section" aria-labelledby="schedule-drawer-target">
          <h3 className="schedule-drawer__section-title" id="schedule-drawer-target">
            Destination
          </h3>
          <dl className="schedule-drawer__facts">
            <Fact label="Queue">
              <Anchor
                href={queueRowHref(tasksHref, schedule.queue ?? "")}
                size="sm"
                className="schedule-drawer__link"
              >
                {schedule.queue}
              </Anchor>
            </Fact>
            <Fact label="Task type">
              <Code className="schedule-drawer__code">{schedule.type}</Code>
            </Fact>
            <Fact label="Priority">{formatCount(schedule.priority ?? 0)}</Fact>
            <Fact label="Namespace">{schedule.namespace}</Fact>
            <Fact label="Revision">
              <span title={`Updated ${formatExact(schedule.updatedAt)}`}>
                {schedule.revision} · updated {formatRelative(schedule.updatedAt)}
              </span>
            </Fact>
          </dl>
        </section>
      ) : null}

      {schedule.kind === "user" ? (
        <ScheduleRecentTasks schedule={schedule} tasksHref={tasksHref} capturedAt={capturedAt} />
      ) : maintenance !== null ? (
        <section className="schedule-drawer__section" aria-labelledby="schedule-drawer-runs">
          <h3 className="schedule-drawer__section-title" id="schedule-drawer-runs">
            Recent runs
          </h3>
          <Text c="dimmed" size="xs">
            {maintenance.recordedRunCount === 0
              ? "No run is retained yet."
              : `The latest ${formatCount(maintenance.runs.length)} of ${formatCount(maintenance.recordedRunCount)} retained runs. Phases: ${maintenance.phases.join(", ").replaceAll("_", " ")}.`}
          </Text>
          {maintenance.runs.length === 0 ? null : <MaintenanceRunHistory runs={maintenance.runs} />}
        </section>
      ) : null}
    </div>
  );
}

type RecentTasks =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; tasks: DashboardTaskRow[]; more: boolean };

/**
 * The newest tasks of the schedule's type in its queue.
 *
 * The task listing has no schedule filter, so this list also holds tasks of the same type that
 * an application enqueued directly. The heading says so.
 */
function ScheduleRecentTasks({
  schedule,
  tasksHref,
  capturedAt,
}: {
  schedule: PresentedScheduleRow;
  tasksHref: string;
  capturedAt: string;
}) {
  const client = useDashboardClient();
  const [recent, setRecent] = useState<RecentTasks>({ status: "loading" });
  const occurrences = schedule.occurrenceCount ?? 0;
  const destination = JSON.stringify([schedule.queue, schedule.type]);
  // The list shows a loader only for a new destination. A refresh keeps the rows until it ends.
  const loadedDestination = useRef<string | null>(null);
  // A poll can arrive before the previous read ends. The reader then runs one more read after it,
  // so a slow read still shows its rows and requests do not pile up.
  const reader = useRef<CoalescedRead<DashboardTasksCursorPage> | null>(null);
  useEffect(() => {
    const read = createCoalescedRead<DashboardTasksCursorPage>((result) => {
      if (result.status === "ready") {
        const page = result.value;
        setRecent({
          status: "ready",
          tasks: page.tasks.slice(0, RECENT_TASK_LIMIT),
          more: page.tasks.length > RECENT_TASK_LIMIT || page.nextCursor !== null,
        });
      } else {
        setRecent({
          status: "failed",
          message: result.error instanceof Error ? result.error.message : "The request failed.",
        });
      }
    });
    reader.current = read;
    loadedDestination.current = null;
    return () => read.close();
  }, []);
  useEffect(() => {
    if (loadedDestination.current !== destination) setRecent({ status: "loading" });
    loadedDestination.current = destination;
    reader.current?.request(destination, () =>
      client.tasksCursor({
        queue: schedule.queue,
        taskType: schedule.type,
        pageSize: 25,
        count: "none",
      }),
    );
    // A refresh of the page reloads the list, so task states stay current and a failed read can
    // recover. A new fire also reloads it, also after the count reaches its cap.
  }, [
    client,
    destination,
    schedule.queue,
    schedule.type,
    occurrences,
    schedule.lastFiredAt,
    capturedAt,
  ]);

  return (
    <section className="schedule-drawer__section" aria-labelledby="schedule-drawer-tasks">
      <div className="schedule-drawer__section-header">
        <h3 className="schedule-drawer__section-title" id="schedule-drawer-tasks">
          Recent tasks
        </h3>
        <Anchor href={tasksHref} size="sm" className="schedule-drawer__link">
          View all in Tasks
        </Anchor>
      </div>
      <Text c="dimmed" size="xs">
        Tasks of type <Code fz="xs">{schedule.type}</Code> in the {schedule.queue} queue, most
        recently updated first. Workhorse enqueued {scheduleOccurrenceCount(schedule)}{" "}
        {occurrences === 1 ? "occurrence" : "occurrences"} of this schedule.
      </Text>
      {recent.status === "loading" ? (
        <Group gap="xs" py="sm" aria-live="polite">
          <Loader size={14} />
          <Text size="sm" c="dimmed">
            Loading tasks
          </Text>
        </Group>
      ) : recent.status === "failed" ? (
        <Text size="sm" c="red" py="sm" role="alert">
          Could not load tasks: {recent.message}
        </Text>
      ) : recent.tasks.length === 0 ? (
        <Text size="sm" c="dimmed" py="sm">
          No task of this type is in the queue. Finished tasks leave after their retention period.
        </Text>
      ) : (
        <ul className="schedule-drawer__tasks">
          {recent.tasks.map((task) => (
            <li key={task.id}>
              <a className="schedule-drawer__task" href={taskDrawerHref(tasksHref, task.id)}>
                <span className="schedule-drawer__task-id">{task.id.slice(0, 8)}</span>
                <StatusLabel state={task.state} />
                <span className="schedule-drawer__task-time" title={formatExact(task.createdAt)}>
                  Created {formatRelative(task.createdAt)}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
      {recent.status === "ready" && recent.more ? (
        <Text size="xs" c="dimmed">
          Showing the newest {formatCount(recent.tasks.length)}.{" "}
          <Anchor href={tasksHref} size="xs">
            Open the Tasks view
          </Anchor>{" "}
          to see more.
        </Text>
      ) : null}
    </section>
  );
}
