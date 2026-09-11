import type { DashboardTaskDetail } from "@stablemates/workhorse-dashboard-server/wire";
import {
  ActionIcon,
  Badge,
  Box,
  Code,
  CopyButton,
  Group,
  Paper,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import {
  describeCancelOutcome,
  describeIdempotency,
  describeRetryEventSource,
  describeRetryPolicy,
  formatRetryDelay,
  formatIdempotencyWindow,
} from "../presentation.js";
import { readDashboardIdempotencyEvidence } from "@stablemates/workhorse-dashboard-server/wire";
import type { RetryPolicy } from "@stablemates/workhorse";
import { Fragment } from "react";
import { CheckCircle, Copy, LinkSimple } from "@phosphor-icons/react";
import {
  DrawerSection,
  TaskEvent,
  MetaRow,
  coalescingEvidenceFor,
  enqueueCount,
  eventDetail,
} from "./task-detail-overview.js";
import { formatDuration, formatExact, formatRelative } from "../preferences.js";
import { HelpButton } from "../charts/system.js";

function KeyEvidenceRows({
  scope,
  keyLength,
  keyDigest,
}: {
  scope: string;
  keyLength: number;
  keyDigest: string;
}) {
  return (
    <>
      <MetaRow label="Scope">
        <Code className="task-drawer__evidence-value">{scope}</Code>
      </MetaRow>
      <MetaRow label="Key length">
        <Text size="sm">{keyLength} bytes</Text>
      </MetaRow>
      <MetaRow label="Key digest">
        <Code className="task-drawer__evidence-value">{keyDigest}</Code>
      </MetaRow>
    </>
  );
}

/** The accepted enqueue mode owns one section, even when SQL also records shared key metadata. */
export function TaskEnqueueSection({ task }: { task: DashboardTaskDetail }) {
  return coalescingEvidenceFor(task) ? (
    <CoalescingSection task={task} />
  ) : (
    <IdempotencySection task={task} />
  );
}

/** Persisted debounce or throttle evidence for the identity that survived coalescing. */
export function CoalescingSection({ task }: { task: DashboardTaskDetail }) {
  const evidence = coalescingEvidenceFor(task);
  if (evidence === null) return null;
  const label = evidence.mode === "debounce" ? "Debounce" : "Throttle";
  const initialRequest = idempotencyEvidenceFor(task)?.requestDigest;
  return (
    <DrawerSection
      id="coalescing-heading"
      title={label}
      aside={
        <Badge size="xs" variant="light" color="grape" tt="none">
          {evidence.mode === "debounce" ? "Replace pending" : "Keep first"}
        </Badge>
      }
    >
      <Text size="sm" mb="sm">
        {evidence.mode === "debounce"
          ? "New submissions with this key can replace the task's input while it is pending."
          : "Matching submissions within this window return this task without changing its input. A different request with the same key is rejected."}
      </Text>
      <Stack gap={8}>
        <MetaRow label="Window">
          <Text size="sm">{formatDuration(evidence.windowMs)}</Text>
        </MetaRow>
        {evidence.schedule === null ? null : (
          <MetaRow label="Schedule">
            <Text size="sm" title={evidence.schedule}>
              {evidence.schedule === "reset"
                ? "Restart the window after each replacement"
                : evidence.schedule === "preserve"
                  ? "Keep the original run time"
                  : evidence.schedule}
            </Text>
          </MetaRow>
        )}
        <MetaRow label="Submissions">
          <Badge variant="light" color="teal" tt="none">
            {enqueueCount(
              evidence.absorbed,
              evidence.mode === "debounce" ? "replaced" : "absorbed",
            )}
          </Badge>
          {evidence.rejected > 0 ? (
            <Badge variant="light" color="orange" tt="none">
              {enqueueCount(evidence.rejected, "rejected")}
            </Badge>
          ) : null}
        </MetaRow>
        <KeyEvidenceRows {...evidence} />
        {initialRequest ? (
          <MetaRow label="Initial request">
            <Code
              className="task-drawer__evidence-value"
              title="Request digest recorded when the task was first enqueued"
            >
              {initialRequest}
            </Code>
          </MetaRow>
        ) : null}
        {evidence.expiresAt === null ? null : (
          <MetaRow label="Window ends">
            <Text size="sm">{formatExact(evidence.expiresAt)}</Text>
          </MetaRow>
        )}
      </Stack>
      <Text c="dimmed" size="xs" mt="sm">
        The raw key is never shown; the digest identifies matching submissions without exposing it.
      </Text>
    </DrawerSection>
  );
}
/**
 * How one recorded cancellation boundary reads.
 *
 * `cancel_requested` is only a request. `canceled` is final, and its `source` says how it became
 * final: `immediate` when Workhorse removed a task that had not started, `acknowledged` when the
 * running handler observed the signal and stopped, and `recovered` when the lease expired after a
 * request. None of these claim that external effects were undone.
 */
export function cancelEventDescription(event: TaskEvent): { text: string; title: string } | null {
  if (event.type !== "cancel_requested" && event.type !== "canceled") return null;
  const source = eventDetail(event, "source");
  if (event.type === "cancel_requested") {
    const described = describeCancelOutcome("cancel_requested");
    return { text: "awaiting handler", title: described.exact };
  }
  if (source === "acknowledged") {
    return {
      text: "handler observed the signal",
      title:
        "The running handler observed the cancellation signal and stopped, and Workhorse recorded " +
        "an immutable canceled outcome. External effects the handler had already started are not " +
        "undone by cancellation.",
    };
  }
  if (source === "recovered") {
    return {
      text: "lease expired after the request",
      title:
        "The lease expired before the handler acknowledged the request, so recovery finalized the " +
        "cancellation instead of retrying. Whatever the lost handler had already done externally " +
        "is not undone by cancellation.",
    };
  }
  const described = describeCancelOutcome("canceled");
  return { text: "before any handler ran", title: described.exact };
}
/**
 * Accepted deduplication evidence for one task, if Workhorse recorded any.
 *
 * Everything shown here comes from the safe metadata on the single initial `enqueued` event. The
 * raw key is not stored there and is therefore never available to render.
 */
function idempotencyEvidenceFor(task: DashboardTaskDetail) {
  for (const event of task.events) {
    const evidence = readDashboardIdempotencyEvidence(event);
    if (evidence !== null) return evidence;
  }
  return null;
}
/**
 * Deduplication evidence for one task. Rendered only for a keyed task, so an unkeyed task keeps
 * exactly the drawer it had before. Colour is decoration; the label and wording carry the meaning.
 */
function IdempotencySection({ task }: { task: DashboardTaskDetail }) {
  const evidence = idempotencyEvidenceFor(task);
  if (evidence === null) return null;
  const described = describeIdempotency(evidence);
  return (
    <DrawerSection
      id="idempotency-heading"
      title="Idempotency"
      aside={
        <Badge size="xs" variant="light" color="violet" tt="none" title={described.exact}>
          {described.label}
        </Badge>
      }
    >
      <Text size="sm" mb="sm" style={{ overflowWrap: "anywhere" }}>
        {described.summary}.
      </Text>
      <Stack gap={8}>
        <MetaRow label="Retention">
          <Text size="sm">{formatIdempotencyWindow(evidence.ttlMs)}</Text>
        </MetaRow>
        <KeyEvidenceRows {...evidence} />
        <MetaRow label="Request digest">
          <Code className="task-drawer__evidence-value">{evidence.requestDigest}</Code>
        </MetaRow>
        {evidence.expiresAt === null ? null : (
          <MetaRow label="Expires">
            <Text size="sm">{formatExact(evidence.expiresAt)}</Text>
          </MetaRow>
        )}
      </Stack>
      <Text c="dimmed" size="xs" mt="sm">
        The raw key is never recorded with the task, so it is never shown here.
      </Text>
    </DrawerSection>
  );
}
/**
 * Retry evidence recorded with one `retry_scheduled` event. The stored policy, chosen delay, and
 * delay source travel together, so an override reads differently from the task's persisted policy.
 */
export function retryEventDescription(event: TaskEvent): { text: string; title: string } | null {
  if (event.type !== "retry_scheduled") return null;
  const details = (event.details ?? {}) as Record<string, unknown>;
  const rawPolicy = details.retry_policy;
  const policy = (rawPolicy ?? null) as RetryPolicy | null;
  const source = typeof details.retry_delay_source === "string" ? details.retry_delay_source : null;
  const delayMs = typeof details.retry_delay_ms === "number" ? details.retry_delay_ms : null;
  const described = describeRetryEventSource(source, policy);
  const text =
    delayMs === null ? described.label : `${described.label} · ${formatRetryDelay(delayMs)} delay`;
  const title =
    delayMs === null
      ? `${described.exact} ${described.summary}.`
      : `${described.exact} Chosen delay ${delayMs} ms. ${described.summary}.`;
  return { text, title };
}
/**
 * Persisted retry scheduling for one task. The policy is stated in words, never as a raw stored
 * kind, and an exhausted attempt budget is called out because a stored policy stops scheduling
 * once the final attempt has been used. Colour is decoration only; the label carries the meaning.
 */
export function RetryPolicyLine({ task }: { task: DashboardTaskDetail }) {
  const policy = describeRetryPolicy(task.identity.retryPolicy);
  const attempt = task.current.runtime?.attempt ?? task.current.outcome?.attempt ?? null;
  const exhausted = attempt !== null && attempt >= task.identity.maxAttempts;
  const budget =
    attempt === null
      ? `${task.identity.maxAttempts} attempt budget`
      : `attempt ${attempt} of ${task.identity.maxAttempts}`;
  const title = `${policy.exact}. ${
    exhausted
      ? "The attempt budget is exhausted, so no further retry will be scheduled."
      : "Retries remain within the attempt budget."
  }`;
  // The default policy's summary is a fixed explainer, so it hides behind the help icon; a
  // configured policy's summary carries its actual delays, which stay visible as data.
  const isDefaultPolicy = task.identity.retryPolicy === null;
  return (
    <MetaRow label="Retry policy">
      <Badge size="xs" variant="light" color="orange" title={title} tt="none">
        {policy.label}
      </Badge>
      <Text c="dimmed" size="xs" title={title}>
        {isDefaultPolicy ? budget : `${policy.summary} · ${budget}`}
        {exhausted ? " · budget exhausted, no further retry is scheduled" : ""}
      </Text>
      {isDefaultPolicy ? <HelpButton label="Default backoff" help={`${policy.summary}.`} /> : null}
    </MetaRow>
  );
}
/**
 * Display form of a task UUID: the first eight characters, matching the task table's ID column.
 * Every renderer of a shortened id carries the full id in `title`, so hover always recovers it.
 */
function shortTaskId(id: string): string {
  return id.slice(0, 8);
}
/** One task UUID shown shortened, recoverable on hover, and copyable in full. */
export function TaskIdChip({ id }: { id: string }) {
  return (
    <Group gap={4} wrap="nowrap" align="center">
      <Code fz="xs" title={id}>
        {shortTaskId(id)}
      </Code>
      <CopyButton value={id} timeout={2000}>
        {({ copied, copy }) => (
          <Tooltip label={copied ? "Copied" : "Copy task id"} withArrow>
            <ActionIcon
              size="xs"
              variant="subtle"
              color={copied ? "teal" : "gray"}
              aria-label={copied ? "Task id copied to the clipboard" : "Copy task id"}
              onClick={copy}
            >
              {copied ? <CheckCircle size={12} weight="bold" /> : <Copy size={12} />}
            </ActionIcon>
          </Tooltip>
        )}
      </CopyButton>
    </Group>
  );
}
export interface LineageNavigationProps {
  taskLinkHref: (id: string) => string;
  onOpenTask?: (id: string) => void;
}
/** A related task identity that preserves ordinary browser link behavior and swaps an open drawer. */
export function RelatedTaskLink({
  id,
  taskLinkHref,
  onOpenTask,
}: { id: string } & LineageNavigationProps) {
  return (
    <Text
      component="a"
      href={taskLinkHref(id)}
      fz="xs"
      ff="monospace"
      title={id}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        verticalAlign: "baseline",
      }}
      onClick={(event) => {
        if (
          onOpenTask === undefined ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        onOpenTask(id);
      }}
    >
      {/* The icon marks the identifier as a task link, not inert monospace text. */}
      <LinkSimple size={11} aria-hidden style={{ flexShrink: 0 }} />
      {shortTaskId(id)}
    </Text>
  );
}
export function RelatedTaskLinks({
  ids,
  ...navigation
}: { ids: string[] } & LineageNavigationProps) {
  return ids.map((id, index) => (
    <Fragment key={id}>
      {index === 0 ? null : ", "}
      <RelatedTaskLink id={id} {...navigation} />
    </Fragment>
  ));
}
function batchFailureMessage(batch: DashboardTaskDetail["batchExecutions"][number]): string | null {
  if (!batch.batchWideFailure) return null;
  for (const member of batch.members) {
    const error = member.error;
    if (typeof error === "object" && error !== null && "message" in error) {
      const message = (error as { message: unknown }).message;
      if (typeof message === "string" && message.length > 0) return message;
    }
  }
  return "The shared batch callback failed before every task stored an attempt error.";
}
/** One durable batch dispatch, including links to every other member's task detail. */
export function BatchExecutionLine({
  batch,
  selectedTaskId,
  ...navigation
}: {
  batch: DashboardTaskDetail["batchExecutions"][number];
  selectedTaskId: string;
} & LineageNavigationProps) {
  const otherMembers = batch.members.filter((member) => member.id !== selectedTaskId);
  const sharedFailure = batchFailureMessage(batch);
  return (
    <Paper withBorder p="sm">
      <Group justify="space-between" align="flex-start" gap="xs">
        <Box>
          <Text fw={600} size="sm">
            Processed in a batch of {batch.members.length}
          </Text>
          <Text c="dimmed" size="xs" title={formatExact(batch.dispatchedAt)}>
            Attempt {batch.attempt} · dispatched {formatRelative(batch.dispatchedAt)}
          </Text>
        </Box>
        {sharedFailure === null ? null : (
          <Badge color="red" variant="light" tt="none">
            Batch-wide failure
          </Badge>
        )}
      </Group>
      {sharedFailure === null ? null : (
        <Text c="red" size="xs" mt="xs">
          {sharedFailure}
        </Text>
      )}
      <Text c="dimmed" size="xs" mt="xs">
        {otherMembers.length === 0 ? (
          "No other tasks joined this dispatch."
        ) : (
          <>
            Peers:{" "}
            {otherMembers.map((member, index) => (
              <Fragment key={`${member.id}:${member.attempt}`}>
                {index === 0 ? null : ", "}
                <RelatedTaskLink id={member.id} {...navigation} /> (attempt {member.attempt}
                {member.outcome === null ? " active" : ` ${member.outcome}`})
              </Fragment>
            ))}
          </>
        )}
      </Text>
    </Paper>
  );
}
export function BatchExecutions({
  task,
  ...navigation
}: { task: DashboardTaskDetail } & LineageNavigationProps) {
  if (task.batchExecutions.length === 0) return null;
  return (
    <DrawerSection id="batch-executions-heading" title="Batch execution">
      <Stack gap="sm">
        {task.batchExecutions.map((batch) => (
          <BatchExecutionLine
            key={batch.id}
            batch={batch}
            selectedTaskId={task.identity.id}
            {...navigation}
          />
        ))}
      </Stack>
    </DrawerSection>
  );
}
export type DependencyEdge = DashboardTaskDetail["dependencyLineage"]["records"][number];
