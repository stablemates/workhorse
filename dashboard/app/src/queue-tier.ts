import type { DashboardManagedQueueRow } from "@stablemates/workhorse-dashboard-server/wire";

/**
 * Describe a queue's storage tier and the history it keeps (ADR 0077).
 *
 * A full-tier queue records every attempt and claim, so only a fast-tier queue has a history line.
 * A schema older than version 37 does not report the tier, and the page says so instead of guessing.
 */
export function describeQueueTier(
  queue: Pick<DashboardManagedQueueRow, "tier" | "recordAttempts" | "recordClaims">,
): { label: string; historyLabel: string | null; title: string } {
  if (queue.tier === undefined) {
    return {
      label: "—",
      historyLabel: null,
      title: "The installed Workhorse schema does not report queue tiers. Migrate it to see them.",
    };
  }
  if (queue.tier === "full") {
    return {
      label: "Full",
      historyLabel: null,
      title: "Full tier: Workhorse records every attempt and claim for this queue.",
    };
  }
  const kept = [
    queue.recordAttempts === true ? "attempts" : null,
    queue.recordClaims === true ? "claims" : null,
  ].filter((entry) => entry !== null);
  const historyLabel = kept.length === 0 ? "No history" : `Records ${kept.join(", ")}`;
  const title =
    kept.length === 0
      ? "Fast tier: Workhorse keeps no attempt history and no claimed events for this queue."
      : `Fast tier: Workhorse records ${kept.join(" and ")} for this queue.`;
  return { label: "Fast", historyLabel, title };
}
