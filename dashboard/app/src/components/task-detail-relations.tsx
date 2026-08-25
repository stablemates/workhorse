import type { DashboardJobDetail } from "@workhorse-js/dashboard-server/wire";
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Code,
  CopyButton,
  Group,
  Paper,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import {
  describeCancellationRequest,
  describeCancelOutcome,
  describeIdempotency,
  describeRetryEventSource,
  describeRetryPolicy,
  formatRetryDelay,
  idempotencyEvidenceLine,
  isTerminalTaskState,
} from "../presentation.js";
import { readIdempotencyEvidence } from "@workhorse-js/dashboard-server/wire";
import type { RetryPolicy } from "@stablemates/workhorse";
import { Fragment, useEffect, useRef } from "react";
import { CheckCircle, Copy, Prohibit } from "@phosphor-icons/react";
import {
  DrawerSection,
  JobEvent,
  MetaRow,
  coalescingEvidenceFor,
  enqueueCount,
  eventDetail,
} from "./task-detail-overview.js";
import { formatDuration, formatExact, formatRelative } from "../preferences.js";
import { HelpButton } from "../charts/system.js";

/** Persisted debounce or throttle evidence for the identity that survived coalescing. */
export function CoalescingSection({ job }: { job: DashboardJobDetail }) {
  const evidence = coalescingEvidenceFor(job);
  if (evidence === null) return null;
  const label = evidence.mode === "debounce" ? "Debounce" : "Throttle";
  const counts = [enqueueCount(evidence.absorbed, "absorbed")];
  if (evidence.rejected > 0) counts.push(enqueueCount(evidence.rejected, "rejected"));
  return (
    <DrawerSection
      id="coalescing-heading"
      title="Coalescing"
      aside={
        <Badge size="xs" variant="light" color="grape" tt="none">
          {label}
        </Badge>
      }
    >
      <Text c="dimmed" size="xs">
        {formatDuration(evidence.windowMs)} window
        {evidence.schedule === null ? "" : ` · ${evidence.schedule} schedule`} ·{" "}
        {counts.join(" · ")}
      </Text>
      <Text c="dimmed" size="xs" mt={4}>
        scope {evidence.scope} · key length {evidence.keyLength} · digest {evidence.keyDigest}
      </Text>
      {evidence.expiresAt === null ? null : (
        <Text c="dimmed" size="xs" mt={4} title={formatExact(evidence.expiresAt)}>
          Current window ends {formatExact(evidence.expiresAt)}.
        </Text>
      )}
      <Text c="dimmed" size="xs" mt={4}>
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
export function cancelEventDescription(event: JobEvent): { text: string; title: string } | null {
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
function idempotencyEvidenceFor(job: DashboardJobDetail) {
  for (const event of job.events) {
    const evidence = readIdempotencyEvidence(event);
    if (evidence !== null) return evidence;
  }
  return null;
}
/**
 * Deduplication evidence for one task. Rendered only for a keyed task, so an unkeyed task keeps
 * exactly the drawer it had before. Colour is decoration; the label and wording carry the meaning.
 */
export function IdempotencySection({ job }: { job: DashboardJobDetail }) {
  const evidence = idempotencyEvidenceFor(job);
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
      <Text c="dimmed" size="xs" title={described.exact}>
        {described.summary}.
      </Text>
      <Text c="dimmed" size="xs" mt={4} title={described.exact}>
        {idempotencyEvidenceLine(evidence)}
      </Text>
      <Text c="dimmed" size="xs" mt={4}>
        The raw key is never recorded with the task, so it is never shown here.
      </Text>
    </DrawerSection>
  );
}
/**
 * Retry evidence recorded with one `retry_scheduled` event. The stored policy, chosen delay, and
 * delay source travel together, so an override reads differently from the job's persisted policy.
 */
export function retryEventDescription(event: JobEvent): { text: string; title: string } | null {
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
/** The lifecycle states an operator may cancel. Everything else is terminal or unknown. */
function canCancelTask(job: DashboardJobDetail): boolean {
  const runtime = job.current.runtime;
  if (runtime === null) return false;
  if (isTerminalTaskState(job.identity.state)) return false;
  // A scheduled task covers both a plain future run and a suspended durable wait, which the demo
  // shows as "waiting". Both are cancelable because neither is executing right now.
  return runtime.state === "scheduled" || runtime.state === "ready" || runtime.state === "active";
}
/**
 * Audited cancellation for one task.
 *
 * The action is a two-step confirmation with an optional reason. Cancellation is irreversible: a
 * canceled outcome is immutable and there is no uncancel. Wording changes with
 * the task's state, and for a running task it says plainly that cancellation is cooperative and
 * that external effects can continue until the handler observes the signal. Nothing here claims
 * force, immediacy, or that anything already done externally is undone.
 */
export function CancelTaskPanel({
  job,
  confirming,
  setConfirming,
  reason,
  setReason,
  pending,
  cancelTask,
}: {
  job: DashboardJobDetail;
  confirming: boolean;
  setConfirming: (confirming: boolean) => void;
  reason: string;
  setReason: (reason: string) => void;
  pending: boolean;
  cancelTask: (id: string, reason: string) => void;
}) {
  const reasonRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (confirming) reasonRef.current?.focus();
  }, [confirming]);

  const cancellation = job.current.runtime?.cancellation ?? null;
  const requested = describeCancellationRequest(cancellation);
  const cancelable = canCancelTask(job);
  const running = job.current.runtime?.state === "active";
  const waiting =
    job.current.runtime?.state === "scheduled" && job.current.runtime.waitName !== null;
  const trimmedReason = reason.trim();

  // Everything an assistive technology needs is in text: the heading and the current state
  // sentence. What a cancellation reported is announced by the notification it raises, which
  // outlives this panel, because closing the drawer must not take the answer with it.
  return (
    <DrawerSection
      id="cancellation-heading"
      title="Cancellation"
      aside={
        requested === null ? null : (
          <Badge size="xs" variant="light" color="gray" tt="none" title={requested.exact}>
            {requested.label}
          </Badge>
        )
      }
    >
      {requested === null ? null : (
        <Text c="dimmed" size="xs" mb="xs" title={requested.exact}>
          {requested.summary}.{" "}
          {cancellation === null ? null : (
            <span title={formatExact(cancellation.requestedAt)}>
              Requested {formatRelative(cancellation.requestedAt)}
              {cancellation.requestedBy === null ? "" : ` by ${cancellation.requestedBy}`}
              {cancellation.reason === null ? "" : ` · ${cancellation.reason}`}.
            </span>
          )}
        </Text>
      )}
      {cancelable ? (
        confirming ? (
          <Stack gap="xs">
            <Text size="xs" c="dimmed">
              {running
                ? "Workhorse asks the handler to stop, but it cannot force the handler. Until the " +
                  "handler checks the signal, external effects that it started can continue."
                : waiting
                  ? "This task is at a durable wait. Workhorse closes its attempt without resuming " +
                    "the handler, but it cannot undo earlier external work."
                  : "This task has not started. Workhorse can cancel it before any handler runs."}{" "}
              You cannot undo a cancellation.
            </Text>
            <TextInput
              ref={reasonRef}
              size="xs"
              label="Reason (optional)"
              description="Workhorse records this reason in the audit trail."
              placeholder="Why are you canceling this task?"
              value={reason}
              disabled={pending}
              onChange={(event) => setReason(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && !pending) setConfirming(false);
              }}
            />
            <Group gap="xs">
              <Button
                size="xs"
                color="red"
                variant="light"
                loading={pending}
                disabled={pending}
                onClick={() => cancelTask(job.identity.id, trimmedReason)}
              >
                {running ? "Request cancellation" : "Cancel task"}
              </Button>
              <Button
                size="xs"
                variant="default"
                disabled={pending}
                onClick={() => setConfirming(false)}
              >
                Keep running
              </Button>
            </Group>
          </Stack>
        ) : (
          <Button
            size="xs"
            variant="default"
            leftSection={<Prohibit size={14} />}
            disabled={pending}
            onClick={() => setConfirming(true)}
          >
            Cancel task
          </Button>
        )
      ) : (
        <Text c="dimmed" size="xs">
          {isTerminalTaskState(job.identity.state)
            ? `Because this task finished as ${job.identity.state}, Workhorse cannot change its outcome.`
            : "Workhorse cannot cancel this task because it has no live runtime."}
        </Text>
      )}
    </DrawerSection>
  );
}
/**
 * Persisted retry scheduling for one task. The policy is stated in words, never as a raw stored
 * kind, and an exhausted attempt budget is called out because a stored policy stops scheduling
 * once the final attempt has been used. Colour is decoration only; the label carries the meaning.
 */
export function RetryPolicyLine({ job }: { job: DashboardJobDetail }) {
  const policy = describeRetryPolicy(job.identity.retryPolicy);
  const attempt = job.current.runtime?.attempt ?? job.current.outcome?.attempt ?? null;
  const exhausted = attempt !== null && attempt >= job.identity.maxAttempts;
  const budget =
    attempt === null
      ? `${job.identity.maxAttempts} attempt budget`
      : `attempt ${attempt} of ${job.identity.maxAttempts}`;
  const title = `${policy.exact}. ${
    exhausted
      ? "The attempt budget is exhausted, so no further retry will be scheduled."
      : "Retries remain within the attempt budget."
  }`;
  // The default policy's summary is a fixed explainer, so it hides behind the help icon; a
  // configured policy's summary carries its actual delays, which stay visible as data.
  const isDefaultPolicy = job.identity.retryPolicy === null;
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
function batchFailureMessage(batch: DashboardJobDetail["batchExecutions"][number]): string | null {
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
  selectedJobId,
  ...navigation
}: {
  batch: DashboardJobDetail["batchExecutions"][number];
  selectedJobId: string;
} & LineageNavigationProps) {
  const otherMembers = batch.members.filter((member) => member.id !== selectedJobId);
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
  job,
  ...navigation
}: { job: DashboardJobDetail } & LineageNavigationProps) {
  if (job.batchExecutions.length === 0) return null;
  return (
    <DrawerSection id="batch-executions-heading" title="Batch execution">
      <Stack gap="sm">
        {job.batchExecutions.map((batch) => (
          <BatchExecutionLine
            key={batch.id}
            batch={batch}
            selectedJobId={job.identity.id}
            {...navigation}
          />
        ))}
      </Stack>
    </DrawerSection>
  );
}
export type DependencyEdge = DashboardJobDetail["dependencyLineage"]["records"][number];
