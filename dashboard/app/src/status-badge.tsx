import type { ReactNode } from "react";
import { Badge, Tooltip, VisuallyHidden } from "@mantine/core";

import { statusColor } from "./status-colors.js";

/**
 * Text that a screen reader reads in place of the visible text. A status label is static text,
 * not a live region: a list shows many labels, and a refresh must not announce each row. A
 * generic element has no accessible name, so the label is hidden text and not an `aria-label`.
 */
export function StatusText({ text, label }: { text: ReactNode; label: string }) {
  return (
    <>
      <span aria-hidden="true">{text}</span>
      <VisuallyHidden>{label}</VisuallyHidden>
    </>
  );
}

/** A state label whose accessible meaning does not depend on its decorative color. */
export function StatusBadge({ state }: { state: string }) {
  return (
    <Badge color={statusColor(state)} variant="light" tt="capitalize" style={{ flexShrink: 0 }}>
      <StatusText text={state} label={`Status: ${state}`} />
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
      tabIndex={children ? 0 : undefined}
      onClick={children ? (event) => event.stopPropagation() : undefined}
    >
      <StatusText text={text} label={label} />
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
