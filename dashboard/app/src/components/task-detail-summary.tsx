import type { DashboardTaskDetail } from "@stablemates/workhorse-dashboard-server/wire";
import { ActionIcon, CopyButton, Tooltip } from "@mantine/core";
import { CheckmarkCircle02Icon, Copy01Icon, Link04Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import type { TaskGroupsNavigation } from "../pages/task-groups.js";
import { defaultTaskGroupsLocation, taskGroupsLocationHref } from "../task-groups-location.js";
import { describeRetryPolicy } from "../presentation.js";
import { statusColor, taskStatusColors } from "../status-colors.js";
import { StatusText } from "../status-badge.js";
import { formatDuration, formatExact, formatRelative } from "../preferences.js";
import { formatCount } from "../count-format.js";
import { describeTaskConcurrency } from "../concurrency-policy.js";
import {
  DrawerDisclosure,
  DrawerSection,
  JsonValue,
  MetaRow,
  StateDot,
} from "./task-detail-overview.js";
import { ConcurrencyPolicyLine, TimingPolicyLine } from "./task-detail-durability.js";
import { RetryPolicyLine } from "./task-detail-relations.js";

type Attempt = DashboardTaskDetail["attempts"][number];

/**
 * What the header says about the task's state.
 *
 * A task that waits for a signal, a decision, or a durable timer has a runtime state that does not
 * say what it waits for, so the header names the wait in the same words as the task list.
 */
export function taskDisplayStatus(task: DashboardTaskDetail): {
  text: string;
  label: string;
  color: string;
} {
  const state = task.identity.state;
  const runtime = task.current.runtime;
  if (task.signalWait) {
    return {
      text: "Waiting for signal",
      label: `Waiting for signal: ${task.signalWait.name}`,
      color: taskStatusColors.signalWait,
    };
  }
  if (task.humanWait) {
    return {
      text: "Waiting for decision",
      label: `Waiting for decision: ${task.humanWait.name}`,
      color: taskStatusColors.humanWait,
    };
  }
  if (state === "scheduled" && runtime?.waitName) {
    return {
      text: "Durable wait",
      label: `Durable wait: ${runtime.waitName}`,
      color: taskStatusColors.durableWait,
    };
  }
  const text = state.replaceAll("_", " ");
  return {
    text: `${text.charAt(0).toUpperCase()}${text.slice(1)}`,
    label: `Status: ${state}`,
    color: statusColor(state),
  };
}

/** The first eight characters of a task UUID, the form the task table shows. */
function shortId(id: string): string {
  return id.slice(0, 8);
}

/** A task id in monospace with a copy control. The full id is in the title and the copy. */
function CopyableTaskId({ id }: { id: string }) {
  return (
    <span className="task-detail__id">
      <span className="task-detail__mono" title={id}>
        {shortId(id)}
      </span>
      <CopyButton value={id} timeout={2000}>
        {({ copied, copy }) => (
          <Tooltip label={copied ? "Copied" : "Copy task id"} withArrow>
            <ActionIcon
              size="xs"
              variant="subtle"
              color="gray"
              aria-label={copied ? "Task id copied to the clipboard" : "Copy task id"}
              onClick={copy}
            >
              <HugeiconsIcon
                icon={copied ? CheckmarkCircle02Icon : Copy01Icon}
                size={12}
                strokeWidth={copied ? 2 : 1.5}
              />
            </ActionIcon>
          </Tooltip>
        )}
      </CopyButton>
    </span>
  );
}

/**
 * The identity block at the top of the drawer: type, actions, state, id, queue, and age.
 *
 * `heading` is the type heading, which the drawer owns because it is also the focus target when
 * an action removes the control that held focus. `actions` is the task's actions menu.
 */
export function TaskDetailHeader({
  task,
  heading,
  actions,
}: {
  task: DashboardTaskDetail;
  heading: ReactNode;
  actions: ReactNode;
}) {
  const status = taskDisplayStatus(task);
  return (
    <div className="task-detail__header">
      <div className="task-detail__title-row">
        {heading}
        <div className="task-detail__actions">{actions}</div>
      </div>
      <div className="task-detail__meta">
        <span className="task-detail__status">
          <StateDot color={status.color} />
          <StatusText text={status.text} label={status.label} />
        </span>
        <CopyableTaskId id={task.identity.id} />
        <span>
          <span className="task-detail__meta-hint">Queue </span>
          {task.identity.queue}
        </span>
        <span title={formatExact(task.identity.createdAt)}>
          Created {formatRelative(task.identity.createdAt)}
        </span>
      </div>
    </div>
  );
}

/** A relative time with the exact time on hover. */
function When({ value }: { value: string }) {
  return (
    <span className="task-detail__number" title={formatExact(value)}>
      {formatRelative(value)}
    </span>
  );
}

/**
 * How many attempts the task has used, or `null` if the task detail cannot show the count.
 *
 * The count comes from the runtime or the outcome, not from the attempts list, because task detail
 * carries only the newest attempts and a fast-tier task can record none. `current_attempt` starts
 * at 1 and a retry raises it before the next claim. So a live attempt that started, or a durable
 * wait inside one, counts, and a task that waits for its first claim or its next retry has used one
 * fewer.
 *
 * A cancel before a claim keeps the attempt that was to run next on the outcome: attempt 1 before
 * the first claim, or the next retry during a backoff. Retention can remove the history of an
 * attempt that ran. So for a canceled task, the count is known only from history:
 *
 * 1. If the task did not end canceled, the final attempt started, and the count is that attempt.
 * 2. If an attempt row or a `claimed` event names the final attempt, the count is that attempt.
 * 3. If a section that is not truncated holds an earlier attempt, or the events hold the
 *    `enqueued` event, the section covers the final attempt. A started attempt that a cancel closes
 *    writes an attempt row, and its claim writes an event. So the final attempt did not start, and
 *    the count is one fewer.
 * 4. Otherwise retention can have removed the history, and the count is `null`.
 */
export function attemptsUsed(task: DashboardTaskDetail): number | null {
  const runtime = task.current.runtime;
  if (runtime) {
    const started = runtime.state === "active" || runtime.attemptStartedAt !== null;
    return started ? runtime.attempt : Math.max(runtime.attempt - 1, 0);
  }
  const outcome = task.current.outcome;
  if (!outcome) return task.attempts.at(-1)?.attempt ?? 0;
  const final = outcome.attempt;
  if (outcome.state !== "canceled") return final;
  if (
    task.attempts.some((attempt) => attempt.attempt === final) ||
    task.events.some((event) => event.type === "claimed" && event.attempt === final)
  ) {
    return final;
  }
  const attemptsCover =
    !task.truncated.attempts && task.attempts.some((attempt) => attempt.attempt < final);
  const eventsCover =
    !task.truncated.events &&
    task.events.some(
      (event) => event.type === "enqueued" || (event.attempt !== null && event.attempt < final),
    );
  return attemptsCover || eventsCover ? final - 1 : null;
}

/** The links of the drawer that leave the task list for another dashboard page. */
export type TaskPageNavigation = Pick<TaskGroupsNavigation, "href" | "followLink">;

/**
 * The task group of a member task: the short group id as a link to the group detail, the position
 * of the task in the group, and the group state.
 */
function TaskGroupRow({
  group,
  navigation,
}: {
  group: NonNullable<DashboardTaskDetail["group"]>;
  navigation: TaskPageNavigation;
}) {
  const path = taskGroupsLocationHref({ ...defaultTaskGroupsLocation, groupId: group.id });
  return (
    <MetaRow label="Group">
      <a
        className="task-detail__mono"
        href={navigation.href(path)}
        title={group.id}
        aria-label={`Task group ${shortId(group.id)}`}
        style={{ display: "inline-flex", alignItems: "center", gap: 3 }}
        onClick={(event) => navigation.followLink(event, path)}
      >
        {/* The icon marks the identifier as a link, as the related task links in the drawer do. */}
        <HugeiconsIcon icon={Link04Icon} size={11} aria-hidden style={{ flexShrink: 0 }} />
        {shortId(group.id)}
      </a>
      <span className="task-detail__muted">
        member {formatCount(group.position)} · {group.state}
      </span>
    </MetaRow>
  );
}

/**
 * The plain-text facts an operator reads first. A row shows only when the task has a value for it,
 * so a task that did not use a feature has no row for that feature.
 */
export function TaskProperties({
  task,
  navigation,
}: {
  task: DashboardTaskDetail;
  navigation: TaskPageNavigation;
}) {
  // A database below schema 90 returns no group key, and a task that is not a member has null.
  const group = task.group ?? null;
  const runtime = task.current.runtime;
  const outcome = task.current.outcome;
  const used = attemptsUsed(task);
  // The row names the same attempt as the Attempt column of the task table: the one that runs now
  // or runs next. If the count is known and that attempt has not started, the row says so.
  const attempt = runtime?.attempt ?? outcome?.attempt ?? Math.max(used ?? 0, 1);
  const notStarted = used !== null && used < attempt;
  const maxAttempts = task.identity.maxAttempts;
  // A count is unknown only for a canceled task, and a canceled task gets no retry.
  const usage =
    used === null
      ? "The attempt history is no longer kept, so the number of attempts used is not known."
      : used >= maxAttempts
        ? "The attempt budget is used, so Workhorse schedules no further retry."
        : `${formatCount(used)} of ${formatCount(maxAttempts)} attempts used. Retries remain within the attempt budget.`;
  // The attempts list names the worker of each finished attempt, so this row is for a live one.
  const worker = runtime?.state === "active" ? runtime.workerId : null;
  const cancellation = runtime?.cancellation ?? null;
  return (
    <div className="task-detail__properties">
      {outcome ? (
        <MetaRow label="Finished">
          <When value={outcome.finishedAt} />
        </MetaRow>
      ) : null}
      {runtime && runtime.state === "scheduled" && !task.humanWait && !task.signalWait ? (
        <MetaRow label={runtime.waitName ? "Wakes" : "Runs"}>
          <When value={runtime.runAt} />
        </MetaRow>
      ) : null}
      {task.humanWait ? (
        <MetaRow label="Decision">
          <span className="task-detail__mono">{task.humanWait.name}</span>
          <span className="task-detail__muted">
            due <When value={task.humanWait.deadlineAt} />
          </span>
        </MetaRow>
      ) : null}
      {cancellation ? (
        <MetaRow label="Cancel requested">
          <span title={formatExact(cancellation.requestedAt)}>
            {formatRelative(cancellation.requestedAt)}
            {cancellation.requestedBy ? ` by ${cancellation.requestedBy}` : ""}
            {cancellation.reason ? ` · ${cancellation.reason}` : ""}
          </span>
        </MetaRow>
      ) : null}
      {group ? <TaskGroupRow group={group} navigation={navigation} /> : null}
      <MetaRow label="Attempt">
        <span className="task-detail__number" title={usage}>
          {formatCount(attempt)} of {formatCount(maxAttempts)}
        </span>
        {notStarted ? <span className="task-detail__muted">not started</span> : null}
      </MetaRow>
      {worker ? (
        <MetaRow label="Worker">
          <span className="task-detail__mono">{worker}</span>
        </MetaRow>
      ) : null}
      <MetaRow label="Priority">
        <span
          className="task-detail__number"
          title="Higher values are claimed first; equal values keep FIFO order."
        >
          {task.identity.priority}
        </span>
      </MetaRow>
      {task.tags.length > 0 ? (
        <MetaRow label="Tags">
          <ul className="task-detail__tags" aria-label="Tags">
            {task.tags.map((tag, index) => (
              <li key={`${tag}-${index}`}>{tag}</li>
            ))}
          </ul>
        </MetaRow>
      ) : null}
    </div>
  );
}

/** One short line for the policy disclosure, so its state reads without opening it. */
function policyDigest(task: DashboardTaskDetail): string {
  const retry = describeRetryPolicy(task.identity.retryPolicy).label;
  const limited =
    (task.identity.deadlineAt ?? null) !== null ||
    (task.identity.executionTimeoutMs ?? null) !== null;
  const parts = [
    task.identity.retryPolicy === null ? retry : `${retry} retry`,
    limited ? "time limits set" : "no time limits",
  ];
  const key = task.identity.concurrencyKey;
  if (key) parts.push(`key ${key}`);
  return parts.join(" · ");
}

/** Retry, time limits, and concurrency: the rules the task runs under, closed by default. */
export function TaskExecutionPolicy({ task }: { task: DashboardTaskDetail }) {
  const concurrency = describeTaskConcurrency(task);
  return (
    <DrawerDisclosure title="Execution policy" summary={policyDigest(task)}>
      <div className="task-detail__properties">
        <RetryPolicyLine task={task} />
        <TimingPolicyLine task={task} />
        {concurrency ? <ConcurrencyPolicyLine task={task} /> : null}
      </div>
    </DrawerDisclosure>
  );
}

/** The message of a stored error, or null when the value has no message text. */
function errorMessage(error: unknown): string | null {
  if (typeof error === "string") return error;
  if (typeof error !== "object" || error === null) return null;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message.length > 0 ? message : null;
}

/** A failed attempt that Workhorse retried reads as "Retried", in the attention hue. */
function attemptOutcome(outcome: string): { text: string; color: string } {
  if (outcome === "retry") return { text: "Retried", color: taskStatusColors.scheduled };
  const text = outcome.replaceAll("_", " ");
  return { text: `${text.charAt(0).toUpperCase()}${text.slice(1)}`, color: statusColor(outcome) };
}

function AttemptItem({ attempt }: { attempt: Attempt }) {
  const { text, color } = attemptOutcome(attempt.outcome);
  const message = errorMessage(attempt.error);
  const hasError = attempt.error !== null && attempt.error !== undefined;
  return (
    <li className="task-detail__attempt">
      <StateDot color={color} />
      <div className="task-detail__attempt-body">
        <div className="task-detail__attempt-line">
          <span className="task-detail__attempt-name">Attempt {attempt.attempt}</span>
          <span>
            <StatusText text={text} label={`Status: ${attempt.outcome}`} />
          </span>
          <span className="task-detail__muted task-detail__number">
            {formatDuration(attempt.executionMs)}
          </span>
          <span className="task-detail__muted task-detail__mono">{attempt.workerId}</span>
          <span
            className="task-detail__attempt-time task-detail__muted task-detail__number"
            title={formatExact(attempt.finishedAt)}
          >
            {formatRelative(attempt.finishedAt)}
          </span>
        </div>
        {hasError && message ? <p className="task-detail__attempt-error">{message}</p> : null}
        <DrawerDisclosure title={hasError ? "Details and error" : "Details"} compact>
          <dl className="task-detail__attempt-facts">
            <dt>Executing</dt>
            <dd>{formatDuration(attempt.executionMs)}</dd>
            <dt>Elapsed</dt>
            <dd>{formatDuration(attempt.elapsedMs)}</dd>
            <dt>Logical start</dt>
            <dd>{formatExact(attempt.startedAt)}</dd>
            <dt>Final claim</dt>
            <dd>{formatExact(attempt.claimedAt)}</dd>
            <dt>Finished</dt>
            <dd>{formatExact(attempt.finishedAt)}</dd>
          </dl>
          {hasError ? (
            <JsonValue
              label="Attempt error"
              value={attempt.error}
              emptyLabel="No error value was stored."
              copyLabel={`the attempt ${attempt.attempt} error`}
              maxHeight={180}
            />
          ) : null}
        </DrawerDisclosure>
      </div>
    </li>
  );
}

/** The attempts as a compact timeline, oldest first, with the attempt that runs now at the end. */
export function TaskAttempts({ task }: { task: DashboardTaskDetail }) {
  const runtime = task.current.runtime;
  const running =
    runtime?.state === "active" && !task.attempts.some((item) => item.attempt === runtime.attempt)
      ? runtime
      : null;
  if (task.attempts.length === 0 && running === null) return null;
  return (
    <DrawerSection
      id="attempt-history-heading"
      title="Attempts"
      aside={
        <span className="task-detail__muted task-detail__number">
          {formatCount(task.attempts.length + (running ? 1 : 0))}
          {task.truncated.attempts ? "+" : ""}
        </span>
      }
    >
      {task.truncated.attempts ? (
        <p className="task-detail__note">
          Only the most recent attempts show here. The event feed for this task has the rest.
        </p>
      ) : null}
      <ol className="task-detail__timeline">
        {task.attempts.map((attempt) => (
          <AttemptItem key={attempt.attempt} attempt={attempt} />
        ))}
        {running ? (
          <li className="task-detail__attempt">
            <StateDot color={taskStatusColors.active} />
            <div className="task-detail__attempt-body">
              <div className="task-detail__attempt-line">
                <span className="task-detail__attempt-name">Attempt {running.attempt}</span>
                <span>Running</span>
                {running.workerId ? (
                  <span className="task-detail__muted task-detail__mono">{running.workerId}</span>
                ) : null}
                {running.attemptStartedAt ? (
                  <span
                    className="task-detail__attempt-time task-detail__muted task-detail__number"
                    title={formatExact(running.attemptStartedAt)}
                  >
                    started {formatRelative(running.attemptStartedAt)}
                  </span>
                ) : null}
              </div>
            </div>
          </li>
        ) : null}
      </ol>
    </DrawerSection>
  );
}
