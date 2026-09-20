import { memo } from "react";
import { Badge, Group, Table, Text } from "@mantine/core";
import type { DashboardTaskRow } from "@stablemates/workhorse-dashboard-server/wire";
import type { TaskActionTarget, TaskRowActionId } from "../presentation.js";
import { TaskOpenButton } from "../task-table-ui.js";
import { TaskTableId } from "./task-table-id.js";
import {
  DurableProgressBadge,
  TaskEnqueueBadge,
  TaskName,
  TaskRowActions,
  TaskStatusIndicators,
  TaskTags,
  taskDuration,
} from "./task-list.js";
import { formatExact, formatRelative } from "../preferences.js";
import { sameStructure } from "../render-identity.js";

export interface TaskListRowProps {
  task: DashboardTaskRow;
  /** Mounted Events URL for this task, passed as a value so the row can compare it. */
  eventsHref: string;
  onOpen: (id: string) => void;
  onAction: (id: TaskRowActionId, task: TaskActionTarget) => void;
  canRunNow: boolean;
  canCompleteHumanWait: boolean;
  /** The action in flight for this row, or null while it is idle. */
  pendingAction: TaskRowActionId | null;
  /** The instant the listing is being shown at, which the "updated" label is measured from. */
  shownAt: number;
  /** The time zone the absolute timestamps are written in. */
  timeZone: string;
}

/**
 * Whether a poll gave this row anything to draw.
 *
 * Every poll decodes a new object for each task it reports, including the tasks it did not
 * change, so comparing references marks a whole page as different. The row compares what it
 * renders instead.
 *
 * The clock is compared through the label it produces rather than by value. A row updated an
 * hour ago says the same thing at every poll, and only the row whose phrase actually moved on
 * has a reason to render again.
 */
export function sameTaskRow(previous: TaskListRowProps, next: TaskListRowProps): boolean {
  return (
    previous.onOpen === next.onOpen &&
    previous.onAction === next.onAction &&
    previous.eventsHref === next.eventsHref &&
    previous.canRunNow === next.canRunNow &&
    previous.canCompleteHumanWait === next.canCompleteHumanWait &&
    previous.pendingAction === next.pendingAction &&
    previous.timeZone === next.timeZone &&
    sameStructure(previous.task, next.task) &&
    formatRelative(previous.task.updatedAt, previous.shownAt) ===
      formatRelative(next.task.updatedAt, next.shownAt)
  );
}

/** One task in the listing. Memoised, so an unchanged poll re-renders no row. */
export const TaskListRow = memo(function TaskListRow({
  task,
  eventsHref,
  onOpen,
  onAction,
  canRunNow,
  canCompleteHumanWait,
  pendingAction,
  shownAt,
}: TaskListRowProps) {
  return (
    <Table.Tr onClick={() => onOpen(task.id)} style={{ cursor: "pointer" }}>
      <Table.Td className="task-table__col--actions">
        <TaskRowActions
          task={task}
          eventsHref={eventsHref}
          onAction={onAction}
          capabilities={{ runNow: canRunNow, completeHumanWait: canCompleteHumanWait }}
          pendingAction={pendingAction}
        />
      </Table.Td>
      <Table.Td className="task-table__col--id">
        <TaskTableId id={task.id} />
      </Table.Td>
      <Table.Td className="task-table__col--status">
        <TaskStatusIndicators task={task} />
      </Table.Td>
      <Table.Td className="task-table__col--queue">
        <Text size="sm" c="dimmed" title={task.queue}>
          {task.queue}
        </Text>
      </Table.Td>
      <Table.Td className="task-table__col--task">
        <TaskOpenButton taskId={task.id} taskType={task.type} onOpen={() => onOpen(task.id)}>
          <Group gap={4} wrap="nowrap" style={{ minWidth: 0 }}>
            <TaskName type={task.type} queue={task.queue} />
            <TaskEnqueueBadge task={task} />
            {task.priority > 0 ? (
              <Badge
                size="xs"
                variant="light"
                color="orange"
                tt="none"
                title={`Priority ${task.priority}; higher-priority ready tasks are claimed first.`}
              >
                P{task.priority}
              </Badge>
            ) : null}
          </Group>
        </TaskOpenButton>
      </Table.Td>
      <Table.Td className="task-table__col--tags">
        <TaskTags tags={task.tags} />
      </Table.Td>
      <Table.Td className="task-table__col--steps" ta="right">
        <DurableProgressBadge task={task} />
      </Table.Td>
      <Table.Td className="task-table__col--attempt" ta="right">
        <Text
          size="sm"
          c={task.attempt > 1 ? "yellow.8" : undefined}
          fw={task.attempt > 1 ? 600 : undefined}
        >
          {task.attempt}/{task.maxAttempts}
        </Text>
      </Table.Td>
      <Table.Td className="task-table__col--duration" ta="left">
        <Text size="sm" c="dimmed">
          {taskDuration(task) ?? "—"}
        </Text>
      </Table.Td>
      <Table.Td className="task-table__col--updated" ta="left">
        <Text size="sm" title={formatExact(task.updatedAt)} c="dimmed">
          {formatRelative(task.updatedAt, shownAt)}
        </Text>
      </Table.Td>
    </Table.Tr>
  );
}, sameTaskRow);
