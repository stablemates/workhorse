import { useTaskActions } from "../task-actions.js";
import { TaskRowActions, TaskTags } from "../components/task-list.js";
import { taskHref } from "../core.js";
import type { TaskActionTarget } from "../presentation.js";
import type { DashboardTaskDetail } from "@stablemates/workhorse-dashboard-server/wire";
import { Badge, Box, Center, Code, Group, Loader, Paper, Stack, Text } from "@mantine/core";
import { ResizableTaskDrawer } from "../components/resizable-task-drawer.js";
import { StatusLabel } from "../status-badge.js";
import { formatClock, formatDuration, formatExact, formatRelative } from "../preferences.js";
import {
  DrawerSection,
  TaskCheckpoints,
  TaskProgress,
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
    selectedTaskId,
    selectedTask,
    taskDetailError,
    reloadSelectedTask,
    inspectTask,
    closeTaskDetail,
  } = controller;

  return (
    <ResizableTaskDrawer
      id="task-detail-drawer"
      opened={taskDrawerOpened(selectedTaskId)}
      onClose={closeTaskDetail}
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
      {taskDetailError ? (
        <Text c="red" size="sm">
          {taskDetailError}
        </Text>
      ) : selectedTask ? (
        <TaskDetailContent
          auditActor={auditActor}
          controller={controller}
          task={selectedTask}
          taskLinkHref={taskLinkHref}
          onOpenTask={inspectTask}
          reload={reloadSelectedTask}
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
  task,
  taskLinkHref,
  onOpenTask,
  reload,
}: {
  auditActor: string;
  controller: DashboardController;
  task: DashboardTaskDetail;
  taskLinkHref: (taskId: string) => string;
  onOpenTask: DashboardController["inspectTask"];
  reload: DashboardController["reloadSelectedTask"];
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
                {task.identity.type}
              </Text>
              <TaskDetailActions
                key={task.identity.id}
                task={task}
                controller={controller}
                auditActor={auditActor}
              />
            </Group>
            <Text c="dimmed" size="xs" title={formatExact(task.identity.createdAt)}>
              Queue {task.identity.queue} · created {formatRelative(task.identity.createdAt)}
            </Text>
          </Box>
          <StatusLabel state={task.identity.state} />
        </Group>
        {task.tags && task.tags.length > 0 ? (
          <Box mt="xs">
            <TaskTags tags={task.tags} />
          </Box>
        ) : null}
        <Stack gap={6} mt="md">
          <MetaRow label="Task id">
            <TaskIdChip id={task.identity.id} />
          </MetaRow>
          <MetaRow label="Priority">
            <Badge size="xs" variant="light" color="orange" tt="none">
              {task.identity.priority}
            </Badge>
            <HelpButton
              label="Priority"
              help="Higher values are claimed first; equal values keep FIFO order."
            />
          </MetaRow>
          <RetryPolicyLine task={task} />
          <TimingPolicyLine task={task} />
          <ConcurrencyPolicyLine task={task} />
          <DependencyLine task={task} taskLinkHref={taskLinkHref} onOpenTask={onOpenTask} />
          <ChildLine task={task} taskLinkHref={taskLinkHref} onOpenTask={onOpenTask} />
          <RedriveLine task={task} taskLinkHref={taskLinkHref} onOpenTask={onOpenTask} />
        </Stack>
      </Box>
      <BatchExecutions task={task} taskLinkHref={taskLinkHref} onOpenTask={onOpenTask} />
      <DrawerSection id="task-input-heading" title="Input">
        <JsonValue
          label="Stored payload"
          value={task.payload}
          emptyLabel="This task was enqueued without input."
          copyLabel="the task input"
        />
      </DrawerSection>
      <TaskOutcome task={task} />
      <TaskEnqueueSection task={task} />
      <SignalTaskPanel task={task} auditActor={auditActor} reload={reload} />
      <TaskProgress task={task} />
      <TaskCheckpoints task={task} />
      <DurableWaits task={task} />
      <DrawerSection
        id="attempt-history-heading"
        title="Attempt history"
        aside={
          <Badge variant="light" color={task.attempts.length > 0 ? "blue" : "gray"}>
            {task.attempts.length}
          </Badge>
        }
      >
        {task.attempts.length === 0 ? (
          <Text c="dimmed" size="sm">
            No attempt has finished yet.
          </Text>
        ) : (
          <Stack gap="sm">
            {task.attempts.map((attempt) => (
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
  task,
  controller,
  auditActor,
}: {
  task: DashboardTaskDetail;
  controller: DashboardController;
  auditActor: string;
}) {
  const runtime = task.current.runtime;
  const target: TaskActionTarget = {
    ...task.identity,
    payload: task.payload,
    workerId: runtime?.workerId ?? null,
    lastWorkerId:
      task.waits.find((wait) => wait.name === runtime?.waitName)?.workerId ??
      task.attempts.at(-1)?.workerId ??
      null,
    cancellation: runtime?.cancellation ?? null,
    waitName: runtime?.waitName ?? null,
    wait: runtime?.waitName
      ? (() => {
          const wait = task.waits.find((item) => item.name === runtime.waitName);
          return wait ? { name: wait.name, mode: wait.mode, wakeAt: wait.wakeAt } : null;
        })()
      : null,
    humanWait: task.humanWait ?? null,
  };
  const actions = useTaskActions({
    canCompleteHumanWait: task.canCompleteHumanWait ?? false,
    inspectTask: controller.inspectTask,
    runTaskNow: controller.runTaskNow,
    auditActor,
    reload: async () => {
      await controller.loadPage();
      await controller.reloadSelectedTask();
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
          task={target}
          showOpenDetails={false}
          onAction={actions.runRowAction}
          capabilities={{
            runNow: controller.runTaskNow !== null,
            completeHumanWait: task.canCompleteHumanWait ?? false,
          }}
          pendingAction={
            actions.cancelingTaskId === task.identity.id
              ? "cancel"
              : actions.completingHumanWaitTaskId === task.identity.id
                ? "complete-human-wait"
                : actions.redrivingTaskId === task.identity.id
                  ? "redrive"
                  : actions.runningNowTaskId === task.identity.id
                    ? "run-now"
                    : null
          }
        />
      </Group>
    </>
  );
}
