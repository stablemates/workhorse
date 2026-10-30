import type { DashboardTaskDetail } from "@stablemates/workhorse-dashboard-server/wire";
import { Box, Code, Group, Stack, Text } from "@mantine/core";
import { describeTaskConcurrency } from "../concurrency-policy.js";
import { readDashboardIdempotencyEvidence } from "@stablemates/workhorse-dashboard-server/wire";
import {
  DependencyEdge,
  LineageNavigationProps,
  RelatedTaskLink,
  RelatedTaskLinks,
  cancelEventDescription,
  retryEventDescription,
} from "./task-detail-relations.js";
import {
  formatClock,
  formatCountdown,
  formatDuration,
  formatExact,
  formatRelative,
  useNow,
} from "../preferences.js";
import {
  DrawerSection,
  DurableWait,
  MetaRow,
  StateDot,
  boundaryEventPresentation,
  eventDetail,
  genericEventLabel,
  waitPhaseColor,
  waitPhaseFor,
  waitPhaseLabel,
  waitReplayWording,
} from "./task-detail-overview.js";
import { eventDetailSummary } from "../event-presentation.js";
import { formatCount } from "../count-format.js";

/** Plain-English consequence of one dependency policy action, said of the dependent task. */
function dependencyActionPhrase(action: "release" | "cancel" | "fail"): string {
  if (action === "release") return "can run";
  return action === "cancel" ? "is canceled" : "fails";
}
/**
 * One dependency edge's policy as a sentence instead of the stored action triple.
 *
 * The stored form ("success: release, failure: fail") names actions without saying which task
 * each one happens to, so operators could not tell who releases whom. The sentence names both
 * roles, and the caller says which of the two tasks is the one on screen.
 */
function dependencyPolicySentence(
  policy: Pick<DependencyEdge, "onSuccess" | "onFailure" | "onCancellation">,
  prerequisite: string,
  dependent: string,
): string {
  return (
    `If ${prerequisite} succeeds, ${dependent} ${dependencyActionPhrase(policy.onSuccess)}; ` +
    `if ${prerequisite} fails, ${dependent} ${dependencyActionPhrase(policy.onFailure)}; ` +
    `if ${prerequisite} is canceled, ${dependent} ${dependencyActionPhrase(policy.onCancellation)}.`
  );
}
/** Past-tense verb for what a settled dependency edge did to its dependent. */
const dependencyResolutionVerb: Record<"release" | "cancel" | "fail", string> = {
  release: "released",
  cancel: "canceled",
  fail: "failed",
};
/** The immutable prerequisite edge and its current release state. */
export function DependencyLine({
  task,
  ...navigation
}: { task: DashboardTaskDetail } & LineageNavigationProps) {
  // Spawning a child also inserts a dependency edge — the parent blocks until the child joins —
  // so every parent-child pair would otherwise appear twice in this drawer: once here and once
  // in ChildLine. ChildLine owns that relationship; this component shows only the dependencies
  // an enqueue declared explicitly.
  const childEdgeKeys = new Set(
    (task.childLineage?.records ?? []).map((edge) => `${edge.parentTaskId}:${edge.childTaskId}`),
  );
  const explicitRecords = task.dependencyLineage.records.filter(
    (edge) => !childEdgeKeys.has(`${edge.dependentTaskId}:${edge.prerequisiteTaskId}`),
  );
  const ownChildIds = new Set(
    (task.childLineage?.records ?? [])
      .filter((edge) => edge.parentTaskId === task.identity.id)
      .map((edge) => edge.childTaskId),
  );
  const explicitPrerequisiteIds = task.identity.prerequisiteTaskIds.filter(
    (id) => !ownChildIds.has(id),
  );
  if (explicitPrerequisiteIds.length === 0 && explicitRecords.length === 0) return null;
  const blocked = task.identity.blockedReason === "prerequisite_pending";
  const summary = blocked
    ? "Blocked until every prerequisite satisfies the dependency policy"
    : task.identity.dependencyReleasedAt === null
      ? "Dependency recorded"
      : `Released ${formatRelative(task.identity.dependencyReleasedAt)}`;
  // One edge renders as one row. The prerequisite identity, its state, and its policy used to be
  // split between a labeled row and a raw "success: release, failure: fail" line that repeated
  // the same id, which read as two different facts about two different tasks.
  const prerequisiteEdges = explicitRecords.filter(
    (edge) => edge.dependentTaskId === task.identity.id,
  );
  const dependentEdges = explicitRecords.filter(
    (edge) =>
      edge.prerequisiteTaskId === task.identity.id && edge.dependentTaskId !== task.identity.id,
  );
  return (
    <Stack gap={6}>
      {explicitPrerequisiteIds.length > 0 ? (
        <MetaRow label={explicitPrerequisiteIds.length === 1 ? "Prerequisite" : "Prerequisites"}>
          <span>
            <RelatedTaskLinks ids={explicitPrerequisiteIds} {...navigation} />
          </span>
          <span className="task-detail__status">
            <StateDot color={blocked ? "yellow" : "teal"} />
            {blocked ? "blocked" : "released"}
          </span>
          <Text c="dimmed" size="xs">
            {summary}
          </Text>
        </MetaRow>
      ) : null}
      {prerequisiteEdges.map((edge) => (
        <MetaRow key={`${edge.dependentTaskId}:${edge.prerequisiteTaskId}`} label="Policy">
          {prerequisiteEdges.length > 1 ? (
            <RelatedTaskLink id={edge.prerequisiteTaskId} {...navigation} />
          ) : null}
          <Text c="dimmed" size="xs">
            {dependencyPolicySentence(edge, "it", "this task")}
            {edge.releasedAt === null || edge.resolution === null
              ? ""
              : ` It ${dependencyResolutionVerb[edge.resolution]} this task ${formatRelative(edge.releasedAt)}.`}
          </Text>
        </MetaRow>
      ))}
      {dependentEdges.map((edge) => (
        <MetaRow key={`${edge.dependentTaskId}:${edge.prerequisiteTaskId}`} label="Dependent">
          <RelatedTaskLink id={edge.dependentTaskId} {...navigation} />
          <Text c="dimmed" size="xs">
            {dependencyPolicySentence(edge, "this task", "it")}{" "}
            {edge.releasedAt === null || edge.resolution === null
              ? "Still waiting on this task's outcome."
              : `This task ${dependencyResolutionVerb[edge.resolution]} it ${formatRelative(edge.releasedAt)}.`}
          </Text>
        </MetaRow>
      ))}
      {task.dependencyLineage.truncated ? (
        <Text c="dimmed" size="xs">
          Additional dependency edges are omitted.
        </Text>
      ) : null}
    </Stack>
  );
}
/** The immutable parent-child edge and whether the parent has consumed the child result. */
export function ChildLine({
  task,
  ...navigation
}: { task: DashboardTaskDetail } & LineageNavigationProps) {
  if (task.childLineage.records.length === 0) return null;
  const children = task.childLineage.records.filter(
    (edge) => edge.parentTaskId === task.identity.id,
  );
  const joinedChildren = children.filter((edge) => edge.joinedAt !== null).length;
  return (
    <Stack gap={6}>
      {children.length > 0 ? (
        <Text c="dimmed" size="xs" fw={600}>
          {formatCount(joinedChildren)} of {formatCount(children.length)}{" "}
          {children.length === 1 ? "child" : "children"} joined
        </Text>
      ) : null}
      {task.childLineage.records.map((edge) => {
        const isParent = edge.parentTaskId === task.identity.id;
        const state =
          edge.joinedAt !== null
            ? "joined"
            : edge.outcomeState === "succeeded"
              ? "result ready"
              : (edge.outcomeState ?? "waiting");
        return (
          <MetaRow key={`${edge.parentTaskId}:${edge.name}`} label={isParent ? "Child" : "Parent"}>
            <RelatedTaskLink id={isParent ? edge.childTaskId : edge.parentTaskId} {...navigation} />
            <Text c="dimmed" size="xs">
              {edge.name} · {edge.type} · {state}
            </Text>
            {edge.error === null ? null : <Code fz="xs">{JSON.stringify(edge.error)}</Code>}
          </MetaRow>
        );
      })}
      {task.childLineage.truncated ? (
        <Text c="dimmed" size="xs">
          Additional child edges are omitted.
        </Text>
      ) : null}
    </Stack>
  );
}
/** Fresh execution identities linked to the immutable failed source they replay. */
export function RedriveLine({
  task,
  ...navigation
}: { task: DashboardTaskDetail } & LineageNavigationProps) {
  if (task.redriveLineage.records.length === 0) return null;
  return (
    <Stack gap={6}>
      {task.redriveLineage.records.map((edge) => {
        const isSource = edge.sourceTaskId === task.identity.id;
        return (
          <MetaRow
            key={`${edge.sourceTaskId}:${edge.targetTaskId}`}
            label={isSource ? "Redrive" : "Redriven from"}
          >
            <RelatedTaskLink
              id={isSource ? edge.targetTaskId : edge.sourceTaskId}
              {...navigation}
            />
            <Text c="dimmed" size="xs">
              {edge.requestedBy} · {edge.reason} · {formatRelative(edge.requestedAt)}
            </Text>
          </MetaRow>
        );
      })}
      {task.redriveLineage.truncated ? (
        <Text c="dimmed" size="xs">
          Additional redrive edges are omitted.
        </Text>
      ) : null}
    </Stack>
  );
}
/**
 * Queue admission context for the selected task.
 *
 * A running task gets live utilisation of the budget it is competing in. A finished task keeps its
 * key, which never changes, beside the queue's limits as they stand now. The two are labelled
 * differently on purpose: no snapshot of the old policy exists, so the second must never be read
 * as the configuration this task ran under. A third case is marked separately again: when the
 * queue's ceiling is known but its utilisation was never measured, the line shows the ceiling and
 * says the usage is unknown, rather than showing zeroes that would read as an idle queue.
 */
export function ConcurrencyPolicyLine({ task }: { task: DashboardTaskDetail }) {
  const described = describeTaskConcurrency(task);
  if (described === null) return null;
  return (
    <>
      {described.concurrencyKey === null ? null : (
        <MetaRow label="Concurrency key">
          <span className="task-detail__mono" title={described.keyTitle}>
            {described.concurrencyKey}
          </span>
        </MetaRow>
      )}
      <MetaRow label="Concurrency">
        <Text size="sm" title={described.title}>
          {described.summary}
          {described.utilizationKnown ? "" : " · usage not measured"}
        </Text>
        {/* The numbers state no tense of their own, so this marker keeps a finished task's
            ceilings from reading as the ones it ran under. */}
        {described.basisLabel === null ? null : (
          <Text c="dimmed" size="xs" title={described.title}>
            {described.basisLabel}
          </Text>
        )}
      </MetaRow>
    </>
  );
}
/**
 * Absolute lifetime and per-attempt execution limits persisted with the task definition.
 *
 * A task without limits says so instead of omitting the row: an operator asking "why is this
 * still running?" needs "no limit is set" as an answer, not a gap where the answer would be.
 */
export function TimingPolicyLine({ task }: { task: DashboardTaskDetail }) {
  const deadlineAt = task.identity.deadlineAt ?? null;
  const executionTimeoutMs = task.identity.executionTimeoutMs ?? null;
  if (deadlineAt === null && executionTimeoutMs === null) {
    // "None set" stays visible — an operator asking "why is this still running?" needs the
    // answer in the row — while the wordier explanation moves behind the help icon.
    return (
      <MetaRow label="Time limits">
        <Text size="sm" title="No lifetime deadline and no per-attempt execution limit.">
          None set
        </Text>
      </MetaRow>
    );
  }
  const runtimeTimeoutAt = task.current.runtime?.attemptTimeoutAt ?? null;
  const parts = [
    deadlineAt === null ? null : `deadline ${formatExact(deadlineAt)}`,
    executionTimeoutMs === null
      ? null
      : `${formatDuration(executionTimeoutMs)} active execution per attempt`,
    runtimeTimeoutAt === null ? null : `current timeout target ${formatExact(runtimeTimeoutAt)}`,
  ].filter((part): part is string => part !== null);
  return (
    <MetaRow label="Time limits">
      <Text size="sm" title={parts.join("; ")}>
        {parts.join(" · ")}
      </Text>
    </MetaRow>
  );
}
/**
 * Compact ordered view of the recorded boundary events for this task. Repeated
 * claims inside one attempt are called out, because a durable wait releases
 * ownership without closing the logical attempt.
 */
/**
 * The events the history shows. Acceptance is a boundary worth showing only when it deduplicated
 * something, so an unkeyed task's `enqueued` event is left out.
 */
export function boundaryEvents(task: DashboardTaskDetail): DashboardTaskDetail["events"] {
  return task.events.filter(
    (event) => event.type !== "enqueued" || readDashboardIdempotencyEvidence(event) !== null,
  );
}
export function BoundaryTimeline({ task }: { task: DashboardTaskDetail }) {
  const events = boundaryEvents(task);
  if (events.length === 0) return null;
  const claimsPerAttempt = new Map<number | null, number>();
  const claimOrdinals = new Map<string, number>();
  for (const event of events) {
    if (event.type !== "claimed") continue;
    const ordinal = (claimsPerAttempt.get(event.attempt) ?? 0) + 1;
    claimsPerAttempt.set(event.attempt, ordinal);
    claimOrdinals.set(event.id, ordinal);
  }
  const repeatedClaimAttempts: Array<number | null> = [];
  for (const [attempt, count] of claimsPerAttempt) {
    if (count > 1) repeatedClaimAttempts.push(attempt);
  }
  return (
    <Box>
      {task.truncated.events ? (
        <p className="task-detail__note">
          Only the most recent events show here. The event feed for this task has the rest.
        </p>
      ) : null}
      <ol className="task-drawer__events">
        {events.map((event) => {
          const claimIndex = claimOrdinals.get(event.id) ?? null;
          const name = eventDetail(event, "name");
          const fence = eventDetail(event, "fence_token");
          const worker = eventDetail(event, "worker_id");
          const requestedBy = eventDetail(event, "requested_by");
          const reason = eventDetail(event, "reason");
          const retry = retryEventDescription(event);
          const cancel = cancelEventDescription(event);
          const knownParts = [
            name,
            worker,
            fence === null ? null : `fence ${fence}`,
            requestedBy === null ? null : `by ${requestedBy}`,
            reason === null ? null : `reason ${reason}`,
            retry?.text ?? null,
            cancel?.text ?? null,
          ].filter((part): part is string => part !== null);
          const parts =
            knownParts.length > 0
              ? knownParts
              : [eventDetailSummary(event.details)].filter((part): part is string => part !== null);
          const eventLabel =
            boundaryEventPresentation[event.type]?.label ?? genericEventLabel(event.type);
          const summary = [
            event.attempt === null ? "no attempt" : `attempt ${event.attempt}`,
            ...(claimIndex === null ? [] : [`claim ${claimIndex}`]),
            ...parts,
          ].join(" · ");
          const hoverDetails = [summary, cancel?.title ?? retry?.title]
            .filter(Boolean)
            .join("\n\n");
          return (
            <li key={event.id} className="task-drawer__event">
              <span className="task-drawer__event-name" title={eventLabel}>
                <StateDot color={boundaryEventPresentation[event.type]?.color ?? "gray"} />
                {eventLabel}
              </span>
              <Text
                c="dimmed"
                size="xs"
                className="task-drawer__event-summary"
                lineClamp={1}
                title={hoverDetails}
              >
                {summary}
              </Text>
              <Text
                c="dimmed"
                size="xs"
                className="task-detail__number"
                title={formatExact(event.occurredAt)}
                ta="right"
              >
                {formatClock(event.occurredAt)}
              </Text>
            </li>
          );
        })}
      </ol>
      {repeatedClaimAttempts.length > 0 ? (
        <p className="task-detail__note">
          {repeatedClaimAttempts.length === 1
            ? `Attempt ${repeatedClaimAttempts[0]} has ${formatCount(claimsPerAttempt.get(repeatedClaimAttempts[0]!) ?? 0)} claims.`
            : `Attempts ${repeatedClaimAttempts.join(", ")} each have more than one claim.`}{" "}
          A durable wait releases ownership without closing the logical attempt, so one attempt can
          hold several claims with different fence tokens.
        </p>
      ) : null}
    </Box>
  );
}
/** One stored wait row rendered with its release proof and immutable provenance. */
function DurableWaitCard({
  task,
  wait,
  nowMs,
}: {
  task: DashboardTaskDetail;
  wait: DurableWait;
  nowMs: number;
}) {
  const phase = waitPhaseFor(task, wait, nowMs);
  const runtime = task.current.runtime;
  const suspended = phase !== "resumed" && runtime !== null;
  return (
    <Box className="task-drawer__card">
      <Group justify="space-between" align="flex-start">
        <Box style={{ minWidth: 0 }}>
          <Text fw={600} size="sm">
            {wait.name}
          </Text>
          <Text c="dimmed" size="xs">
            {wait.mode === "relative"
              ? `Relative · requested ${formatDuration(wait.durationMs)}`
              : `Absolute · requested ${formatExact(wait.requestedWakeAt)}`}
          </Text>
        </Box>
        <span className="task-detail__status">
          <StateDot color={waitPhaseColor[phase]} />
          {waitPhaseLabel[phase]}
        </span>
      </Group>
      <Box className="task-drawer__card-rule" />
      <Stack gap={4}>
        <Group justify="space-between" gap="xs" wrap="nowrap">
          <Text c="dimmed" size="xs">
            Not before
          </Text>
          <Text size="xs" ta="right">
            {formatExact(wait.wakeAt)}
          </Text>
        </Group>
        <Group justify="space-between" gap="xs" wrap="nowrap">
          <Text c="dimmed" size="xs">
            {phase === "resumed" ? "Target passed" : "Time remaining"}
          </Text>
          <Text size="xs" ta="right">
            {phase === "resumed"
              ? formatRelative(wait.wakeAt)
              : formatCountdown(wait.wakeAt, nowMs)}
          </Text>
        </Group>
      </Stack>
      <Box className="task-drawer__card-rule" />
      <Text fw={600} size="xs" mb={4}>
        {suspended ? "Ownership released while scheduled" : "Ownership at this boundary"}
      </Text>
      {suspended ? (
        <Stack gap={2}>
          <Text c="dimmed" size="xs">
            Worker {runtime.workerId === null ? "null" : runtime.workerId} · fence{" "}
            {runtime.fenceToken}
          </Text>
          <Text c="dimmed" size="xs">
            Lease expiry {runtime.expiresAt === null ? "null" : formatExact(runtime.expiresAt)} ·
            heartbeat {runtime.heartbeatAt === null ? "null" : formatExact(runtime.heartbeatAt)}
          </Text>
          <Text c="dimmed" size="xs">
            Runtime state {runtime.state} · wait marker{" "}
            {runtime.waitName === null ? "null" : runtime.waitName}
          </Text>
        </Stack>
      ) : (
        <Text c="dimmed" size="xs">
          This wait is no longer active. Its events below record how Workhorse released it.
        </Text>
      )}
      <Box className="task-drawer__card-rule" />
      <Text fw={600} size="xs" mb={4}>
        Attempt preserved across the wait
      </Text>
      <Stack gap={2}>
        <Text c="dimmed" size="xs">
          Wait recorded on attempt {wait.attempt}
          {runtime ? ` · runtime attempt ${runtime.attempt}` : ""}
        </Text>
        {runtime?.attemptStartedAt ? (
          <Text c="dimmed" size="xs" title={formatExact(runtime.attemptStartedAt)}>
            Logical attempt started {formatRelative(runtime.attemptStartedAt)}
          </Text>
        ) : null}
      </Stack>
      <Box className="task-drawer__card-rule" />
      <Text fw={600} size="xs" mb={4}>
        Immutable wait provenance
      </Text>
      <Text c="dimmed" size="xs" title={formatExact(wait.createdAt)}>
        Authorized by {wait.workerId} · fence {wait.fenceToken} · attempt {wait.attempt} ·{" "}
        {formatRelative(wait.createdAt)}
      </Text>
    </Box>
  );
}
/**
 * Durable wait evidence for one task. Waits are stored rows, not a workflow graph,
 * so this panel reports only what Workhorse recorded.
 */
export function DurableWaits({ task }: { task: DashboardTaskDetail }) {
  const runtimeWaitName = task.current.runtime?.waitName ?? null;
  const nowMs = useNow(runtimeWaitName !== null);
  // The event history renders under the attempts, so a task without a wait has no section here.
  if (task.waits.length === 0) return null;
  const planNames = new Set((task.durability?.steps ?? []).map((step) => step.name));
  const unmatchedWaits = task.waits.filter((wait) => !planNames.has(wait.name));
  const matchedWaits = task.waits.filter((wait) => planNames.has(wait.name));
  return (
    <DrawerSection
      id="durable-wait-heading"
      title="Durable wait"
      help={`The target is the earliest wake time. If a queue is paused, or a worker or database is unavailable, the task can wake later. ${waitReplayWording} Workhorse stores checkpoint and wait records, not a workflow graph.`}
      aside={
        <span className="task-detail__muted task-detail__number">
          {formatCount(task.waits.length)}
          {task.truncated.waits ? "+" : ""}
        </span>
      }
    >
      <Stack gap="sm">
        {matchedWaits.map((wait) => (
          <DurableWaitCard key={wait.name} task={task} wait={wait} nowMs={nowMs} />
        ))}
      </Stack>
      {unmatchedWaits.length > 0 ? (
        <Box mt={matchedWaits.length > 0 ? "md" : undefined}>
          {matchedWaits.length > 0 ? (
            <Text fw={600} size="xs" mb={4}>
              Additional wait evidence
            </Text>
          ) : null}
          <Stack gap="sm">
            {unmatchedWaits.map((wait) => (
              <DurableWaitCard key={wait.name} task={task} wait={wait} nowMs={nowMs} />
            ))}
          </Stack>
        </Box>
      ) : null}
    </DrawerSection>
  );
}
