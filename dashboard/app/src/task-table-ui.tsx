import { UnstyledButton } from "@mantine/core";
import type { ReactNode } from "react";

export function taskOpenButtonId(jobId: string): string {
  return `task-open-${jobId}`;
}

/** A real keyboard control for opening a task from an otherwise pointer-clickable table row. */
export function TaskOpenButton({
  jobId,
  taskType,
  onOpen,
  children,
}: {
  jobId: string;
  taskType: string;
  onOpen: () => void;
  children: ReactNode;
}) {
  return (
    <UnstyledButton
      id={taskOpenButtonId(jobId)}
      className="task-table__open"
      aria-label={`View task ${taskType}, ${jobId}`}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
    >
      {children}
    </UnstyledButton>
  );
}
