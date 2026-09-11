import { useCallback, useRef, useState } from "react";
import { Button, Code, Group, Modal, Text, TextInput } from "@mantine/core";
import { useDashboardClient } from "./core.js";
import { useConfirmationActivity } from "./dropdown-activity.js";
import {
  humanWaitQuickAction,
  isTerminalTaskState,
  redriveAtLeastOnceWarning,
  type TaskActionTarget,
  type TaskRowActionId,
} from "./presentation.js";
import {
  notifyCancel,
  notifyDashboard,
  notifyFailure,
  notifyRedrive,
  notifyRunNow,
} from "./notifications.js";
import { copyToClipboard, formatJson } from "./preferences.js";
import type { RunNowFeedback } from "./run-now.js";
import type { TaskLocationState } from "./task-location.js";

/** Shared execution and confirmation flow for listing and detail actions. */
export function useTaskActions({
  canCompleteHumanWait,
  inspectTask,
  runTaskNow,
  auditActor,
  reload,
  updateLocation,
}: {
  canCompleteHumanWait: boolean;
  inspectTask: (id: string) => void;
  runTaskNow: ((id: string) => Promise<RunNowFeedback>) | null;
  auditActor: string;
  reload: () => Promise<void>;
  updateLocation: (updates: Partial<TaskLocationState>) => void;
}) {
  const client = useDashboardClient();
  // Notifications report outcomes; local state tracks pending actions and confirmation dialogs.
  const [runningNowTaskId, setRunningNowTaskId] = useState<string | null>(null);
  const [completingHumanWaitTaskId, setCompletingHumanWaitTaskId] = useState<string | null>(null);
  const [confirmingHumanWait, setConfirmingHumanWait] = useState<{
    taskId: string;
    waitName: string;
    quickAction: NonNullable<ReturnType<typeof humanWaitQuickAction>>;
  } | null>(null);
  const [confirmingRedrive, setConfirmingRedrive] = useState<TaskActionTarget | null>(null);
  const [redrivingTaskId, setRedrivingTaskId] = useState<string | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState<TaskActionTarget | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelingTaskId, setCancelingTaskId] = useState<string | null>(null);
  const cancelInFlight = useRef(false);
  useConfirmationActivity(confirmingCancel !== null);
  /**
   * Apply one row action.
   *
   * Filtering uses the same location update as the filter controls. Cancellation opens a dialog
   * before sending a request, so the operator can confirm the target and supply an audit reason.
   */
  const runRowAction = useCallback(
    (id: TaskRowActionId, task: TaskActionTarget) => {
      if (id === "inspect") return inspectTask(task.id);
      if (id === "cancel") {
        if (
          cancelInFlight.current ||
          isTerminalTaskState(task.state) ||
          task.cancellation ||
          !["ready", "scheduled", "active"].includes(task.state)
        )
          return;
        setCancelReason("");
        setConfirmingCancel(task);
        return;
      }
      if (id === "complete-human-wait") {
        const wait = task.humanWait;
        const quickAction = wait ? humanWaitQuickAction(wait.context) : null;
        if (!wait || !quickAction || !canCompleteHumanWait || completingHumanWaitTaskId) return;
        setConfirmingHumanWait({ taskId: task.id, waitName: wait.name, quickAction });
        return;
      }
      if (id === "run-now") {
        if (runTaskNow === null || runningNowTaskId !== null) return;
        setRunningNowTaskId(task.id);
        void runTaskNow(task.id)
          .then((feedback) => notifyRunNow(feedback, { openTask: inspectTask }))
          .finally(() => setRunningNowTaskId(null));
        return;
      }
      if (id === "redrive") {
        if (task.state !== "failed" || redrivingTaskId !== null) return;
        setConfirmingRedrive(task);
        return;
      }
      if (id === "filter-type") return updateLocation({ taskType: task.type });
      if (id === "filter-queue") return updateLocation({ queue: task.queue });
      if (id === "filter-worker") {
        const worker = task.workerId ?? task.lastWorkerId;
        if (worker !== null) updateLocation({ worker });
        return;
      }
      const copying = id === "copy-id" ? "Task ID" : "Input";
      void copyToClipboard(id === "copy-id" ? task.id : formatJson(task.payload)).then((failure) =>
        notifyDashboard({
          // One id for both clipboard actions: copying twice is one running answer, not a stack.
          id: "workhorse-task-clipboard",
          title: failure ? `${copying} not copied` : `${copying} copied`,
          message: failure ?? `${copying} copied to the clipboard.`,
          tone: failure ? "failure" : "neutral",
        }),
      );
    },
    [
      completingHumanWaitTaskId,
      canCompleteHumanWait,
      inspectTask,
      redrivingTaskId,
      runTaskNow,
      runningNowTaskId,
      updateLocation,
    ],
  );
  const cancelTask = async () => {
    if (!confirmingCancel || cancelInFlight.current) return;
    const task = confirmingCancel;
    cancelInFlight.current = true;
    setCancelingTaskId(task.id);
    try {
      const result = await client.cancelTask({
        id: task.id,
        audit: {
          actor: auditActor,
          reason: cancelReason.trim() || null,
          requestId: crypto.randomUUID(),
        },
      });
      notifyCancel(
        { taskId: task.id, status: result.status, state: result.state },
        { openTask: inspectTask },
      );
      setConfirmingCancel(null);
      setCancelReason("");
    } catch (cause) {
      notifyFailure("Task not canceled", cause, "Workhorse could not cancel the task");
      return;
    } finally {
      cancelInFlight.current = false;
      setCancelingTaskId(null);
    }
    try {
      await reload();
    } catch (cause) {
      notifyFailure(
        "Task refresh failed",
        cause,
        "Cancellation completed, but the dashboard could not refresh",
      );
    }
  };
  const completeHumanWait = async () => {
    if (!confirmingHumanWait || !canCompleteHumanWait) return;
    const { taskId, waitName, quickAction } = confirmingHumanWait;
    setCompletingHumanWaitTaskId(taskId);
    try {
      const completion = await client.completeHumanWait({
        id: taskId,
        name: waitName,
        result: quickAction.result,
        idempotencyKey: crypto.randomUUID(),
        audit: {
          actor: auditActor,
          reason: `${quickAction.label} human wait ${waitName} from the dashboard`,
          requestId: crypto.randomUUID(),
        },
      });
      notifyDashboard({
        title: completion.status === "completed" ? "Decision completed" : "Decision unchanged",
        message: `${waitName}: ${completion.status}`,
        tone: completion.status === "completed" ? "success" : "neutral",
      });
      setConfirmingHumanWait(null);
      await reload();
    } catch (cause) {
      notifyFailure("Decision not completed", cause, "Workhorse rejected the human decision");
    } finally {
      setCompletingHumanWaitTaskId(null);
    }
  };
  /**
   * Redrive one dead letter, then refresh the listing.
   *
   * The result is reported from what the server said rather than guessed, because whether a failure
   * produced a fresh copy or replayed one it had already produced is a durable fact this dashboard
   * does not get to decide.
   */
  const redriveTask = async (task: TaskActionTarget) => {
    if (!client.redriveTask) return;
    setRedrivingTaskId(task.id);
    try {
      const result = await client.redriveTask({
        id: task.id,
        audit: {
          actor: auditActor,
          reason: `Redrive dead letter ${task.id} from the dashboard`,
          requestId: crypto.randomUUID(),
        },
      });
      notifyRedrive(result, { openTask: inspectTask });
      setConfirmingRedrive(null);
      await reload();
    } catch (cause) {
      notifyFailure("Task not redriven", cause, "Workhorse could not redrive the task");
    } finally {
      setRedrivingTaskId(null);
    }
  };

  const confirmations = (
    <>
      <Modal
        opened={confirmingCancel !== null}
        onClose={() => {
          if (!cancelInFlight.current) setConfirmingCancel(null);
        }}
        title="Cancel this task?"
        centered
        closeOnClickOutside={cancelingTaskId === null}
        closeOnEscape={cancelingTaskId === null}
        withCloseButton={cancelingTaskId === null}
      >
        {confirmingCancel ? (
          <Code
            block
            mb="sm"
          >{`${confirmingCancel.type} in ${confirmingCancel.queue}\n${confirmingCancel.id}`}</Code>
        ) : null}
        <Text size="sm" mb="sm">
          {confirmingCancel?.state === "active"
            ? "Workhorse asks the handler to stop. External effects can continue until the handler checks the cancellation signal."
            : confirmingCancel?.waitName != null
              ? "Workhorse closes this task's waiting attempt without resuming the handler. Earlier external work cannot be undone."
              : "Workhorse cancels this task before another handler can run."}{" "}
          You cannot undo a cancellation.
        </Text>
        <TextInput
          data-autofocus
          label="Reason (optional)"
          description="Workhorse records this reason in the audit trail."
          placeholder="Why are you canceling this task?"
          value={cancelReason}
          disabled={cancelingTaskId !== null}
          onChange={(event) => setCancelReason(event.currentTarget.value)}
        />
        <Group justify="flex-end" mt="lg">
          <Button
            variant="default"
            disabled={cancelingTaskId !== null}
            onClick={() => setConfirmingCancel(null)}
          >
            Keep task
          </Button>
          <Button color="red" loading={cancelingTaskId !== null} onClick={() => void cancelTask()}>
            {confirmingCancel?.state === "active" ? "Request cancellation" : "Cancel task"}
          </Button>
        </Group>
      </Modal>
      <Modal
        opened={confirmingHumanWait !== null}
        onClose={() => setConfirmingHumanWait(null)}
        title={
          confirmingHumanWait
            ? `Confirm ${confirmingHumanWait.quickAction.label}`
            : "Confirm decision"
        }
        centered
      >
        <Text size="sm" mb="sm">
          The first accepted result resumes the handler and cannot be replaced. Confirm the result
          before completing this decision.
        </Text>
        {confirmingHumanWait ? (
          <Code block>{confirmingHumanWait.quickAction.formatted}</Code>
        ) : null}
        <Group justify="flex-end" mt="lg">
          <Button
            variant="default"
            disabled={completingHumanWaitTaskId !== null}
            onClick={() => setConfirmingHumanWait(null)}
          >
            Cancel
          </Button>
          <Button
            loading={completingHumanWaitTaskId !== null}
            onClick={() => void completeHumanWait()}
          >
            Confirm decision
          </Button>
        </Group>
      </Modal>
      <Modal
        opened={confirmingRedrive !== null}
        onClose={() => setConfirmingRedrive(null)}
        title="Redrive this dead letter"
        centered
      >
        <Text size="sm" mb="sm">
          {redriveAtLeastOnceWarning}
        </Text>
        {confirmingRedrive ? (
          <Code
            block
          >{`${confirmingRedrive.type} in ${confirmingRedrive.queue}\n${confirmingRedrive.id}`}</Code>
        ) : null}
        <Group justify="flex-end" mt="lg">
          <Button
            variant="default"
            disabled={redrivingTaskId !== null}
            onClick={() => setConfirmingRedrive(null)}
          >
            Cancel
          </Button>
          <Button
            loading={redrivingTaskId !== null}
            onClick={() => void (confirmingRedrive && redriveTask(confirmingRedrive))}
          >
            Redrive as a new task
          </Button>
        </Group>
      </Modal>
    </>
  );
  return {
    runRowAction,
    completingHumanWaitTaskId,
    redrivingTaskId,
    runningNowTaskId,
    cancelingTaskId,
    confirmations,
  };
}
