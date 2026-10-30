/**
 * Shared meanings for task states and the events that report those transitions.
 *
 * Each value is a Mantine color name. `mantine-theme.ts` maps each name to a hue of the Untitled
 * theme: `blue` to `color-2`, `violet` to `color-3`, `orange` to `color-1`, and `teal`, `red`,
 * and `yellow` to the success, error, and warning colors. The three wait kinds share `color-1`,
 * because their labels already name the kind of wait.
 */
export const taskStatusColors = {
  active: "blue",
  ready: "violet",
  succeeded: "teal",
  failed: "red",
  canceled: "gray",
  blocked: "yellow",
  scheduled: "yellow",
  signalWait: "orange",
  humanWait: "orange",
  durableWait: "orange",
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
 * Text colors for status notes such as retry counts and blocked counts. The theme `warning` and
 * `error` colors are too light or too dark for text on some backgrounds: `warning` gives about
 * 1.2:1 on white. Each value here mixes the theme color toward black or white until it reaches
 * 4.5:1 on the body, striped row, and hovered row backgrounds of its color scheme.
 */
export const statusTextColors = {
  // Light: 45% `warning` or 75% `error`, and the rest black.
  // Dark: `warning` as it is, or 45% `error` and the rest white.
  warning: { light: "#736900", dark: "#ffea00" },
  danger: { light: "#bd0222", dark: "#fe8ea0" },
} as const;

/** CSS values that resolve to the status text color of the current color scheme. */
export const warningTextColor = "var(--workhorse-color-warning-text)";
export const dangerTextColor = "var(--workhorse-color-danger-text)";
