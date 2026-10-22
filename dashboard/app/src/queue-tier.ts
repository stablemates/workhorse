import type {
  DashboardManagedQueueRow,
  DashboardQueueTier,
  DashboardSetQueueTierStatus,
} from "@stablemates/workhorse-dashboard-server/wire";

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

/** What this host lets the dashboard change about a queue's tier and history. */
export interface QueueTierCapabilities {
  canSetTier: boolean;
  canSetHistory: boolean;
}

export type QueueTierActionId = "tier" | "recordAttempts" | "recordClaims";

export interface QueueTierAction {
  id: QueueTierActionId;
  label: string;
  /** Why the action is disabled, or null when it is available. */
  unavailable: string | null;
}

const schemaUnavailable =
  "The installed Workhorse schema does not report queue tiers. Migrate it to change them.";

/**
 * The tier and history actions of one queue row, each with the reason it is disabled.
 *
 * An action that does not apply stays in the menu with its reason, as the task row menu does, so
 * an operator learns why in the place they looked. Workhorse decides whether a tier switch is
 * allowed; the menu only states what this host and schema can do.
 */
export function queueTierActions(
  queue: Pick<DashboardManagedQueueRow, "tier" | "recordAttempts" | "recordClaims">,
  capabilities: QueueTierCapabilities,
): QueueTierAction[] {
  const historyUnavailable = !capabilities.canSetHistory
    ? "This host cannot change the history of a queue."
    : queue.tier === undefined
      ? schemaUnavailable
      : queue.tier === "full"
        ? "A full-tier queue records attempts and claims regardless."
        : null;
  return [
    {
      id: "tier",
      label: queue.tier === "fast" ? "Move to the full tier" : "Move to the fast tier",
      unavailable: !capabilities.canSetTier
        ? "This host cannot change the tier of a queue."
        : queue.tier === undefined
          ? schemaUnavailable
          : null,
    },
    {
      id: "recordAttempts",
      label: queue.recordAttempts === true ? "Stop recording attempts" : "Record attempts",
      unavailable: historyUnavailable,
    },
    {
      id: "recordClaims",
      label: queue.recordClaims === true ? "Stop recording claims" : "Record claims",
      unavailable: historyUnavailable,
    },
  ];
}

/**
 * Describe what one tier switch reported.
 *
 * A refusal names the guard that stopped it and what the operator can do, because "not changed"
 * alone sends them to the logs. A refused switch changes nothing, so the row keeps its tier.
 */
export function describeTierSwitch(
  queue: string,
  requested: DashboardQueueTier,
  status: DashboardSetQueueTierStatus,
): { title: string; message: string; tone: "success" | "failure" } {
  switch (status) {
    case "set":
      return {
        title: "Queue tier changed",
        message:
          requested === "fast"
            ? `${queue} is on the fast tier. It records only the history that its history settings turn on.`
            : `${queue} is on the full tier. Workhorse records every attempt and claim.`,
        tone: "success",
      };
    case "live_tasks":
      return {
        title: "Queue tier not changed",
        message: `${queue} still holds tasks that are not finished. Its tier can change only when it holds none. Wait for them to finish or clear them, then try again.`,
        tone: "failure",
      };
    case "concurrency_policy":
      return {
        title: "Queue tier not changed",
        message: `${queue} has a concurrency policy, and a fast-tier queue cannot have one. Remove the policy from the deployment, then try again.`,
        tone: "failure",
      };
    case "rate_limit_policy":
      return {
        title: "Queue tier not changed",
        message: `${queue} has a rate-limit policy, and a fast-tier queue cannot have one. Remove the policy from the deployment, then try again.`,
        tone: "failure",
      };
  }
}
