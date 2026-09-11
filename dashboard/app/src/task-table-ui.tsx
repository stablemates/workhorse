import { UnstyledButton } from "@mantine/core";
import type { ReactNode } from "react";

export function taskOpenButtonId(taskId: string): string {
  return `task-open-${taskId}`;
}

/** A real keyboard control for opening a task from an otherwise pointer-clickable table row. */
export function TaskOpenButton({
  taskId,
  taskType,
  onOpen,
  children,
}: {
  taskId: string;
  taskType: string;
  onOpen: () => void;
  children: ReactNode;
}) {
  return (
    <UnstyledButton
      id={taskOpenButtonId(taskId)}
      className="task-table__open"
      aria-label={`View task ${taskType}, ${taskId}`}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
    >
      {children}
    </UnstyledButton>
  );
}
