/**
 * Task detail drawer behaviour, kept out of the component so it can be asserted directly.
 *
 * The drawer is deliberately non-modal: an operator comparing tasks clicks straight from one
 * table row to the next while the panel stays open, so the panel must never take the pointer,
 * the focus, or the scroll position away from the task list behind it.
 */

/** Props that make the drawer a side panel rather than a modal dialog. */
export const taskDrawerModelessProps = {
  withOverlay: false,
  lockScroll: false,
  trapFocus: false,
  closeOnClickOutside: false,
  returnFocus: false,
  /* Escape still closes, because that is the only keyboard affordance a side panel keeps. */
  closeOnEscape: true,
} as const;

/**
 * What the drawer body shows for one controller state.
 *
 * Picking another task clears the loaded detail but keeps the selected id, so the drawer stays
 * open on a loader instead of closing and re-opening.
 */
export type TaskDrawerBody = "closed" | "error" | "loading" | "detail";

export function taskDrawerBody(state: {
  selectedJobId: string | null;
  selectedJob: unknown | null;
  jobDetailError: string | null;
}): TaskDrawerBody {
  if (state.selectedJobId === null) return "closed";
  if (state.jobDetailError !== null) return "error";
  if (state.selectedJob === null) return "loading";
  return "detail";
}

/** The drawer is open for as long as a task is selected, including while its detail loads. */
export function taskDrawerOpened(selectedJobId: string | null): boolean {
  return selectedJobId !== null;
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
