/**
 * Chart series colors for each color scheme.
 *
 * `mantine-theme.ts` writes each value as a CSS variable, so a chart names a role and the color
 * scheme picks the value. Each light value gives at least 3:1 on the light panel (`#fbfbfb`), and
 * each dark value gives at least 3:1 on the dark panel (`#202020`). The order of each list is the
 * order of the stacked segments, so neighbors stay apart for color-blind readers. The dataviz
 * palette validator checked each order against both panels.
 */

/**
 * Colors for series that are not task states: amber, sky, emerald, violet, teal, and rose.
 * A series keeps its slot while the set of series stays the same, because the slot comes from
 * the sorted label, not from the volume.
 */
export const categoricalSeriesColors = {
  light: ["#b26d1c", "#0284c7", "#059669", "#7c3aed", "#0d9488", "#e11d48"],
  dark: ["#c4833a", "#0b96d4", "#0ca678", "#8b5cf6", "#12a594", "#f43f5e"],
} as const;

/** The color of the series that holds every group after the cap. Slate stays apart from rose. */
export const overflowSeriesColor = { light: "#64748b", dark: "#7c8aa0" } as const;

/**
 * Task states from the baseline of a stacked bar to its top. A finished task is the base, and
 * blocked work is on top. This order keeps the two blues apart from each other and from violet.
 */
export const activityStatusOrder = [
  "succeeded",
  "ready",
  "active",
  "scheduled",
  "failed",
  "canceled",
  "blocked",
] as const;

export type ActivityStatus = (typeof activityStatusOrder)[number];

/**
 * Semantic colors for task states: completed is emerald, running is amber, queued is sky,
 * scheduled is blue, failed is rose, canceled is slate, and blocked (waiting) is violet.
 */
export const activityStatusColors = {
  light: {
    succeeded: "#059669",
    ready: "#0284c7",
    active: "#b26d1c",
    scheduled: "#1d4ed8",
    failed: "#e11d48",
    canceled: "#64748b",
    blocked: "#7c3aed",
  },
  dark: {
    succeeded: "#0ca678",
    ready: "#0b96d4",
    active: "#c4833a",
    scheduled: "#5b7cf0",
    failed: "#f43f5e",
    canceled: "#7c8aa0",
    blocked: "#a275f7",
  },
} as const satisfies Record<"light" | "dark", Record<ActivityStatus, string>>;

/** The CSS variable of a categorical slot. Slots repeat only past the cap, which never happens. */
export function categoricalSeriesColor(slot: number): string {
  return `var(--workhorse-series-${(slot % categoricalSeriesColors.light.length) + 1})`;
}

export const overflowSeriesVariable = "var(--workhorse-series-other)";

/** The CSS variable of a task state's chart color. */
export function activityStatusColor(status: ActivityStatus): string {
  return `var(--workhorse-chart-${status})`;
}

/** CSS variables for one color scheme, for the theme's CSS variables resolver. */
export function chartColorVariables(mode: "light" | "dark"): Record<string, string> {
  return {
    ...Object.fromEntries(
      categoricalSeriesColors[mode].map((value, index) => [
        `--workhorse-series-${index + 1}`,
        value,
      ]),
    ),
    "--workhorse-series-other": overflowSeriesColor[mode],
    // Attempt outcomes on the System health chart reuse the state hues: a retry waits like a
    // blocked task, and an expired lease ends a running attempt.
    "--workhorse-chart-retry": activityStatusColors[mode].blocked,
    "--workhorse-chart-lease-expired": activityStatusColors[mode].active,
    ...Object.fromEntries(
      activityStatusOrder.map((status) => [
        `--workhorse-chart-${status}`,
        activityStatusColors[mode][status],
      ]),
    ),
  };
}
