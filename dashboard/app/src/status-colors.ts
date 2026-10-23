/** Shared meanings for task states and the events that report those transitions. */
export const taskStatusColors = {
  active: "blue",
  ready: "cyan",
  succeeded: "teal",
  failed: "red",
  canceled: "gray",
  blocked: "yellow",
  scheduled: "yellow",
  signalWait: "violet",
  humanWait: "pink",
  durableWait: "indigo",
} as const;

const healthyStates = new Set(["succeeded", "ready", "active", "busy"]);
const failureStates = new Set(["failed", "discarded", "incomplete"]);
const warningStates = new Set(["blocked", "scheduled", "retryable", "recent", "due"]);
const canceledStates = new Set(["canceled", "cancel_requested"]);

export function statusColor(state: string): string {
  if (state === "blocked") return taskStatusColors.blocked;
  if (state === "active" || state === "busy") return taskStatusColors.active;
  if (state === "ready") return taskStatusColors.ready;
  if (healthyStates.has(state)) return taskStatusColors.succeeded;
  if (failureStates.has(state) || state === "unhealthy" || state === "offline")
    return taskStatusColors.failed;
  if (canceledStates.has(state)) return taskStatusColors.canceled;
  if (warningStates.has(state)) return taskStatusColors.scheduled;
  return "gray";
}

/**
 * Text colors for status notes such as retry counts and blocked counts. A filled palette shade
 * is too light for text on a light background: `yellow.8` gives about 2.5:1 on white. Each value
 * here reaches 4.5:1 on the body, striped row, and hovered row backgrounds of its color scheme.
 */
export const statusTextColors = {
  warning: { light: "#946200", dark: "#fcc419" },
  danger: { light: "#c92a2a", dark: "#ff8787" },
} as const;

/** CSS values that resolve to the status text color of the current color scheme. */
export const warningTextColor = "var(--workhorse-color-warning-text)";
export const dangerTextColor = "var(--workhorse-color-danger-text)";
