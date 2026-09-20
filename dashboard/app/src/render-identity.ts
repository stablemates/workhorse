import type { LoadState, PageData } from "./core.js";
import type { DashboardTaskCounts } from "@stablemates/workhorse-dashboard-server/wire";

/**
 * Whether two answers describe the same thing.
 *
 * Every poll decodes a fresh object graph, so reference identity reports a change even when the
 * server repeated what the screen already shows. Comparing the structure instead lets the
 * dashboard keep the object it is already rendering, and React then has nothing to reconcile.
 *
 * Functions and other non-plain values compare by reference, because two closures cannot be
 * shown to agree.
 */
export function sameStructure(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object") return false;
  if (left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    return (
      left.length === right.length && left.every((entry, at) => sameStructure(entry, right[at]))
    );
  }
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  if (keys.length !== Object.keys(rightRecord).length) return false;
  return keys.every(
    (key) => Object.hasOwn(rightRecord, key) && sameStructure(leftRecord[key], rightRecord[key]),
  );
}

/**
 * The load state after a page answered, reusing whatever the answer repeated.
 *
 * A poll that changed nothing returns the state object the shell already holds, so `setState`
 * bails out and no component below it renders. A poll that changed one page still hands back the
 * same object for a value it did not touch.
 */
export function readyLoadState(current: LoadState, data: PageData): LoadState {
  if (current.status === "ready" && sameStructure(current.data, data)) return current;
  const preserved =
    current.data !== null && sameStructure(current.data, data) ? current.data : data;
  return { status: "ready", data: preserved, error: null };
}

/** The counts after a poll answered, reusing the current object when the totals repeated. */
export function readyTaskCounts(
  current: DashboardTaskCounts | null,
  counts: DashboardTaskCounts,
): DashboardTaskCounts {
  return current !== null && sameStructure(current, counts) ? current : counts;
}
