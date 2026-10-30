import { taskStatusColors } from "../status-colors.js";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  ActionIcon,
  Box,
  Button,
  Code,
  Group,
  ScrollArea,
  Stack,
  Stepper,
  Text,
  Tooltip,
} from "@mantine/core";
import {
  ArrowRight01Icon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  Copy01Icon,
  UnavailableIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { describeDurableBoundary, readTaskResultEvidence } from "../presentation.js";
import type { DashboardTaskDetail } from "@stablemates/workhorse-dashboard-server/wire";
import {
  checkpointOutput,
  formatBytes,
  formatExact,
  formatJson,
  formatRelative,
  hasStoredValue,
} from "../preferences.js";
import { useDashboardClient } from "../core.js";
import { formatCount } from "../count-format.js";
import { HelpButton } from "./help-button.js";

type Checkpoint = DashboardTaskDetail["checkpoints"][number];

/**
 * One top-level block of the task detail drawer.
 *
 * Every section shares this wrapper so the drawer reads as a sequence of identically headed
 * blocks. Sections render conditionally, so each one carries its own space above it instead of a
 * sibling divider that could be left behind.
 */
export function DrawerSection({
  id,
  title,
  help,
  aside,
  children,
}: {
  /** Stable heading element id, used as the section's aria-labelledby target. */
  id: string;
  title: string;
  /** An explanation of the section, behind an information control beside the title. */
  help?: string;
  /** Optional right-aligned heading companion, such as a count in plain muted text. */
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Box component="section" aria-labelledby={id} className="task-drawer__section">
      <div className="task-drawer__section-head">
        <h3 id={id} className="task-drawer__section-title">
          {title}
        </h3>
        {help ? <HelpButton label={title} help={help} /> : null}
        {aside ? <span className="task-drawer__section-aside">{aside}</span> : null}
      </div>
      {children}
    </Box>
  );
}
/**
 * Secondary detail that stays closed until an operator asks for it.
 *
 * It is a native disclosure, so the keyboard, screen readers, and find-in-page work without
 * script, and a refresh keeps it open or closed because React does not own its `open` state.
 */
export function DrawerDisclosure({
  title,
  summary,
  compact = false,
  children,
}: {
  title: string;
  /** A short digest beside the title, so the closed disclosure still says something. */
  summary?: ReactNode;
  /** A smaller disclosure inside another block, such as the error of one attempt. */
  compact?: boolean;
  children: ReactNode;
}) {
  return (
    <details
      className={
        compact
          ? "task-drawer__disclosure task-drawer__disclosure--compact"
          : "task-drawer__disclosure"
      }
    >
      <summary>
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          size={14}
          strokeWidth={2}
          aria-hidden
          className="task-drawer__disclosure-icon"
        />
        <span className="task-drawer__disclosure-title">{title}</span>
        {summary ? <span className="task-drawer__disclosure-summary">{summary}</span> : null}
      </summary>
      <div className="task-drawer__disclosure-body">{children}</div>
    </details>
  );
}
/** A small round mark in a state hue. The text beside it carries the meaning. */
export function StateDot({ color }: { color: string }) {
  return (
    <span
      className="task-detail__dot"
      data-color={color}
      aria-hidden="true"
      style={{ ["--task-detail-dot" as string]: `var(--mantine-color-${color}-filled)` }}
    />
  );
}
/**
 * One label/value row of drawer metadata.
 *
 * Rows sit in a two-column grid with a fixed label column, so every value starts on the same
 * vertical line.
 */
export function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="task-drawer__meta-row">
      <div className="task-drawer__meta-label">{label}</div>
      <div className="task-drawer__meta-value">{children}</div>
    </div>
  );
}
/**
 * Bounded viewer for one stored JSON value.
 *
 * Every stored value in this drawer is operator evidence, so it is shown in full rather than
 * truncated, but its height is capped and it scrolls inside its own box so one large payload
 * cannot push the rest of the drawer off screen. The copy action carries the exact bytes, because
 * a value an operator can read but not extract is not usable evidence.
 *
 * When nothing is stored, `emptyLabel` is shown instead. No placeholder value is ever invented.
 */
export function JsonValue({
  label,
  value,
  emptyLabel,
  copyLabel,
  maxHeight = 280,
  tone = "neutral",
}: {
  label: string;
  value: unknown;
  emptyLabel: string;
  /** What to name this value to a screen reader on the copy control. */
  copyLabel: string;
  maxHeight?: number;
  /** An error value gets a red edge, so it does not read as a result. */
  tone?: "neutral" | "error";
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const present = hasStoredValue(value);
  const text = present ? formatJson(value) : "";
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = useCallback(() => {
    setCopyError(null);
    if (!navigator.clipboard) {
      setCopyError("Copying is not available in this browser. Select the text to copy it.");
      return;
    }
    void navigator.clipboard.writeText(text).then(
      () => setCopied(true),
      () => setCopyError("Copying is not available in this browser. Select the text to copy it."),
    );
  }, [text]);
  if (!present) {
    return <p className="task-detail__note">{emptyLabel}</p>;
  }
  return (
    <Box>
      <div className="task-drawer__code" data-tone={tone}>
        <div className="task-drawer__code-head">
          <span className="task-drawer__code-label">{label}</span>
          <Tooltip label={copied ? "Copied" : `Copy ${copyLabel}`} withArrow>
            <ActionIcon
              size="sm"
              variant="subtle"
              color="gray"
              aria-label={copied ? `${copyLabel} copied to the clipboard` : `Copy ${copyLabel}`}
              onClick={copy}
            >
              <HugeiconsIcon
                icon={copied ? CheckmarkCircle02Icon : Copy01Icon}
                size={14}
                strokeWidth={copied ? 2 : 1.5}
              />
            </ActionIcon>
          </Tooltip>
        </div>
        <ScrollArea.Autosize mah={maxHeight} type="auto">
          <pre className="task-drawer__code-body">{text}</pre>
        </ScrollArea.Autosize>
      </div>
      {/* Copy feedback is announced, not only shown as an icon. */}
      <Box role="status" aria-live="polite">
        {copyError ? (
          <Text c="red" size="xs" mt={4}>
            {copyError}
          </Text>
        ) : copied ? (
          <Text c="dimmed" size="xs" mt={4}>
            Copied {copyLabel} to the clipboard.
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}
/**
 * Final outcome of one task: the stored result, the terminal error, or the latest attempt error.
 *
 * The header already states the task's state, so this section shows only the value. A task that
 * has not finished and has no attempt error has nothing to show, and the section is omitted. A
 * retrying task's error is titled as an attempt error, so it is never read as a terminal one.
 */
export function TaskOutcome({ task }: { task: DashboardTaskDetail }) {
  const outcome = task.current.outcome;
  const evidence = readTaskResultEvidence({
    state: task.identity.state,
    outcome,
    runtimeError: task.current.runtime?.error,
    currentError: task.current.error,
    blockedByPersistentFailure: task.durability?.persistentFailure != null,
  });
  const described = evidence.description;
  if (described.state === "pending" && described.valueLabel === null) return null;
  const isResult = described.state === "succeeded";
  const title = isResult
    ? "Result"
    : described.state === "pending"
      ? "Latest attempt error"
      : described.state === "canceled"
        ? "Cancellation"
        : "Error";
  const valueLabel = isResult || described.state === "canceled" ? "JSON" : "Error";
  const copyLabel = (described.valueLabel ?? "final result").toLowerCase();
  return (
    <DrawerSection id="task-outcome-heading" title={title} help={described.summary}>
      {/* Only a succeeded outcome shows the stored result; every other value here is an error,
          which task detail always carries. */}
      {outcome?.state === "succeeded" && described.valueLabel !== null ? (
        <TaskStoredValue
          taskId={task.identity.id}
          kind="result"
          omitted={outcome.resultOmitted}
          valueBytes={outcome.resultBytes}
          value={evidence.value}
          label={valueLabel}
          emptyLabel={described.emptyLabel ?? "Nothing was stored."}
          copyLabel={copyLabel}
        />
      ) : (
        <JsonValue
          label={valueLabel}
          value={evidence.value}
          emptyLabel={described.emptyLabel ?? "Nothing was stored."}
          copyLabel={copyLabel}
          tone={described.state === "failed" || described.state === "pending" ? "error" : "neutral"}
        />
      )}
    </DrawerSection>
  );
}
/**
 * One stored value the drawer did not carry, shown by size until an operator asks for it.
 *
 * A payload, a result, or a checkpoint may hold a megabyte, and a drawer that carried every one of
 * them would transfer all of them to draw a summary. Task detail reports the size of a value it
 * withheld, and this asks PostgreSQL for the one value an operator opens.
 */
function StoredValue({
  identity,
  omitted,
  valueBytes,
  value,
  read,
  label,
  emptyLabel,
  copyLabel,
  maxHeight,
}: {
  /** Changing this discards a value fetched for the previous one. */
  identity: string;
  omitted: boolean;
  valueBytes: number;
  value: unknown;
  read: () => Promise<unknown>;
  label: string;
  emptyLabel: string;
  copyLabel: string;
  maxHeight?: number;
}) {
  const [fetched, setFetched] = useState<{ value: unknown } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setFetched(null);
    setError(null);
  }, [identity]);
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setFetched({ value: await read() });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Workhorse could not read this value");
    } finally {
      setLoading(false);
    }
  }, [read]);
  if (!omitted || fetched !== null) {
    return (
      <JsonValue
        label={label}
        value={fetched === null ? value : fetched.value}
        emptyLabel={emptyLabel}
        copyLabel={copyLabel}
        maxHeight={maxHeight}
      />
    );
  }
  return (
    <div className="task-drawer__code task-drawer__code--withheld">
      <div className="task-drawer__code-head">
        <span className="task-drawer__code-label">
          {label} · {formatBytes(valueBytes)}, not loaded with the task
        </span>
        <Button size="compact-xs" variant="default" loading={loading} onClick={() => void load()}>
          Show this value
        </Button>
      </div>
      {error === null ? null : (
        <Text c="red" size="xs" px="sm" pb="xs">
          {error}
        </Text>
      )}
    </div>
  );
}

/** One task's whole stored payload or result, read on demand when the drawer withheld it. */
export function TaskStoredValue({
  taskId,
  kind,
  omitted,
  valueBytes,
  value,
  label,
  emptyLabel,
  copyLabel,
}: {
  taskId: string;
  kind: "payload" | "result";
  omitted: boolean;
  valueBytes: number;
  value: unknown;
  label: string;
  emptyLabel: string;
  copyLabel: string;
}) {
  const client = useDashboardClient();
  const read = useCallback(
    async () => (await client.taskValue({ id: taskId, kind })).value,
    [client, taskId, kind],
  );
  return (
    <StoredValue
      identity={`${taskId}:${kind}`}
      omitted={omitted}
      valueBytes={valueBytes}
      value={value}
      read={read}
      label={label}
      emptyLabel={emptyLabel}
      copyLabel={copyLabel}
    />
  );
}

/** One checkpoint's saved value, read on demand when the drawer withheld it. */
function CheckpointValue({
  taskId,
  checkpoint,
  label,
  maxHeight,
}: {
  taskId: string;
  checkpoint: Checkpoint;
  label: string;
  maxHeight?: number;
}) {
  const client = useDashboardClient();
  const read = useCallback(
    async () => (await client.checkpointValue({ id: taskId, name: checkpoint.name })).value,
    [client, taskId, checkpoint.name],
  );
  return (
    <StoredValue
      identity={`${taskId}:${checkpoint.name}`}
      omitted={checkpoint.valueOmitted}
      valueBytes={checkpoint.valueBytes}
      value={checkpoint.value}
      read={read}
      label={label}
      emptyLabel="This checkpoint stored no value."
      copyLabel={`the ${checkpoint.name} interim result`}
      maxHeight={maxHeight}
    />
  );
}
function plannedStepDescription(
  task: DashboardTaskDetail,
  checkpoint: Checkpoint | undefined,
  stepIndex: number,
  activeStep: number,
) {
  const boundary = describeDurableBoundary({
    stepIndex,
    hasCheckpoint: checkpoint !== undefined,
    persistentFailureAfterStepIndex: task.durability?.persistentFailure?.afterStepIndex ?? null,
  });
  if (checkpoint) {
    return (
      <Stack gap={2} mt={2}>
        <Text c="dimmed" size="xs">
          Attempt {checkpoint.attempt} · {checkpoint.workerId} · fence {checkpoint.fenceToken}
        </Text>
        {checkpoint.valueOmitted ? (
          <Code fz="xs">{formatBytes(checkpoint.valueBytes)} saved</Code>
        ) : (
          <Code fz="xs" title={JSON.stringify(checkpoint.value)}>
            {checkpointOutput(checkpoint.value)}
          </Code>
        )}
        {boundary.state === "blocked" ? (
          <Text c="dimmed" size="xs">
            {boundary.label}. {boundary.summary}
          </Text>
        ) : null}
      </Stack>
    );
  }
  // A stage past a declared persistent failure can never run again, so it is reported as never
  // reached rather than as waiting its turn.
  if (boundary.state === "not-reached") return `${boundary.label}. ${boundary.summary}`;
  if (stepIndex !== activeStep) return "An earlier stage must finish first";
  if (task.identity.state === "active")
    return "The stage is running, but Workhorse has not saved a checkpoint yet";
  if (task.identity.state === "ready") return "The task is ready for a worker";
  if (task.identity.state === "scheduled")
    return "The task is scheduled, so this stage has not started";
  if (task.identity.state === "failed") return "The task failed before it reached this stage";
  return "Workhorse did not record a checkpoint";
}
function PlannedDurability({ task }: { task: DashboardTaskDetail }) {
  const plan = task.durability!;
  const checkpoints = new Map(task.checkpoints.map((checkpoint) => [checkpoint.name, checkpoint]));
  const planNames = new Set(plan.steps.map((step) => step.name));
  const completedPlanSteps = plan.steps.filter((step) => checkpoints.has(step.name)).length;
  const unmatchedCheckpoints = task.checkpoints.filter(
    (checkpoint) => !planNames.has(checkpoint.name),
  );
  const activeStep = plan.steps.findIndex((step) => !checkpoints.has(step.name));
  const resolvedActiveStep = activeStep === -1 ? plan.steps.length : activeStep;
  const persistentFailure = plan.persistentFailure;
  const hasEvidencePastPersistentBoundary =
    persistentFailure !== null &&
    plan.steps.some(
      (step, stepIndex) =>
        stepIndex > persistentFailure.afterStepIndex && checkpoints.has(step.name),
    );
  return (
    <Box>
      <div className="task-drawer__item-head">
        <span className="task-drawer__item-title">{plan.label}</span>
        <span className="task-detail__muted task-detail__number">
          {formatCount(completedPlanSteps)} of {formatCount(plan.steps.length)} saved
        </span>
        <HelpButton
          label={plan.label}
          help={`${plan.description} This demo defines the stage plan. Workhorse stores checkpoint and wait records, not the plan.`}
        />
      </div>
      {persistentFailure ? (
        /* State is carried by the heading text and the icon, never by colour alone. */
        <Box className="task-drawer__callout" mb="sm">
          <Group gap={6} align="center" wrap="nowrap" mb={2}>
            <HugeiconsIcon icon={UnavailableIcon} size={13} strokeWidth={2} aria-hidden />
            <Text fw={600} size="xs">
              {hasEvidencePastPersistentBoundary
                ? "Earlier demo evidence detected"
                : "Intentionally blocked between stages"}
            </Text>
          </Group>
          <Text c="dimmed" size="xs">
            {hasEvidencePastPersistentBoundary
              ? "An earlier demo saved checkpoints after the current failure boundary. Workhorse keeps that evidence below. "
              : "Workhorse keeps the interim results that it already saved. "}
            {persistentFailure.reason}
          </Text>
        </Box>
      ) : null}
      <Stepper
        active={resolvedActiveStep}
        orientation="vertical"
        size="xs"
        color="violet"
        iconSize={28}
        allowNextStepsSelect={false}
        completedIcon={<HugeiconsIcon icon={CheckmarkCircle02Icon} size={15} strokeWidth={2} />}
        progressIcon={
          // A blocked task is not waiting for anything, so it never shows a waiting clock.
          persistentFailure && !hasEvidencePastPersistentBoundary ? (
            <HugeiconsIcon
              icon={UnavailableIcon}
              size={14}
              strokeWidth={2}
              style={{ display: "block" }}
            />
          ) : (
            <HugeiconsIcon
              icon={Clock01Icon}
              size={14}
              strokeWidth={2}
              style={{ display: "block" }}
            />
          )
        }
      >
        {plan.steps.map((step, stepIndex) => {
          const checkpoint = checkpoints.get(step.name);
          const boundary = describeDurableBoundary({
            stepIndex,
            hasCheckpoint: checkpoint !== undefined,
            persistentFailureAfterStepIndex: persistentFailure?.afterStepIndex ?? null,
          });
          return (
            <Stepper.Step
              key={step.name}
              label={step.label}
              description={plannedStepDescription(task, checkpoint, stepIndex, resolvedActiveStep)}
              loading={
                !persistentFailure &&
                task.identity.state === "active" &&
                stepIndex === resolvedActiveStep
              }
              allowStepSelect={false}
              aria-label={`${step.label}: ${boundary.label}. ${boundary.summary}`}
            />
          );
        })}
        <Stepper.Completed>
          {persistentFailure && !hasEvidencePastPersistentBoundary ? (
            <Text c="dimmed" fw={600} size="sm" mt="xs">
              Workhorse saved every reachable boundary. This demo blocks the task before it can
              produce a final result.
            </Text>
          ) : (
            <Text
              c={task.identity.state === "succeeded" ? "teal" : undefined}
              fw={600}
              size="sm"
              mt="xs"
            >
              {task.identity.state === "succeeded"
                ? "Workhorse saved every declared boundary, and the task finished."
                : "Workhorse saved every declared boundary, but the current attempt is still running."}
            </Text>
          )}
        </Stepper.Completed>
      </Stepper>
      {unmatchedCheckpoints.length > 0 ? (
        <Box mt="md">
          <Text fw={600} size="xs" mb={4}>
            Additional interim results
          </Text>
          <Stack gap="xs">
            {unmatchedCheckpoints.map((checkpoint) => (
              <CheckpointValue
                key={checkpoint.name}
                taskId={task.identity.id}
                checkpoint={checkpoint}
                label={checkpoint.name}
                maxHeight={160}
              />
            ))}
          </Stack>
        </Box>
      ) : null}
    </Box>
  );
}
/** Saved interim results. Omitted for a task that saved none and declares no stage plan. */
export function TaskCheckpoints({ task }: { task: DashboardTaskDetail }) {
  if (!task.durability && task.checkpoints.length === 0) return null;
  const currentAttempt = task.current.outcome?.attempt ?? task.current.runtime?.attempt ?? 1;
  return (
    <DrawerSection
      id="interim-results-heading"
      title="Interim results"
      help="Interim results show completed work rather than current progress. Workhorse saves each result at a named restart boundary, and later attempts reuse it."
      aside={
        <span className="task-detail__muted task-detail__number">
          {formatCount(task.checkpoints.length)}
          {task.truncated.checkpoints ? "+" : ""}
        </span>
      }
    >
      {task.truncated.checkpoints ? (
        <p className="task-detail__note">
          This task saved more results than the drawer shows. These are its most recent.
        </p>
      ) : null}
      {task.durability ? (
        <PlannedDurability task={task} />
      ) : (
        <Stack gap="md">
          {task.checkpoints.map((checkpoint) => {
            const persistedAcrossRetry = currentAttempt > checkpoint.attempt;
            return (
              <Box key={checkpoint.name}>
                <div className="task-drawer__item-head">
                  <span className="task-drawer__item-title">{checkpoint.name}</span>
                  <span className="task-detail__muted" title={formatExact(checkpoint.createdAt)}>
                    {persistedAcrossRetry ? "Kept across retry · " : ""}attempt {checkpoint.attempt}{" "}
                    · {checkpoint.workerId} · fence {checkpoint.fenceToken} ·{" "}
                    {formatRelative(checkpoint.createdAt)}
                  </span>
                </div>
                <CheckpointValue taskId={task.identity.id} checkpoint={checkpoint} label="JSON" />
              </Box>
            );
          })}
        </Stack>
      )}
    </DrawerSection>
  );
}
/** The latest mutable progress. Omitted when the task reported none. */
export function TaskProgress({ task }: { task: DashboardTaskDetail }) {
  const progress = task.progress;
  if (!progress) return null;
  return (
    <DrawerSection
      id="task-progress-heading"
      title="Progress"
      aside={
        <span className="task-detail__muted" title={formatExact(progress.updatedAt)}>
          Revision {progress.revision} · attempt {progress.attempt} · {progress.workerId} · fence{" "}
          {progress.fenceToken} · updated {formatRelative(progress.updatedAt)}
        </span>
      }
    >
      <JsonValue
        label={`Revision ${progress.revision}`}
        value={progress.value}
        emptyLabel="The worker reported JSON null as its latest progress."
        copyLabel="the latest task progress"
      />
    </DrawerSection>
  );
}
export type DurableWait = DashboardTaskDetail["waits"][number];
export type TaskEvent = DashboardTaskDetail["events"][number];
export type WaitPhase = "sleeping" | "waking" | "resumed";
export const waitPhaseLabel: Record<WaitPhase, string> = {
  sleeping: "Sleeping",
  waking: "Waking",
  resumed: "Resumed",
};
export const waitPhaseColor: Record<WaitPhase, string> = {
  sleeping: "indigo",
  waking: "cyan",
  resumed: "teal",
};
/** Exact replay wording for a durable wait boundary; kept verbatim on purpose. */
export const waitReplayWording =
  "After the target time, the next claim restarts the handler from its entry point in the same attempt.";
/**
 * Phase of one stored wait. Only the runtime row currently marked with this wait
 * name is still suspended; anything else means the handler already restarted.
 */
export function waitPhaseFor(
  task: DashboardTaskDetail,
  wait: DurableWait,
  nowMs: number,
): WaitPhase {
  const runtime = task.current.runtime;
  if (!runtime || runtime.waitName !== wait.name) return "resumed";
  return new Date(wait.wakeAt).getTime() > nowMs ? "sleeping" : "waking";
}
export function eventDetail(event: TaskEvent, key: string): string | null {
  const details = event.details;
  if (!details || typeof details !== "object") return null;
  const value = (details as Record<string, unknown>)[key];
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}
export const boundaryEventPresentation: Record<string, { label: string; color: string }> = {
  enqueued: { label: "Enqueued", color: "gray" },
  debounced: { label: "Debounced", color: "grape" },
  debounce_rejected: { label: "Debounce rejected", color: "orange" },
  throttled: { label: "Throttled", color: "grape" },
  wait_scheduled: { label: "Wait scheduled", color: taskStatusColors.durableWait },
  wait_elapsed: { label: "Wait elapsed", color: taskStatusColors.ready },
  wait_replayed: { label: "Wait replayed", color: "grape" },
  signal_waiting: { label: "Waiting for signal", color: taskStatusColors.signalWait },
  signal_received: { label: "Signal received", color: "teal" },
  signal_replayed: { label: "Signal replayed", color: "grape" },
  signal_rejected: { label: "Signal rejected", color: "orange" },
  batch_dispatched: { label: "Batch dispatched", color: taskStatusColors.active },
  batch_failed: { label: "Batch failed", color: taskStatusColors.failed },
  claimed: { label: "Claimed", color: taskStatusColors.active },
  checkpoint_saved: { label: "Checkpoint saved", color: "teal" },
  progress_updated: { label: "Progress updated", color: taskStatusColors.active },
  retry_scheduled: { label: "Retry scheduled", color: taskStatusColors.scheduled },
  cancel_requested: { label: "Cancellation requested", color: taskStatusColors.canceled },
  promoted: { label: "Promoted", color: taskStatusColors.ready },
  lease_expired: { label: "Lease expired", color: taskStatusColors.failed },
  released: { label: "Released", color: taskStatusColors.ready },
  deadline_exceeded: { label: "Deadline exceeded", color: taskStatusColors.failed },
  execution_timed_out: { label: "Execution timed out", color: taskStatusColors.failed },
  redriven: { label: "Redriven", color: "orange" },
  redrive_created: { label: "Redrive created", color: "orange" },
  dependency_blocked: { label: "Dependency blocked", color: taskStatusColors.blocked },
  dependency_released: { label: "Dependency released", color: "teal" },
  dependency_failed: { label: "Dependency failed", color: taskStatusColors.failed },
  dependency_canceled: { label: "Dependency canceled", color: taskStatusColors.canceled },
  dependency_counter_repaired: { label: "Dependency counter repaired", color: "orange" },
  child_created: { label: "Child created", color: "blue" },
  child_joined: { label: "Child joined", color: "teal" },
  children_created: { label: "Children created", color: "blue" },
  children_joined: { label: "Children joined", color: "teal" },
  parent_linked: { label: "Parent linked", color: "blue" },
  human_wait_created: { label: "Human wait created", color: taskStatusColors.humanWait },
  human_wait_completed: { label: "Human wait completed", color: "teal" },
  human_wait_replayed: { label: "Human wait replayed", color: "grape" },
  human_wait_rejected: { label: "Human wait rejected", color: "orange" },
  succeeded: { label: "Succeeded", color: taskStatusColors.succeeded },
  failed: { label: "Failed", color: taskStatusColors.failed },
  canceled: { label: "Canceled", color: taskStatusColors.canceled },
};
export function genericEventLabel(type: string): string {
  const words = type.replaceAll("_", " ");
  return words.length === 0 ? "Unknown event" : `${words[0]!.toUpperCase()}${words.slice(1)}`;
}
export interface CoalescingEvidence {
  mode: "debounce" | "throttle";
  scope: string;
  keyDigest: string;
  keyLength: number;
  windowMs: number;
  schedule: string | null;
  expiresAt: string | null;
  absorbed: number;
  rejected: number;
}
export function coalescingEvidenceFor(task: DashboardTaskDetail): CoalescingEvidence | null {
  let latest: { type: string; occurredAt: string; evidence: CoalescingEvidence } | null = null;
  for (const event of task.events) {
    // Rejected submissions describe a proposal, not the task's accepted configuration.
    if (!["enqueued", "debounced", "throttled"].includes(event.type)) continue;
    if (!event.details || typeof event.details !== "object") continue;
    const details = event.details as Record<string, unknown>;
    const mode = details.debounce ? "debounce" : details.throttle ? "throttle" : null;
    if (mode === null) continue;
    const raw = details[mode];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const scope = typeof record.scope === "string" ? record.scope : null;
    const keyDigest = typeof record.key_digest === "string" ? record.key_digest : null;
    const keyLength = typeof record.key_length === "number" ? record.key_length : null;
    const windowMs = typeof record.window_ms === "number" ? record.window_ms : null;
    if (scope === null || keyDigest === null || keyLength === null || windowMs === null) continue;
    // Throttle preserves the initial window; debounce replacements may reset theirs.
    if (mode === "throttle" && latest?.type === "enqueued") continue;
    const originalThrottle = mode === "throttle" && event.type === "enqueued";
    if (!originalThrottle && latest && Date.parse(event.occurredAt) < Date.parse(latest.occurredAt))
      continue;
    const evidence: CoalescingEvidence = {
      mode,
      scope,
      keyDigest,
      keyLength,
      windowMs,
      schedule: typeof record.schedule === "string" ? record.schedule : null,
      expiresAt: typeof record.expires_at === "string" ? record.expires_at : null,
      absorbed: 0,
      rejected: 0,
    };
    latest = { type: event.type, occurredAt: event.occurredAt, evidence };
  }
  if (!latest) return null;
  const evidence = latest.evidence;
  return {
    ...evidence,
    absorbed: task.events.filter((event) =>
      evidence.mode === "debounce" ? event.type === "debounced" : event.type === "throttled",
    ).length,
    rejected:
      evidence.mode === "debounce"
        ? task.events.filter((event) => event.type === "debounce_rejected").length
        : 0,
  };
}
export function enqueueCount(count: number, adjective: string): string {
  return `${formatCount(count)} ${adjective} enqueue${count === 1 ? "" : "s"}`;
}
