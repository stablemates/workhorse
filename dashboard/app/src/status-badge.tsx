import type { ReactNode } from "react";
import { Badge, Tooltip } from "@mantine/core";

import { statusColor } from "./status-colors.js";

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

/** A rectangular status label with optional details available by pointer, keyboard, and touch. */
export function StatusLabel({
  state,
  text = state.replaceAll("_", " "),
  label = `Status: ${state}`,
  color = statusColor(state),
  children,
}: {
  state: string;
  text?: string;
  label?: string;
  color?: string;
  children?: ReactNode;
}) {
  const badge = (
    <Badge
      className="status-label"
      size="sm"
      radius={0}
      variant="light"
      color={color}
      tt="uppercase"
      w="max-content"
      styles={{ root: { justifyContent: "flex-start", textAlign: "left", flexShrink: 0 } }}
      role="status"
      tabIndex={children ? 0 : undefined}
      aria-label={label}
      onClick={children ? (event) => event.stopPropagation() : undefined}
    >
      {text}
    </Badge>
  );
  if (!children) return badge;
  return (
    <Tooltip
      label={children}
      multiline
      maw={420}
      withArrow
      events={{ hover: true, focus: true, touch: true }}
    >
      {badge}
    </Tooltip>
  );
}
