import type { DashboardRedriveCursor } from "@stablemates/workhorse-dashboard-server/wire";
import type { RedriveSelection } from "./presentation.js";

/*
 * The rules that keep a batch redrive on the selection that the operator confirmed. They are
 * internal to the Tasks page, so they live outside `presentation.ts`, which the package exports.
 */

/** Why the listing cannot open a redrive now, or null when it can. */
export function redriveSelectionBlocked({
  selection,
  shownTasks,
  pending,
}: {
  selection: RedriveSelection;
  shownTasks: number;
  pending: boolean;
}): string | null {
  // While new results load, the rows on screen answer the previous filters, and so does the
  // selection read from them.
  if (pending) return "Wait for the new results, so the redrive acts on the filters shown.";
  if (selection.unavailable !== null) return selection.unavailable;
  if (shownTasks === 0) return "This listing shows no dead letter, so there is nothing to redrive.";
  return null;
}

/**
 * A redrive that the operator opened: the selection that its dialog shows, and the progress
 * through it. The listing reads the selection once, when the dialog opens.
 */
export interface RedriveConfirmation {
  selection: RedriveSelection;
  cursor: DashboardRedriveCursor | null;
  redriven: number;
  running: boolean;
}

/**
 * The filters and cursor of the next batch that a confirmation asks for, or null when it must not
 * ask now.
 *
 * The request comes only from the confirmation, never from the listing on screen. So a confirm
 * always acts on the selection that the dialog named. While the page loads new results, the
 * confirm asks for nothing, because the screen no longer agrees with the dialog.
 */
export function confirmedRedriveBatch(
  confirmation: RedriveConfirmation | null,
  pending: boolean,
): {
  queue: string | null;
  taskType: string | null;
  tags: string[];
  cursor: DashboardRedriveCursor | null;
  selected: string;
} | null {
  if (confirmation === null || confirmation.running || pending) return null;
  const { selection, cursor } = confirmation;
  if (selection.unavailable !== null) return null;
  return {
    queue: selection.queue,
    taskType: selection.taskType,
    tags: [...selection.tags],
    cursor,
    selected: selection.selected,
  };
}
