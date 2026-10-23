import { Text, Tooltip, VisuallyHidden, type TextProps } from "@mantine/core";
import type { ReactNode } from "react";

/**
 * A short table value with its full explanation. The explanation is hidden text after the value,
 * so a screen reader reads it with the cell. A tooltip shows it by pointer, keyboard, and touch.
 * A paragraph has no accessible name, so the explanation is not an `aria-label`.
 */
export function ExplainedValue({
  explanation,
  children,
  ...textProps
}: TextProps & { explanation: string; children: ReactNode }) {
  return (
    <Tooltip
      label={explanation}
      multiline
      maw={320}
      withArrow
      events={{ hover: true, focus: true, touch: true }}
    >
      <Text
        {...textProps}
        className="explained-value"
        tabIndex={0}
        // A tap shows the explanation and does not also select the row.
        onClick={(event) => event.stopPropagation()}
      >
        {children}
        <VisuallyHidden>{`. ${explanation}`}</VisuallyHidden>
      </Text>
    </Tooltip>
  );
}
