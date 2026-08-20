import type { DashboardJobDetail } from "@workhorse-js/dashboard-server/wire";
import { Badge, Box, Center, Code, Drawer, Group, Loader, Paper, Stack, Text } from "@mantine/core";
import { StatusBadge } from "../status-badge.js";
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
  CancelTaskPanel,
  CoalescingSection,
  IdempotencySection,
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
    confirmingCancel,
    setConfirmingCancel,
    cancelReason,
    setCancelReason,
    cancelingJobId,
    cancelTask,
  } = controller;

  return (
    <Drawer
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
          job={selectedJob}
          taskLinkHref={taskLinkHref}
          onOpenTask={inspectJob}
          reload={reloadSelectedJob}
          confirmingCancel={confirmingCancel}
          setConfirmingCancel={setConfirmingCancel}
          cancelReason={cancelReason}
          setCancelReason={setCancelReason}
          cancelingJobId={cancelingJobId}
          cancelTask={cancelTask}
        />
      ) : (
        <Center mih={200}>
          <Loader size="sm" />
        </Center>
      )}
    </Drawer>
  );
}

function TaskDetailContent({
  auditActor,
  job,
  taskLinkHref,
  onOpenTask,
  reload,
  confirmingCancel,
  setConfirmingCancel,
  cancelReason,
  setCancelReason,
  cancelingJobId,
  cancelTask,
}: {
  auditActor: string;
  job: DashboardJobDetail;
  taskLinkHref: (taskId: string) => string;
  onOpenTask: DashboardController["inspectJob"];
  reload: DashboardController["reloadSelectedJob"];
  confirmingCancel: boolean;
  setConfirmingCancel: DashboardController["setConfirmingCancel"];
  cancelReason: string;
  setCancelReason: DashboardController["setCancelReason"];
  cancelingJobId: string | null;
  cancelTask: DashboardController["cancelTask"];
}) {
  return (
    <Stack gap="xl">
      {/* The overview answers "what task is this, and under which rules does it run?" as one
          aligned label/value grid, so every policy and limit reads from the same column instead
          of each line wrapping at its own offset. */}
      <Box component="section" aria-labelledby="task-overview-heading">
        <Group justify="space-between" align="flex-start" wrap="nowrap" gap="sm">
          <Box style={{ minWidth: 0 }}>
            <Text id="task-overview-heading" component="h3" fw={700} size="lg" my={0}>
              {job.identity.type}
            </Text>
            <Text c="dimmed" size="xs" title={formatExact(job.identity.createdAt)}>
              Queue {job.identity.queue} · created {formatRelative(job.identity.createdAt)}
            </Text>
          </Box>
          <StatusBadge state={job.identity.state} />
        </Group>
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
      <IdempotencySection job={job} />
      <CoalescingSection job={job} />
      <SignalTaskPanel job={job} auditActor={auditActor} reload={reload} />
      <CancelTaskPanel
        job={job}
        confirming={confirmingCancel}
        setConfirming={setConfirmingCancel}
        reason={cancelReason}
        setReason={setCancelReason}
        pending={cancelingJobId === job.identity.id}
        cancelTask={cancelTask}
      />
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
                  <StatusBadge state={attempt.outcome} />
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
