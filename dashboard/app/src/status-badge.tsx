import { Badge } from "@mantine/core";

const healthyStates = new Set(["succeeded", "ready", "active", "busy"]);
const failureStates = new Set(["failed", "discarded", "incomplete"]);
const warningStates = new Set(["blocked", "scheduled", "retryable", "recent", "due"]);
const canceledStates = new Set(["canceled", "cancel_requested"]);

function statusColor(state: string): string {
  if (healthyStates.has(state)) return "teal";
  if (failureStates.has(state) || state === "unhealthy" || state === "offline") return "red";
  if (canceledStates.has(state)) return "gray";
  if (warningStates.has(state)) return "yellow";
  return "gray";
}

/** A state label whose accessible meaning does not depend on its decorative color. */
export function StatusBadge({ state }: { state: string }) {
  return (
    <Badge
      color={statusColor(state)}
      variant="light"
      tt="capitalize"
      role="status"
      aria-label={`Status: ${state}`}
      style={{ flexShrink: 0 }}
    >
      {state}
    </Badge>
  );
}
