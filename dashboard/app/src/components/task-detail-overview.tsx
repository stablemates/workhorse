import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  ActionIcon,
  Badge,
  Box,
  Code,
  Group,
  Paper,
  ScrollArea,
  Stack,
  Stepper,
  Text,
  Tooltip,
} from "@mantine/core";
import { CheckCircle, Clock, Copy, Prohibit } from "@phosphor-icons/react";
import {
  describeDurableBoundary,
  readTaskResultEvidence,
  type TaskResultState,
} from "../presentation.js";
import type { DashboardJobDetail } from "@workhorse-js/dashboard-server/wire";
import {
  checkpointOutput,
  formatExact,
  formatJson,
  formatRelative,
  hasStoredValue,
} from "../preferences.js";

/**
 * One top-level block of the task detail drawer.
 *
 * Every section shares this wrapper so the drawer reads as a sequence of separated, identically
 * headed blocks instead of one continuous column. The separator is a border on the section itself
 * rather than a sibling `Divider`, because most sections render conditionally and a divider next
 * to a section that returned null would leave a stray rule.
 */
export function DrawerSection({
  id,
  title,
  aside,
  children,
}: {
  /** Stable heading element id, used as the section's aria-labelledby target. */
  id: string;
  title: string;
  /** Optional right-aligned heading companion, typically a count or state badge. */
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Box component="section" aria-labelledby={id} className="task-drawer__section">
      <Group justify="space-between" align="center" mb="xs" wrap="nowrap">
        <Text id={id} component="h3" fw={600} size="sm" my={0}>
          {title}
        </Text>
        {aside ?? null}
      </Group>
      {children}
    </Box>
  );
}
/**
 * One aligned label/value row of drawer metadata.
 *
 * The label column has a fixed width so every value in the overview starts on the same vertical
 * line; without it each row's label, badge, and explainer run together at a different offset and
 * the block reads as one dense paragraph.
 */
export function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Group gap="sm" align="baseline" wrap="nowrap">
      <Text c="dimmed" size="xs" fw={600} className="task-drawer__meta-label">
        {label}
      </Text>
      <Group gap="xs" align="baseline" wrap="wrap" style={{ flex: 1, minWidth: 0 }}>
        {children}
      </Group>
    </Group>
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
  maxHeight = 220,
}: {
  label: string;
  value: unknown;
  emptyLabel: string;
  /** What to name this value to a screen reader on the copy control. */
  copyLabel: string;
  maxHeight?: number;
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
  return (
    <Box>
      <Group justify="space-between" align="center" mb={4} wrap="nowrap">
        <Text fw={600} size="xs">
          {label}
        </Text>
        {present ? (
          <Tooltip label={copied ? "Copied" : `Copy ${copyLabel}`} withArrow>
            <ActionIcon
              size="sm"
              variant="subtle"
              color={copied ? "teal" : "gray"}
              aria-label={copied ? `${copyLabel} copied to the clipboard` : `Copy ${copyLabel}`}
              onClick={copy}
            >
              {copied ? <CheckCircle size={14} weight="bold" /> : <Copy size={14} />}
            </ActionIcon>
          </Tooltip>
        ) : null}
      </Group>
      {present ? (
        <>
          <ScrollArea.Autosize mah={maxHeight} type="auto">
            <Code block fz="xs">
              {text}
            </Code>
          </ScrollArea.Autosize>
          {/* Copy feedback is announced, not only coloured, so the result is never icon-only. */}
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
        </>
      ) : (
        <Text c="dimmed" size="xs">
          {emptyLabel}
        </Text>
      )}
    </Box>
  );
}
export const outcomeStateColor: Record<TaskResultState, string> = {
  succeeded: "teal",
  failed: "red",
  canceled: "gray",
  pending: "yellow",
};
/**
 * Final outcome of one task, stated before any interim evidence.
 *
 * An operator opening this drawer is usually asking "did this finish, and what did it produce?".
 * That question is answered from the stored terminal row alone: a task that has not finished says
 * so instead of showing an empty result, and a retrying task's latest error is labelled as an
 * attempt error so it is never mistaken for a terminal one.
 */
export function TaskOutcome({ job }: { job: DashboardJobDetail }) {
  const outcome = job.current.outcome;
  const evidence = readTaskResultEvidence({
    state: job.identity.state,
    outcome,
    runtimeError: job.current.runtime?.error,
    currentError: job.current.error,
    blockedByPersistentFailure: job.durability?.persistentFailure != null,
  });
  const described = evidence.description;
  return (
    <DrawerSection
      id="task-outcome-heading"
      title="Outcome"
      aside={
        <Badge
          variant="light"
          color={outcomeStateColor[described.state]}
          tt="none"
          title={outcome ? `Finished ${formatExact(outcome.finishedAt)}` : described.summary}
        >
          {described.label}
        </Badge>
      }
    >
      <Text c="dimmed" size="xs" mb="xs">
        {described.summary}
      </Text>
      {outcome ? (
        <Text c="dimmed" size="xs" mb="xs" title={formatExact(outcome.finishedAt)}>
          Attempt {outcome.attempt} finished {formatRelative(outcome.finishedAt)}
        </Text>
      ) : null}
      <JsonValue
        label={described.valueLabel ?? "Final result"}
        value={evidence.value}
        emptyLabel={described.emptyLabel ?? "Nothing was stored."}
        copyLabel={(described.valueLabel ?? "final result").toLowerCase()}
      />
    </DrawerSection>
  );
}
export function plannedStepDescription(
  job: DashboardJobDetail,
  checkpoint: DashboardJobDetail["checkpoints"][number] | undefined,
  stepIndex: number,
  activeStep: number,
) {
  const boundary = describeDurableBoundary({
    stepIndex,
    hasCheckpoint: checkpoint !== undefined,
    persistentFailureAfterStepIndex: job.durability?.persistentFailure?.afterStepIndex ?? null,
  });
  if (checkpoint) {
    return (
      <Stack gap={2} mt={2}>
        <Text c="dimmed" size="xs">
          Attempt {checkpoint.attempt} · {checkpoint.workerId} · fence {checkpoint.fenceToken}
        </Text>
        <Code fz="xs" title={JSON.stringify(checkpoint.value)}>
          {checkpointOutput(checkpoint.value)}
        </Code>
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
  if (job.identity.state === "active")
    return "The stage is running, but Workhorse has not saved a checkpoint yet";
  if (job.identity.state === "ready") return "The task is ready for a worker";
  if (job.identity.state === "scheduled")
    return "The task is scheduled, so this stage has not started";
  if (job.identity.state === "failed") return "The task failed before it reached this stage";
  return "Workhorse did not record a checkpoint";
}
export function PlannedDurability({ job }: { job: DashboardJobDetail }) {
  const plan = job.durability!;
  const checkpoints = new Map(job.checkpoints.map((checkpoint) => [checkpoint.name, checkpoint]));
  const planNames = new Set(plan.steps.map((step) => step.name));
  const completedPlanSteps = plan.steps.filter((step) => checkpoints.has(step.name)).length;
  const unmatchedCheckpoints = job.checkpoints.filter(
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
      <Group justify="space-between" align="flex-start" mb="sm">
        <Box>
          <Text fw={600} size="sm">
            {plan.label}
          </Text>
          <Text c="dimmed" size="xs">
            {plan.description}
          </Text>
        </Box>
        <Badge variant="light" color="violet">
          {completedPlanSteps}/{plan.steps.length} durable
        </Badge>
      </Group>
      {persistentFailure ? (
        /* State is carried by the heading text and the icon, never by colour alone. */
        <Paper withBorder p="xs" mb="sm">
          <Group gap={6} align="center" wrap="nowrap" mb={2}>
            <Prohibit size={13} weight="bold" aria-hidden />
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
        </Paper>
      ) : null}
      <Stepper
        active={resolvedActiveStep}
        orientation="vertical"
        size="xs"
        color="violet"
        iconSize={28}
        allowNextStepsSelect={false}
        completedIcon={<CheckCircle size={15} weight="bold" />}
        progressIcon={
          // A blocked task is not waiting for anything, so it never shows a waiting clock.
          persistentFailure && !hasEvidencePastPersistentBoundary ? (
            <Prohibit size={14} weight="bold" style={{ display: "block" }} />
          ) : (
            <Clock size={14} weight="bold" style={{ display: "block" }} />
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
              description={plannedStepDescription(job, checkpoint, stepIndex, resolvedActiveStep)}
              loading={
                !persistentFailure &&
                job.identity.state === "active" &&
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
              c={job.identity.state === "succeeded" ? "teal" : "violet"}
              fw={600}
              size="sm"
              mt="xs"
            >
              {job.identity.state === "succeeded"
                ? "Workhorse saved every declared boundary, and the task finished."
                : "Workhorse saved every declared boundary, but the current attempt is still running."}
            </Text>
          )}
        </Stepper.Completed>
      </Stepper>
      <Text c="dimmed" size="xs" mt="sm">
        This demo defines the stage plan. Workhorse stores checkpoint and wait records, not the
        plan.
      </Text>
      {unmatchedCheckpoints.length > 0 ? (
        <Box mt="md">
          <Text fw={600} size="xs" mb={4}>
            Additional interim results
          </Text>
          <Stack gap="xs">
            {unmatchedCheckpoints.map((checkpoint) => (
              <Paper key={checkpoint.name} withBorder p="xs">
                <JsonValue
                  label={checkpoint.name}
                  value={checkpoint.value}
                  emptyLabel="This checkpoint stored no value."
                  copyLabel={`the ${checkpoint.name} interim result`}
                  maxHeight={160}
                />
              </Paper>
            ))}
          </Stack>
        </Box>
      ) : null}
    </Box>
  );
}
export function JobCheckpoints({ job }: { job: DashboardJobDetail }) {
  const currentAttempt = job.current.outcome?.attempt ?? job.current.runtime?.attempt ?? 1;
  return (
    <DrawerSection
      id="interim-results-heading"
      title="Interim results"
      aside={
        <Badge variant="light" color={job.checkpoints.length > 0 ? "teal" : "gray"}>
          {job.checkpoints.length}
        </Badge>
      }
    >
      {/* Named once, here, so the rest of the section never has to re-explain what it is showing. */}
      <Text c="dimmed" size="xs" mb="sm">
        Interim results show completed work rather than current progress. Workhorse saves each
        result at a named restart boundary, and later attempts reuse it.
      </Text>
      {job.durability ? (
        <PlannedDurability job={job} />
      ) : job.checkpoints.length === 0 ? (
        <Text c="dimmed" size="sm">
          This task has not reached a named restart boundary.
        </Text>
      ) : (
        <Stack gap="sm">
          {job.checkpoints.map((checkpoint) => {
            const persistedAcrossRetry = currentAttempt > checkpoint.attempt;
            return (
              <Paper key={checkpoint.name} withBorder p="sm">
                <Group justify="space-between" align="flex-start">
                  <Box>
                    <Text fw={600} size="sm">
                      {checkpoint.name}
                    </Text>
                    <Text c="dimmed" size="xs" title={formatExact(checkpoint.createdAt)}>
                      Attempt {checkpoint.attempt} · {checkpoint.workerId}
                    </Text>
                    <Text c="dimmed" size="xs" title={formatExact(checkpoint.createdAt)}>
                      Fence {checkpoint.fenceToken} · {formatRelative(checkpoint.createdAt)}
                    </Text>
                  </Box>
                  <Badge variant="light" color={persistedAcrossRetry ? "violet" : "teal"}>
                    {persistedAcrossRetry ? "Persisted across retry" : "Saved"}
                  </Badge>
                </Group>
                <Box mt="sm">
                  <JsonValue
                    label="Checkpoint output"
                    value={checkpoint.value}
                    emptyLabel="This checkpoint stored no value."
                    copyLabel={`the ${checkpoint.name} interim result`}
                  />
                </Box>
              </Paper>
            );
          })}
        </Stack>
      )}
    </DrawerSection>
  );
}
export function JobProgress({ job }: { job: DashboardJobDetail }) {
  const progress = job.progress;
  return (
    <DrawerSection
      id="job-progress-heading"
      title="Latest progress"
      aside={
        <Badge variant="light" color={progress ? "blue" : "gray"}>
          {progress ? `Revision ${progress.revision}` : "Not reported"}
        </Badge>
      }
    >
      {progress ? (
        <Paper withBorder p="sm">
          <Text c="dimmed" size="xs" mb="sm" title={formatExact(progress.updatedAt)}>
            Attempt {progress.attempt} · {progress.workerId} · fence {progress.fenceToken} · updated{" "}
            {formatRelative(progress.updatedAt)}
          </Text>
          <JsonValue
            label="Mutable progress"
            value={progress.value}
            emptyLabel="The worker reported JSON null as its latest progress."
            copyLabel="the latest task progress"
          />
        </Paper>
      ) : (
        <Text c="dimmed" size="sm">
          This task has not reported mutable progress.
        </Text>
      )}
    </DrawerSection>
  );
}
export type DurableWait = DashboardJobDetail["waits"][number];
export type JobEvent = DashboardJobDetail["events"][number];
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
export function waitPhaseFor(job: DashboardJobDetail, wait: DurableWait, nowMs: number): WaitPhase {
  const runtime = job.current.runtime;
  if (!runtime || runtime.waitName !== wait.name) return "resumed";
  return new Date(wait.wakeAt).getTime() > nowMs ? "sleeping" : "waking";
}
export function eventDetail(event: JobEvent, key: string): string | null {
  const details = event.details;
  if (!details || typeof details !== "object") return null;
  const value = (details as Record<string, unknown>)[key];
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}
export const boundaryEventPresentation: Record<string, { label: string; color: string }> = {
  enqueued: { label: "Enqueued", color: "violet" },
  debounced: { label: "Debounced", color: "grape" },
  debounce_rejected: { label: "Debounce rejected", color: "orange" },
  throttled: { label: "Throttled", color: "grape" },
  wait_scheduled: { label: "Wait scheduled", color: "indigo" },
  wait_elapsed: { label: "Wait elapsed", color: "cyan" },
  wait_replayed: { label: "Wait replayed", color: "grape" },
  signal_waiting: { label: "Waiting for signal", color: "indigo" },
  signal_received: { label: "Signal received", color: "teal" },
  signal_replayed: { label: "Signal replayed", color: "grape" },
  signal_rejected: { label: "Signal rejected", color: "orange" },
  claimed: { label: "Claimed", color: "blue" },
  checkpoint_saved: { label: "Checkpoint saved", color: "teal" },
  progress_updated: { label: "Progress updated", color: "blue" },
  retry_scheduled: { label: "Retry scheduled", color: "orange" },
  cancel_requested: { label: "Cancellation requested", color: "gray" },
  promoted: { label: "Promoted", color: "yellow" },
  lease_expired: { label: "Lease expired", color: "red" },
  deadline_exceeded: { label: "Deadline exceeded", color: "red" },
  execution_timed_out: { label: "Execution timed out", color: "red" },
  redriven: { label: "Redriven", color: "orange" },
  redrive_created: { label: "Redrive created", color: "orange" },
  dependency_blocked: { label: "Dependency blocked", color: "orange" },
  dependency_released: { label: "Dependency released", color: "teal" },
  dependency_failed: { label: "Dependency failed", color: "red" },
  dependency_canceled: { label: "Dependency canceled", color: "gray" },
  child_created: { label: "Child created", color: "blue" },
  child_joined: { label: "Child joined", color: "teal" },
  children_created: { label: "Children created", color: "blue" },
  children_joined: { label: "Children joined", color: "teal" },
  parent_linked: { label: "Parent linked", color: "blue" },
  human_wait_created: { label: "Human wait created", color: "indigo" },
  human_wait_completed: { label: "Human wait completed", color: "teal" },
  human_wait_replayed: { label: "Human wait replayed", color: "grape" },
  human_wait_rejected: { label: "Human wait rejected", color: "orange" },
  succeeded: { label: "Succeeded", color: "green" },
  failed: { label: "Failed", color: "red" },
  canceled: { label: "Canceled", color: "gray" },
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
export function coalescingEvidenceFor(job: DashboardJobDetail): CoalescingEvidence | null {
  for (const event of job.events) {
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
    return {
      mode,
      scope,
      keyDigest,
      keyLength,
      windowMs,
      schedule: typeof record.schedule === "string" ? record.schedule : null,
      expiresAt: typeof record.expires_at === "string" ? record.expires_at : null,
      absorbed: job.events.filter((candidate) =>
        mode === "debounce" ? candidate.type === "debounced" : candidate.type === "throttled",
      ).length,
      rejected: job.events.filter((candidate) => candidate.type === "debounce_rejected").length,
    };
  }
  return null;
}
export function enqueueCount(count: number, adjective: string): string {
  return `${count} ${adjective} enqueue${count === 1 ? "" : "s"}`;
}
