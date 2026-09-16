import type { DashboardEventsWindow } from "@stablemates/workhorse-dashboard-server/wire";

/**
 * Event presentation shared by the events page and the task detail drawer.
 *
 * Both readers stay out of `pages/events` on purpose: the drawer is part of the shell, and an
 * import from the page would carry the whole events table into the main bundle.
 */
/** Window choices offered by the events page; `custom` is added by the page itself. */
export const eventsWindowOptions: ReadonlyArray<{
  value: DashboardEventsWindow;
  label: string;
}> = [
  { value: "15m", label: "15m" },
  { value: "1h", label: "1h" },
  { value: "6h", label: "6h" },
  { value: "24h", label: "24h" },
];
/** One-line rendering of an event payload, for a table cell that cannot hold formatted JSON. */
export function eventDetailSummary(details: unknown): string | null {
  if (details === null || details === undefined) return null;
  if (typeof details !== "object") return String(details);
  const entries = Object.entries(details as Record<string, unknown>);
  if (entries.length === 0) return null;
  return entries
    .map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : value}`)
    .join(" · ");
}
