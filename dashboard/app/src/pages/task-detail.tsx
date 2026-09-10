import { useTaskActions } from "../task-actions.js";
import { TaskRowActions, TaskTags } from "../components/task-list.js";
import { taskHref } from "../core.js";
import type { TaskActionTarget } from "../presentation.js";
import type { DashboardJobDetail } from "@stablemates/workhorse-dashboard-server/wire";
import { Badge, Box, Center, Code, Group, Loader, Paper, Stack, Text } from "@mantine/core";
import { ResizableTaskDrawer } from "../components/resizable-task-drawer.js";
import { StatusLabel } from "../status-badge.js";
import { formatClock, formatDuration, formatExact, formatRelative } from "../preferences.js";
import {
  DrawerSection,
  JobCheckpoints,
  JobProgress,
  JsonValue,
  MetaRow,
  TaskOutcome,
} from "../components/task-detail-overview.js";
import {
  BatchExecutions,
  TaskEnqueueSection,
  RetryPolicyLine,
  TaskIdChip,
} from "../components/task-detail-relations.js";
import { HelpButton } from "../charts/system.js";
import {
  ChildLine,
  ConcurrencyPolicyLine,
  DependencyLine,
  DurableWaits,
  RedriveLine,
  TimingPolicyLine,
} from "../components/task-detail-durability.js";
import { SignalTaskPanel } from "../components/signal-task.js";
import type { useDashboardController } from "../shell/controller.js";
import { taskDrawerOpened, taskDrawerViewportProps } from "../task-drawer.js";

type DashboardController = ReturnType<typeof useDashboardController>;

interface TaskDetailDrawerProps {
  auditActor: string;
  controller: DashboardController;
  drawerProps: Omit<ReturnType<typeof taskDrawerViewportProps>, "closeOnEscape"> & {
    closeOnEscape: boolean;
  };
  taskLinkHref: (taskId: string) => string;
}

export function TaskDetailDrawer({
  auditActor,
  controller,
  drawerProps,
  taskLinkHref,
}: TaskDetailDrawerProps) {
  const {
    selectedJobId,
    selectedJob,
    jobDetailError,
    reloadSelectedJob,
    inspectJob,
    closeJobDetail,
  } = controller;

  return (
    <ResizableTaskDrawer
      id="task-detail-drawer"
      opened={taskDrawerOpened(selectedJobId)}
      onClose={closeJobDetail}
      title={
        <Text component="h2" fw={600} size="lg" my={0}>
          Task details
        </Text>
      }
      position="right"
      closeButtonProps={{
        id: "task-detail-drawer-close",
        "aria-label": "Close task details",
      }}
      // The panel sits beside the task list instead of over it, so a row behind it stays
      // clickable and picking another task swaps the contents in place.
      {...drawerProps}
      classNames={{ content: "task-drawer__content" }}
    >
      {jobDetailError ? (
        <Text c="red" size="sm">
          {jobDetailError}
        </Text>
      ) : selectedJob ? (
        <TaskDetailContent
          auditActor={auditActor}
          controller={controller}
          job={selectedJob}
          taskLinkHref={taskLinkHref}
          onOpenTask={inspectJob}
          reload={reloadSelectedJob}
        />
      ) : (
        <Center mih={200}>
          <Loader size="sm" />
        </Center>
      )}
    </ResizableTaskDrawer>
  );
}

function TaskDetailContent({
  controller,
  auditActor,
  job,
  taskLinkHref,
  onOpenTask,
  reload,
}: {
  auditActor: string;
  controller: DashboardController;
  job: DashboardJobDetail;
  taskLinkHref: (taskId: string) => string;
  onOpenTask: DashboardController["inspectJob"];
  reload: DashboardController["reloadSelectedJob"];
}) {
  return (
    <Stack gap="xl">
      {/* The overview answers "what task is this, and under which rules does it run?" as one
          aligned label/value grid, so every policy and limit reads from the same column instead
          of each line wrapping at its own offset. */}
      <Box component="section" aria-labelledby="task-overview-heading">
        <Group justify="space-between" align="flex-start" wrap="nowrap" gap="sm">
          <Box style={{ minWidth: 0, flex: 1 }}>
            <Group gap="xs" wrap="nowrap" align="center">
              <Text
                id="task-overview-heading"
                component="h3"
                fw={700}
                size="lg"
                my={0}
                style={{ minWidth: 0, overflowWrap: "anywhere" }}
              >
                {job.identity.type}
              </Text>
              <TaskDetailActions
                key={job.identity.id}
                job={job}
                controller={controller}
                auditActor={auditActor}
              />
            </Group>
            <Text c="dimmed" size="xs" title={formatExact(job.identity.createdAt)}>
              Queue {job.identity.queue} · created {formatRelative(job.identity.createdAt)}
            </Text>
          </Box>
          <StatusLabel state={job.identity.state} />
        </Group>
        {job.tags && job.tags.length > 0 ? (
          <Box mt="xs">
            <TaskTags tags={job.tags} />
          </Box>
        ) : null}
        <Stack gap={6} mt="md">
          <MetaRow label="Task id">
            <TaskIdChip id={job.identity.id} />
          </MetaRow>
          <MetaRow label="Priority">
            <Badge size="xs" variant="light" color="orange" tt="none">
              {job.identity.priority}
            </Badge>
            <HelpButton
              label="Priority"
              help="Higher values are claimed first; equal values keep FIFO order."
            />
          </MetaRow>
          <RetryPolicyLine job={job} />
          <TimingPolicyLine job={job} />
          <ConcurrencyPolicyLine job={job} />
          <DependencyLine job={job} taskLinkHref={taskLinkHref} onOpenTask={onOpenTask} />
          <ChildLine job={job} taskLinkHref={taskLinkHref} onOpenTask={onOpenTask} />
          <RedriveLine job={job} taskLinkHref={taskLinkHref} onOpenTask={onOpenTask} />
        </Stack>
      </Box>
      <BatchExecutions job={job} taskLinkHref={taskLinkHref} onOpenTask={onOpenTask} />
      <DrawerSection id="task-input-heading" title="Input">
        <JsonValue
          label="Stored payload"
          value={job.payload}
          emptyLabel="This task was enqueued without input."
          copyLabel="the task input"
        />
      </DrawerSection>
      <TaskOutcome job={job} />
      <TaskEnqueueSection job={job} />
      <SignalTaskPanel job={job} auditActor={auditActor} reload={reload} />
      <JobProgress job={job} />
      <JobCheckpoints job={job} />
      <DurableWaits job={job} />
      <DrawerSection
        id="attempt-history-heading"
        title="Attempt history"
        aside={
          <Badge variant="light" color={job.attempts.length > 0 ? "blue" : "gray"}>
            {job.attempts.length}
          </Badge>
        }
      >
        {job.attempts.length === 0 ? (
          <Text c="dimmed" size="sm">
            No attempt has finished yet.
          </Text>
        ) : (
          <Stack gap="sm">
            {job.attempts.map((attempt) => (
              <Paper key={attempt.attempt} withBorder p="sm">
                <Group justify="space-between">
                  <Text fw={600} size="sm">
                    Attempt {attempt.attempt}
                  </Text>
                  <StatusLabel state={attempt.outcome} />
                </Group>
                <Text c="dimmed" size="xs" mt={4} title={formatExact(attempt.startedAt)}>
                  {attempt.workerId} · executing {formatDuration(attempt.executionMs)} · elapsed{" "}
                  {formatDuration(attempt.elapsedMs)}
                </Text>
                <Text c="dimmed" size="xs" title={formatExact(attempt.claimedAt)}>
                  Logical start {formatClock(attempt.startedAt)} · final claim{" "}
                  {formatClock(attempt.claimedAt)}
                </Text>
                {attempt.error ? (
                  <Code block mt="sm">
                    {JSON.stringify(attempt.error, null, 2)}
                  </Code>
                ) : null}
              </Paper>
            ))}
          </Stack>
        )}
      </DrawerSection>
    </Stack>
  );
}

function TaskDetailActions({
  job,
  controller,
  auditActor,
}: {
  job: DashboardJobDetail;
  controller: DashboardController;
  auditActor: string;
}) {
  const runtime = job.current.runtime;
  const target: TaskActionTarget = {
    ...job.identity,
    payload: job.payload,
    workerId: runtime?.workerId ?? null,
    lastWorkerId:
      job.waits.find((wait) => wait.name === runtime?.waitName)?.workerId ??
      job.attempts.at(-1)?.workerId ??
      null,
    cancellation: runtime?.cancellation ?? null,
    waitName: runtime?.waitName ?? null,
    wait: runtime?.waitName
      ? (() => {
          const wait = job.waits.find((item) => item.name === runtime.waitName);
          return wait ? { name: wait.name, mode: wait.mode, wakeAt: wait.wakeAt } : null;
        })()
      : null,
    humanWait: job.humanWait ?? null,
  };
  const actions = useTaskActions({
    canCompleteHumanWait: job.canCompleteHumanWait ?? false,
    inspectJob: controller.inspectJob,
    runTaskNow: controller.runTaskNow,
    auditActor,
    reload: async () => {
      await controller.loadPage();
      await controller.reloadSelectedJob();
    },
    updateLocation: (updates) =>
      controller.navigate(
        taskHref({
          ...controller.location,
          ...updates,
          taskId: null,
          page: 1,
          cursor: null,
          direction: "next",
        }),
      ),
  });
  return (
    <>
      {actions.confirmations}
      <Group gap="xs">
        <TaskRowActions
          job={target}
          showOpenDetails={false}
          onAction={actions.runRowAction}
          capabilities={{
            runNow: controller.runTaskNow !== null,
            completeHumanWait: job.canCompleteHumanWait ?? false,
          }}
          pendingAction={
            actions.cancelingJobId === job.identity.id
              ? "cancel"
              : actions.completingHumanWaitJobId === job.identity.id
                ? "complete-human-wait"
                : actions.redrivingJobId === job.identity.id
                  ? "redrive"
                  : actions.runningNowJobId === job.identity.id
                    ? "run-now"
                    : null
          }
        />
      </Group>
    </>
  );
}
