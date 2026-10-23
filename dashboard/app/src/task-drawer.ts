/**
 * Task detail drawer behaviour, kept out of the component so it can be asserted directly.
 *
 * The drawer is deliberately non-modal: an operator comparing tasks clicks straight from one
 * table row to the next while the panel stays open, so the panel must never take the pointer or
 * scroll position away from the task list behind it. On a narrow viewport the same content becomes
 * a modal, full-width panel because there is no useful list area to preserve beside it.
 */

/** Props that make the drawer a side panel rather than a modal dialog. */
export const taskDrawerModelessProps = {
  withOverlay: false,
  lockScroll: false,
  trapFocus: false,
  closeOnClickOutside: false,
  // The shell returns focus to the current task control, including after the drawer switches tasks.
  returnFocus: false,
  /* Escape still closes, because that is the only keyboard affordance a side panel keeps. */
  closeOnEscape: true,
} as const;

/** Responsive drawer policy for task details. */
export function taskDrawerViewportProps(narrow: boolean) {
  // "xl" rather than "lg": the drawer lays metadata out as a label/value grid and shows JSON
  // evidence blocks, both of which wrap badly one step narrower.
  if (!narrow) return { ...taskDrawerModelessProps, size: "xl" as const };
  return {
    withOverlay: true,
    lockScroll: true,
    trapFocus: true,
    closeOnClickOutside: true,
    // The shell owns this so switching tasks updates the return target before the panel closes.
    returnFocus: false,
    closeOnEscape: true,
    size: "100%" as const,
  };
}

export type TaskDrawerFocusChange = "drawer" | "trigger" | "none";

/** Where focus moves when URL reconciliation opens, switches, or closes task detail. */
export function taskDrawerFocusChange(
  previousTaskId: string | null,
  selectedTaskId: string | null,
): TaskDrawerFocusChange {
  if (previousTaskId === selectedTaskId) return "none";
  return selectedTaskId === null ? "trigger" : "drawer";
}

/** Escape closes a dropdown before the detail panel behind it. */
export function taskDrawerCloseOnEscape(dropdownOpened: boolean): boolean {
  return !dropdownOpened;
}

/**
 * What the drawer body shows for one controller state.
 *
 * Picking another task clears the loaded detail but keeps the selected id, so the drawer stays
 * open on a loader instead of closing and re-opening. A failed reload of the task on screen keeps
 * its detail: the error shows above the detail the operator was reading, which says which facts
 * may be old instead of replacing them.
 */
export type TaskDrawerBody = "closed" | "error" | "loading" | "detail";

export function taskDrawerBody(state: {
  selectedTaskId: string | null;
  selectedTask: unknown | null;
  taskDetailError: string | null;
}): TaskDrawerBody {
  if (state.selectedTaskId === null) return "closed";
  if (state.selectedTask !== null) return "detail";
  if (state.taskDetailError !== null) return "error";
  return "loading";
}

/**
 * Whether a detail load keeps the detail that the drawer shows now.
 *
 * An action such as Retry reloads the task on screen. Emptying the drawer first unmounted the
 * whole detail: the panel became a spinner, scrolled back to the top, lost the text in its
 * fields, and dropped keyboard focus to the document body. Only a load for another task empties
 * it, because the old detail must never show under the new task's heading.
 */
export function taskDetailKeepsShownDetail(
  shownTaskId: string | null,
  requestedId: string,
): boolean {
  return shownTaskId === requestedId;
}

/**
 * Whether the drawer must put focus back after a render removed the control that held it.
 *
 * A reload can remove the focused control, for example the signal form after the signal arrives.
 * The browser then moves focus to the document body, and a keyboard or screen reader user loses
 * their place. The drawer moves focus to the task heading instead. It does nothing when focus
 * already went somewhere real, or when the drawer now shows another task, because the shell owns
 * focus for a task switch.
 */
export function taskDetailFocusLost(state: {
  focusedTaskId: string | null;
  focusedControlConnected: boolean;
  focusOnBody: boolean;
  selectedTaskId: string | null;
}): boolean {
  return (
    state.focusedTaskId !== null &&
    state.focusedTaskId === state.selectedTaskId &&
    !state.focusedControlConnected &&
    state.focusOnBody
  );
}

/** The drawer is open for as long as a task is selected, including while its detail loads. */
export function taskDrawerOpened(selectedTaskId: string | null): boolean {
  return selectedTaskId !== null;
}

/**
 * Ticket dispenser that decides which in-flight detail load is still allowed to write state.
 *
 * Because the drawer is modeless, an operator clicks task A then task B before A's request has
 * settled. Both requests resolve against the same drawer, and the network decides the order, so
 * without a guard A's late detail or late error silently overwrites B's. Comparing the settled
 * task id is not enough either: re-clicking the same row would let the older of two identical
 * requests win. Each call to `begin` therefore invalidates every earlier ticket, and only the
 * newest one is `current`.
 */
export interface LatestRequestGuard {
  /** Claim the drawer for a new load, invalidating any request still in flight. */
  begin(): number;
  /** Whether this ticket is still the newest, i.e. whether it may write drawer state. */
  current(ticket: number): boolean;
  /** Drop the claim entirely, so no in-flight request writes state (used when closing). */
  cancel(): void;
}

export function createLatestRequestGuard(): LatestRequestGuard {
  let latest = 0;
  return {
    begin: () => (latest += 1),
    current: (ticket) => ticket === latest,
    cancel: () => {
      latest += 1;
    },
  };
}

/**
 * Whether a settled cancellation for one task may still write to the drawer.
 *
 * Cancellation state (the pending row, the reason field, the failure message, and the result
 * line) is single-slot: the drawer holds one of each for whichever task it currently shows.
 * Because the drawer is modeless, the operator can request cancellation of task A and click task
 * B before the server answers, so a late answer for A would otherwise plant A's error or A's
 * result under B's heading. The request guard cannot decide this on its own: it tracks detail
 * loads, and a cancellation outlives the load that opened it. The task id the operator is
 * looking at now is the fact that settles it.
 */
export function cancelResultAppliesTo(taskId: string, selectedTaskId: string | null): boolean {
  return selectedTaskId === taskId;
}

/**
 * The next pending-cancellation task id once the cancellation of `taskId` has settled.
 *
 * The pending flag is a single slot holding at most one task id. Clearing it unconditionally
 * would let a slow cancellation, settling after the operator started a second one, unstick a
 * spinner belonging to a request that is still running, so only the owner clears it.
 */
export function clearPendingCancel(pending: string | null, taskId: string): string | null {
  return pending === taskId ? null : pending;
}

/**
 * What the drawer must do to agree with the URL it is being reconciled against.
 *
 * The URL is the only source of truth for the open task, so a click, a pasted deep link, a
 * reload, and Back all arrive here as the same question. `none` is the load guard that matters
 * in practice: this reconciliation runs on every render of the controller, and without it an
 * unrelated re-render (a poll landing, a filter changing, a timezone tick) would restart the
 * detail request for the task already on screen, discarding an in-flight load and flashing the
 * panel back to its spinner.
 */
export type TaskDrawerSync = "none" | "open" | "close";

export function taskDrawerSync(
  requestedTaskId: string | null,
  shownTaskId: string | null,
): TaskDrawerSync {
  if (requestedTaskId === shownTaskId) return "none";
  return requestedTaskId === null ? "close" : "open";
}
