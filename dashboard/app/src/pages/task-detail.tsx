import { useTaskActions } from "../task-actions.js";
import { TaskRowActions } from "../components/task-list.js";
import { taskHref } from "../core.js";
import { humanWaitQuickAction, type TaskActionTarget } from "../presentation.js";
import type { DashboardTaskDetail } from "@stablemates/workhorse-dashboard-server/wire";
import { Alert, Box, Center, Loader } from "@mantine/core";
import { AlertCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { ResizableTaskDrawer } from "../components/resizable-task-drawer.js";
import { hasStoredValue } from "../preferences.js";
import {
  DrawerDisclosure,
  DrawerSection,
  JsonValue,
  TaskCheckpoints,
  TaskOutcome,
  TaskProgress,
  TaskStoredValue,
} from "../components/task-detail-overview.js";
import { BatchExecutions, TaskEnqueueSection } from "../components/task-detail-relations.js";
import {
  BoundaryTimeline,
  boundaryEvents,
  ChildLine,
  DependencyLine,
  DurableWaits,
  RedriveLine,
} from "../components/task-detail-durability.js";
import {
  TaskAttempts,
  TaskDetailHeader,
  TaskExecutionPolicy,
  TaskProperties,
  type TaskPageNavigation,
} from "../components/task-detail-summary.js";
import { SignalTaskPanel } from "../components/signal-task.js";
import type { useDashboardController } from "../shell/controller.js";
import {
  taskDetailFocusLost,
  taskDrawerBody,
  taskDrawerOpened,
  taskDrawerViewportProps,
} from "../task-drawer.js";
import { formatCount } from "../count-format.js";
import { useLayoutEffect, useRef, type FocusEvent } from "react";

/** The task heading: it names the task and stays mounted while the task reloads. */
const taskOverviewHeadingId = "task-overview-heading";

type DashboardController = ReturnType<typeof useDashboardController>;

interface TaskDetailDrawerProps {
  auditActor: string;
  controller: DashboardController;
  drawerProps: Omit<ReturnType<typeof taskDrawerViewportProps>, "closeOnEscape"> & {
    closeOnEscape: boolean;
  };
  taskLinkHref: (taskId: string) => string;
  /** The links to other dashboard pages, such as the group of a member task. */
  pageNavigation: TaskPageNavigation;
}

export function TaskDetailDrawer({
  auditActor,
  controller,
  drawerProps,
  taskLinkHref,
  pageNavigation,
}: TaskDetailDrawerProps) {
  const {
    selectedTaskId,
    selectedTask,
    taskDetailError,
    reloadSelectedTask,
    inspectTask,
    closeTaskDetail,
  } = controller;
  const body = taskDrawerBody({ selectedTaskId, selectedTask, taskDetailError });
  /** The last control in the detail that held focus, and the task it belongs to. */
  const focusedControl = useRef<{ taskId: string; element: Element } | null>(null);
  const trackFocus = (event: FocusEvent<HTMLElement>) => {
    if (selectedTask) {
      focusedControl.current = { taskId: selectedTask.identity.id, element: event.target };
    }
  };
  // Runs after each render, because any reload can remove the control that holds focus.
  useLayoutEffect(() => {
    const focused = focusedControl.current;
    if (!focused || focused.element.isConnected) return;
    focusedControl.current = null;
    const active = document.activeElement;
    if (
      !taskDetailFocusLost({
        focusedTaskId: focused.taskId,
        focusedControlConnected: false,
        focusOnBody: active === null || active === document.body,
        selectedTaskId,
      })
    ) {
      return;
    }
    (
      document.getElementById(taskOverviewHeadingId) ??
      document.getElementById("task-detail-drawer-close")
    )?.focus();
  });

  return (
    <ResizableTaskDrawer
      id="task-detail-drawer"
      opened={taskDrawerOpened(selectedTaskId)}
      onClose={closeTaskDetail}
      title="Task details"
      position="right"
      closeButtonProps={{
        id: "task-detail-drawer-close",
        "aria-label": "Close task details",
      }}
      // The panel sits beside the task list instead of over it, so a row behind it stays
      // clickable and picking another task swaps the contents in place.
      {...drawerProps}
      classNames={{ content: "task-drawer__content task-drawer__content--task" }}
    >
      {taskDetailError ? (
        // Stale detail stays readable under a warning. A task that never loaded shows the error.
        <Alert
          color={body === "detail" ? "yellow" : "red"}
          icon={<HugeiconsIcon icon={AlertCircleIcon} size={16} />}
          mb="md"
          title={body === "detail" ? "These details can be out of date" : "Task not loaded"}
        >
          {body === "detail"
            ? `Workhorse could not reload this task. The detail below can be out of date. ${taskDetailError}`
            : taskDetailError}
        </Alert>
      ) : null}
      {body === "detail" && selectedTask ? (
        <Box onFocusCapture={trackFocus}>
          <TaskDetailContent
            auditActor={auditActor}
            controller={controller}
            task={selectedTask}
            taskLinkHref={taskLinkHref}
            pageNavigation={pageNavigation}
            onOpenTask={inspectTask}
            reload={reloadSelectedTask}
          />
        </Box>
      ) : body === "error" ? null : (
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
  pageNavigation,
  onOpenTask,
  reload,
}: {
  auditActor: string;
  controller: DashboardController;
  task: DashboardTaskDetail;
  taskLinkHref: (taskId: string) => string;
  pageNavigation: TaskPageNavigation;
  onOpenTask: DashboardController["inspectTask"];
  reload: DashboardController["reloadSelectedTask"];
}) {
  const navigation = { taskLinkHref, onOpenTask };
  const hasLineage =
    task.identity.prerequisiteTaskIds.length > 0 ||
    task.dependencyLineage.records.length > 0 ||
    task.childLineage.records.length > 0 ||
    task.redriveLineage.records.length > 0;
  // A failed task's error is the first thing an operator reads, so it comes before the input.
  const errorFirst = task.current.outcome?.state === "failed";
  const outcome = <TaskOutcome task={task} />;
  const eventCount = boundaryEvents(task).length;
  return (
    <div className="task-detail">
      {/* The overview answers "what task is this, and what state is it in?" in a header and a
          short grid of plain values. Rules and evidence that most reads do not need follow it. */}
      <Box
        component="section"
        aria-labelledby={taskOverviewHeadingId}
        className="task-detail__summary"
      >
        <TaskDetailHeader
          task={task}
          heading={
            <h3
              id={taskOverviewHeadingId}
              // Focus target when an action removes the control that held focus. It takes
              // focus from a script only, so it does not join the tab order.
              tabIndex={-1}
              className="task-detail__type"
            >
              {task.identity.type}
            </h3>
          }
          actions={
            <TaskDetailActions
              key={task.identity.id}
              task={task}
              controller={controller}
              auditActor={auditActor}
            />
          }
        />
        <TaskProperties task={task} navigation={pageNavigation} />
      </Box>
      {hasLineage ? (
        <DrawerSection id="related-tasks-heading" title="Related tasks">
          <div className="task-detail__properties">
            <DependencyLine task={task} {...navigation} />
            <ChildLine task={task} {...navigation} />
            <RedriveLine task={task} {...navigation} />
          </div>
        </DrawerSection>
      ) : null}
      <SignalTaskPanel task={task} auditActor={auditActor} reload={reload} />
      {task.humanWait && hasStoredValue(task.humanWait.context) ? (
        <DrawerSection id="human-wait-heading" title="Decision context">
          <JsonValue
            label="JSON"
            value={task.humanWait.context}
            emptyLabel="The decision has no context."
            copyLabel="the decision context"
            maxHeight={200}
          />
        </DrawerSection>
      ) : null}
      {errorFirst ? outcome : null}
      <DrawerSection id="task-input-heading" title="Payload">
        <TaskStoredValue
          taskId={task.identity.id}
          kind="payload"
          omitted={task.payloadOmitted}
          valueBytes={task.payloadBytes}
          value={task.payload}
          label="JSON"
          emptyLabel="This task was enqueued without a payload."
          copyLabel="the task payload"
        />
      </DrawerSection>
      {errorFirst ? null : outcome}
      <BatchExecutions task={task} {...navigation} />
      <TaskProgress task={task} />
      <TaskCheckpoints task={task} />
      <DurableWaits task={task} />
      <TaskAttempts task={task} />
      <TaskEnqueueSection task={task} />
      {/* Detail that most reads do not need stays closed at the end of the drawer. */}
      <div className="task-drawer__section task-detail__more">
        {eventCount === 0 ? null : (
          <DrawerDisclosure
            title="Event history"
            summary={`${formatCount(eventCount)}${task.truncated.events ? "+" : ""} ${eventCount === 1 ? "event" : "events"}`}
          >
            <BoundaryTimeline task={task} />
          </DrawerDisclosure>
        )}
        <TaskExecutionPolicy task={task} />
      </div>
    </div>
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
    humanWait: task.humanWait
      ? { ...task.humanWait, quickAction: humanWaitQuickAction(task.humanWait.context) }
      : null,
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
    </>
  );
}
